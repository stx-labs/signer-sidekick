import { AsyncLocalStorage } from "node:async_hooks";

interface InteractiveRequestContext {
  readonly signal: AbortSignal;
}

const interactiveRequestContext = new AsyncLocalStorage<InteractiveRequestContext>();

export class InteractiveRequestDeadlineError extends Error {
  constructor() {
    super("Interactive operator request deadline exceeded");
    this.name = "InteractiveRequestDeadlineError";
  }
}

export class InteractiveRequestCancelledError extends Error {
  constructor() {
    super("Interactive operator request was cancelled");
    this.name = "InteractiveRequestCancelledError";
  }
}

export function currentInteractiveRequestSignal(): AbortSignal | undefined {
  return interactiveRequestContext.getStore()?.signal;
}

export async function withOperatorRequestSignal<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  return await interactiveRequestContext.run({ signal }, work);
}

export async function withInteractiveRequestDeadline<T>(
  milliseconds: number,
  work: () => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const deadlineError = new InteractiveRequestDeadlineError();
  const timeout = setTimeout(() => controller.abort(deadlineError), milliseconds);
  timeout.unref?.();
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  try {
    signal.throwIfAborted();
    return await interactiveRequestContext.run({ signal }, async () => {
      let rejectDeadline: ((reason?: unknown) => void) | undefined;
      const onAbort = () => rejectDeadline?.(signal.reason ?? deadlineError);
      const deadline = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject;
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([work(), deadline]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}
