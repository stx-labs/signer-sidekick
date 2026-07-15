import type {
  ManagerActivityPage,
  StoredManagerClaim,
  StoredManagerWithdrawal,
} from "./storage/store.js";

export interface ManagerActivityStore {
  listManagerClaims(
    chainId: number,
    contractId: string,
    options?: { limit?: number; offset?: number; rewardCycle?: string | null },
  ): ManagerActivityPage<StoredManagerClaim>;
  listManagerWithdrawals(
    chainId: number,
    contractId: string,
    options?: {
      limit?: number;
      offset?: number;
      state?: "pending" | "settled" | "reclaimed" | null;
    },
  ): ManagerActivityPage<StoredManagerWithdrawal>;
  getManagerActivityMetadata(
    chainId: number,
    contractId: string,
  ): { eventCount: number; latestBlockHeight: number | null };
}

export interface ManagerClaimActivity {
  txId: string;
  eventIndex: number;
  blockHeight: number;
  stakerPrincipal: string;
  rewardCycle: string;
  bondIndex: string | null;
  amountSats: string;
  destination: "direct-sbtc" | "bitcoin-l1";
  withdrawalRequestId: string | null;
}

export interface WithdrawalActivity {
  requestId: string;
  stakerPrincipal: string;
  amountSats: string;
  maxFeeSats: string;
  initiatedTxId: string;
  initiatedBlockHeight: number;
  state: "pending" | "settled" | "reclaimed";
  resolvedTxId: string | null;
  resolvedBlockHeight: number | null;
}

export interface ManagerActivity {
  claims: ManagerClaimActivity[];
  withdrawals: WithdrawalActivity[];
  eventCount: number;
  latestBlockHeight: number | null;
  claimTotal: number;
  withdrawalTotal: number;
  pendingWithdrawalTotal: number;
}

export interface ManagerActivityOptions {
  claimLimit?: number;
  claimOffset?: number;
  rewardCycle?: string | null;
  withdrawalLimit?: number;
  withdrawalOffset?: number;
  withdrawalState?: "pending" | "settled" | "reclaimed" | null;
}

export function readManagerActivity(
  store: ManagerActivityStore,
  chainId: number,
  managerPrincipal: string,
  options: ManagerActivityOptions = {},
): ManagerActivity {
  const claims = store.listManagerClaims(chainId, managerPrincipal, {
    limit: options.claimLimit ?? 50,
    offset: options.claimOffset ?? 0,
    rewardCycle: options.rewardCycle ?? null,
  });
  const withdrawals = store.listManagerWithdrawals(chainId, managerPrincipal, {
    limit: options.withdrawalLimit ?? 50,
    offset: options.withdrawalOffset ?? 0,
    state: options.withdrawalState ?? null,
  });
  const pending = store.listManagerWithdrawals(chainId, managerPrincipal, {
    limit: 1,
    state: "pending",
  });
  return {
    claims: claims.items,
    withdrawals: withdrawals.items,
    ...store.getManagerActivityMetadata(chainId, managerPrincipal),
    claimTotal: claims.total,
    withdrawalTotal: withdrawals.total,
    pendingWithdrawalTotal: pending.total,
  };
}
