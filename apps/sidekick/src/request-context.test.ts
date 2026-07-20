import { describe, expect, it, vi } from "vitest";
import { StacksNodeClient } from "./chain-clients.js";
import {
  InteractiveRequestCancelledError,
  InteractiveRequestDeadlineError,
  withInteractiveRequestDeadline,
  withOperatorRequestSignal,
} from "./request-context.js";

function abortableFetch() {
  return vi.fn(
    async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
}

describe("interactive request context", () => {
  it("aborts chain reads at the operator deadline without retrying", async () => {
    const fetchImpl = abortableFetch();
    const node = new StacksNodeClient("http://node.internal:20443", fetchImpl);

    await expect(
      withInteractiveRequestDeadline(5, async () => node.getInfo()),
    ).rejects.toBeInstanceOf(InteractiveRequestDeadlineError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("propagates client cancellation into an in-flight chain read", async () => {
    const fetchImpl = abortableFetch();
    const node = new StacksNodeClient("http://node.internal:20443", fetchImpl);
    const controller = new AbortController();
    const read = withInteractiveRequestDeadline(
      1_000,
      async () => node.getInfo(),
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort(new InteractiveRequestCancelledError());

    await expect(read).rejects.toBeInstanceOf(InteractiveRequestCancelledError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("propagates background-operation cancellation into an in-flight chain read", async () => {
    const fetchImpl = abortableFetch();
    const node = new StacksNodeClient("http://node.internal:20443", fetchImpl);
    const controller = new AbortController();
    const read = withOperatorRequestSignal(controller.signal, async () => node.getInfo());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort(new InteractiveRequestCancelledError());

    await expect(read).rejects.toBeInstanceOf(InteractiveRequestCancelledError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
