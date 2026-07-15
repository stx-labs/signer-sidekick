import type { ManagerPrintEvent } from "@stx-labs/signer-sidekick-protocol/manager-events";
import type {
  ManagerActivityPage,
  StoredChainEvent,
  StoredManagerClaim,
  StoredManagerWithdrawal,
} from "./storage/store.js";

export interface ManagerActivityStore {
  listChainEventsForContract(
    chainId: number,
    contractId: string,
    limit?: number,
    canonicalOnly?: boolean,
  ): StoredChainEvent[];
  listManagerClaims?(
    chainId: number,
    contractId: string,
    options?: { limit?: number; offset?: number; rewardCycle?: string | null },
  ): ManagerActivityPage<StoredManagerClaim>;
  listManagerWithdrawals?(
    chainId: number,
    contractId: string,
    options?: {
      limit?: number;
      offset?: number;
      state?: "pending" | "settled" | "reclaimed" | null;
    },
  ): ManagerActivityPage<StoredManagerWithdrawal>;
  getManagerActivityMetadata?(
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

interface DecodedEnvelope {
  transactionStatus: string;
  event: ManagerPrintEvent;
}

function decodedEnvelope(value: unknown): DecodedEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as { transactionStatus?: unknown; event?: unknown };
  if (typeof envelope.transactionStatus !== "string" || !envelope.event) return null;
  if (
    typeof envelope.event !== "object" ||
    typeof (envelope.event as { kind?: unknown }).kind !== "string"
  ) {
    return null;
  }
  return envelope as DecodedEnvelope;
}

export function readManagerActivity(
  store: ManagerActivityStore,
  chainId: number,
  managerPrincipal: string,
  options: ManagerActivityOptions = {},
): ManagerActivity {
  if (store.listManagerClaims && store.listManagerWithdrawals && store.getManagerActivityMetadata) {
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
  const limit = 2_000;
  const events = store.listChainEventsForContract(chainId, managerPrincipal, limit, true);
  const claims: ManagerClaimActivity[] = [];
  const withdrawals = new Map<string, WithdrawalActivity>();

  for (const stored of [...events].reverse()) {
    const envelope = decodedEnvelope(stored.decodedPayload);
    if (envelope?.transactionStatus !== "success") continue;
    const event = envelope.event;
    if (event.kind === "claim-staker-rewards") {
      claims.push({
        txId: stored.txId,
        eventIndex: stored.eventIndex,
        blockHeight: stored.blockHeight,
        stakerPrincipal: event.stakerPrincipal,
        rewardCycle: event.rewardCycle,
        bondIndex: event.bondIndex,
        amountSats: event.amountSats,
        destination: event.l1Withdrawal ? "bitcoin-l1" : "direct-sbtc",
        withdrawalRequestId: event.l1Withdrawal?.requestId ?? null,
      });
      if (event.l1Withdrawal) {
        withdrawals.set(event.l1Withdrawal.requestId, {
          requestId: event.l1Withdrawal.requestId,
          stakerPrincipal: event.stakerPrincipal,
          amountSats: event.l1Withdrawal.amountSats,
          maxFeeSats: event.l1Withdrawal.maxFeeSats,
          initiatedTxId: stored.txId,
          initiatedBlockHeight: stored.blockHeight,
          state: "pending",
          resolvedTxId: null,
          resolvedBlockHeight: null,
        });
      }
      continue;
    }
    if (event.kind !== "reclaim-failed-withdrawal" && event.kind !== "settle-accepted-withdrawal") {
      continue;
    }
    const withdrawal = withdrawals.get(event.requestId);
    if (!withdrawal) continue;
    withdrawals.set(event.requestId, {
      ...withdrawal,
      state: event.kind === "reclaim-failed-withdrawal" ? "reclaimed" : "settled",
      resolvedTxId: stored.txId,
      resolvedBlockHeight: stored.blockHeight,
    });
  }

  return {
    claims: claims.reverse(),
    withdrawals: [...withdrawals.values()].sort(
      (left, right) => right.initiatedBlockHeight - left.initiatedBlockHeight,
    ),
    eventCount: events.length,
    latestBlockHeight: events[0]?.blockHeight ?? null,
    claimTotal: claims.length,
    withdrawalTotal: withdrawals.size,
    pendingWithdrawalTotal: [...withdrawals.values()].filter(({ state }) => state === "pending")
      .length,
  };
}
