export type CircuitState = "closed" | "open" | "half_open";

// Thrown instead of calling the operation while the circuit is open.
export class CircuitOpenError extends Error {
  readonly circuit: string;
  readonly retryAfterMs: number;

  constructor(circuit: string, retryAfterMs: number) {
    super(`Circuit "${circuit}" is open`);
    this.name = "CircuitOpenError";
    this.circuit = circuit;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CircuitBreakerOptions {
  name: string;
  /** Consecutive failures that open the circuit. */
  failureThreshold?: number;
  /** How long the circuit stays open before one probe request is allowed. */
  cooldownMs?: number;
  /** Decides which errors count as an outage. Errors it rejects count as "the service answered". */
  isFailure?: (error: unknown) => boolean;
  /** Clock in milliseconds; injectable so tests do not need real time. */
  now?: () => number;
  onStateChange?: (state: CircuitState, previous: CircuitState) => void;
}

export interface CircuitBreaker {
  exec<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Like exec, for a stream. The circuit is checked when the first item is requested; an error
   * anywhere in the stream counts as one failure. A consumer that stops early (for example a
   * client that disconnects) is neither a success nor a failure.
   */
  execStream<T>(source: () => AsyncIterable<T>): AsyncGenerator<T, void, undefined>;
  readonly state: CircuitState;
  reset(): void;
}

// Builds a small circuit breaker: closed -> open after N consecutive failures,
// open -> half_open after the cooldown (one probe), half_open -> closed or open.
export function createCircuitBreaker({
  name,
  failureThreshold = 5,
  cooldownMs = 30_000,
  isFailure = () => true,
  now = Date.now,
  onStateChange
}: CircuitBreakerOptions): CircuitBreaker {
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw new RangeError("failureThreshold must be an integer of at least 1");
  }
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new RangeError("cooldownMs must be a non-negative number");
  }

  let state: CircuitState = "closed";
  let failures = 0;
  let openedAt = 0;

  function transition(next: CircuitState): void {
    if (next === state) return;
    const previous = state;
    state = next;
    onStateChange?.(next, previous);
  }

  function open(): void {
    failures = 0;
    openedAt = now();
    transition("open");
  }

  function close(): void {
    failures = 0;
    transition("closed");
  }

  // Only the probe may close a half-open circuit; a slow request from before the outage must not.
  function recordSuccess(wasProbe: boolean): void {
    if (wasProbe) close();
    else if (state === "closed") failures = 0;
  }

  function recordFailure(wasProbe: boolean): void {
    if (wasProbe) {
      open();
      return;
    }
    if (state !== "closed") return;
    failures += 1;
    if (failures >= failureThreshold) open();
  }

  // Lets a request through, or throws CircuitOpenError. Returns true when the caller is the probe.
  function admit(): boolean {
    if (state === "open") {
      const remaining = cooldownMs - (now() - openedAt);
      if (remaining > 0) throw new CircuitOpenError(name, remaining);
      transition("half_open");
      return true; // this caller is the single probe
    }
    if (state === "half_open") throw new CircuitOpenError(name, 0); // the probe is still in flight
    return false;
  }

  // A probe that ended without a verdict goes back to "open"; the cooldown has already passed,
  // so the next caller becomes the new probe.
  function release(): void {
    if (state === "half_open") transition("open");
  }

  async function exec<T>(operation: () => Promise<T>): Promise<T> {
    const wasProbe = admit();
    try {
      const result = await operation();
      recordSuccess(wasProbe);
      return result;
    } catch (error) {
      if (isFailure(error)) recordFailure(wasProbe);
      else recordSuccess(wasProbe);
      throw error;
    }
  }

  async function* execStream<T>(source: () => AsyncIterable<T>): AsyncGenerator<T, void, undefined> {
    const wasProbe = admit();
    let settled = false;
    try {
      for await (const item of source()) yield item;
      settled = true;
      recordSuccess(wasProbe);
    } catch (error) {
      settled = true;
      if (isFailure(error)) recordFailure(wasProbe);
      else recordSuccess(wasProbe);
      throw error;
    } finally {
      if (!settled && wasProbe) release();
    }
  }

  return {
    exec,
    execStream,
    get state(): CircuitState {
      return state;
    },
    reset: close
  };
}
