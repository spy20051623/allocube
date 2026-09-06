export class RequestTimeoutError extends Error {
  constructor() { super("Request timed out"); }
}

// Bound the entire operation, including response-body reads. Cancel sibling reads on failure.
export async function withRequestDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  milliseconds = 15_000
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  let rejectAbort!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new RequestTimeoutError()), milliseconds);
  try {
    return await Promise.race([interrupted, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return run(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
