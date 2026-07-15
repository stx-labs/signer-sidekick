import { cvToHex, uintCV } from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import { StacksApiClient, StacksNodeClient } from "./chain-clients.js";

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

  it("reads the API v9 signer-stakers cursor contract without repr parsing", async () => {
    const signer = "SP000000000000000000002Q6VF78.signer-manager";
    const cursor = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          total: 2,
          limit: 1,
          cursor: { next: cursor, previous: null, current: null },
          results: [{ staker: "SP000000000000000000002Q6VF78", types: ["stx"] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);

    await expect(client.getSignerStakers(signer, cursor, 1)).resolves.toMatchObject({
      total: 2,
      results: [{ types: ["stx"] }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.example.test/extended/v3/staking/signers/${signer}/stakers?limit=1&cursor=${cursor}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects signer-staker cursors before making an API request", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);

    expect(() =>
      client.getSignerStakers("SP000000000000000000002Q6VF78.signer-manager", "not-a-principal"),
    ).toThrow("Invalid staker cursor");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Stacks node client", () => {
  it("fetches deployed source without a MARF proof using a validated principal", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ source: "(ok true)", publish_height: 123 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new StacksNodeClient("http://127.0.0.1:20443", fetchImpl);

    await expect(
      client.getContractSource("SP000000000000000000002Q6VF78.signer-manager"),
    ).resolves.toEqual({ source: "(ok true)", publish_height: 123 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:20443/v2/contracts/source/SP000000000000000000002Q6VF78/signer-manager?proof=0",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects an invalid contract principal before making a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new StacksNodeClient("http://127.0.0.1:20443", fetchImpl);

    await expect(client.getContractInterface("not-a-principal")).rejects.toThrow(
      "Expected a contract principal",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls a read-only function with structured Clarity arguments", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ okay: true, result: cvToHex(uintCV(141n)) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new StacksNodeClient("http://127.0.0.1:20443", fetchImpl);

    await expect(
      client.callReadOnly(
        "SP000000000000000000002Q6VF78.pox-5",
        "reward-cycle-to-burn-height",
        "SP000000000000000000002Q6VF78",
        [cvToHex(uintCV(141n))],
      ),
    ).resolves.toEqual(uintCV(141n));
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:20443/v2/contracts/call-read/SP000000000000000000002Q6VF78/pox-5/reward-cycle-to-burn-height",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sender: "SP000000000000000000002Q6VF78",
          arguments: [cvToHex(uintCV(141n))],
        }),
      }),
    );
  });
});
