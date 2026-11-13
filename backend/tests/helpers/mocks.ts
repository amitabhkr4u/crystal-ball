// The arguments of the nth call to a mock; fails the test when the mock was not called that often.
export function callArgs(mock: jest.Mock, index = 0): unknown[] {
  const args: unknown[] | undefined = mock.mock.calls[index];
  if (!args) throw new Error(`Expected the mock to be called at least ${index + 1} time(s)`);
  return args;
}

// Lets every pending promise callback run, including ones queued by fire-and-forget calls.
export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
