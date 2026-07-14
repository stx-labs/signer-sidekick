import { describe, expect, it, vi } from "vitest";
import { StacksApiClient } from "./chain-clients.js";

describe("Stacks API client", () => {
  it("sends a configured API key without putting it in the URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          network_id: 1,
          burn_block_height: 958_074,
          stacks_tip_height: 8_550_394,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new StacksApiClient(
      "https://api.example.test",
      "top-secret",
      "x-api-key",
      fetchImpl,
    );

    await client.getNodeInfo();

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/v2/info",
      expect.objectContaining({ headers: { "x-api-key": "top-secret" } }),
    );
    expect(fetchImpl.mock.calls[0]?.[0]).not.toContain("top-secret");
  });
});
