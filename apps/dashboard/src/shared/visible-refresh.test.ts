import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVisibleRefresh } from "./visible-refresh.js";

describe("visible resource refresh", () => {
  it("spaces focus work while keeping explicit refresh immediate", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const run = vi.fn().mockResolvedValue(undefined);
    const loop = startVisibleRefresh(run, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(299);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("focus"));
    await loop.refresh();
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(3);
    loop.stop();
    random.mockRestore();
  });
  let document: EventTarget & { visibilityState: string };
  let window: EventTarget;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    window = new EventTarget();
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", window);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lets a slow read finish through timer and focus events, then polls after settlement", async () => {
    let resolve!: () => void;
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(undefined);
    const loop = startVisibleRefresh(run, vi.fn(), 100);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0].aborted).toBe(false);
    resolve();
    await vi.advanceTimersByTimeAsync(99);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("coalesces multiple evidence changes into one follow-up without aborting", async () => {
    let resolve!: () => void;
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(undefined);
    const loop = startVisibleRefresh(run, vi.fn(), 100);
    await vi.advanceTimersByTimeAsync(0);
    void loop.refresh(true);
    void loop.refresh(true);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("suppresses hidden polling and retries errors on focus without owning resource data", async () => {
    const error = new Error("temporarily unavailable");
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = vi.fn();
    const loop = startVisibleRefresh(run, onError, 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(error);
    document.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(500);
    window.dispatchEvent(new Event("focus"));
    expect(run).toHaveBeenCalledTimes(1);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("aborts on identity/unmount cleanup, suppresses late errors and strict-mode abandoned starts", async () => {
    const abandoned = vi.fn();
    startVisibleRefresh(abandoned, vi.fn()).stop();
    let reject!: (error: Error) => void;
    const run = vi.fn().mockImplementation(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    const onError = vi.fn();
    const loop = startVisibleRefresh(run, onError);
    await vi.advanceTimersByTimeAsync(0);
    expect(abandoned).not.toHaveBeenCalled();
    loop.stop();
    expect(run.mock.calls[0]?.[0].aborted).toBe(true);
    reject(new Error("late error"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
