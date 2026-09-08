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
  let focusScheduled = false;
  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      focusScheduled = false;
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
    focusScheduled = false;
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
  const onFocus = () => {
    if (document.visibilityState !== "visible" || pending || focusScheduled) return;
    focusScheduled = true;
    // Spread independent mounted resources over half a second on tab/window focus. Initial
    // loads and explicit mutation refreshes remain immediate; repeated focus events coalesce.
    schedule(100 + Math.floor(Math.random() * 400));
  };
  document.addEventListener("visibilitychange", onFocus);
  window.addEventListener("focus", onFocus);
  void refresh();
  return {
    refresh,
    stop() {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    },
  };
}
