import { cvToHex, noneCV, someCV, tupleCV, uintCV } from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import {
  RateLimitedError,
  StacksApiClient,
  StacksNodeClient,
  UpstreamHttpError,
  UpstreamSchemaError,
} from "./chain-clients.js";

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

  it("reads canonical smart-contract logs with a durable event cursor", async () => {
    const manager = "SP000000000000000000002Q6VF78.signer-manager";
    const txId = `0x${"11".repeat(32)}`;
    const cursor = "8600000:2147483647:3:1";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          limit: 100,
          offset: 0,
          total: 1,
          next_cursor: null,
          prev_cursor: null,
          cursor,
          results: [
            {
              event_index: 1,
              event_type: "smart_contract_log",
              tx_id: txId,
              contract_log: {
                contract_id: manager,
                topic: "print",
                value: { hex: "0x03", repr: "true" },
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);

    await expect(client.getSmartContractLogs(manager, cursor)).resolves.toMatchObject({
      cursor,
      results: [{ tx_id: txId }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.example.test/extended/v2/smart-contracts/${manager}/logs?limit=100&offset=0&cursor=${encodeURIComponent(cursor)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("enriches log evidence with v3 transaction block identity", async () => {
    const txId = `0x${"11".repeat(32)}`;
    const blockHash = `0x${"22".repeat(32)}`;
    const indexHash = `0x${"33".repeat(32)}`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          tx_id: txId,
          status: "success",
          block: {
            height: 8_600_000,
            hash: blockHash,
            index_hash: indexHash,
            time: 1_784_000_000,
            tx_index: 3,
          },
          bitcoin_block: { height: 960_240, time: 1_784_000_000 },
          type: "contract_call",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);

    await expect(client.getTransaction(txId)).resolves.toMatchObject({
      tx_id: txId,
      block: { height: 8_600_000, hash: blockHash, index_hash: indexHash },
      bitcoin_block: { height: 960_240 },
    });
  });

  it("normalizes API transaction and block hashes before storage", async () => {
    const upperTxId = `0x${"AB".repeat(32)}`;
    const upperBlockHash = `0x${"CD".repeat(32)}`;
    const upperIndexHash = `0x${"EF".repeat(32)}`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          tx_id: upperTxId,
          status: "success",
          block: {
            height: 8_600_000,
            hash: upperBlockHash,
            index_hash: upperIndexHash,
            time: 1_784_000_000,
            tx_index: 3,
          },
          bitcoin_block: { height: 960_240, time: 1_784_000_000 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);

    await expect(client.getTransaction(upperTxId)).resolves.toMatchObject({
      tx_id: upperTxId.toLowerCase(),
      block: {
        hash: upperBlockHash.toLowerCase(),
        index_hash: upperIndexHash.toLowerCase(),
      },
    });
  });

  it("honors Retry-After and retries a rate-limited request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            network_id: 1,
            burn_block_height: 958_074,
            stacks_tip_height: 8_550_394,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);

    await expect(client.getNodeInfo()).resolves.toMatchObject({ network_id: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("classifies exhausted rate limits and non-retryable HTTP failures", async () => {
    const limitedFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(null, { status: 429, headers: { "retry-after": "0" } }),
      );
    const missingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        limitedFetch,
      ).getNodeInfo(),
    ).rejects.toBeInstanceOf(RateLimitedError);
    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        missingFetch,
      ).getNodeInfo(),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
  });

  it("cancels rejected response bodies before returning the typed error", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 404 }));

    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        fetchImpl,
      ).getNodeInfo(),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("classifies an incompatible upstream response without leaking its body", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ private_detail: "must-not-leak" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const error = await new StacksApiClient(
      "https://api.example.test",
      undefined,
      undefined,
      fetchImpl,
    )
      .getNodeInfo()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpstreamSchemaError);
    expect(String(error)).not.toContain("must-not-leak");
  });
});

describe("Stacks node client", () => {
  it("rejects unsafe uSTX quantities at the PoX JSON boundary", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          current_burnchain_block_height: 960_240,
          reward_cycle_id: 141,
          reward_cycle_length: 2_100,
          prepare_cycle_length: 100,
          contract_id: "SP000000000000000000002Q6VF78.pox-5",
          current_cycle: {
            id: 141,
            min_threshold_ustx: Number.MAX_SAFE_INTEGER + 1,
            stacked_ustx: 0,
            is_pox_active: true,
          },
          contract_versions: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new StacksNodeClient("http://127.0.0.1:20443", fetchImpl);

    await expect(client.getPoxInfo()).rejects.toBeInstanceOf(UpstreamSchemaError);
  });

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

  it("reads a data variable and an optional map entry without a MARF proof", async () => {
    const feeKey = cvToHex(tupleCV({ "reward-cycle": uintCV(141n), "bond-index": noneCV() }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: cvToHex(uintCV(500n)) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: cvToHex(someCV(uintCV(0n))) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = new StacksNodeClient("http://127.0.0.1:20443", fetchImpl);
    const manager = "SP000000000000000000002Q6VF78.signer-manager";

    await expect(client.getDataVar(manager, "fees-bips")).resolves.toEqual(uintCV(500n));
    await expect(client.getMapEntry(manager, "fee-bips-for-cycle", feeKey)).resolves.toEqual(
      someCV(uintCV(0n)),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:20443/v2/data_var/SP000000000000000000002Q6VF78/signer-manager/fees-bips?proof=0",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:20443/v2/map_entry/SP000000000000000000002Q6VF78/signer-manager/fee-bips-for-cycle?proof=0",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(feeKey),
      }),
    );
  });
});
