import { parseContractPrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { type ManagerEventVocabulary, managerEventStream } from "./manager-event-vocabulary.js";
import type { ChainStateRepository } from "./storage/chain-state-repository.js";
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
    options?: {
      limit?: number;
      offset?: number;
      rewardCycle?: string | null;
      sort?: ManagerClaimSort;
      direction?: SortDirection;
    },
  ): ManagerActivityPage<StoredManagerClaim>;
  listManagerWithdrawals(
    chainId: number,
    contractId: string,
    options?: {
      limit?: number;
      offset?: number;
      state?: "pending" | "settled" | "reclaimed" | null;
      sort?: ManagerWithdrawalSort;
      direction?: SortDirection;
    },
  ): ManagerActivityPage<StoredManagerWithdrawal>;
  getManagerActivityMetadata(
    chainId: number,
    contractId: string,
  ): { eventCount: number; latestBlockHeight: number | null };
  chainState?: Pick<ChainStateRepository, "getCursor">;
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
  claimSort?: ManagerClaimSort;
  claimDirection?: SortDirection;
  withdrawalLimit?: number;
  withdrawalOffset?: number;
  withdrawalSort?: ManagerWithdrawalSort;
  withdrawalDirection?: SortDirection;
  withdrawalState?: "pending" | "settled" | "reclaimed" | null;
  sourceId?: string;
  eventVocabulary?: ManagerEventVocabulary;
}

export type SortDirection = "asc" | "desc";
export type ManagerClaimSort =
  | "cycle"
  | "staker"
  | "amount"
  | "destination"
  | "block"
  | "transaction";
export type ManagerWithdrawalSort = "request" | "staker" | "amount" | "max-fee" | "state" | "block";

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
    ...(options.claimSort ? { sort: options.claimSort } : {}),
    ...(options.claimDirection ? { direction: options.claimDirection } : {}),
  });
  const withdrawals = store.listManagerWithdrawals(chainId, managerPrincipal, {
    limit: options.withdrawalLimit ?? 50,
    offset: options.withdrawalOffset ?? 0,
    state: options.withdrawalState ?? null,
    ...(options.withdrawalSort ? { sort: options.withdrawalSort } : {}),
    ...(options.withdrawalDirection ? { direction: options.withdrawalDirection } : {}),
  });
  const pending = store.listManagerWithdrawals(chainId, managerPrincipal, {
    limit: 1,
    state: "pending",
  });
  const adminUpdates = store.listManagerAdminUpdates?.(chainId, managerPrincipal) ?? [];
  const { address: deployingAdmin } = parseContractPrincipal(managerPrincipal);
  let eventVocabulary = options.eventVocabulary;
  let fullHistoryCursor: { cursor: string | null; updatedAt?: string } | null = null;
  if (options.sourceId && store.chainState) {
    if (eventVocabulary) {
      fullHistoryCursor = store.chainState.getCursor(
        options.sourceId,
        managerEventStream(managerPrincipal, eventVocabulary),
      );
    } else {
      const generic = store.chainState.getCursor(
        options.sourceId,
        managerEventStream(managerPrincipal, "generic-v1"),
      );
      const reference = store.chainState.getCursor(
        options.sourceId,
        managerEventStream(managerPrincipal, "reference-manager-v1"),
      );
      if (generic && !reference) {
        eventVocabulary = "generic-v1";
        fullHistoryCursor = generic;
      } else if (reference && !generic) {
        eventVocabulary = "reference-manager-v1";
        fullHistoryCursor = reference;
      } else if (generic && reference) {
        // Vocabulary changes create a new stream. The most recently synchronized stream is active;
        // ties fail closed to generic semantics.
        const referenceIsNewer =
          reference.updatedAt !== undefined &&
          generic.updatedAt !== undefined &&
          reference.updatedAt > generic.updatedAt;
        eventVocabulary = referenceIsNewer ? "reference-manager-v1" : "generic-v1";
        fullHistoryCursor = referenceIsNewer ? reference : generic;
      }
    }
  }
  const adminHistoryCurrent =
    eventVocabulary === "reference-manager-v1" && fullHistoryCursor?.cursor === null;
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
