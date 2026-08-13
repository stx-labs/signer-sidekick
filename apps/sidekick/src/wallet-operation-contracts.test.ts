import { describe, expect, it } from "vitest";
import {
  managerCapabilityForWalletAction,
  WALLET_OPERATION_CONTRACTS,
  walletIntentTransactionMatchesAction,
} from "./wallet-operation-contracts.js";

describe("wallet operation contracts", () => {
  it("contains only recurring operator actions", () => {
    expect(Object.values(WALLET_OPERATION_CONTRACTS).map(({ action }) => action)).toEqual([
      "register-self",
      "add-admin",
      "remove-admin",
      "update-fees",
      "withdraw-fees",
      "sweep-fee-refunds",
      "claim-rewards",
      "claim-staker-rewards",
    ]);
  });

  it("records contract-defined authority and shared capability adapters", () => {
    expect(WALLET_OPERATION_CONTRACTS["register-self"].authority).toBe(
      "manager-admin-and-signer-grant",
    );
    expect(WALLET_OPERATION_CONTRACTS["claim-rewards"].authority).toBe("permissionless");
    expect(WALLET_OPERATION_CONTRACTS["claim-staker-rewards"].authority).toBe("permissionless");
    expect(managerCapabilityForWalletAction("add-admin")).toBe("update-admin");
    expect(managerCapabilityForWalletAction("claim-staker-rewards")).toBe(
      "reference-reward-claims",
    );
  });

  it("matches each recurring action to its adapter function", () => {
    expect(
      walletIntentTransactionMatchesAction("remove-admin", {
        method: "stx_callContract",
        params: {
          contract: "SP000000000000000000002Q6VF78.signer-manager",
          functionName: "update-admin",
          functionArgs: [],
          network: "mainnet",
          address: "SP000000000000000000002Q6VF78",
          sponsored: false,
          postConditionMode: "deny",
          postConditions: [],
        },
      }),
    ).toBe(true);
  });
});
