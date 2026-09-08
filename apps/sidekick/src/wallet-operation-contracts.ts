import type {
  BrowserWalletIntentAction,
  BrowserWalletTransaction,
  ManagerActionCapabilityId,
} from "@stx-labs/signer-sidekick-api-contracts";

export type WalletOperationAuthority =
  | "manager-admin"
  | "manager-admin-and-signer-grant"
  | "permissionless";

export interface WalletOperationContract {
  action: BrowserWalletIntentAction;
  /** Manager capability, or null for a protocol-global operation. */
  capability: ManagerActionCapabilityId | null;
  authority: WalletOperationAuthority;
  functionName: string | null;
}

/**
 * The executable contract shared by wallet preparation, action availability, and tests.
 * Descriptive inputs and postconditions live beside each adapter; this registry keeps routing and
 * authority from silently drifting across operator actions.
 */
export const WALLET_OPERATION_CONTRACTS = {
  "register-self": {
    action: "register-self",
    capability: "register-self",
    authority: "manager-admin-and-signer-grant",
    functionName: "register-self",
  },
  "add-admin": {
    action: "add-admin",
    capability: "update-admin",
    authority: "manager-admin",
    functionName: "update-admin",
  },
  "remove-admin": {
    action: "remove-admin",
    capability: "update-admin",
    authority: "manager-admin",
    functionName: "update-admin",
  },
  "update-fees": {
    action: "update-fees",
    capability: "update-fees",
    authority: "manager-admin",
    functionName: "update-fees",
  },
  "withdraw-fees": {
    action: "withdraw-fees",
    capability: "withdraw-fees",
    authority: "manager-admin",
    functionName: "withdraw-fees",
  },
  "sweep-fee-refunds": {
    action: "sweep-fee-refunds",
    capability: "sweep-fee-refunds",
    authority: "manager-admin",
    functionName: "sweep-fee-refunds",
  },
  "claim-rewards": {
    action: "claim-rewards",
    capability: "reference-reward-claims",
    authority: "permissionless",
    functionName: "claim-rewards",
  },
  "claim-staker-rewards": {
    action: "claim-staker-rewards",
    capability: "reference-reward-claims",
    authority: "permissionless",
    functionName: "claim-staker-rewards",
  },
  "calculate-rewards": {
    action: "calculate-rewards",
    capability: null,
    authority: "permissionless",
    functionName: "calculate-rewards",
  },
} as const satisfies Record<BrowserWalletIntentAction, WalletOperationContract>;

export function walletOperationContract(
  action: BrowserWalletIntentAction,
): WalletOperationContract {
  return WALLET_OPERATION_CONTRACTS[action];
}

export function managerCapabilityForWalletAction(
  action: BrowserWalletIntentAction,
): ManagerActionCapabilityId | null {
  return walletOperationContract(action).capability;
}

export function walletIntentTransactionMatchesAction(
  action: BrowserWalletIntentAction,
  transaction: BrowserWalletTransaction,
): boolean {
  const contract = walletOperationContract(action);
  return (
    transaction.method === "stx_callContract" &&
    transaction.params.functionName === contract.functionName
  );
}
