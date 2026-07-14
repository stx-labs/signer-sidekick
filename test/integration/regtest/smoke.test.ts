import { describe, expect, it } from "vitest";

const enabled = process.env.RUN_REGTEST === "1";
const suite = enabled ? describe : describe.skip;

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

suite("Epoch 4.0 external regtest/devnet", () => {
  const nodeUrl = process.env.STACKS_NODE_RPC ?? "http://127.0.0.1:20443";
  const apiUrl = process.env.STACKS_API_URL ?? "http://127.0.0.1:3999";

  it("exposes node identity and PoX state", async () => {
    const [info, pox] = await Promise.all([
      getJson(`${nodeUrl}/v2/info`),
      getJson(`${nodeUrl}/v2/pox`),
    ]);

    expect(info).toHaveProperty("network_id");
    expect(info).toHaveProperty("burn_block_height");
    expect(pox).toHaveProperty("reward_cycle_id");
  });

  it("exposes an indexed API tip", async () => {
    const status = await getJson(`${apiUrl}/extended/v1/status`);
    expect(status).toHaveProperty("server_version");
  });
});
