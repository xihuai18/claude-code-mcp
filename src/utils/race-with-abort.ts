/**
 * Race a promise against an AbortSignal — resolves/rejects the promise
 * or rejects early when the signal fires.
 */
import { ErrorCode } from "../types.js";

export function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    try {
      onAbort();
    } catch {
      /* best-effort */
    }
    return Promise.reject(new Error(`Error [${ErrorCode.CANCELLED}]: request was cancelled.`));
  }
  return new Promise<T>((resolve, reject) => {
    const abortListener = () => {
      try {
        onAbort();
      } catch {
        /* best-effort */
      }
      reject(new Error(`Error [${ErrorCode.CANCELLED}]: request was cancelled.`));
    };
    signal.addEventListener("abort", abortListener, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abortListener));
  });
}
