import type { BrowserWalletIntent } from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../api-client.js";
import {
  type BrowserWalletRecoveryScope,
  LEATHER_PROVIDER_ID,
  POX5_TESTNET_CHAIN_ID,
  XVERSE_PROVIDER_ID,
} from "./browser-wallet.js";
import {
  clearPendingBrowserWalletBroadcast,
  loadPendingBrowserWalletBroadcast,
  loadPendingBrowserWalletBroadcasts,
  type PendingBrowserWalletBroadcast,
  persistPendingBrowserWalletBroadcast,
  recoverPendingBrowserWalletBroadcast,
  recoverSpecificPendingBrowserWalletBroadcast,
} from "./browser-wallet-recovery.js";

const action = "deploy-manager" as const;
const intentId = "4e011bf7-f291-42c4-a35b-ab299a87ff8c";
const admin = "SP000000000000000000002Q6VF78";
const managerPrincipal = `${admin}.signer-manager`;
const txid = `0x${"ab".repeat(32)}`;
const scope: BrowserWalletRecoveryScope = {
  network: "mainnet",
  chainId: 1,
  managerPrincipal,
  action,
  intentId,
};
const pending: PendingBrowserWalletBroadcast = {
  intentId,
  txid,
  sender: admin,
  providerId: LEATHER_PROVIDER_ID,
};

class MemoryStorage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function intent(
  status: BrowserWalletIntent["status"],
  recordedTxid: string | null,
  overrides: Partial<BrowserWalletIntent> = {},
): BrowserWalletIntent {
  return {
    schemaVersion: 2,
    id: intentId,
    action,
    network: "mainnet",
    chainId: 1,
    requiredSender: admin,
    createdAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-19T00:15:00.000Z",
    transaction: {
      method: "stx_deployContract",
      params: {
        name: "signer-manager",
        clarityCode: "(define-public (ping) (ok true))",
        clarityVersion: 6,
        network: "mainnet",
        address: admin,
        sponsored: false,
        postConditionMode: "deny",
        postConditions: [],
      },
    },
    request: { action },
    review: {
      title: "Deploy manager",
      summary: "Deploy the manager",
      expectedPostState: "Manager deployed",
      fields: [{ label: "Manager", value: managerPrincipal }],
    },
    seal: { factsSha256: "11".repeat(32), manifestSha256: "22".repeat(32) },
    status,
    txid: recordedTxid,
    verification: null,
    ...overrides,
  };
}

