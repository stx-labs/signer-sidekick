import type { EngineJobDetail, EngineStatus } from "@stx-labs/signer-sidekick-api-contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EngineWalletClaim, isWalletClaimJobEligible } from "./engine-wallet-claim.js";

const job = {
  mode: "observe",
  state: "preflighted",
  review: {
    adapter: { id: "reference-manager-claim-rewards", revision: 1 },
    managerPrincipal: "ST000000000000000000002AMW42H.signer-manager",
    call: {
      contract: "ST000000000000000000002AMW42H.signer-manager",
      functionName: "claim-rewards",
    },
  },
  approval: null,
  nonce: null,
  attempts: [],
} as unknown as EngineJobDetail;

const status = {
  mode: "observe",
  forcedObserve: { active: false, reason: null, actor: null, forcedAt: null },
  adapters: [
    {
      adapter: { id: "reference-manager-claim-rewards", revision: 1 },
      enabled: true,
      availability: "available",
    },
  ],
} as EngineStatus;

describe("Observe claim wallet eligibility", () => {
  it("explains the signing-account flow without provider or implementation details", () => {
    const html = renderToStaticMarkup(
      createElement(EngineWalletClaim, {
        chainId: 0x80000005,
        job,
        network: "testnet",
        status,
        token: "test-token",
      }),
    );

    expect(html).toContain("Claim with browser wallet");
    expect(html).toContain("Any Stacks account can pay for this claim.");
    expect(html).toContain("Signing account");
    expect(html).not.toContain("Leather signs");
    expect(html).not.toContain("exact Observe job");
  });

  it("exposes only an untouched current Observe claim job", () => {
    expect(isWalletClaimJobEligible(job, status)).toBe(true);
    expect(isWalletClaimJobEligible({ ...job, mode: "assist" }, status)).toBe(false);
    expect(isWalletClaimJobEligible({ ...job, state: "confirmed" }, status)).toBe(false);
    expect(
      isWalletClaimJobEligible(job, {
        ...status,
        forcedObserve: {
          active: true,
          reason: "emergency",
          actor: "operator",
          forcedAt: "2026-07-19T12:00:00.000Z",
        },
      }),
    ).toBe(false);
    expect(
      isWalletClaimJobEligible({ ...job, nonce: { value: "1" } } as EngineJobDetail, status),
    ).toBe(false);
    expect(
      isWalletClaimJobEligible(job, {
        ...status,
        adapters: status.adapters.map((adapter) => ({
          ...adapter,
          enabled: false,
          availability: "disabled",
        })),
      }),
    ).toBe(false);
  });
});
