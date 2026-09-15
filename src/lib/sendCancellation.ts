/** Intentional withdrawal, never a reason to retry a message automatically. */
export class SendCancelledError extends Error {
  constructor() { super("Send cancelled because its session or request changed."); this.name = "SendCancelledError"; }
}

export function throwIfSendCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SendCancelledError();
}

/** Release a caller/preparation wait, while still observing the underlying promise.
 * Do not use this to release ordered admission around a non-abortable delivery. */
export function waitForSend<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { cleanup(); reject(new SendCancelledError()); };
    const cleanup = () => signal.removeEventListener("abort", cancel);
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
}

export function waitForSendDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new SendCancelledError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, ms);
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}

// localStorage's native event only reaches other tabs. Session setters notify
// this tab too; token refresh with the same identity does not invalidate sends.
export function notifySendIdentityChange(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event("send-identity-changed"));
  }
}
