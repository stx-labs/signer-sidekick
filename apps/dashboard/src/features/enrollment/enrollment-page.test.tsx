import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../api-client.js";
import { openPoolCardPreview, PoolCardError, poolCardSetupRequired } from "./enrollment-page.js";

describe("pool card error actions", () => {
  it("offers Initial Setup only when pool setup is incomplete", () => {
    const setup = new ApiRequestError("Request failed: pool setup not complete", {
      kind: "http",
      status: 409,
      code: "pool_setup_not_complete",
    });
    const transport = new ApiRequestError("Could not reach Sidekick", { kind: "transport" });

    expect(poolCardSetupRequired(setup)).toBe(true);
    expect(poolCardSetupRequired(transport)).toBe(false);
    expect(poolCardSetupRequired(new Error("Internal failure"))).toBe(false);

    const setupHtml = renderToStaticMarkup(
      <PoolCardError error="Setup is incomplete." setupRequired onRetry={() => undefined} />,
    );
    const transportHtml = renderToStaticMarkup(
      <PoolCardError
        error="Sidekick is unavailable."
        setupRequired={false}
        onRetry={() => undefined}
      />,
    );
    expect(setupHtml).toContain("Open Initial Setup");
    expect(transportHtml).not.toContain("Open Initial Setup");
    expect(transportHtml).toContain(">Retry<");
  });
});

describe("pool card preview", () => {
  it("loads a real page before delivering the generated artifact", () => {
    const postMessage = vi.fn();
    const preview = { postMessage } as unknown as Window;
    const open = vi.fn().mockReturnValue(preview);
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();

    expect(
      openPoolCardPreview("<main>pool</main>", open, "https://sidekick.example", {
        addEventListener,
        removeEventListener,
      }),
    ).toBe(true);

    const onMessage = addEventListener.mock.calls[0]?.[1] as (event: MessageEvent) => void;
    expect(open).toHaveBeenCalledWith("/pool-card-preview.html", "_blank");
    onMessage({
      origin: "https://sidekick.example",
      source: preview,
      data: { type: "sidekick-pool-card-preview-ready" },
    } as MessageEvent);
    expect(postMessage).toHaveBeenCalledWith(
      { type: "sidekick-pool-card-preview", body: "<main>pool</main>" },
      "https://sidekick.example",
    );
    expect(removeEventListener).toHaveBeenCalledWith("message", onMessage);
  });

  it("reports a blocked pop-up instead of failing silently", () => {
    expect(
      openPoolCardPreview("<main>pool</main>", () => null, "https://sidekick.example", {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    ).toBe(false);
  });
});
