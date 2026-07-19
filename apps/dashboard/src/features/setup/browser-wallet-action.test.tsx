import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BrowserWalletRecoveryScope, LEATHER_PROVIDER_ID } from "./browser-wallet.js";
import { BrowserWalletActionPanel } from "./browser-wallet-action.js";
import {
  type PendingBrowserWalletBroadcast,
  persistPendingBrowserWalletBroadcast,
} from "./browser-wallet-recovery.js";

const admin = "SP000000000000000000002Q6VF78";
const managerPrincipal = `${admin}.signer-manager`;

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

afterEach(() => vi.unstubAllGlobals());

describe("BrowserWalletActionPanel recovery", () => {
  it("renders every same-scope pending intent and blocks new preparation and signing", () => {
    const storage = new MemoryStorage();
    const firstIntentId = "4e011bf7-f291-42c4-a35b-ab299a87ff8c";
    const secondIntentId = "a545c55b-bc60-4f4c-b58f-a1546ec422ef";
    const firstTxid = `0x${"ab".repeat(32)}`;
    const secondTxid = `0x${"cd".repeat(32)}`;
    const records: Array<{
      scope: BrowserWalletRecoveryScope;
      pending: PendingBrowserWalletBroadcast;
    }> = [
      {
        scope: {
          network: "mainnet",
          chainId: 1,
          managerPrincipal,
          action: "deploy-manager",
          intentId: firstIntentId,
        },
        pending: {
          intentId: firstIntentId,
          txid: firstTxid,
          sender: admin,
          providerId: LEATHER_PROVIDER_ID,
        },
      },
      {
        scope: {
          network: "mainnet",
          chainId: 1,
          managerPrincipal,
          action: "deploy-manager",
          intentId: secondIntentId,
        },
        pending: {
          intentId: secondIntentId,
          txid: secondTxid,
          sender: admin,
          providerId: LEATHER_PROVIDER_ID,
        },
      },
    ];
    for (const record of records) {
      persistPendingBrowserWalletBroadcast(record.scope, record.pending, [storage]);
    }
    vi.stubGlobal("localStorage", storage);

    const html = renderToStaticMarkup(
      <BrowserWalletActionPanel
        chainId={1}
        createRequest={{ action: "deploy-manager" }}
        managerPrincipal={managerPrincipal}
        network="mainnet"
        token="test-token"
      />,
    );

    expect(html).toContain("Multiple saved wallet broadcasts need review.");
    expect(html).toContain("does not cancel its broadcast");
    for (const value of [firstIntentId, secondIntentId, firstTxid, secondTxid]) {
      expect(html).toContain(value);
    }
    expect(html.match(/Retry recording this transaction/g)).toHaveLength(2);
    expect(html.match(/Clear this recovery record/g)).toHaveLength(2);
    expect(html).not.toContain("Review wallet transaction");
    expect(html).not.toContain("Connect Leather and sign");
  });
});
