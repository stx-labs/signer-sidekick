import { parseContractPrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import type {
  ManagerActivityPage,
  StoredManagerAdminUpdate,
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
  getCursor?(sourceId: string, stream: string): { cursor: string | null } | null;
  listManagerAdminUpdates?(chainId: number, contractId: string): StoredManagerAdminUpdate[];
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
  admins: {
    status: "current" | "sync-required";
    principals: string[];
    updatesObserved: number;
  };
}

export interface ManagerActivityOptions {
  claimLimit?: number;
  claimOffset?: number;
  rewardCycle?: string | null;
  withdrawalLimit?: number;
  withdrawalOffset?: number;
  withdrawalState?: "pending" | "settled" | "reclaimed" | null;
  sourceId?: string;
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
  const adminUpdates = store.listManagerAdminUpdates?.(chainId, managerPrincipal) ?? [];
  const { address: deployingAdmin } = parseContractPrincipal(managerPrincipal);
  const fullHistoryCursor =
    options.sourceId && store.getCursor
      ? store.getCursor(options.sourceId, `manager-logs:v2:${managerPrincipal}`)
      : null;
  const adminHistoryCurrent = fullHistoryCursor?.cursor === null;
  const admins = new Set([deployingAdmin]);
  if (adminHistoryCurrent) {
    for (const update of adminUpdates) {
      // A transaction index is required to establish the order of two admin changes in one block.
      // New v2 event syncs persist it; until then, do not present a partial reconstruction as current.
      if (update.transactionIndex === null) {
        admins.clear();
        break;
      }
      if (update.enabled) admins.add(update.adminPrincipal);
      else admins.delete(update.adminPrincipal);
    }
  }
  const adminStatus = adminHistoryCurrent && admins.size > 0 ? "current" : "sync-required";
  return {
    claims: claims.items,
    withdrawals: withdrawals.items,
    ...store.getManagerActivityMetadata(chainId, managerPrincipal),
    claimTotal: claims.total,
    withdrawalTotal: withdrawals.total,
    pendingWithdrawalTotal: pending.total,
    admins: {
      status: adminStatus,
      principals: adminStatus === "current" ? [...admins].sort() : [],
      updatesObserved: adminUpdates.length,
    },
  };
}
