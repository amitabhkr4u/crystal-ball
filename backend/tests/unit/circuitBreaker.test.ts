import { CircuitOpenError, createCircuitBreaker, type CircuitState } from "../../src/utils/circuitBreaker";

const boom = new Error("boom");
const failing = (): Promise<string> => Promise.reject(boom);
const succeeding = (): Promise<string> => Promise.resolve("ok");

// Builds a breaker with a fake clock; threshold 3, cooldown 10s.
function setup(options: { isFailure?: (error: unknown) => boolean } = {}) {
  let clock = 1_000;
  const changes: Array<[CircuitState, CircuitState]> = [];
  const breaker = createCircuitBreaker({
    name: "test",
    failureThreshold: 3,
    cooldownMs: 10_000,
    now: () => clock,
    onStateChange: (state, previous) => changes.push([state, previous]),
    ...options
  });
  return {
    breaker,
    changes,
    advance(ms: number): void {
      clock += ms;
    }
  };
}

async function* items(...values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value;
}

async function* failsAfter(first: string): AsyncGenerator<string> {
  yield first;
  throw boom;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

async function fail(breaker: { exec: (op: () => Promise<string>) => Promise<string> }, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) await breaker.exec(failing).catch(() => undefined);
}

describe("createCircuitBreaker", () => {
  it("passes the result through while closed", async () => {
    const { breaker } = setup();
    await expect(breaker.exec(succeeding)).resolves.toBe("ok");
    expect(breaker.state).toBe("closed");
  });

  it("rethrows the original error and stays closed below the threshold", async () => {
    const { breaker } = setup();
    await expect(breaker.exec(failing)).rejects.toBe(boom);
    await fail(breaker, 1);
    expect(breaker.state).toBe("closed");
  });

  it("opens after the threshold and rejects without calling the operation", async () => {
    const { breaker } = setup();
    await fail(breaker, 3);
    expect(breaker.state).toBe("open");

    let calls = 0;
    await expect(
      breaker.exec(() => {
        calls += 1;
        return succeeding();
      })
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(0);
  });

  it("tells the caller how long to wait", async () => {
    const { breaker, advance } = setup();
    await fail(breaker, 3);
    advance(4_000);
    const error = await breaker.exec(succeeding).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect((error as CircuitOpenError).retryAfterMs).toBe(6_000);
    expect((error as CircuitOpenError).circuit).toBe("test");
  });

  it("only counts consecutive failures: a success resets the count", async () => {
    const { breaker } = setup();
    await fail(breaker, 2);
    await breaker.exec(succeeding);
    await fail(breaker, 2);
    expect(breaker.state).toBe("closed");
  });

  it("ignores errors that isFailure rejects, but still rethrows them", async () => {
    const clientError = new Error("400 bad request");
    const { breaker } = setup({ isFailure: (error) => error !== clientError });
    for (let i = 0; i < 5; i += 1) {
      await expect(breaker.exec(() => Promise.reject(clientError))).rejects.toBe(clientError);
    }
    expect(breaker.state).toBe("closed");
  });

  it("lets exactly one probe through after the cooldown", async () => {
    const { breaker, advance } = setup();
    await fail(breaker, 3);
    advance(10_000);

    let release: (value: string) => void = () => undefined;
    const probe = breaker.exec(() => new Promise<string>((resolve) => (release = resolve)));
    expect(breaker.state).toBe("half_open");
    await expect(breaker.exec(succeeding)).rejects.toBeInstanceOf(CircuitOpenError);

    release("probed");
    await expect(probe).resolves.toBe("probed");
    expect(breaker.state).toBe("closed");
  });

  it("closes after a successful probe and counts failures from zero again", async () => {
    const { breaker, advance } = setup();
    await fail(breaker, 3);
    advance(10_000);
    await breaker.exec(succeeding);
    await fail(breaker, 2);
    expect(breaker.state).toBe("closed");
  });

  it("re-opens and restarts the cooldown after a failed probe", async () => {
    const { breaker, advance } = setup();
    await fail(breaker, 3);
    advance(10_000);
    await fail(breaker, 1);
    expect(breaker.state).toBe("open");

    advance(9_999);
    await expect(breaker.exec(succeeding)).rejects.toBeInstanceOf(CircuitOpenError);
    advance(1);
    await expect(breaker.exec(succeeding)).resolves.toBe("ok");
    expect(breaker.state).toBe("closed");
  });

  it("reports every state change once", async () => {
    const { breaker, changes, advance } = setup();
    await fail(breaker, 3);
    advance(10_000);
    await breaker.exec(succeeding);
    expect(changes).toEqual([
      ["open", "closed"],
      ["half_open", "open"],
      ["closed", "half_open"]
    ]);
  });

  it("reset() closes an open circuit", async () => {
    const { breaker } = setup();
    await fail(breaker, 3);
    breaker.reset();
    expect(breaker.state).toBe("closed");
    await expect(breaker.exec(succeeding)).resolves.toBe("ok");
  });

  it("rejects invalid settings", () => {
    expect(() => createCircuitBreaker({ name: "x", failureThreshold: 0 })).toThrow(RangeError);
    expect(() => createCircuitBreaker({ name: "x", cooldownMs: -1 })).toThrow(RangeError);
  });
});

describe("createCircuitBreaker execStream", () => {
  it("yields every item and counts the finished stream as one success", async () => {
    const { breaker } = setup();
    await fail(breaker, 2);
    await expect(collect(breaker.execStream(() => items("a", "b")))).resolves.toEqual(["a", "b"]);
    await fail(breaker, 2);
    expect(breaker.state).toBe("closed");
  });

  it("counts an error thrown mid-stream as a failure and rethrows it", async () => {
    const { breaker } = setup();
    for (let i = 0; i < 3; i += 1) {
      await expect(collect(breaker.execStream(() => failsAfter("a")))).rejects.toBe(boom);
    }
    expect(breaker.state).toBe("open");
  });

  it("rejects a stream without starting it while the circuit is open", async () => {
    const { breaker } = setup();
    await fail(breaker, 3);
    let started = false;
    await expect(
      collect(
        breaker.execStream(() => {
          started = true;
          return items("a");
        })
      )
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(started).toBe(false);
  });

  it("ignores stream errors that isFailure rejects", async () => {
    const { breaker } = setup({ isFailure: () => false });
    for (let i = 0; i < 5; i += 1) {
      await expect(collect(breaker.execStream(() => failsAfter("a")))).rejects.toBe(boom);
    }
    expect(breaker.state).toBe("closed");
  });

  it("does not count a consumer that walks away early", async () => {
    const { breaker } = setup();
    for (let i = 0; i < 5; i += 1) {
      for await (const item of breaker.execStream(() => items("a", "b"))) {
        expect(item).toBe("a");
        break;
      }
    }
    expect(breaker.state).toBe("closed");
  });

  it("closes the circuit when a probe stream completes", async () => {
    const { breaker, advance } = setup();
    await fail(breaker, 3);
    advance(10_000);
    await collect(breaker.execStream(() => items("a")));
    expect(breaker.state).toBe("closed");
  });

  it("releases the probe when its consumer walks away, so the next call can probe", async () => {
    const { breaker, advance } = setup();
    await fail(breaker, 3);
    advance(10_000);
    for await (const item of breaker.execStream(() => items("a", "b"))) {
      expect(item).toBe("a");
      break;
    }
    expect(breaker.state).toBe("open");
    await expect(breaker.exec(succeeding)).resolves.toBe("ok");
    expect(breaker.state).toBe("closed");
  });
});
