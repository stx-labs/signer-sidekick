import { cvToHex, noneCV, someCV, tupleCV, uintCV } from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import {
  ChainAnchorError,
  captureChainAnchor,
  createChainAnchor,
  StacksApiClient,
  StacksNodeClient,
  UpstreamHttpError,
  UpstreamSchemaError,
  UpstreamUnavailableError,
} from "./chain-clients.js";

const indexBlockHash = `0x${"ab".repeat(32)}`;

describe("Stacks API client", () => {
  it("reads recent burn-block timestamps for empirical timing estimates", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          limit: 30,
          offset: 0,
          total: 2,
          results: [
            { burn_block_height: 910_000, burn_block_time: 1_784_000_000 },
            { burn_block_height: 909_999, burn_block_time: 1_783_999_400 },
          ],
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

    await expect(client.getBurnBlocks()).resolves.toMatchObject({
      results: [{ burn_block_height: 910_000 }, { burn_block_height: 909_999 }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/extended/v2/burn-blocks?limit=30&offset=0",
      expect.objectContaining({ headers: { "x-api-key": "top-secret" } }),
    );
  });

  it("paginates within the API v9 burn-block page cap", async () => {
    const blocks = Array.from({ length: 70 }, (_, index) => ({
      burn_block_height: 910_000 - index,
      burn_block_time: 1_784_000_000 - index * 600,
    }));
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      return new Response(
        JSON.stringify({
          limit,
          offset,
          total: blocks.length,
          results: blocks.slice(offset, offset + limit),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);

    await expect(client.getBurnBlocks(70)).resolves.toMatchObject({
      limit: 70,
      total: 70,
      results: blocks,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "https://api.example.test/extended/v2/burn-blocks?limit=10&offset=60",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

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
          cursor: {
            next: null,
            previous: "SP000000000000000000002Q6VF78",
            current: cursor,
          },
          results: [{ staker: cursor, types: ["stx"] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);

    await expect(client.getSignerStakers(signer, cursor, 1)).resolves.toMatchObject({
      total: 2,
      cursor: { current: cursor },
      results: [{ staker: cursor, types: ["stx"] }],
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
          prev_cursor: "8599999:2147483647:3:1",
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
      prev_cursor: "8599999:2147483647:3:1",
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

  it("reads public transaction details for the node-index fallback", async () => {
    const txId = `0x${"ab".repeat(32)}`;
    const blockHash = `0x${"cd".repeat(32)}`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          tx_id: txId.toUpperCase().replace("0X", "0x"),
          tx_status: "success",
          sender_address: "SP000000000000000000002Q6VF78",
          tx_type: "contract_call",
          contract_call: {
            contract_id: "SP000000000000000000002Q6VF78.pox-5",
            function_name: "delegate-stx",
            function_args: [{ hex: "0x01000000000000000000000000000001f4", repr: "u500" }],
          },
          post_conditions: [],
          sponsored: false,
          anchor_mode: "any",
          post_condition_mode: "deny",
          canonical: true,
          block_hash: blockHash.toUpperCase().replace("0X", "0x"),
          block_height: 8_600_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);

    await expect(client.getTransactionDetails(txId)).resolves.toMatchObject({
      tx_id: txId,
      sender_address: "SP000000000000000000002Q6VF78",
      contract_call: {
        contract_id: "SP000000000000000000002Q6VF78.pox-5",
        function_args: [{ hex: "0x01000000000000000000000000000001f4" }],
      },
      block_hash: blockHash,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.example.test/extended/v1/tx/${txId}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("reads a bounded canonical block projection by height", async () => {
    const blockHash = `0x${"12".repeat(32)}`;
    const indexHash = `0x${"34".repeat(32)}`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          canonical: true,
          height: 8_600_000,
          hash: blockHash.toUpperCase().replace("0X", "0x"),
          index_block_hash: indexHash,
          parent_block_hash: `0x${"56".repeat(32)}`,
          parent_index_block_hash: `0x${"78".repeat(32)}`,
          burn_block_height: 960_240,
          transactions: ["must-not-enter-the-trusted-projection"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);

    await expect(client.getBlock(8_600_000)).resolves.toEqual({
      canonical: true,
      height: 8_600_000,
      hash: blockHash,
      index_block_hash: indexHash,
      parent_block_hash: `0x${"56".repeat(32)}`,
      parent_index_block_hash: `0x${"78".repeat(32)}`,
      burn_block_height: 960_240,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/extended/v2/blocks/8600000",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("enumerates same and higher origin nonces without treating unrelated rows as ownership", async () => {
    const principal = "SP000000000000000000002Q6VF78";
    const other = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";
    const sameTxid = `0x${"11".repeat(32)}`;
    const recipientTxid = `0x${"22".repeat(32)}`;
    const higherTxid = `0x${"33".repeat(32)}`;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            total: 3,
            limit: 50,
            cursor: { next: null, previous: null, current: `3000:${higherTxid}` },
            results: [
              {
                tx_id: higherTxid,
                sender: { address: principal, nonce: 9 },
                sponsor: null,
                status: "pending",
                type: "contract_call",
              },
              {
                // Global coverage includes unrelated rows. They count toward completeness without
                // being reported as activity for the requested gas principal.
                tx_id: recipientTxid,
                sender: { address: other, nonce: 18 },
                sponsor: null,
                status: "pending",
                type: "token_transfer",
              },
              {
                tx_id: sameTxid,
                sender: { address: principal, nonce: 7 },
                sponsor: { address: other, nonce: 4 },
                status: "pending",
                type: "contract_call",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);

    await expect(client.enumerateGasPayerMempoolActivity(principal)).resolves.toEqual({
      status: "complete",
      principal,
      pagesRead: 2,
      observedTransactionCount: 3,
      reportedTotal: 3,
      nonceActivities: [
        {
          txid: higherTxid,
          principal,
          nonce: 9n,
          role: "origin",
          state: "mempool",
          origin: { principal, nonce: 9n },
          sponsor: null,
        },
        {
          txid: sameTxid,
          principal,
          nonce: 7n,
          role: "origin",
          state: "mempool",
          origin: { principal, nonce: 7n },
          sponsor: { principal: other, nonce: 4n },
        },
      ],
    });
  });

  it("follows every global mempool cursor in both stable scans", async () => {
    const principal = "SP000000000000000000002Q6VF78";
    const firstTxid = `0x${"44".repeat(32)}`;
    const secondTxid = `0x${"55".repeat(32)}`;
    const secondCursor = `2000:${secondTxid}`;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const secondPage = String(input).includes("cursor=");
      return secondPage
        ? new Response(
            JSON.stringify({
              total: 2,
              limit: 1,
              cursor: { next: null, previous: `3000:${firstTxid}`, current: secondCursor },
              results: [
                {
                  tx_id: secondTxid,
                  sender: { address: principal, nonce: 8 },
                  sponsor: null,
                  status: "pending",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response(
            JSON.stringify({
              total: 2,
              limit: 1,
              cursor: { next: secondCursor, previous: null, current: `3000:${firstTxid}` },
              results: [
                {
                  tx_id: firstTxid,
                  sender: { address: principal, nonce: 7 },
                  sponsor: null,
                  status: "pending",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
    });
    const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);

    await expect(
      client.enumerateGasPayerMempoolActivity(principal, { pageSize: 1 }),
    ).resolves.toMatchObject({
      status: "complete",
      pagesRead: 4,
      observedTransactionCount: 2,
      reportedTotal: 2,
      nonceActivities: [{ nonce: 7n }, { nonce: 8n }],
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/extended/v3/mempool/transactions?limit=1",
      `https://api.example.test/extended/v3/mempool/transactions?limit=1&cursor=${encodeURIComponent(secondCursor)}`,
      "https://api.example.test/extended/v3/mempool/transactions?limit=1",
      `https://api.example.test/extended/v3/mempool/transactions?limit=1&cursor=${encodeURIComponent(secondCursor)}`,
    ]);
  });

  it("reports global pagination and transaction caps instead of silently truncating", async () => {
    const principal = "SP000000000000000000002Q6VF78";
    const txid = `0x${"66".repeat(32)}`;
    const nextCursor = `1000:${`0x${"77".repeat(32)}`}`;
    const page = {
      total: 51,
      limit: 1,
      cursor: { next: nextCursor, previous: null, current: `2000:${txid}` },
      results: [
        {
          tx_id: txid,
          sender: { address: principal, nonce: 7 },
          sponsor: null,
          status: "pending",
        },
      ],
    };
    const cappedByPages = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ...page, total: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const cappedByTransactions = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(page), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        cappedByPages,
      ).enumerateGasPayerMempoolActivity(principal, { pageSize: 1, maxPages: 1 }),
    ).resolves.toMatchObject({
      status: "incomplete",
      reason: "page-limit",
      pagesRead: 1,
      observedTransactionCount: 1,
      reportedTotal: 2,
    });
    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        cappedByTransactions,
      ).enumerateGasPayerMempoolActivity(principal, {
        pageSize: 1,
        maxTransactions: 50,
      }),
    ).resolves.toMatchObject({
      status: "incomplete",
      reason: "transaction-limit",
      pagesRead: 1,
      observedTransactionCount: 1,
      reportedTotal: 51,
    });
    expect(cappedByPages).toHaveBeenCalledOnce();
    expect(cappedByTransactions).toHaveBeenCalledOnce();
  });

  it("fails closed on unavailable and incompatible global mempool responses", async () => {
    const principal = "SP000000000000000000002Q6VF78";
    const unavailable = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503, headers: { "retry-after": "0" } }));
    const incompatible = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ total: 0, private_detail: "must-not-leak" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        unavailable,
      ).enumerateGasPayerMempoolActivity(principal),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    const schemaError = await new StacksApiClient(
      "https://api.example.test",
      undefined,
      undefined,
      incompatible,
    )
      .enumerateGasPayerMempoolActivity(principal)
      .catch((error: unknown) => error);
    expect(schemaError).toBeInstanceOf(UpstreamSchemaError);
    expect(String(schemaError)).not.toContain("private_detail");
    expect(unavailable).toHaveBeenCalledTimes(4);
  });

  it("reports an unsponsored origin nonce from complete global mempool coverage", async () => {
    const principal = "SP000000000000000000002Q6VF78";
    const txid = `0x${"81".repeat(32)}`;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: `2000:${txid}` },
            results: [
              {
                tx_id: txid,
                sender: { address: principal, nonce: 7 },
                sponsor: null,
                status: "pending",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        fetchImpl,
      ).enumerateGasPayerMempoolActivity(principal),
    ).resolves.toEqual({
      status: "complete",
      principal,
      pagesRead: 2,
      observedTransactionCount: 1,
      reportedTotal: 1,
      nonceActivities: [
        {
          txid,
          principal,
          nonce: 7n,
          role: "origin",
          state: "mempool",
          origin: { principal, nonce: 7n },
          sponsor: null,
        },
      ],
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/extended/v3/mempool/transactions?limit=50",
      "https://api.example.test/extended/v3/mempool/transactions?limit=50",
    ]);
  });

  it("finds sponsor-only nonce activity that the principal-scoped route omits", async () => {
    const principal = "SP000000000000000000002Q6VF78";
    const origin = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";
    const txid = `0x${"82".repeat(32)}`;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: `2000:${txid}` },
            results: [
              {
                tx_id: txid,
                sender: { address: origin, nonce: 31 },
                sponsor: { address: principal, nonce: 8 },
                status: "pending",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        fetchImpl,
      ).enumerateGasPayerMempoolActivity(principal),
    ).resolves.toMatchObject({
      status: "complete",
      nonceActivities: [
        {
          txid,
          principal,
          nonce: 8n,
          role: "sponsor",
          state: "mempool",
          origin: { principal: origin, nonce: 31n },
          sponsor: { principal, nonce: 8n },
        },
      ],
    });
  });

  it("fails global coverage closed at either the page or transaction bound", async () => {
    const principal = "SP000000000000000000002Q6VF78";
    const txid = `0x${"83".repeat(32)}`;
    const nextCursor = `1000:${`0x${"84".repeat(32)}`}`;
    const firstPage = {
      total: 2,
      limit: 1,
      cursor: { next: nextCursor, previous: null, current: `2000:${txid}` },
      results: [
        {
          tx_id: txid,
          sender: { address: principal, nonce: 7 },
          sponsor: null,
          status: "pending",
        },
      ],
    };
    const pageBound = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(firstPage), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const transactionBound = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(firstPage), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        pageBound,
      ).enumerateGasPayerMempoolActivity(principal, { pageSize: 1, maxPages: 1 }),
    ).resolves.toMatchObject({
      status: "incomplete",
      reason: "page-limit",
      observedTransactionCount: 1,
      reportedTotal: 2,
    });
    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        transactionBound,
      ).enumerateGasPayerMempoolActivity(principal, {
        pageSize: 1,
        maxTransactions: 1,
      }),
    ).resolves.toMatchObject({
      status: "incomplete",
      reason: "transaction-limit",
      observedTransactionCount: 1,
      reportedTotal: 2,
    });
    expect(pageBound).toHaveBeenCalledOnce();
    expect(transactionBound).toHaveBeenCalledOnce();
  });

  it("rejects duplicate rows and total drift across global mempool pages", async () => {
    const principal = "SP000000000000000000002Q6VF78";
    const firstTxid = `0x${"85".repeat(32)}`;
    const secondTxid = `0x${"86".repeat(32)}`;
    const nextCursor = `1000:${secondTxid}`;
    const page = (txid: string, total: number, next: string | null, current: string) => ({
      total,
      limit: 1,
      cursor: { next, previous: null, current },
      results: [
        {
          tx_id: txid,
          sender: { address: principal, nonce: 7 },
          sponsor: null,
          status: "pending",
        },
      ],
    });
    const duplicate = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page(firstTxid, 2, nextCursor, `2000:${firstTxid}`)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page(firstTxid, 2, null, nextCursor)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const drift = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page(firstTxid, 2, nextCursor, `2000:${firstTxid}`)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page(secondTxid, 3, null, nextCursor)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        duplicate,
      ).enumerateGasPayerMempoolActivity(principal, { pageSize: 1 }),
    ).resolves.toMatchObject({ status: "incomplete", reason: "duplicate-transaction" });
    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        drift,
      ).enumerateGasPayerMempoolActivity(principal, { pageSize: 1 }),
    ).resolves.toMatchObject({ status: "incomplete", reason: "total-changed" });
  });

  it("rejects a same-total mempool swap between consecutive complete scans", async () => {
    const principal = "SP000000000000000000002Q6VF78";
    const firstTxid = `0x${"87".repeat(32)}`;
    const secondTxid = `0x${"88".repeat(32)}`;
    const response = (txid: string, nonce: number) =>
      new Response(
        JSON.stringify({
          total: 1,
          limit: 50,
          cursor: { next: null, previous: null, current: `2000:${txid}` },
          results: [
            {
              tx_id: txid,
              sender: { address: principal, nonce },
              sponsor: null,
              status: "pending",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(firstTxid, 7))
      .mockResolvedValueOnce(response(secondTxid, 8));

    await expect(
      new StacksApiClient(
        "https://api.example.test",
        undefined,
        undefined,
        fetchImpl,
      ).enumerateGasPayerMempoolActivity(principal),
    ).resolves.toMatchObject({
      status: "incomplete",
      reason: "snapshot-changed",
      observedTransactionCount: 1,
      reportedTotal: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries one short explicit rate limit", async () => {
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
    ).rejects.toMatchObject({
      name: "RateLimitedError",
      endpoint: "https://api.example.test/v2/info",
    });
    expect(limitedFetch).toHaveBeenCalledTimes(2);
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
  it("pins every actionable node read to one exact index block", async () => {
    const manager = "SP000000000000000000002Q6VF78.signer-manager";
    const feeKey = cvToHex(tupleCV({ "reward-cycle": uintCV(141n), "bond-index": noneCV() }));
    const pox = {
      current_burnchain_block_height: 960_240,
      reward_cycle_id: 141,
      reward_cycle_length: 2_100,
      prepare_cycle_length: 100,
      contract_id: "SP000000000000000000002Q6VF78.pox-5",
      contract_versions: [],
    };
    const responses = [
      pox,
      { source: "(define-public (ping) (ok true))", publish_height: 8_600_000 },
      { functions: [] },
      { okay: true, result: cvToHex(uintCV(141n)) },
      { data: cvToHex(uintCV(500n)) },
      { data: cvToHex(someCV(uintCV(0n))) },
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new StacksNodeClient("http://127.0.0.1:20443", fetchImpl);
    const readOptions = { tip: indexBlockHash };

    await client.getPoxInfo(readOptions);
    await client.getContractSource(manager, readOptions);
    await client.getContractInterface(manager, readOptions);
    await client.callReadOnly(
      "SP000000000000000000002Q6VF78.pox-5",
      "reward-cycle-to-burn-height",
      "SP000000000000000000002Q6VF78",
      [cvToHex(uintCV(141n))],
      readOptions,
    );
    await client.getDataVar(manager, "fees-bips", readOptions);
    await client.getMapEntry(manager, "fee-bips-for-cycle", feeKey, readOptions);

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `http://127.0.0.1:20443/v2/pox?tip=${indexBlockHash.slice(2)}`,
      `http://127.0.0.1:20443/v2/contracts/source/SP000000000000000000002Q6VF78/signer-manager?proof=0&tip=${indexBlockHash.slice(2)}`,
      `http://127.0.0.1:20443/v2/contracts/interface/SP000000000000000000002Q6VF78/signer-manager?tip=${indexBlockHash.slice(2)}`,
      `http://127.0.0.1:20443/v2/contracts/call-read/SP000000000000000000002Q6VF78/pox-5/reward-cycle-to-burn-height?tip=${indexBlockHash.slice(2)}`,
      `http://127.0.0.1:20443/v2/data_var/SP000000000000000000002Q6VF78/signer-manager/fees-bips?proof=0&tip=${indexBlockHash.slice(2)}`,
      `http://127.0.0.1:20443/v2/map_entry/SP000000000000000000002Q6VF78/signer-manager/fee-bips-for-cycle?proof=0&tip=${indexBlockHash.slice(2)}`,
    ]);
  });

  it("rejects an invalid tip before issuing a node request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new StacksNodeClient("http://127.0.0.1:20443", fetchImpl);

    expect(() => client.getPoxInfo({ tip: "0x12" })).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {
      rewardCycleLength: 2_100,
      prepareCycleLength: 100,
      burnBlockHeight: 960_240,
      nextCycleStart: 961_000,
      phase: "reward",
      checkpoint: "second-half",
    },
    {
      rewardCycleLength: 1_050,
      prepareCycleLength: 50,
      burnBlockHeight: 960_990,
      nextCycleStart: 961_000,
      phase: "prepare",
      checkpoint: "second-half",
    },
  ])("derives a typed anchor from runtime PoX boundaries ($rewardCycleLength blocks)", ({
    rewardCycleLength,
    prepareCycleLength,
    burnBlockHeight,
    nextCycleStart,
    phase,
    checkpoint,
  }) => {
    expect(
      createChainAnchor(
        {
          network_id: 1,
          burn_block_height: burnBlockHeight,
          stacks_tip_height: 8_600_000,
        },
        {
          server_version: "stacks-blockchain-api v9",
          status: "ready",
          chain_tip: {
            block_height: 8_600_000,
            block_hash: `0x${"cd".repeat(32)}`,
            index_block_hash: indexBlockHash,
            burn_block_height: burnBlockHeight,
          },
        },
        {
          current_burnchain_block_height: burnBlockHeight,
          reward_cycle_id: 141,
          reward_cycle_length: rewardCycleLength,
          prepare_cycle_length: prepareCycleLength,
          contract_id: "SP000000000000000000002Q6VF78.pox-5",
          contract_versions: [],
          next_cycle: {
            id: 142,
            min_threshold_ustx: 1,
            min_increment_ustx: 1,
            stacked_ustx: 1,
            prepare_phase_start_block_height: nextCycleStart - prepareCycleLength,
            blocks_until_prepare_phase: nextCycleStart - prepareCycleLength - burnBlockHeight,
            reward_phase_start_block_height: nextCycleStart,
            blocks_until_reward_phase: nextCycleStart - burnBlockHeight,
          },
        },
      ),
    ).toMatchObject({
      rewardCycleLength,
      prepareCycleLength,
      burnBlockHeight,
      phase,
      checkpoint,
      indexBlockHash,
    });
  });

  it("accepts a node that learned one newer Bitcoin tip than the shared API anchor", () => {
    expect(
      createChainAnchor(
        {
          network_id: 1,
          burn_block_height: 960_263,
          stacks_tip_height: 8_667_384,
        },
        {
          server_version: "stacks-blockchain-api v9",
          status: "ready",
          chain_tip: {
            block_height: 8_667_384,
            block_hash: `0x${"cd".repeat(32)}`,
            index_block_hash: indexBlockHash,
            burn_block_height: 960_262,
          },
        },
        {
          current_burnchain_block_height: 960_263,
          reward_cycle_id: 141,
          reward_cycle_length: 2_100,
          prepare_cycle_length: 100,
          contract_id: "SP000000000000000000002Q6VF78.pox-5",
          contract_versions: [],
          next_cycle: {
            id: 142,
            min_threshold_ustx: 1,
            min_increment_ustx: 1,
            stacked_ustx: 1,
            prepare_phase_start_block_height: 961_000,
            blocks_until_prepare_phase: 738,
            reward_phase_start_block_height: 961_100,
            blocks_until_reward_phase: 838,
          },
        },
      ),
    ).toMatchObject({
      stacksBlockHeight: 8_667_384,
      burnBlockHeight: 960_262,
      indexBlockHash,
    });
  });

  it("rejects an API anchor that trails the node by more than one Bitcoin block", () => {
    expect(() =>
      createChainAnchor(
        {
          network_id: 1,
          burn_block_height: 960_264,
          stacks_tip_height: 8_667_384,
        },
        {
          server_version: "stacks-blockchain-api v9",
          status: "ready",
          chain_tip: {
            block_height: 8_667_384,
            block_hash: `0x${"cd".repeat(32)}`,
            index_block_hash: indexBlockHash,
            burn_block_height: 960_262,
          },
        },
        {
          current_burnchain_block_height: 960_264,
          reward_cycle_id: 141,
          reward_cycle_length: 2_100,
          prepare_cycle_length: 100,
          contract_id: "SP000000000000000000002Q6VF78.pox-5",
          contract_versions: [],
          next_cycle: {
            id: 142,
            min_threshold_ustx: 1,
            min_increment_ustx: 1,
            stacked_ustx: 1,
            prepare_phase_start_block_height: 961_000,
            blocks_until_prepare_phase: 736,
            reward_phase_start_block_height: 961_100,
            blocks_until_reward_phase: 836,
          },
        },
      ),
    ).toThrow(ChainAnchorError);
  });

  it("derives prior-cycle anchor facts when the one-block lead crosses a reward-cycle boundary", () => {
    expect(
      createChainAnchor(
        {
          network_id: 1,
          burn_block_height: 961_100,
          stacks_tip_height: 8_667_384,
        },
        {
          server_version: "stacks-blockchain-api v9",
          status: "ready",
          chain_tip: {
            block_height: 8_667_384,
            block_hash: `0x${"cd".repeat(32)}`,
            index_block_hash: indexBlockHash,
            burn_block_height: 961_099,
          },
        },
        {
          current_burnchain_block_height: 961_100,
          reward_cycle_id: 142,
          reward_cycle_length: 2_100,
          prepare_cycle_length: 100,
          contract_id: "SP000000000000000000002Q6VF78.pox-5",
          contract_versions: [],
          next_cycle: {
            id: 143,
            min_threshold_ustx: 1,
            min_increment_ustx: 1,
            stacked_ustx: 1,
            prepare_phase_start_block_height: 963_100,
            blocks_until_prepare_phase: 2_000,
            reward_phase_start_block_height: 963_200,
            blocks_until_reward_phase: 2_100,
          },
        },
      ),
    ).toMatchObject({ rewardCycle: 141, cyclePosition: 2_099, phase: "prepare" });
  });

  it("retains the exact source heights when a chain anchor is temporarily inconsistent", () => {
    let thrown: unknown;
    try {
      createChainAnchor(
        {
          network_id: 1,
          burn_block_height: 4_818,
          stacks_tip_height: 28_079,
        },
        {
          server_version: "stacks-blockchain-api v9",
          status: "ready",
          chain_tip: {
            block_height: 28_097,
            block_hash: `0x${"cd".repeat(32)}`,
            index_block_hash: indexBlockHash,
            burn_block_height: 4_819,
          },
        },
        {
          current_burnchain_block_height: 4_819,
          reward_cycle_id: 5,
          reward_cycle_length: 20,
          prepare_cycle_length: 5,
          contract_id: "ST000000000000000000002AMW42H.pox-5",
          contract_versions: [],
          next_cycle: {
            id: 6,
            min_threshold_ustx: 1,
            min_increment_ustx: 1,
            stacked_ustx: 1,
            prepare_phase_start_block_height: 4_830,
            blocks_until_prepare_phase: 11,
            reward_phase_start_block_height: 4_835,
            blocks_until_reward_phase: 16,
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: ChainAnchorError.name,
      retryable: true,
      tips: {
        node: { stacksTipHeight: 28_079, burnBlockHeight: 4_818 },
        api: { stacksTipHeight: 28_097, burnBlockHeight: 4_819 },
        poxBurnBlockHeight: 4_819,
      },
    });
  });

  it("retries and discards an anchor when the API tip keeps changing during capture", async () => {
    const firstStatus = {
      server_version: "stacks-blockchain-api v9",
      status: "ready",
      chain_tip: {
        block_height: 8_600_000,
        block_hash: `0x${"cd".repeat(32)}`,
        index_block_hash: indexBlockHash,
        burn_block_height: 960_240,
      },
    };
    const movedStatus = {
      ...firstStatus,
      chain_tip: {
        ...firstStatus.chain_tip,
        index_block_hash: `0x${"ef".repeat(32)}`,
      },
    };
    const api = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce(firstStatus)
        .mockResolvedValueOnce(movedStatus)
        .mockResolvedValueOnce(firstStatus)
        .mockResolvedValueOnce(movedStatus)
        .mockResolvedValueOnce(firstStatus)
        .mockResolvedValueOnce(movedStatus),
    } as unknown as StacksApiClient;
    const node = {
      getInfo: vi.fn().mockResolvedValue({
        network_id: 1,
        burn_block_height: 960_240,
        stacks_tip_height: 8_600_000,
      }),
      getPoxInfo: vi.fn().mockResolvedValue({
        current_burnchain_block_height: 960_240,
        reward_cycle_id: 141,
        reward_cycle_length: 2_100,
        prepare_cycle_length: 100,
        contract_id: "SP000000000000000000002Q6VF78.pox-5",
        contract_versions: [],
        next_cycle: {
          id: 142,
          min_threshold_ustx: 1,
          min_increment_ustx: 1,
          stacked_ustx: 1,
          prepare_phase_start_block_height: 960_200,
          blocks_until_prepare_phase: -40,
          reward_phase_start_block_height: 960_300,
          blocks_until_reward_phase: 60,
        },
      }),
    } as unknown as StacksNodeClient;

    await expect(captureChainAnchor(node, api)).rejects.toMatchObject({
      name: ChainAnchorError.name,
      retryable: true,
      tips: {
        node: { stacksTipHeight: 8_600_000, burnBlockHeight: 960_240 },
        api: { stacksTipHeight: 8_600_000, burnBlockHeight: 960_240 },
        poxBurnBlockHeight: 960_240,
      },
    });
    expect(node.getPoxInfo).toHaveBeenCalledWith({ tip: indexBlockHash });
    expect(api.getStatus).toHaveBeenCalledTimes(6);
  });

  it("uses a stable API anchor while the node is several Nakamoto blocks ahead", async () => {
    const apiStatus = {
      server_version: "stacks-blockchain-api v9",
      status: "ready",
      chain_tip: {
        block_height: 8_600_000,
        block_hash: `0x${"cd".repeat(32)}`,
        index_block_hash: indexBlockHash,
        burn_block_height: 960_240,
      },
    };
    const api = {
      getStatus: vi.fn().mockResolvedValue(apiStatus),
    } as unknown as StacksApiClient;
    const node = {
      getInfo: vi.fn().mockResolvedValue({
        network_id: 1,
        burn_block_height: 960_240,
        stacks_tip_height: 8_600_007,
        stacks_tip: `0x${"12".repeat(32)}`,
      }),
      getPoxInfo: vi.fn().mockResolvedValue({
        current_burnchain_block_height: 960_240,
        reward_cycle_id: 141,
        reward_cycle_length: 2_100,
        prepare_cycle_length: 100,
        contract_id: "SP000000000000000000002Q6VF78.pox-5",
        contract_versions: [],
        next_cycle: {
          id: 142,
          min_threshold_ustx: 1,
          min_increment_ustx: 1,
          stacked_ustx: 1,
          prepare_phase_start_block_height: 961_000,
          blocks_until_prepare_phase: 760,
          reward_phase_start_block_height: 961_100,
          blocks_until_reward_phase: 860,
        },
      }),
    } as unknown as StacksNodeClient;

    await expect(captureChainAnchor(node, api)).resolves.toMatchObject({
      stacksBlockHeight: 8_600_000,
      indexBlockHash,
      burnBlockHeight: 960_240,
    });
    expect(node.getPoxInfo).toHaveBeenCalledWith({ tip: indexBlockHash });
  });

  it("recaptures all sources after a one-time API tip move", async () => {
    const firstStatus = {
      server_version: "stacks-blockchain-api v9",
      status: "ready",
      chain_tip: {
        block_height: 8_600_000,
        block_hash: `0x${"cd".repeat(32)}`,
        index_block_hash: indexBlockHash,
        burn_block_height: 960_240,
      },
    };
    const stableStatus = {
      ...firstStatus,
      chain_tip: {
        ...firstStatus.chain_tip,
        block_height: 8_600_001,
        index_block_hash: `0x${"ef".repeat(32)}`,
      },
    };
    const api = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce(firstStatus)
        .mockResolvedValueOnce(stableStatus)
        .mockResolvedValue(stableStatus),
    } as unknown as StacksApiClient;
    const node = {
      getInfo: vi.fn().mockResolvedValue({
        network_id: 1,
        burn_block_height: 960_240,
        stacks_tip_height: 8_600_005,
      }),
      getPoxInfo: vi.fn().mockResolvedValue({
        current_burnchain_block_height: 960_240,
        reward_cycle_id: 141,
        reward_cycle_length: 2_100,
        prepare_cycle_length: 100,
        contract_id: "SP000000000000000000002Q6VF78.pox-5",
        contract_versions: [],
        next_cycle: {
          id: 142,
          min_threshold_ustx: 1,
          min_increment_ustx: 1,
          stacked_ustx: 1,
          prepare_phase_start_block_height: 961_000,
          blocks_until_prepare_phase: 760,
          reward_phase_start_block_height: 961_100,
          blocks_until_reward_phase: 860,
        },
      }),
    } as unknown as StacksNodeClient;

    await expect(captureChainAnchor(node, api)).resolves.toMatchObject({
      stacksBlockHeight: 8_600_001,
      indexBlockHash: stableStatus.chain_tip.index_block_hash,
    });
    expect(api.getStatus).toHaveBeenCalledTimes(4);
    expect(node.getInfo).toHaveBeenCalledTimes(2);
  });

  it("uses the node tip when the API is exactly one canonical Stacks block ahead", async () => {
    const nodeTipHash = `0x${"12".repeat(32)}`;
    const nodeTipIndexHash = `0x${"34".repeat(32)}`;
    const apiTip = {
      server_version: "stacks-blockchain-api v9",
      status: "ready",
      chain_tip: {
        block_height: 8_600_001,
        block_hash: `0x${"56".repeat(32)}`,
        index_block_hash: `0x${"78".repeat(32)}`,
        burn_block_height: 960_240,
      },
    };
    const api = {
      getStatus: vi.fn().mockResolvedValue(apiTip),
      getBlock: vi.fn().mockResolvedValue({
        canonical: true,
        height: 8_600_000,
        hash: nodeTipHash,
        index_block_hash: nodeTipIndexHash,
        parent_block_hash: `0x${"9a".repeat(32)}`,
        parent_index_block_hash: `0x${"bc".repeat(32)}`,
        burn_block_height: 960_240,
      }),
    } as unknown as StacksApiClient;
    const node = {
      getInfo: vi.fn().mockResolvedValue({
        network_id: 1,
        burn_block_height: 960_240,
        stacks_tip_height: 8_600_000,
        stacks_tip: nodeTipHash,
      }),
      getPoxInfo: vi.fn().mockResolvedValue({
        current_burnchain_block_height: 960_240,
        reward_cycle_id: 141,
        reward_cycle_length: 2_100,
        prepare_cycle_length: 100,
        contract_id: "SP000000000000000000002Q6VF78.pox-5",
        contract_versions: [],
        next_cycle: {
          id: 142,
          min_threshold_ustx: 1,
          min_increment_ustx: 1,
          stacked_ustx: 1,
          prepare_phase_start_block_height: 961_000,
          blocks_until_prepare_phase: 760,
          reward_phase_start_block_height: 961_100,
          blocks_until_reward_phase: 860,
        },
      }),
    } as unknown as StacksNodeClient;

    await expect(captureChainAnchor(node, api)).resolves.toMatchObject({
      stacksBlockHeight: 8_600_000,
      indexBlockHash: nodeTipIndexHash,
      burnBlockHeight: 960_240,
    });
    expect(api.getBlock).toHaveBeenCalledWith(nodeTipHash);
    expect(node.getPoxInfo).toHaveBeenCalledWith({ tip: nodeTipIndexHash });
  });

  it("rejects an unproven node tip when the API is one Stacks block ahead", async () => {
    const nodeTipHash = `0x${"12".repeat(32)}`;
    const api = {
      getStatus: vi.fn().mockResolvedValue({
        server_version: "stacks-blockchain-api v9",
        status: "ready",
        chain_tip: {
          block_height: 8_600_001,
          block_hash: `0x${"56".repeat(32)}`,
          index_block_hash: `0x${"78".repeat(32)}`,
          burn_block_height: 960_240,
        },
      }),
      getBlock: vi.fn().mockResolvedValue({
        canonical: false,
        height: 8_600_000,
        hash: nodeTipHash,
        index_block_hash: `0x${"34".repeat(32)}`,
        parent_block_hash: `0x${"9a".repeat(32)}`,
        parent_index_block_hash: `0x${"bc".repeat(32)}`,
        burn_block_height: 960_240,
      }),
    } as unknown as StacksApiClient;
    const node = {
      getInfo: vi.fn().mockResolvedValue({
        network_id: 1,
        burn_block_height: 960_240,
        stacks_tip_height: 8_600_000,
        stacks_tip: nodeTipHash,
      }),
      getPoxInfo: vi.fn(),
    } as unknown as StacksNodeClient;

    await expect(captureChainAnchor(node, api)).rejects.toMatchObject({
      name: ChainAnchorError.name,
      message: "API could not prove the node tip is canonical",
      retryable: true,
    });
    expect(node.getPoxInfo).not.toHaveBeenCalled();
  });

  it("retains node build evidence and PoX-5 sBTC contract capabilities", async () => {
    const responses = [
      {
        server_version: "stacks-node 9.9.9.0.0 (abcdef0, release build, linux [x86_64])",
        network_id: 256,
        parent_network_id: 3_669_344_250,
        burn_block_height: 202,
        stacks_tip_height: 500,
        stacks_tip: "AB".repeat(32),
      },
      {
        current_burnchain_block_height: 202,
        reward_cycle_id: 11,
        reward_cycle_length: 20,
        prepare_cycle_length: 5,
        contract_id: "ST000000000000000000002AMW42H.pox-5",
        pox_5_sbtc_contract: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token",
        pox_5_sbtc_registry_contract: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-registry",
        contract_versions: [],
      },
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new StacksNodeClient("http://127.0.0.1:20443", fetchImpl);

    await expect(client.getInfo()).resolves.toMatchObject({
      server_version: expect.stringContaining("9.9.9"),
      network_id: 256,
      parent_network_id: 3_669_344_250,
      stacks_tip: `0x${"ab".repeat(32)}`,
    });
    await expect(client.getPoxInfo()).resolves.toMatchObject({
      pox_5_sbtc_contract: expect.stringContaining(".sbtc-token"),
      pox_5_sbtc_registry_contract: expect.stringContaining(".sbtc-registry"),
    });
  });

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
