import type {
  BrowserWalletTransaction,
  ManagerActionCapabilityId,
  RecurringWalletIntentAction,
} from "@stx-labs/signer-sidekick-api-contracts";

export type WalletOperationAuthority =
  | "manager-admin"
  | "manager-admin-and-signer-grant"
  | "permissionless";

export interface WalletOperationContract {
  action: RecurringWalletIntentAction;
  lifecycle: "recurring";
  /** Manager capability, or null for a protocol-global operation. */
  capability: ManagerActionCapabilityId | null;
  authority: WalletOperationAuthority;
  functionName: string | null;
  completionEvidence: "contract-source" | "canonical-post-state" | "immutable-engine-job";
}

/**
 * The executable contract shared by wallet preparation, action availability, and tests.
 * Descriptive inputs and postconditions live beside each adapter; this registry keeps routing and
 * authority from silently drifting while onboarding is removed around the recurring operations.
 */
export const WALLET_OPERATION_CONTRACTS = {
  "register-self": {
    action: "register-self",
    lifecycle: "recurring",
    capability: "register-self",
    authority: "manager-admin-and-signer-grant",
    functionName: "register-self",
    completionEvidence: "canonical-post-state",
  },
  "add-admin": {
    action: "add-admin",
    lifecycle: "recurring",
    capability: "update-admin",
    authority: "manager-admin",
    functionName: "update-admin",
    completionEvidence: "canonical-post-state",
  },
  "remove-admin": {
    action: "remove-admin",
    lifecycle: "recurring",
    capability: "update-admin",
    authority: "manager-admin",
    functionName: "update-admin",
    completionEvidence: "canonical-post-state",
  },
  "update-fees": {
    action: "update-fees",
    lifecycle: "recurring",
    capability: "update-fees",
    authority: "manager-admin",
    functionName: "update-fees",
    completionEvidence: "canonical-post-state",
  },
  "withdraw-fees": {
    action: "withdraw-fees",
    lifecycle: "recurring",
    capability: "withdraw-fees",
    authority: "manager-admin",
    functionName: "withdraw-fees",
    completionEvidence: "canonical-post-state",
  },
  "sweep-fee-refunds": {
    action: "sweep-fee-refunds",
    lifecycle: "recurring",
    capability: "sweep-fee-refunds",
    authority: "manager-admin",
    functionName: "sweep-fee-refunds",
    completionEvidence: "canonical-post-state",
  },
  "claim-rewards": {
    action: "claim-rewards",
    lifecycle: "recurring",
    capability: "reference-reward-claims",
    authority: "permissionless",
    functionName: "claim-rewards",
    completionEvidence: "immutable-engine-job",
  },
  "claim-staker-rewards": {
    action: "claim-staker-rewards",
    lifecycle: "recurring",
    capability: "reference-reward-claims",
    authority: "permissionless",
    functionName: "claim-staker-rewards",
    completionEvidence: "canonical-post-state",
  },
  "calculate-rewards": {
    action: "calculate-rewards",
    lifecycle: "recurring",
    capability: null,
    authority: "permissionless",
    functionName: "calculate-rewards",
    completionEvidence: "canonical-post-state",
  },
} as const satisfies Record<RecurringWalletIntentAction, WalletOperationContract>;

export function walletOperationContract(
  action: RecurringWalletIntentAction,
): WalletOperationContract {
  return WALLET_OPERATION_CONTRACTS[action];
}

export function managerCapabilityForWalletAction(
  action: RecurringWalletIntentAction,
): ManagerActionCapabilityId | null {
  return walletOperationContract(action).capability;
}

export function walletIntentTransactionMatchesAction(
  action: RecurringWalletIntentAction,
  transaction: BrowserWalletTransaction,
): boolean {
  const contract = walletOperationContract(action);
  return (
    transaction.method === "stx_callContract" &&
    transaction.params.functionName === contract.functionName
  );
}
