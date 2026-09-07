/** Lifecycle glue for existing page effects: no resource cache, retries, or data authority. */
export function startVisibleRefresh(
  run: (signal: AbortSignal) => Promise<unknown>,
  onError: (error: unknown) => void,
  intervalMs = 30_000,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | null = null;
  let again = false;
  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void refreshIfVisible();
    }, delay);
  };
  const refresh = (afterCurrent = false): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    if (pending) {
      again ||= afterCurrent;
      return pending;
    }
    clearTimeout(timer);
    pending = Promise.resolve()
      .then(() => (controller.signal.aborted ? undefined : run(controller.signal)))
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) onError(error);
      })
      .finally(() => {
        pending = null;
        if (!controller.signal.aborted) schedule(again ? 0 : intervalMs);
        again = false;
      });
    return pending;
  };
  const refreshIfVisible = () => {
    if (document.visibilityState === "visible") return refresh();
    schedule(intervalMs);
    return Promise.resolve();
  };
  document.addEventListener("visibilitychange", refreshIfVisible);
  window.addEventListener("focus", refreshIfVisible);
  void refresh();
  return {
    refresh,
    stop() {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    },
  };
}