describe("browser wallet broadcast recovery", () => {
  it("persists under chain, manager, action, and intent and recovers without another wallet request", async () => {
    const storage = new MemoryStorage();
    const requestWallet = vi.fn().mockResolvedValue(pending);
    const firstRecord = vi.fn().mockRejectedValue(new Error("Sidekick is unavailable"));

    const walletResult = await requestWallet();
    expect(persistPendingBrowserWalletBroadcast(scope, walletResult, [storage])).toBe(true);
    expect([...storage.values.keys()][0]).toBe(
      `signer-sidekick:browser-wallet:pending:v3:mainnet:00000001:${managerPrincipal}:deploy-manager:${intentId}`,
    );
    await expect(firstRecord(walletResult.intentId, walletResult.txid)).rejects.toThrow(
      "Sidekick is unavailable",
    );

    // Reload recovery has no in-memory intent; it discovers the one fully scoped record.
    expect(loadPendingBrowserWalletBroadcast(scope, [storage])).toMatchObject(pending);
    const getIntent = vi.fn().mockResolvedValue(intent("expired", null));
    const recordTxid = vi.fn().mockResolvedValue(intent("submitted", txid));
    await expect(
      recoverPendingBrowserWalletBroadcast(scope, { getIntent, recordTxid }, [storage]),
    ).resolves.toMatchObject({ outcome: "recorded", pending, intent: { txid } });

    expect(requestWallet).toHaveBeenCalledTimes(1);
    expect(getIntent).toHaveBeenCalledWith(intentId);
    expect(recordTxid).toHaveBeenCalledWith(intentId, txid);
    expect(loadPendingBrowserWalletBroadcast(scope, [storage])).toBeNull();
  });

  it("isolates recovery records by every authority-bearing scope field", () => {
    const storage = new MemoryStorage();
    persistPendingBrowserWalletBroadcast(scope, pending, [storage]);

    expect(
      loadPendingBrowserWalletBroadcast(
        { ...scope, network: "pox5-testnet", chainId: POX5_TESTNET_CHAIN_ID },
        [storage],
      ),
    ).toBeNull();
    expect(
      loadPendingBrowserWalletBroadcast({ ...scope, network: "devnet" }, [storage]),
    ).toBeNull();
    expect(
      loadPendingBrowserWalletBroadcast(
        { ...scope, managerPrincipal: "SP000000000000000000002Q6VF78.other-manager" },
        [storage],
      ),
    ).toBeNull();
    expect(
      loadPendingBrowserWalletBroadcast({ ...scope, action: "register-self" }, [storage]),
    ).toBeNull();
    expect(
      loadPendingBrowserWalletBroadcast(
        { ...scope, intentId: "a545c55b-bc60-4f4c-b58f-a1546ec422ef" },
        [storage],
      ),
    ).toBeNull();
  });

  it.each([
    "register-self",
    "add-admin",
    "remove-admin",
    "update-fees",
  ] as const)("accepts mainnet Xverse recovery for %s", (xverseAction) => {
    const storage = new MemoryStorage();
    const xverseScope = { ...scope, action: xverseAction };
    const xversePending: PendingBrowserWalletBroadcast = {
      ...pending,
      providerId: XVERSE_PROVIDER_ID,
    };

    expect(persistPendingBrowserWalletBroadcast(xverseScope, xversePending, [storage])).toBe(true);
    expect(loadPendingBrowserWalletBroadcast(xverseScope, [storage])).toMatchObject({
      ...xversePending,
      action: xverseAction,
      chainId: 1,
    });
  });

  it.each([
    "deploy-manager",
    "withdraw-fees",
    "sweep-fee-refunds",
    "claim-rewards",
  ] as const)("rejects mainnet Xverse recovery for Leather-only %s", (leatherOnlyAction) => {
    const storage = new MemoryStorage();

    expect(
      persistPendingBrowserWalletBroadcast(
        { ...scope, action: leatherOnlyAction },
        { ...pending, providerId: XVERSE_PROVIDER_ID },
        [storage],
      ),
    ).toBe(false);
    expect(storage.values.size).toBe(0);
  });

  it.each([
    "register-self",
    "add-admin",
    "remove-admin",
    "update-fees",
  ] as const)("rejects PoX-5 Testnet Xverse recovery for %s", (xverseAction) => {
    const storage = new MemoryStorage();

    expect(
      persistPendingBrowserWalletBroadcast(
        {
          ...scope,
          network: "pox5-testnet",
          chainId: POX5_TESTNET_CHAIN_ID,
          action: xverseAction,
        },
        {
          ...pending,
          sender: "ST000000000000000000002AMW42H",
          providerId: XVERSE_PROVIDER_ID,
        },
        [storage],
      ),
    ).toBe(false);
    expect(storage.values.size).toBe(0);
  });

  it("isolates private-network recovery by logical network even when chain IDs match", () => {
    const storage = new MemoryStorage();
    const privateManager = "ST000000000000000000002AMW42H.signer-manager";
    const privatePending = {
      ...pending,
      sender: "ST000000000000000000002AMW42H",
    };
    const devnetScope = {
      ...scope,
      network: "devnet",
      chainId: 0x8000_0000,
      managerPrincipal: privateManager,
    };
    const regtestScope = { ...devnetScope, network: "regtest" };

    expect(persistPendingBrowserWalletBroadcast(devnetScope, privatePending, [storage])).toBe(true);
    expect(persistPendingBrowserWalletBroadcast(regtestScope, privatePending, [storage])).toBe(
      true,
    );
    expect(loadPendingBrowserWalletBroadcast(devnetScope, [storage])).toMatchObject({
      network: "devnet",
      chainId: 0x8000_0000,
    });
    expect(loadPendingBrowserWalletBroadcast(regtestScope, [storage])).toMatchObject({
      network: "regtest",
      chainId: 0x8000_0000,
    });
    expect([...storage.values.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(":devnet:80000000:"),
        expect.stringContaining(":regtest:80000000:"),
      ]),
    );
  });

  it("clears an already-recorded txid but retains conflicting or mismatched intents", async () => {
    const storage = new MemoryStorage();
    persistPendingBrowserWalletBroadcast(scope, pending, [storage]);
    const recordTxid = vi.fn();

    await expect(
      recoverPendingBrowserWalletBroadcast(
        scope,
        { getIntent: vi.fn().mockResolvedValue(intent("mempool", txid)), recordTxid },
        [storage],
      ),
    ).resolves.toMatchObject({ outcome: "already-recorded" });
    expect(recordTxid).not.toHaveBeenCalled();
    expect(loadPendingBrowserWalletBroadcast(scope, [storage])).toBeNull();

    persistPendingBrowserWalletBroadcast(scope, pending, [storage]);
    await expect(
      recoverPendingBrowserWalletBroadcast(
        scope,
        {
          getIntent: vi.fn().mockResolvedValue(intent("submitted", `0x${"cd".repeat(32)}`)),
          recordTxid,
        },
        [storage],
      ),
    ).resolves.toMatchObject({ outcome: "conflict" });
    expect(recordTxid).not.toHaveBeenCalled();
    expect(loadPendingBrowserWalletBroadcast(scope, [storage])).toMatchObject(pending);

    await expect(
      recoverPendingBrowserWalletBroadcast(
        scope,
        {
          getIntent: vi
            .fn()
            .mockResolvedValue(intent("expired", null, { network: "pox5-testnet" })),
          recordTxid,
        },
        [storage],
      ),
    ).resolves.toMatchObject({ outcome: "conflict" });
    await expect(
      recoverPendingBrowserWalletBroadcast(
        scope,
        {
          getIntent: vi
            .fn()
            .mockResolvedValue(intent("expired", null, { requiredSender: "SP123" })),
          recordTxid,
        },
        [storage],
      ),
    ).resolves.toMatchObject({ outcome: "conflict" });
    expect(recordTxid).not.toHaveBeenCalled();
  });

  it("coalesces concurrent reload recovery into one backend submission", async () => {
    const storage = new MemoryStorage();
    persistPendingBrowserWalletBroadcast(scope, pending, [storage]);
    const getIntent = vi.fn().mockResolvedValue(intent("expired", null));
    const recordTxid = vi.fn().mockResolvedValue(intent("submitted", txid));

    const first = recoverPendingBrowserWalletBroadcast(scope, { getIntent, recordTxid }, [storage]);
    const second = recoverPendingBrowserWalletBroadcast(scope, { getIntent, recordTxid }, [
      storage,
    ]);
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(getIntent).toHaveBeenCalledTimes(1);
    expect(recordTxid).toHaveBeenCalledTimes(1);
  });

  it("fails closed for two same-scope intents and recovers only the selected exact record", async () => {
    const storage = new MemoryStorage();
    const selector = { network: scope.network, chainId: scope.chainId, managerPrincipal, action };
    const otherIntentId = "a545c55b-bc60-4f4c-b58f-a1546ec422ef";
    const otherTxid = `0x${"cd".repeat(32)}`;
    const otherScope = { ...scope, intentId: otherIntentId };
    const otherPending = { ...pending, intentId: otherIntentId, txid: otherTxid };
    persistPendingBrowserWalletBroadcast(scope, pending, [storage]);
    persistPendingBrowserWalletBroadcast(otherScope, otherPending, [storage]);

    expect(loadPendingBrowserWalletBroadcasts(selector, [storage])).toEqual([
      expect.objectContaining(pending),
      expect.objectContaining(otherPending),
    ]);
    expect(loadPendingBrowserWalletBroadcast(selector, [storage])).toBeNull();
    const getIntent = vi.fn();
    const recordTxid = vi.fn();
    await expect(
      recoverPendingBrowserWalletBroadcast(selector, { getIntent, recordTxid }, [storage]),
    ).resolves.toBeNull();
    expect(getIntent).not.toHaveBeenCalled();
    expect(recordTxid).not.toHaveBeenCalled();

    getIntent.mockResolvedValue(intent("expired", null, { id: otherIntentId }));
    recordTxid.mockResolvedValue(intent("submitted", otherTxid, { id: otherIntentId }));
    await expect(
      recoverSpecificPendingBrowserWalletBroadcast(
        { ...otherPending, ...otherScope },
        { getIntent, recordTxid },
        [storage],
      ),
    ).resolves.toMatchObject({ outcome: "recorded", pending: otherPending });
    expect(getIntent).toHaveBeenCalledWith(otherIntentId);
    expect(recordTxid).toHaveBeenCalledWith(otherIntentId, otherTxid);
    expect(loadPendingBrowserWalletBroadcasts(selector, [storage])).toEqual([
      expect.objectContaining(pending),
    ]);
  });

  it("retains a stale 404 record until the operator clears its exact scope", async () => {
    const storage = new MemoryStorage();
    persistPendingBrowserWalletBroadcast(scope, pending, [storage]);

    await expect(
      recoverPendingBrowserWalletBroadcast(
        scope,
        {
          getIntent: vi.fn().mockRejectedValue(
            new ApiRequestError("Request failed: wallet intent not found", {
              kind: "http",
              status: 404,
              code: "wallet_intent_not_found",
            }),
          ),
          recordTxid: vi.fn(),
        },
        [storage],
      ),
    ).rejects.toMatchObject({ status: 404 });
    const restored = loadPendingBrowserWalletBroadcast(scope, [storage]);
    expect(restored).toMatchObject(pending);

    if (!restored) throw new Error("Expected the exact stale recovery record");
    clearPendingBrowserWalletBroadcast(restored, restored, [storage]);
    expect(loadPendingBrowserWalletBroadcast(scope, [storage])).toBeNull();
  });

  it("rejects malformed, wrong-provider, and ambiguous records and clears only the expected one", () => {
    const storage = new MemoryStorage();
    persistPendingBrowserWalletBroadcast(scope, pending, [storage]);
    const key = [...storage.values.keys()][0];
    if (!key) throw new Error("Expected recovery storage key");
    const stored = storage.getItem(key);
    if (!stored) throw new Error("Expected recovery storage value");
    const encoded = JSON.parse(stored) as Record<string, unknown>;
    storage.setItem(key, JSON.stringify({ ...encoded, rawTransaction: "secret" }));
    expect(loadPendingBrowserWalletBroadcast(scope, [storage])).toBeNull();

    storage.values.clear();
    persistPendingBrowserWalletBroadcast(scope, pending, [storage]);
    clearPendingBrowserWalletBroadcast(scope, { ...pending, txid: `0x${"cd".repeat(32)}` }, [
      storage,
    ]);
    expect(loadPendingBrowserWalletBroadcast(scope, [storage])).toMatchObject(pending);
    clearPendingBrowserWalletBroadcast(scope, pending, [storage]);
    expect(loadPendingBrowserWalletBroadcast(scope, [storage])).toBeNull();
  });
});
