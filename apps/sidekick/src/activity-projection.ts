import { createHash } from "node:crypto";
import {
  type ActivityCoverage,
  type ActivityDetail,
  type ActivityDisplayStatus,
  type ActivityDomain,
  type ActivityGroupSummary,
  type ActivityOutcome,
  type ActivityResponse,
  type ActivityStage,
  type ActivityTimelineEntry,
  activityDetailSchema,
  activityResponseSchema,
  type EngineChainAnchor,
  type OperatorDeadline,
  type RewardRun,
  transactionExecutionSourceSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { z } from "zod";
import { managerEventStream } from "./manager-event-vocabulary.js";
import type { ObserverRuntimeStatus } from "./observer-server.js";
import { pox5PoolActivityStream } from "./pox5-pool-activity-sync.js";
import type { ActivityKey } from "./storage/activity-read-repository.js";
import type { SidekickStore, StoredActivityChainEvent } from "./storage/store.js";
import type {
  ActivityScopeNeighbors,
  StoredWalletIntent,
  WalletIntentObservation,
  WalletIntentState,
} from "./storage/wallet-intent-repository.js";
import type {
  StoredReconciliationObservation,
  StoredTransactionAttempt,
  StoredTransactionJob,
} from "./transaction-engine/repository.js";
import type { TransactionJobState } from "./transaction-engine/state-machine.js";

const maximumAuthorityRecords = 10_000;
export const noncanonicalReobserveRecoveryMs = 5 * 60_000;
const activityPageLimitSchema = z.number().int().min(1).max(100);
const activityIdSchema = z.string().min(1).max(500);

export type ActivityStatusFilter =
  | "all"
  | "action-required"
  | "needs-attention"
  | "in-progress"
  | "resolved";
export type ActivityTypeFilter = "all" | "actions" | "chain-events" | "configuration";
export type ActivityTimeFilter = "24h" | "7d" | "30d" | "all";

export interface ActivityQuery {
  status: ActivityStatusFilter;
  type: ActivityTypeFilter;
  domain: ActivityDomain | "all";
  time: ActivityTimeFilter;
  search: string | null;
  cursor: string | null;
  limit: number;
}

export interface ActivityProjectionContext {
  now: Date;
  burnBlockHeight: number | null;
  rewardCycleId: number | null;
  phase: "reward" | "prepare" | null;
}

interface ActivityRecord {
  summary: ActivityGroupSummary;
  timeline: ActivityTimelineEntry[];
  aliases: string[];
}

interface ActivityProjectionInput {
  records: readonly ActivityRecord[];
  coverage: ActivityCoverage[];
  query: ActivityQuery;
  context: ActivityProjectionContext;
}

interface ActivityCursor {
  version: 2;
  occurredAt: string;
  activityId: string;
  filterSha256: string;
}

export class ActivityProjectionError extends Error {
  constructor(
    readonly code: "invalid_activity_cursor" | "activity_authority_limit_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "ActivityProjectionError";
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Activity source state: ${String(value)}`);
}

export function walletIntentActivityState(state: WalletIntentState): {
  displayStatus: ActivityDisplayStatus;
  outcome: ActivityOutcome;
} {
  switch (state) {
    case "prepared":
      return { displayStatus: "action-required", outcome: "pending" };
    case "submitted":
    case "mempool":
    case "confirmed":
    case "reobserve":
      return { displayStatus: "in-progress", outcome: "pending" };
    case "complete":
      return { displayStatus: "complete", outcome: "succeeded" };
    case "failed":
      return { displayStatus: "needs-attention", outcome: "failed" };
    case "expired":
    case "superseded":
      return { displayStatus: "superseded", outcome: "superseded" };
    default:
      return assertNever(state);
  }
}

export function engineJobActivityState(state: TransactionJobState): {
  displayStatus: ActivityDisplayStatus;
  outcome: ActivityOutcome;
} {
  switch (state) {
    case "prepared":
    case "preflighted":
    case "awaiting_approval":
      return { displayStatus: "action-required", outcome: "pending" };
    case "nonce_reserved":
    case "broadcast":
    case "confirmed":
    case "noncanonical_reobserve":
      return { displayStatus: "in-progress", outcome: "pending" };
    case "blocked":
      return { displayStatus: "needs-attention", outcome: "pending" };
    case "ambiguous":
      return { displayStatus: "needs-attention", outcome: "ambiguous" };
    case "reconciled":
      return { displayStatus: "complete", outcome: "succeeded" };
    case "superseded":
      return { displayStatus: "superseded", outcome: "superseded" };
    default:
      return assertNever(state);
  }
}

export function walletIntentActivityStage(state: WalletIntentState): ActivityStage {
  switch (state) {
    case "prepared":
      return "review-ready";
    case "submitted":
      return "submitted";
    case "mempool":
      return "mempool";
    case "confirmed":
      return "confirmed";
    case "reobserve":
      return "reobserving";
    case "failed":
      return "failed";
    case "complete":
      return "complete";
    case "expired":
    case "superseded":
      return "superseded";
    default:
      return assertNever(state);
  }
}

export function engineJobActivityStage(state: TransactionJobState): ActivityStage {
  switch (state) {
    case "prepared":
      return "review-ready";
    case "preflighted":
      return "preflighted";
    case "awaiting_approval":
      return "awaiting-approval";
    case "nonce_reserved":
      return "nonce-reserved";
    case "broadcast":
      return "broadcast";
    case "confirmed":
      return "confirmed";
    case "noncanonical_reobserve":
      return "reobserving";
    case "blocked":
      return "blocked";
    case "ambiguous":
      return "ambiguous";
    case "reconciled":
      return "complete";
    case "superseded":
      return "superseded";
    default:
      return assertNever(state);
  }
}

export function engineJobActivityPresentation(
  state: TransactionJobState,
  updatedAt: string,
  now: Date,
): {
  displayStatus: ActivityDisplayStatus;
  outcome: ActivityOutcome;
  deadline: OperatorDeadline | null;
} {
  const recoveryDeadline =
    state === "noncanonical_reobserve"
      ? new Date(Date.parse(updatedAt) + noncanonicalReobserveRecoveryMs).toISOString()
      : null;
  if (
    state === "noncanonical_reobserve" &&
    recoveryDeadline !== null &&
    now.getTime() >= Date.parse(recoveryDeadline)
  ) {
    return {
      displayStatus: "needs-attention",
      outcome: "pending",
      deadline: { kind: "time", at: recoveryDeadline },
    };
  }
  return {
    ...engineJobActivityState(state),
    deadline: recoveryDeadline === null ? null : { kind: "time", at: recoveryDeadline },
  };
}

function isActive(status: ActivityDisplayStatus): boolean {
  return ["action-required", "in-progress", "needs-attention"].includes(status);
}

function deadlineOverdue(
  deadline: OperatorDeadline | null,
  context: ActivityProjectionContext,
): boolean {
  if (deadline === null) return false;
  switch (deadline.kind) {
    case "time":
      return Date.parse(deadline.at) <= context.now.getTime();
    case "burn-block":
      return (
        context.burnBlockHeight !== null && context.burnBlockHeight >= deadline.burnBlockHeight
      );
    case "reward-cycle":
      if (context.rewardCycleId === null) return false;
      if (context.rewardCycleId > deadline.rewardCycleId) return true;
      if (context.rewardCycleId < deadline.rewardCycleId) return false;
      return deadline.phase === "cycle-start" || context.phase === "prepare";
    default:
      return assertNever(deadline);
  }
}

const activeStatusPriority: Record<
  Extract<ActivityDisplayStatus, "needs-attention" | "action-required" | "in-progress">,
  number
> = {
  "needs-attention": 0,
  "action-required": 1,
  "in-progress": 2,
};

export function sortActiveActivity(
  items: readonly ActivityGroupSummary[],
  context: ActivityProjectionContext,
): ActivityGroupSummary[] {
  return [...items].sort((left, right) => {
    const leftPriority =
      activeStatusPriority[left.displayStatus as keyof typeof activeStatusPriority];
    const rightPriority =
      activeStatusPriority[right.displayStatus as keyof typeof activeStatusPriority];
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftOverdue = deadlineOverdue(left.deadline, context);
    const rightOverdue = deadlineOverdue(right.deadline, context);
    if (leftOverdue !== rightOverdue) return leftOverdue ? -1 : 1;
    const leftUrgency =
      left.urgencyAt === null ? Number.POSITIVE_INFINITY : Date.parse(left.urgencyAt);
    const rightUrgency =
      right.urgencyAt === null ? Number.POSITIVE_INFINITY : Date.parse(right.urgencyAt);
    if (leftUrgency !== rightUrgency) return leftUrgency - rightUrgency;
    const updatedDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (updatedDifference !== 0) return updatedDifference;
    return left.activityId.localeCompare(right.activityId);
  });
}

function filterDocument(query: ActivityQuery): string {
  return JSON.stringify({
    domain: query.domain,
    search: query.search,
    status: query.status,
    time: query.time,
    type: query.type,
  });
}

function filterSha256(query: ActivityQuery): string {
  return createHash("sha256").update(filterDocument(query)).digest("hex");
}

function encodeCursor(value: ActivityCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string, query: ActivityQuery): ActivityCursor {
  try {
    const parsed = z
      .object({
        version: z.literal(2),
        occurredAt: z.iso.datetime(),
        activityId: activityIdSchema,
        filterSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown);
    if (parsed.filterSha256 !== filterSha256(query)) throw new Error("filter mismatch");
    return parsed;
  } catch {
    throw new ActivityProjectionError(
      "invalid_activity_cursor",
      "Activity cursor is invalid or belongs to different filters",
    );
  }
}

function matchesStatus(item: ActivityGroupSummary, filter: ActivityStatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "action-required":
    case "needs-attention":
    case "in-progress":
      return item.displayStatus === filter;
    case "resolved":
      return ["complete", "superseded", "observed"].includes(item.displayStatus);
    default:
      return assertNever(filter);
  }
}

function matchesType(item: ActivityGroupSummary, filter: ActivityTypeFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "actions":
      return item.kind === "operation";
    case "chain-events":
      return item.kind === "chain-event";
    case "configuration":
      return item.kind === "configuration-change";
    default:
      return assertNever(filter);
  }
}

function timeCutoff(filter: ActivityTimeFilter, now: Date): number | null {
  const day = 24 * 60 * 60 * 1_000;
  switch (filter) {
    case "24h":
      return now.getTime() - day;
    case "7d":
      return now.getTime() - 7 * day;
    case "30d":
      return now.getTime() - 30 * day;
    case "all":
      return null;
    default:
      return assertNever(filter);
  }
}

function matchesSearch(item: ActivityGroupSummary, search: string | null): boolean {
  if (search === null) return true;
  const query = search.toLowerCase();
  return [item.activityId, item.actorPrincipal, ...item.txids]
    .filter((value): value is string => value !== null)
    .some((value) => value.toLowerCase().startsWith(query));
}

function matchesFilters(
  item: ActivityGroupSummary,
  query: ActivityQuery,
  context: ActivityProjectionContext,
): boolean {
  const cutoff = timeCutoff(query.time, context.now);
  return (
    matchesStatus(item, query.status) &&
    matchesType(item, query.type) &&
    (query.domain === "all" || item.domain === query.domain) &&
    (cutoff === null || isActive(item.displayStatus) || Date.parse(item.occurredAt) >= cutoff) &&
    matchesSearch(item, query.search)
  );
}

function historyOrder(left: ActivityGroupSummary, right: ActivityGroupSummary): number {
  const occurredDifference = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
  return occurredDifference !== 0
    ? occurredDifference
    : left.activityId < right.activityId
      ? -1
      : left.activityId > right.activityId
        ? 1
        : 0;
}

export function projectActivityPage(input: ActivityProjectionInput): ActivityResponse {
  const limit = activityPageLimitSchema.parse(input.query.limit);
  const matching = input.records
    .map(({ summary }) => summary)
    .filter((item) => matchesFilters(item, input.query, input.context));
  const active = sortActiveActivity(
    matching.filter(({ displayStatus }) => isActive(displayStatus)),
    input.context,
  );
  let history = matching.filter(({ displayStatus }) => !isActive(displayStatus)).sort(historyOrder);
  if (input.query.cursor !== null) {
    const cursor = decodeCursor(input.query.cursor, input.query);
    history = history.filter(
      (item) =>
        Date.parse(item.occurredAt) < Date.parse(cursor.occurredAt) ||
        (item.occurredAt === cursor.occurredAt && item.activityId > cursor.activityId),
    );
  }
  const items = history.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    history.length > limit && last
      ? encodeCursor({
          version: 2,
          occurredAt: last.occurredAt,
          activityId: last.activityId,
          filterSha256: filterSha256(input.query),
        })
      : null;
  return activityResponseSchema.parse({
    schemaVersion: 1,
    generatedAt: input.context.now.toISOString(),
    active,
    items,
    nextCursor,
    coverage: input.coverage,
  });
}

function coverage(
  source: ActivityCoverage["source"],
  status: ActivityCoverage["status"],
  observedAt: string | null,
  reason: string | null = null,
): ActivityCoverage {
  return { source, status, observedAt, anchor: null, reason };
}

const walletActionPresentation = {
  "register-self": { domain: "signer", title: "Signer registration" },
  "add-admin": { domain: "manager", title: "Add manager admin" },
  "remove-admin": { domain: "manager", title: "Remove manager admin" },
  "update-fees": { domain: "manager", title: "Update manager fees" },
  "withdraw-fees": { domain: "rewards", title: "Withdraw manager fees" },
  "sweep-fee-refunds": { domain: "rewards", title: "Sweep fee refunds" },
  "claim-rewards": { domain: "rewards", title: "Claim manager rewards" },
  "claim-staker-rewards": { domain: "rewards", title: "Claim staker rewards" },
  "calculate-rewards": { domain: "rewards", title: "Calculate PoX-5 rewards" },
} as const satisfies Record<
  StoredWalletIntent["action"],
  { domain: ActivityDomain; title: string }
>;

function walletIntentOperationScope(intent: StoredWalletIntent): string {
  if (intent.action === "register-self") return "register-self";
  if (intent.action !== "claim-staker-rewards") return intent.scope;
  if (intent.manifest === null || typeof intent.manifest !== "object") return intent.scope;
  const request = (intent.manifest as Record<string, unknown>).request;
  if (request === null || typeof request !== "object") return intent.scope;
  const rewardCycle = (request as Record<string, unknown>).rewardCycle;
  return typeof rewardCycle === "number" || typeof rewardCycle === "string"
    ? `claim-staker-rewards:${rewardCycle}`
    : intent.scope;
}

function walletIntentSummary(
  intent: StoredWalletIntent,
  observations: readonly WalletIntentObservation[],
  sourceCoverage: ActivityCoverage,
  readOnly: boolean,
  supersedesActivityId: string | null,
  supersededByActivityId: string | null,
  includeTimeline: boolean,
): ActivityRecord {
  const presentation = walletActionPresentation[intent.action];
  const base = walletIntentActivityState(intent.state);
  const lastObservation = observations.at(-1) ?? null;
  const state =
    intent.state === "failed" && lastObservation?.outcome === "abort"
      ? { displayStatus: "needs-attention" as const, outcome: "aborted" as const }
      : base;
  const activityId = `wallet-intent:${intent.id}`;
  const txids = intent.txid === null ? [] : [intent.txid];
  const primaryAction =
    readOnly || !isActive(state.displayStatus)
      ? null
      : { kind: "resume-activity" as const, activityId, label: "Resume operation" };
  const summary = walletIntentSummaryText(intent, lastObservation);
  const timeline: ActivityTimelineEntry[] = includeTimeline
    ? [
        {
          schemaVersion: 1,
          eventId: `${activityId}:prepared`,
          code: "plan-created",
          title: "Transaction plan created",
          detail: "Sidekick sealed a transaction review against current authority evidence.",
          occurredAt: intent.createdAt,
          source: "wallet-intents",
          txid: null,
          stacksBlockHeight: null,
          indexBlockHash: null,
          canonical: null,
          finalized: null,
        },
      ]
    : [];
  if (includeTimeline && intent.submittedAt !== null && intent.txid !== null) {
    timeline.push({
      schemaVersion: 1,
      eventId: `${activityId}:submitted`,
      code: "transaction-id-reported",
      title: "Transaction ID reported",
      detail: "The external wallet returned a transaction ID for independent observation.",
      occurredAt: intent.submittedAt,
      source: "wallet-intents",
      txid: intent.txid,
      stacksBlockHeight: null,
      indexBlockHash: null,
      canonical: null,
      finalized: null,
    });
  }
  for (const observation of includeTimeline ? observations : []) {
    const evidence = z
      .object({
        decoded: z.object({ executionSource: transactionExecutionSourceSchema.optional() }),
      })
      .safeParse(observation.evidence);
    const executionSource = evidence.success ? evidence.data.decoded.executionSource : undefined;
    timeline.push({
      schemaVersion: 1,
      eventId: `${activityId}:observation:${observation.id}`,
      code: `observation-${observation.outcome}`,
      title: observation.outcome.replaceAll("-", " "),
      detail: `Sidekick recorded ${observation.outcome.replaceAll("-", " ")} transaction evidence.${executionSource ? ` Execution evidence: ${executionSource === "node" ? "local node" : executionSource === "api" ? "configured API" : "configured API, corroborated by local node"}.` : ""}`,
      occurredAt: observation.observedAt,
      source: "wallet-intents",
      txid: intent.txid,
      stacksBlockHeight: observation.blockHeight,
      indexBlockHash: observation.indexBlockHash,
      canonical: observation.canonical,
      finalized: observation.outcome === "complete" ? true : null,
    });
  }
  return {
    summary: {
      schemaVersion: 1,
      activityId,
      kind: "operation",
      domain: presentation.domain,
      code: intent.action,
      title: presentation.title,
      summary,
      stage: walletIntentActivityStage(intent.state),
      operationScope: walletIntentOperationScope(intent),
      ...state,
      occurredAt: intent.createdAt,
      updatedAt: intent.updatedAt,
      deadline: intent.state === "prepared" ? { kind: "time", at: intent.expiresAt } : null,
      urgencyAt: intent.state === "prepared" ? intent.expiresAt : null,
      actorPrincipal: intent.requiredSender,
      txids,
      anchor: null,
      supersedesActivityId,
      supersededByActivityId,
      primaryAction,
      coverage: [sourceCoverage],
    },
    timeline: timeline.sort(timelineOrder),
    aliases: [activityId, ...txids.map((txid) => chainActivityId(intent.chainId, txid))].sort(),
  };
}

export function walletIntentSummaryText(
  intent: Pick<StoredWalletIntent, "state">,
  lastObservation: Pick<WalletIntentObservation, "outcome"> | null,
): string {
  switch (intent.state) {
    case "prepared":
      return "Transaction review is ready for the operator.";
    case "submitted":
      return "The transaction ID is recorded, but no canonical transaction evidence has been found yet. Refresh verification to check the local node and indexed API again.";
    case "mempool":
      return "The transaction is in the mempool and is waiting to be included in a block.";
    case "confirmed":
      return "The transaction is canonical; Sidekick is verifying the expected on-chain result.";
    case "complete":
      return "The expected on-chain result is canonical and reconciled.";
    case "reobserve":
      return "Previously observed transaction evidence is no longer canonical. Sidekick must observe it again before the result can be trusted.";
    case "failed":
      return lastObservation?.outcome === "abort"
        ? "The transaction executed and aborted."
        : "Sidekick could not verify the expected result.";
    case "expired":
      return "The sealed transaction review expired.";
    case "superseded":
      return "A newer operation replaced this transaction review.";
  }
}

function engineSummaryText(job: StoredTransactionJob): string {
  switch (job.state) {
    case "prepared":
    case "preflighted":
    case "awaiting_approval":
      return "The reward operation is ready for its next reviewed operator action.";
    case "nonce_reserved":
    case "broadcast":
    case "confirmed":
    case "noncanonical_reobserve":
      return "The reward operation is proceeding under durable observation.";
    case "blocked":
      return job.blockReason ?? "The reward operation is blocked.";
    case "ambiguous":
      return "The transaction or nonce outcome is ambiguous; do not submit a blind replacement.";
    case "reconciled":
      return "The expected reward state is canonical and reconciled.";
    case "superseded":
      return "A newer reward operation superseded this one.";
    default:
      return assertNever(job.state);
  }
}

function engineAttemptTimeline(
  activityId: string,
  attempt: StoredTransactionAttempt,
): ActivityTimelineEntry[] {
  const entries: ActivityTimelineEntry[] = [
    {
      schemaVersion: 1,
      eventId: `${activityId}:attempt:${attempt.attemptId}:signed`,
      code: "transaction-signed",
      title: "Transaction signed",
      detail: `Attempt ${attempt.attemptNumber} committed a signed transaction reference and nonce.`,
      occurredAt: attempt.createdAt,
      source: "transaction-engine",
      txid: attempt.precomputedTxid,
      stacksBlockHeight: null,
      indexBlockHash: null,
      canonical: null,
      finalized: null,
    },
  ];
  if (attempt.submittedAt !== null) {
    entries.push({
      schemaVersion: 1,
      eventId: `${activityId}:attempt:${attempt.attemptId}:submitted`,
      code: "transaction-submitted",
      title: "Transaction submitted",
      detail: `Attempt ${attempt.attemptNumber} was submitted for network observation.`,
      occurredAt: attempt.submittedAt,
      source: "transaction-engine",
      txid: attempt.precomputedTxid,
      stacksBlockHeight: null,
      indexBlockHash: null,
      canonical: null,
      finalized: null,
    });
  }
  if (attempt.inclusion !== null) {
    entries.push({
      schemaVersion: 1,
      eventId: `${activityId}:attempt:${attempt.attemptId}:inclusion`,
      code:
        attempt.inclusion.executionStatus === "success"
          ? "canonical-execution-observed"
          : "transaction-aborted",
      title:
        attempt.inclusion.executionStatus === "success"
          ? "Canonical execution observed"
          : "Transaction execution aborted",
      detail: `The node reported ${attempt.inclusion.executionStatus.replaceAll("_", " ")} execution.`,
      occurredAt: attempt.inclusion.observedAt,
      source: "transaction-engine",
      txid: attempt.precomputedTxid,
      stacksBlockHeight: attempt.inclusion.stacksBlockHeight,
      indexBlockHash: attempt.inclusion.indexBlockHash,
      canonical: attempt.inclusion.canonical,
      finalized: null,
    });
  }
  return entries;
}

function reconciliationTimeline(
  activityId: string,
  observation: StoredReconciliationObservation,
): ActivityTimelineEntry {
  return {
    schemaVersion: 1,
    eventId: `${activityId}:reconciliation:${observation.observationId}`,
    code: `post-state-${observation.outcome.replaceAll("_", "-")}`,
    title: `Post-state ${observation.outcome.replaceAll("_", " ")}`,
    detail:
      observation.reason ??
      `Sidekick recorded ${observation.outcome.replaceAll("_", " ")} post-state evidence.`,
    occurredAt: observation.observedAt,
    source: "transaction-engine",
    txid: null,
    stacksBlockHeight: observation.chainAnchor.stacksBlockHeight,
    indexBlockHash: observation.chainAnchor.indexBlockHash,
    canonical: observation.canonical,
    finalized: observation.finalityDepth > 0,
  };
}

function engineRecord(
  job: StoredTransactionJob,
  attempts: readonly StoredTransactionAttempt[],
  reconciliations: readonly StoredReconciliationObservation[],
  sourceCoverage: ActivityCoverage,
  readOnly: boolean,
  supersedesActivityId: string | null,
  now: Date,
  includeTimeline: boolean,
): ActivityRecord {
  const activityId = `engine-job:${job.jobId}`;
  const mapped = engineJobActivityPresentation(job.state, job.updatedAt, now);
  const aborted = attempts.some(
    ({ inclusion }) => inclusion !== null && inclusion.executionStatus !== "success",
  );
  const rejected = attempts.some(({ state }) => state === "rejected");
  const state =
    job.state === "blocked" && aborted
      ? { displayStatus: "needs-attention" as const, outcome: "aborted" as const }
      : job.state === "blocked" && rejected
        ? { displayStatus: "needs-attention" as const, outcome: "failed" as const }
        : mapped;
  const txids = [...new Set(attempts.map(({ precomputedTxid }) => precomputedTxid))].sort();
  const timeline: ActivityTimelineEntry[] = includeTimeline
    ? [
        {
          schemaVersion: 1,
          eventId: `${activityId}:created`,
          code: "plan-created",
          title: "Reward operation planned",
          detail: `Sidekick created a reviewed ${job.adapterId} operation plan.`,
          occurredAt: job.createdAt,
          source: "transaction-engine",
          txid: null,
          stacksBlockHeight: job.chainAnchor.stacksBlockHeight,
          indexBlockHash: job.chainAnchor.indexBlockHash,
          canonical: true,
          finalized: null,
        },
        ...attempts.flatMap((attempt) => engineAttemptTimeline(activityId, attempt)),
        ...reconciliations.map((observation) => reconciliationTimeline(activityId, observation)),
      ]
    : [];
  return {
    summary: {
      schemaVersion: 1,
      activityId,
      kind: "operation",
      domain: "rewards",
      code: job.adapterId,
      title: "Manager reward operation",
      summary:
        job.state === "noncanonical_reobserve" && mapped.displayStatus === "needs-attention"
          ? "The transaction became noncanonical and did not recover before the five-minute re-observation deadline."
          : engineSummaryText(job),
      stage: engineJobActivityStage(job.state),
      operationScope: job.operationScopeKey,
      ...state,
      occurredAt: job.createdAt,
      updatedAt: job.updatedAt,
      deadline: mapped.deadline,
      urgencyAt: mapped.deadline?.kind === "time" ? mapped.deadline.at : null,
      actorPrincipal: null,
      txids,
      anchor: job.chainAnchor as EngineChainAnchor,
      supersedesActivityId,
      supersededByActivityId:
        job.supersededByJobId === null ? null : `engine-job:${job.supersededByJobId}`,
      primaryAction:
        readOnly || !isActive(state.displayStatus)
          ? null
          : { kind: "resume-activity", activityId, label: "Resume operation" },
      coverage: [sourceCoverage],
    },
    timeline: timeline.sort(timelineOrder),
    aliases: [activityId, ...txids.map((txid) => chainActivityId(0, txid))].sort(),
  };
}

function rewardRunState(run: RewardRun): {
  displayStatus: ActivityDisplayStatus;
  outcome: ActivityOutcome;
  stage: ActivityStage;
} {
  switch (run.status) {
    case "awaiting-approval":
      return { displayStatus: "action-required", outcome: "pending", stage: "awaiting-approval" };
    case "approved":
      return { displayStatus: "in-progress", outcome: "pending", stage: "preflighted" };
    case "running":
      return { displayStatus: "in-progress", outcome: "pending", stage: "broadcast" };
    case "paused":
      return { displayStatus: "needs-attention", outcome: "pending", stage: "blocked" };
    case "halted":
      return { displayStatus: "needs-attention", outcome: "failed", stage: "failed" };
    case "completed":
      return { displayStatus: "complete", outcome: "succeeded", stage: "complete" };
    case "cancelled":
    case "expired":
      return { displayStatus: "superseded", outcome: "superseded", stage: "superseded" };
    default:
      return assertNever(run.status);
  }
}

function rewardRunTitle(run: RewardRun): string {
  const operations = new Set(run.recipe.orderedOperations);
  if (
    operations.has("claim-rewards") &&
    (operations.has("claim-staker-rewards") ||
      operations.has("settle-accepted-withdrawal") ||
      operations.has("reclaim-failed-withdrawal"))
  ) {
    return "Collect and distribute rewards";
  }
  if (operations.has("calculate-rewards")) return "Calculate rewards";
  if (operations.has("claim-rewards")) return "Collect rewards";
  if (operations.has("claim-staker-rewards")) return "Distribute staker rewards";
  if (operations.has("settle-accepted-withdrawal") || operations.has("reclaim-failed-withdrawal")) {
    return "Finish Bitcoin payouts";
  }
  return "Reward run";
}

function rewardRunRecord(
  run: RewardRun,
  sourceCoverage: ActivityCoverage,
  readOnly: boolean,
  includeTimeline: boolean,
  chainId: number,
  scheduled = false,
): ActivityRecord {
  const activityId = `reward-run:${run.runId}`;
  const state = rewardRunState(run);
  const txids = [...new Set(run.children.flatMap(({ txid }) => (txid === null ? [] : [txid])))];
  const distribution = run.recipe.distribution === 1 ? "First Distribution" : "Second Distribution";
  const progress = `${run.progress.completed} of ${run.progress.total} calls complete`;
  const summary = run.failureReason
    ? `Cycle ${run.recipe.cycle}, ${distribution}: ${progress}. ${run.failureReason}`
    : `Cycle ${run.recipe.cycle}, ${distribution}: ${progress}.`;
  const deadlineAt = !isActive(state.displayStatus)
    ? null
    : run.status === "awaiting-approval"
      ? run.approvalExpiresAt
      : run.runtimeExpiresAt;
  const timeline: ActivityTimelineEntry[] = [];
  if (includeTimeline) {
    timeline.push({
      schemaVersion: 1,
      eventId: `${activityId}:created`,
      code: "recipe-sealed",
      title: "Reward recipe sealed",
      detail: `Sidekick sealed ${run.progress.total} calls for Cycle ${run.recipe.cycle}, ${distribution}. Approval expiry: ${run.approvalExpiresAt}. Runtime cap: ${run.runtimeExpiresAt}.`,
      occurredAt: run.createdAt,
      source: "transaction-engine",
      txid: null,
      stacksBlockHeight: run.recipe.preparedAnchor.stacksBlockHeight,
      indexBlockHash: run.recipe.preparedAnchor.indexBlockHash,
      canonical: true,
      finalized: null,
    });
    if (run.approvedAt) {
      timeline.push({
        schemaVersion: 1,
        eventId: `${activityId}:approved`,
        code: "recipe-approved",
        title: "Reward run approved",
        detail: scheduled
          ? "This run was prepared by the automatic schedule and approved through the reward-run service."
          : "The operator approved this sealed reward recipe.",
        occurredAt: run.approvedAt,
        source: "transaction-engine",
        txid: null,
        stacksBlockHeight: null,
        indexBlockHash: null,
        canonical: null,
        finalized: null,
      });
    }
    timeline.push(
      ...run.children
        .filter(({ status }) => status !== "pending")
        .map(
          (child): ActivityTimelineEntry => ({
            schemaVersion: 1,
            eventId: `${activityId}:child:${child.index}:${child.status}`,
            code: `run-child-${child.status}`,
            title: `${child.operation.replaceAll("-", " ")} ${child.status.replaceAll("-", " ")}`,
            detail: [
              child.failureReason ??
                `Call ${child.index + 1} of ${run.progress.total} is ${child.status.replaceAll("-", " ")}.`,
              child.executionSource
                ? `Transaction execution evidence: ${child.executionSource === "node" ? "local node" : child.executionSource === "api" ? "configured API" : "configured API, corroborated by local node"}.`
                : null,
            ]
              .filter(Boolean)
              .join(" "),
            occurredAt: child.updatedAt,
            source: "transaction-engine",
            txid: child.txid,
            stacksBlockHeight: null,
            indexBlockHash: null,
            canonical: null,
            // Run reconciliation proves the expected effect, but the child row does not retain a
            // finality depth. Canonical chain evidence is merged into this timeline when present.
            finalized: null,
          }),
        ),
    );
    timeline.sort(timelineOrder);
  }
  return {
    summary: {
      schemaVersion: 1,
      activityId,
      kind: "operation",
      domain: "rewards",
      code: "reward-run",
      title: rewardRunTitle(run),
      summary,
      stage: state.stage,
      operationScope: `reward-run:${run.recipe.cycle}:${run.recipe.distribution}`,
      displayStatus: state.displayStatus,
      outcome: state.outcome,
      occurredAt: run.createdAt,
      updatedAt: run.updatedAt,
      deadline: deadlineAt ? { kind: "time", at: deadlineAt } : null,
      urgencyAt: deadlineAt,
      actorPrincipal: run.walletPrincipal,
      txids,
      // The sealed recipe stores the exact block anchor but not the PoX phase fields required by
      // EngineChainAnchor. Keep the summary unanchored; the creation evidence retains height/hash.
      anchor: null,
      supersedesActivityId: null,
      supersededByActivityId: null,
      primaryAction:
        readOnly || !isActive(state.displayStatus)
          ? null
          : { kind: "open-domain", page: "rewards", section: "claims", label: "Open reward run" },
      coverage: [sourceCoverage],
    },
    timeline,
    aliases: [activityId, ...txids.map((txid) => chainActivityId(chainId, txid))].sort(),
  };
}

function chainActivityId(chainId: number, txid: string): string {
  return `chain-tx:${chainId}:${txid}`;
}

function decodedEventKind(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const event = (value as Record<string, unknown>).event;
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
  const kind = (event as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : null;
}

function decodedActor(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const event = (value as Record<string, unknown>).event;
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
  const record = event as Record<string, unknown>;
  for (const field of ["stakerPrincipal", "adminPrincipal", "signer", "oldSigner"] as const) {
    if (typeof record[field] === "string") return record[field];
  }
  return null;
}

function eventDomain(kind: string | null): ActivityDomain {
  if (kind?.includes("reward") || kind?.includes("withdrawal")) return "rewards";
  if (
    kind &&
    [
      "stake",
      "stake-update",
      "unstake",
      "register-for-bond",
      "update-bond-registration",
      "unstake-sbtc",
      "announce-l1-early-exit",
    ].includes(kind)
  ) {
    return "pool";
  }
  return "manager";
}

function eventTitle(kind: string | null, decodedPayload: unknown): string {
  const relationship =
    decodedPayload && typeof decodedPayload === "object" && !Array.isArray(decodedPayload)
      ? (decodedPayload as Record<string, unknown>).event
      : null;
  const relation =
    relationship && typeof relationship === "object" && !Array.isArray(relationship)
      ? (relationship as Record<string, unknown>).relationship
      : null;
  if (kind === "stake") return "Staker joined the pool";
  if (kind === "stake-update") {
    if (relation === "joined") return "Staker moved into the pool";
    if (relation === "left") return "Staker moved to another pool";
    return "Staker updated their pool position";
  }
  if (kind === "unstake") return "Staker scheduled a pool exit";
  if (kind === "register-for-bond") return "Bond participant joined the pool";
  if (kind === "update-bond-registration") {
    if (relation === "joined") return "Bond participant moved into the pool";
    if (relation === "left") return "Bond participant moved to another pool";
    return "Bond participant updated their signer";
  }
  if (kind === "unstake-sbtc") return "Bond participant reduced locked sBTC";
  if (kind === "announce-l1-early-exit") return "Bond participant announced an early exit";
  if (kind === "claim-staker-rewards-for-signer") return "Staker reward payout recorded";
  if (kind === "claim-rewards") return "Rewards collected into the manager";
  return kind && kind !== "other" ? kind.replaceAll("-", " ") : "Manager contract activity";
}

function chainEventOccurredAt(event: StoredActivityChainEvent): string {
  return event.occurredAt ?? event.firstSeenAt;
}

function chainEventRecord(
  chainId: number,
  txid: string,
  events: readonly StoredActivityChainEvent[],
  managerCoverage: ActivityCoverage,
  poolCoverage: ActivityCoverage,
  pox5ContractId: string | null,
  includeTimeline: boolean,
): ActivityRecord {
  const activityId = chainActivityId(chainId, txid);
  const canonicalEvents = events.filter(({ canonical }) => canonical);
  const kinds = [
    ...new Set(
      events
        .map(({ decodedPayload }) => decodedEventKind(decodedPayload))
        .filter((value): value is string => value !== null),
    ),
  ].sort();
  const domain = eventDomain(kinds[0] ?? null);
  const poolEvents =
    pox5ContractId === null ? [] : events.filter(({ contractId }) => contractId === pox5ContractId);
  const occurredAt =
    [...events]
      .sort(
        (left, right) =>
          Date.parse(chainEventOccurredAt(left)) - Date.parse(chainEventOccurredAt(right)),
      )
      .map(chainEventOccurredAt)[0] ??
    events[0]?.updatedAt ??
    new Date(0).toISOString();
  const updatedAt =
    [...events].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
      ?.updatedAt ?? occurredAt;
  const summary =
    canonicalEvents.length === 0
      ? "Previously observed contract activity is no longer canonical."
      : poolEvents.length > 0
        ? `${canonicalEvents.length} verified PoX-5 pool event${canonicalEvents.length === 1 ? "" : "s"} observed.`
        : `${canonicalEvents.length} verified manager contract event${canonicalEvents.length === 1 ? "" : "s"} observed.`;
  const representative = events.find(({ decodedPayload }) => decodedEventKind(decodedPayload));
  const sourceCoverages = [managerCoverage, ...(poolEvents.length > 0 ? [poolCoverage] : [])];
  return {
    summary: {
      schemaVersion: 1,
      activityId,
      kind: "chain-event",
      domain,
      code: kinds[0] ?? "manager-contract-event",
      title:
        kinds.length === 1 && kinds[0]
          ? eventTitle(kinds[0], representative?.decodedPayload)
          : "Manager contract activity",
      summary,
      stage: "observed",
      operationScope: null,
      displayStatus: "observed",
      outcome: "observed",
      occurredAt,
      updatedAt,
      deadline: null,
      urgencyAt: null,
      actorPrincipal:
        events
          .map(({ decodedPayload }) => decodedActor(decodedPayload))
          .find((value) => value !== null) ?? null,
      txids: [txid],
      anchor: null,
      supersedesActivityId: null,
      supersededByActivityId: null,
      primaryAction: null,
      coverage: sourceCoverages,
    },
    timeline: (includeTimeline ? events : [])
      .map((event) => ({
        schemaVersion: 1 as const,
        eventId: `${activityId}:event:${event.eventIndex}`,
        code: event.canonical ? "verified-chain-event" : "chain-event-noncanonical",
        title: event.canonical ? "Verified contract event" : "Contract event became noncanonical",
        detail: `${decodedEventKind(event.decodedPayload)?.replaceAll("-", " ") ?? event.topic ?? "Manager print"} at event index ${event.eventIndex}.`,
        occurredAt: event.canonical ? chainEventOccurredAt(event) : event.updatedAt,
        source:
          pox5ContractId !== null && event.contractId === pox5ContractId
            ? ("indexed-pool-history" as const)
            : ("indexed-manager-history" as const),
        txid,
        stacksBlockHeight: event.blockHeight,
        indexBlockHash: event.indexBlockHash,
        canonical: event.canonical,
        finalized: null,
      }))
      .sort(timelineOrder),
    aliases: [activityId],
  };
}

function mergeChainRecord(operation: ActivityRecord, chainRecord: ActivityRecord): void {
  operation.aliases = [...new Set([...operation.aliases, ...chainRecord.aliases])].sort();
  operation.timeline.push(...chainRecord.timeline);
  operation.summary.coverage = [
    ...new Map(
      [...operation.summary.coverage, ...chainRecord.summary.coverage].map((value) => [
        value.source,
        value,
      ]),
    ).values(),
  ];
  if (Date.parse(chainRecord.summary.updatedAt) > Date.parse(operation.summary.updatedAt)) {
    operation.summary.updatedAt = chainRecord.summary.updatedAt;
  }
}

function settingsRecord(
  audit: { revision: number; changedFields: string[]; changedAt: string },
  sourceCoverage: ActivityCoverage,
  includeTimeline: boolean,
): ActivityRecord {
  const activityId = `settings:${audit.revision}`;
  const changed = audit.changedFields.join(", ");
  return {
    summary: {
      schemaVersion: 1,
      activityId,
      kind: "configuration-change",
      domain: "sidekick",
      code: "runtime-settings-updated",
      title: "Runtime settings updated",
      summary: `Changed ${changed}.`,
      stage: "recorded",
      operationScope: null,
      displayStatus: "observed",
      outcome: "observed",
      occurredAt: audit.changedAt,
      updatedAt: audit.changedAt,
      deadline: null,
      urgencyAt: null,
      actorPrincipal: null,
      txids: [],
      anchor: null,
      supersedesActivityId: null,
      supersededByActivityId: null,
      primaryAction: null,
      coverage: [sourceCoverage],
    },
    timeline: includeTimeline
      ? [
          {
            schemaVersion: 1,
            eventId: `${activityId}:updated`,
            code: "runtime-settings-updated",
            title: "Runtime settings updated",
            detail: `Revision ${audit.revision} changed ${changed}. Secret values are not retained in Activity.`,
            occurredAt: audit.changedAt,
            source: "settings-audit",
            txid: null,
            stacksBlockHeight: null,
            indexBlockHash: null,
            canonical: null,
            finalized: null,
          },
        ]
      : [],
    aliases: [activityId],
  };
}

function timelineOrder(left: ActivityTimelineEntry, right: ActivityTimelineEntry): number {
  const occurredDifference = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  return occurredDifference !== 0 ? occurredDifference : left.eventId.localeCompare(right.eventId);
}

function latestObservedAt(values: readonly { updatedAt: string }[]): string | null {
  return (
    [...values].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
      ?.updatedAt ?? null
  );
}

function requireBounded<T>(values: readonly T[], authority: string): void {
  if (values.length > maximumAuthorityRecords) {
    throw new ActivityProjectionError(
      "activity_authority_limit_exceeded",
      `${authority} exceeds the bounded ${maximumAuthorityRecords}-record Activity read`,
    );
  }
}

interface ActivityReadContext {
  cursors: Map<string, ReturnType<SidekickStore["chainState"]["getCursor"]>>;
  observations: Map<string, WalletIntentObservation>;
  observedIntentIds: Set<string>;
  neighbors: Map<string, ActivityScopeNeighbors>;
  events: Map<string, StoredActivityChainEvent[]>;
}

function activityReadContext(): ActivityReadContext {
  return {
    cursors: new Map(),
    observations: new Map(),
    observedIntentIds: new Set(),
    neighbors: new Map(),
    events: new Map(),
  };
}

export class ActivityProjectionService {
  constructor(
    private readonly options: {
      store: SidekickStore;
      chainId: number;
      managerPrincipal: string;
      sourceId(): string;
      observerStatus?(): ObserverRuntimeStatus;
      now?(): Date;
      context?(): Omit<ActivityProjectionContext, "now"> | null;
      pox5ContractId?(): string | null;
    },
  ) {}

  page(query: ActivityQuery, readOnly = false): ActivityResponse {
    const now = this.options.now?.() ?? new Date();
    const context = {
      now,
      ...(this.options.context?.() ?? { burnBlockHeight: null, rewardCycleId: null, phase: null }),
    };
    const limit = activityPageLimitSchema.parse(query.limit);
    const cursor = query.cursor === null ? null : decodeCursor(query.cursor, query);
    const reads = activityReadContext();
    const records = this.activeRecords(readOnly, now, reads);
    const cutoff = timeCutoff(query.time, now);
    // A selective domain/search can yield a short (even empty) page with a continuation.
    // Bound hydration per request; never scan and decode every historical plan for a GET.
    const keys = ["all", "resolved"].includes(query.status)
      ? this.options.store.activity.historyKeys({
          chainId: this.options.chainId,
          contracts: [this.options.managerPrincipal, ...this.relatedActivityContracts()],
          type: query.type,
          cutoff: cutoff === null ? null : new Date(cutoff).toISOString(),
          after: cursor,
          limit: 201,
        })
      : [];
    this.prepareSummaryReads(keys.slice(0, 200), reads);
    let matching = 0;
    let lastScanned: (typeof keys)[number] | null = null;
    for (const key of keys.slice(0, 200)) {
      const record = this.loadDetail(key.activityId, readOnly, now, false, reads);
      lastScanned = key;
      if (record && matchesFilters(record.summary, query, context)) {
        records.push(record);
        matching += 1;
        if (matching > limit) break;
      }
    }
    const result = projectActivityPage({
      records,
      coverage: this.pageCoverage(reads),
      query,
      context,
    });
    if (result.nextCursor === null && keys.length > 200 && lastScanned) {
      result.nextCursor = encodeCursor({
        version: 2,
        ...lastScanned,
        filterSha256: filterSha256(query),
      });
    }
    return result;
  }

  detail(activityId: string, readOnly = false): ActivityDetail | null {
    const requestedActivityId = activityIdSchema.parse(activityId);
    const record = this.loadDetail(
      requestedActivityId,
      readOnly,
      this.options.now?.() ?? new Date(),
      true,
      activityReadContext(),
    );
    if (!record) return null;
    return activityDetailSchema.parse({
      schemaVersion: 1,
      requestedActivityId,
      canonicalActivityId: record.summary.activityId,
      aliases: [...new Set(record.aliases)].sort(),
      summary: record.summary,
      timeline: record.timeline.sort(timelineOrder),
    });
  }

  private loadDetail(
    requestedActivityId: string,
    readOnly: boolean,
    now: Date,
    includeTimeline: boolean,
    reads: ActivityReadContext,
  ): ActivityRecord | null {
    const walletMatch = /^wallet-intent:(.+)$/.exec(requestedActivityId);
    if (walletMatch?.[1]) {
      const parsedId = z.string().uuid().safeParse(walletMatch[1]);
      if (!parsedId.success) return null;
      const intent = this.options.store.walletIntents.get(parsedId.data);
      return intent ? this.walletDetailRecord(intent, readOnly, includeTimeline, reads) : null;
    }

    const engineMatch = /^engine-job:(.+)$/.exec(requestedActivityId);
    if (engineMatch?.[1]) {
      const parsedId = z.string().uuid().safeParse(engineMatch[1]);
      if (!parsedId.success) return null;
      const job = this.options.store.transactionEngine.getLogicalJob(parsedId.data);
      return job ? this.engineDetailRecord(job, readOnly, now, includeTimeline, reads) : null;
    }

    const rewardRunMatch = /^reward-run:(.+)$/.exec(requestedActivityId);
    if (rewardRunMatch?.[1]) {
      const parsedId = z.string().uuid().safeParse(rewardRunMatch[1]);
      if (!parsedId.success) return null;
      const run = this.options.store.rewardRuns.get(parsedId.data);
      return run ? this.rewardRunDetailRecord(run, readOnly, includeTimeline, reads) : null;
    }

    const chainMatch = /^chain-tx:(\d+):(0x[0-9a-f]{64})$/.exec(requestedActivityId);
    if (chainMatch?.[1] && chainMatch[2]) {
      const chainId = Number(chainMatch[1]);
      if (!Number.isSafeInteger(chainId) || chainId !== this.options.chainId) return null;
      const txid = chainMatch[2];
      // Match the full projection's deterministic authority precedence: wallet intent, recipe run,
      // legacy engine job, then a standalone verified chain record.
      // History keys already exclude every owned transaction before pagination. Only a direct
      // detail/alias request needs to resolve ownership again.
      if (includeTimeline) {
        const intent = this.options.store.walletIntents.getByTxid(txid);
        if (intent) return this.walletDetailRecord(intent, readOnly, includeTimeline, reads);
        const run = this.options.store.rewardRuns.getByTxid(txid);
        if (run) return this.rewardRunDetailRecord(run, readOnly, includeTimeline, reads);
        const job = this.options.store.transactionEngine.getLogicalJobByTxid(txid);
        if (job) return this.engineDetailRecord(job, readOnly, now, includeTimeline, reads);
      }
      const events = this.detailChainEvents([txid], reads).get(txid) ?? [];
      const managerCoverage = this.indexedCoverage(events, reads);
      const poolCoverage = this.poolIndexedCoverage(events, reads);
      return events.length === 0
        ? null
        : chainEventRecord(
            this.options.chainId,
            txid,
            events,
            managerCoverage,
            poolCoverage,
            this.pox5ContractId(),
            includeTimeline,
          );
    }

    const settingsMatch = /^settings:(\d+)$/.exec(requestedActivityId);
    if (settingsMatch?.[1]) {
      const revision = Number(settingsMatch[1]);
      if (!Number.isSafeInteger(revision) || revision < 1) return null;
      const audit = this.options.store.runtimeSettings.getAudit(revision);
      return audit
        ? settingsRecord(
            audit,
            coverage("settings-audit", "current", audit.changedAt),
            includeTimeline,
          )
        : null;
    }
    return null;
  }

  private walletDetailRecord(
    intent: StoredWalletIntent,
    readOnly: boolean,
    includeTimeline: boolean,
    reads: ActivityReadContext,
  ): ActivityRecord {
    this.prepareSummaryReads(
      [{ activityId: `wallet-intent:${intent.id}`, occurredAt: intent.createdAt }],
      reads,
    );
    const { previous, next } = reads.neighbors.get(intent.id) ?? { previous: null, next: null };
    const latestObservation = reads.observations.get(intent.id);
    const record = walletIntentSummary(
      intent,
      includeTimeline
        ? this.options.store.walletIntents.listObservations(intent.id)
        : latestObservation
          ? [latestObservation]
          : [],
      coverage("wallet-intents", "current", intent.updatedAt),
      readOnly,
      previous && ["expired", "superseded"].includes(previous.state)
        ? `wallet-intent:${previous.id}`
        : null,
      ["expired", "superseded"].includes(intent.state) && next ? `wallet-intent:${next.id}` : null,
      includeTimeline,
    );
    this.mergeDetailChainEvents(record, includeTimeline, reads);
    return record;
  }

  private engineDetailRecord(
    job: StoredTransactionJob,
    readOnly: boolean,
    now: Date,
    includeTimeline: boolean,
    reads: ActivityReadContext,
  ): ActivityRecord {
    const previous = this.options.store.transactionEngine.getLogicalJobSupersededBy(job.jobId);
    const attempts = this.options.store.transactionEngine.listAttempts(job.jobId);
    const record = engineRecord(
      job,
      attempts,
      includeTimeline
        ? this.options.store.transactionEngine.listReconciliationObservations(job.jobId)
        : [],
      coverage("transaction-engine", "current", job.updatedAt),
      readOnly,
      previous ? `engine-job:${previous.jobId}` : null,
      now,
      includeTimeline,
    );
    record.aliases = [
      record.summary.activityId,
      ...record.summary.txids.map((txid) => chainActivityId(this.options.chainId, txid)),
    ].sort();
    this.mergeDetailChainEvents(record, includeTimeline, reads);
    return record;
  }

  private rewardRunDetailRecord(
    run: RewardRun,
    readOnly: boolean,
    includeTimeline: boolean,
    reads: ActivityReadContext,
  ): ActivityRecord {
    const record = rewardRunRecord(
      run,
      coverage("transaction-engine", "current", run.updatedAt),
      readOnly,
      includeTimeline,
      this.options.chainId,
      this.options.store.rewardSchedule.isScheduled(run.runId),
    );
    this.mergeDetailChainEvents(record, includeTimeline, reads);
    return record;
  }

  private prepareSummaryReads(keys: readonly ActivityKey[], reads: ActivityReadContext): void {
    const ids = keys.flatMap(({ activityId }) => {
      const id = /^wallet-intent:(.+)$/.exec(activityId)?.[1];
      return id && !reads.observedIntentIds.has(id) ? [id] : [];
    });
    if (ids.length > 0) {
      for (const id of ids) reads.observedIntentIds.add(id);
      for (const [
        id,
        observation,
      ] of this.options.store.walletIntents.listLatestObservationsForActivity(ids)) {
        reads.observations.set(id, observation);
      }
      for (const [id, neighbors] of this.options.store.walletIntents.listActivityScopeNeighbors(
        ids,
      )) {
        reads.neighbors.set(id, neighbors);
      }
    }
    this.detailChainEvents(
      keys.flatMap(({ activityId }) => {
        const txid = /^chain-tx:\d+:(0x[0-9a-f]{64})$/.exec(activityId)?.[1];
        return txid ? [txid] : [];
      }),
      reads,
    );
  }

  private detailChainEvents(
    txids: readonly string[],
    reads: ActivityReadContext,
  ): Map<string, StoredActivityChainEvent[]> {
    const missing = [...new Set(txids)].filter((txid) => !reads.events.has(txid));
    if (missing.length > 0) {
      for (const txid of missing) reads.events.set(txid, []);
      for (const event of this.options.store.listManagerActivityChainEventsForTxids(
        this.options.chainId,
        this.options.managerPrincipal,
        missing,
        this.relatedActivityContracts(),
      ))
        reads.events.get(event.txId)?.push(event);
    }
    return reads.events;
  }

  private mergeDetailChainEvents(
    record: ActivityRecord,
    includeTimeline: boolean,
    reads: ActivityReadContext,
  ): void {
    const byTxid = this.detailChainEvents(record.summary.txids, reads);
    for (const txid of record.summary.txids) {
      const events = byTxid.get(txid) ?? [];
      if (events.length === 0) continue;
      mergeChainRecord(
        record,
        chainEventRecord(
          this.options.chainId,
          txid,
          events,
          this.indexedCoverage(events, reads),
          this.poolIndexedCoverage(events, reads),
          this.pox5ContractId(),
          includeTimeline,
        ),
      );
    }
  }

  /** Overview needs active authorities, never terminal history. */
  active(readOnly = false): ActivityResponse {
    const now = this.options.now?.() ?? new Date();
    const reads = activityReadContext();
    const records = this.activeRecords(readOnly, now, reads);
    return projectActivityPage({
      records,
      coverage: this.pageCoverage(reads),
      query: {
        status: "all",
        type: "all",
        domain: "all",
        time: "all",
        search: null,
        cursor: null,
        limit: 1,
      },
      context: {
        now,
        ...(this.options.context?.() ?? {
          burnBlockHeight: null,
          rewardCycleId: null,
          phase: null,
        }),
      },
    });
  }

  private activeRecords(
    readOnly: boolean,
    now: Date,
    reads: ActivityReadContext,
  ): ActivityRecord[] {
    const keys = this.options.store.activity.activeKeys(maximumAuthorityRecords + 1);
    requireBounded(keys, "Active operation authority");
    this.prepareSummaryReads(keys, reads);
    return keys.flatMap(({ activityId }) => {
      const record = this.loadDetail(activityId, readOnly, now, false, reads);
      return record ? [record] : [];
    });
  }

  private pageCoverage(reads: ActivityReadContext): ActivityCoverage[] {
    return [
      coverage("wallet-intents", "current", null),
      coverage("transaction-engine", "current", null),
      this.indexedCoverage([], reads),
      this.poolIndexedCoverage([], reads),
      this.observerCoverage(),
      coverage("settings-audit", "current", null),
    ];
  }

  private indexedCoverage(
    events: readonly StoredActivityChainEvent[],
    reads: ActivityReadContext,
  ): ActivityCoverage {
    const generic = this.readCursor(
      reads,
      managerEventStream(this.options.managerPrincipal, "generic-v1"),
    );
    const reference = this.readCursor(
      reads,
      managerEventStream(this.options.managerPrincipal, "reference-manager-v1"),
    );
    const cursor = [generic, reference]
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (!cursor) {
      return coverage(
        "indexed-manager-history",
        "delayed",
        latestObservedAt(events),
        "No manager-history synchronization cursor is available yet.",
      );
    }
    return coverage(
      "indexed-manager-history",
      cursor.cursor === null ? "current" : "delayed",
      cursor.updatedAt,
      cursor.cursor === null ? null : "Indexed manager history synchronization is incomplete.",
    );
  }

  private readCursor(reads: ActivityReadContext, stream: string) {
    if (!reads.cursors.has(stream))
      reads.cursors.set(
        stream,
        this.options.store.chainState.getCursor(this.options.sourceId(), stream),
      );
    return reads.cursors.get(stream) ?? null;
  }

  private pox5ContractId(): string | null {
    return this.options.pox5ContractId?.() ?? null;
  }

  private relatedActivityContracts(): string[] {
    const pox5ContractId = this.pox5ContractId();
    return pox5ContractId === null ? [] : [pox5ContractId];
  }

  private poolIndexedCoverage(
    events: readonly StoredActivityChainEvent[],
    reads: ActivityReadContext,
  ): ActivityCoverage {
    const pox5ContractId = this.pox5ContractId();
    if (!pox5ContractId) {
      return coverage(
        "indexed-pool-history",
        "not-configured",
        null,
        "PoX-5 pool activity is unavailable until the active contract is identified.",
      );
    }
    const cursor = this.readCursor(
      reads,
      pox5PoolActivityStream(pox5ContractId, this.options.managerPrincipal),
    );
    const poolEvents = events.filter(({ contractId }) => contractId === pox5ContractId);
    if (!cursor) {
      return coverage(
        "indexed-pool-history",
        "delayed",
        latestObservedAt(poolEvents),
        "No PoX-5 pool-activity synchronization cursor is available yet.",
      );
    }
    return coverage(
      "indexed-pool-history",
      cursor.cursor === null ? "current" : "delayed",
      cursor.updatedAt,
      cursor.cursor === null
        ? "Pool activity is captured from Sidekick observer activation forward."
        : "PoX-5 pool activity synchronization is catching up to a verified observer trigger.",
    );
  }

  private observerCoverage(): ActivityCoverage {
    const status = this.options.observerStatus?.();
    if (!status?.enabled) {
      return coverage("observer", "not-configured", null, "The event observer is not configured.");
    }
    const observedAt = status.inbox.lastProcessedAt ?? status.inbox.lastReceivedAt;
    if (!status.listening) {
      return coverage(
        "observer",
        "unavailable",
        observedAt,
        "The event observer is not listening.",
      );
    }
    if (status.gap?.status === "degraded") {
      return coverage("observer", "delayed", observedAt, "Verified observer delivery is delayed.");
    }
    return coverage("observer", "current", observedAt);
  }
}
