import { describe, expect, it } from "vitest";
import type { ContractInterface } from "./chain-clients.js";
import {
  inspectManagerCapabilities,
  managerActionCapability,
  managerInterfaceSha256,
  missingReferenceManagerFunctions,
} from "./manager-capabilities.js";

function functionEntry(
  name: string,
  access: "public" | "read_only",
  args: unknown[] = [],
  outputs: unknown = null,
) {
  return { name, access, args, outputs };
}

function traitFunction(): ContractInterface["functions"][number] {
  return functionEntry(
    "validate-stake!",
    "public",
    [
      { name: "staker", type: "principal" },
      { name: "first-index", type: "uint128" },
      { name: "num-indexes", type: "uint128" },
      { name: "amount-ustx", type: "uint128" },
      { name: "amount-sats", type: "uint128" },
      { name: "is-bond", type: "bool" },
      { name: "signer-calldata", type: { optional: { buffer: { length: 500 } } } },
    ],
    { type: { response: { ok: "bool", error: "uint128" } } },
  );
}

function referenceInterface(): ContractInterface {
  return {
    functions: [
      traitFunction(),
      ...[
        "claim-rewards",
        "claim-staker-rewards",
        "reclaim-failed-withdrawal",
        "settle-accepted-withdrawal",
        "update-admin",
        "update-fees",
        "withdraw-fees",
        "sweep-fee-refunds",
        "register-self",
      ].map((name) => functionEntry(name, "public")),
      ...[
        "get-earned-staker-rewards",
        "is-admin",
        "get-fee-bips-for-cycle",
        "get-earned-fees",
        "get-withdrawal-liability",
        "get-unclaimed-staker-rewards",
        "get-pox-addr",
        "get-withdrawal-request-staker",
        "check-pox-addr",
      ].map((name) => functionEntry(name, "read_only")),
    ],
  };
}

describe("manager capabilities", () => {
  it("accepts the exact signer-manager trait without requiring the reference interface", () => {
    const capabilities = inspectManagerCapabilities({
      contractInterface: { functions: [traitFunction()] },
      sourceSha256: "ab".repeat(32),
      exactSourceReviewed: false,
      sourceReviewReason: "Unknown source",
    });

    expect(capabilities.signerManagerTrait).toMatchObject({ compatible: true });
    expect(capabilities.observedFunctions.public).toEqual(["validate-stake!"]);
    expect(capabilities.eventVocabulary).toMatchObject({
      normalizationAvailable: false,
      adapter: null,
    });
    expect(managerActionCapability(capabilities, "update-admin")).toMatchObject({
      interfaceAvailable: false,
      executionAvailable: false,
      missingFunctions: ["update-admin", "is-admin"],
    });
  });

  it("rejects a same-named function with the wrong trait signature", () => {
    const incompatible = traitFunction();
    incompatible.args[1] = { name: "first-index", type: "int128" };

    const capabilities = inspectManagerCapabilities({
      contractInterface: { functions: [incompatible] },
      sourceSha256: "ab".repeat(32),
      exactSourceReviewed: false,
      sourceReviewReason: "Unknown source",
    });

    expect(capabilities.signerManagerTrait).toMatchObject({
      compatible: false,
      reason: expect.stringContaining("arguments"),
    });
  });

  it("does not grant execution from a reference-shaped ABI alone", () => {
    const capabilities = inspectManagerCapabilities({
      contractInterface: referenceInterface(),
      sourceSha256: "ab".repeat(32),
      exactSourceReviewed: false,
      sourceReviewReason: "Canonical-only source match",
    });

    expect(managerActionCapability(capabilities, "update-admin")).toMatchObject({
      interfaceAvailable: true,
      executionAvailable: false,
      adapter: null,
      reason: expect.stringContaining("byte-exact source is not reviewed"),
    });
  });

  it("binds interface evidence to callable ABI, Clarity version, and epoch", () => {
    const clarity4 = {
      ...referenceInterface(),
      clarity_version: "Clarity4",
      epoch: "Epoch40",
    };
    const clarity6 = { ...clarity4, clarity_version: "Clarity6" };
    const otherEpoch = { ...clarity4, epoch: "Epoch31" };
    const changedAbi = {
      ...clarity4,
      functions: clarity4.functions.map((entry) =>
        entry.name === "update-fees" ? { ...entry, outputs: { type: "bool" } } : entry,
      ),
    };
    const reorderedAbi = { ...clarity4, functions: [...clarity4.functions].reverse() };

    expect(managerInterfaceSha256(clarity4)).not.toBe(managerInterfaceSha256(clarity6));
    expect(managerInterfaceSha256(clarity4)).not.toBe(managerInterfaceSha256(otherEpoch));
    expect(managerInterfaceSha256(clarity4)).not.toBe(managerInterfaceSha256(changedAbi));
    expect(managerInterfaceSha256(clarity4)).toBe(managerInterfaceSha256(reorderedAbi));
  });

  it("enables reviewed capabilities for an exact reviewed source", () => {
    const sourceSha256 = "cd".repeat(32);
    const capabilities = inspectManagerCapabilities({
      contractInterface: referenceInterface(),
      sourceSha256,
      exactSourceReviewed: true,
      sourceReviewReason: "Exact built-in source match",
    });

    expect(managerActionCapability(capabilities, "reference-reward-claims")).toMatchObject({
      interfaceAvailable: true,
      executionAvailable: true,
      adapter: {
        id: "reference-manager-claim-rewards",
        revision: 1,
        reviewedSourceSha256: sourceSha256,
      },
    });
    expect(capabilities.eventVocabulary).toMatchObject({
      normalizationAvailable: true,
      adapter: {
        id: "reference-manager-print-events",
        revision: 1,
        reviewedSourceSha256: sourceSha256,
      },
    });
    expect(missingReferenceManagerFunctions(referenceInterface())).toEqual([]);
  });
});
