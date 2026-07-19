import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../api-client.js";
import { PoolCardError, poolCardSetupRequired } from "./enrollment-page.js";

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
