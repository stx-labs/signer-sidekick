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
} from "@stx-labs/signer-sidekick-api-contracts";
import { z } from "zod";
import { managerEventStream } from "./manager-event-vocabulary.js";
import type { ObserverRuntimeStatus } from "./observer-server.js";
import { pox5PoolActivityStream } from "./pox5-pool-activity-sync.js";
import type { SidekickStore, StoredActivityChainEvent } from "./storage/store.js";
import type {
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
    : left.activityId.localeCompare(right.activityId);
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

function historyCoverage(
  source: ActivityCoverage["source"],
  observedAt: string | null,
  truncated: boolean,
): ActivityCoverage {
  return coverage(
    source,
    truncated ? "delayed" : "current",
    observedAt,
    truncated
      ? `Activity history is bounded to the newest ${maximumAuthorityRecords} ${source} records; active work remains complete.`
      : null,
  );
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
    timeline.push({
      schemaVersion: 1,
      eventId: `${activityId}:observation:${observation.id}`,
      code: `observation-${observation.outcome}`,
      title: observation.outcome.replaceAll("-", " "),
      detail: `Sidekick recorded ${observation.outcome.replaceAll("-", " ")} transaction evidence.`,
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
  return kind ? kind.replaceAll("-", " ") : "Manager contract activity";
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
    timeline: events
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
  operation.timeline = [...operation.timeline, ...chainRecord.timeline].sort(timelineOrder);
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
    timeline: [
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
    ],
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
    const loaded = this.load(readOnly, now, false);
    const chainContext = this.options.context?.() ?? {
      burnBlockHeight: null,
      rewardCycleId: null,
      phase: null,
    };
    return projectActivityPage({
      records: loaded.records,
      coverage: loaded.coverage,
      query,
      context: {
        now,
        ...chainContext,
      },
    });
  }

  detail(activityId: string, readOnly = false): ActivityDetail | null {
    const requestedActivityId = activityIdSchema.parse(activityId);
    const record = this.loadDetail(
      requestedActivityId,
      readOnly,
      this.options.now?.() ?? new Date(),
    );
    if (!record) return null;
    return activityDetailSchema.parse({
      schemaVersion: 1,
      requestedActivityId,
      canonicalActivityId: record.summary.activityId,
      aliases: [...new Set(record.aliases)].sort(),
      summary: record.summary,
      timeline: record.timeline,
    });
  }

  private loadDetail(
    requestedActivityId: string,
    readOnly: boolean,
    now: Date,
  ): ActivityRecord | null {
    const walletMatch = /^wallet-intent:(.+)$/.exec(requestedActivityId);
    if (walletMatch?.[1]) {
      const parsedId = z.string().uuid().safeParse(walletMatch[1]);
      if (!parsedId.success) return null;
      const intent = this.options.store.walletIntents.get(parsedId.data);
      return intent ? this.walletDetailRecord(intent, readOnly) : null;
    }

    const engineMatch = /^engine-job:(.+)$/.exec(requestedActivityId);
    if (engineMatch?.[1]) {
      const parsedId = z.string().uuid().safeParse(engineMatch[1]);
      if (!parsedId.success) return null;
      const job = this.options.store.transactionEngine.getLogicalJob(parsedId.data);
      return job ? this.engineDetailRecord(job, readOnly, now) : null;
    }

    const chainMatch = /^chain-tx:(\d+):(0x[0-9a-f]{64})$/.exec(requestedActivityId);
    if (chainMatch?.[1] && chainMatch[2]) {
      const chainId = Number(chainMatch[1]);
      if (!Number.isSafeInteger(chainId) || chainId !== this.options.chainId) return null;
      const txid = chainMatch[2];
      // Match the full projection's deterministic authority precedence: wallet intent, engine job,
      // then a standalone verified chain record.
      const intent = this.options.store.walletIntents.getByTxid(txid);
      if (intent) return this.walletDetailRecord(intent, readOnly);
      const job = this.options.store.transactionEngine.getLogicalJobByTxid(txid);
      if (job) return this.engineDetailRecord(job, readOnly, now);
      const events = this.detailChainEvents(txid);
      const managerCoverage = this.indexedCoverage(events);
      const poolCoverage = this.poolIndexedCoverage(events);
      return events.length === 0
        ? null
        : chainEventRecord(
            this.options.chainId,
            txid,
            events,
            managerCoverage,
            poolCoverage,
            this.pox5ContractId(),
          );
    }

    const settingsMatch = /^settings:(\d+)$/.exec(requestedActivityId);
    if (settingsMatch?.[1]) {
      const revision = Number(settingsMatch[1]);
      if (!Number.isSafeInteger(revision) || revision < 1) return null;
      const audit = this.options.store.runtimeSettings.getAudit(revision);
      return audit
        ? settingsRecord(audit, coverage("settings-audit", "current", audit.changedAt))
        : null;
    }
    return null;
  }

  private walletDetailRecord(intent: StoredWalletIntent, readOnly: boolean): ActivityRecord {
    const { previous, next } = this.options.store.walletIntents.getActivityScopeNeighbors(intent);
    const record = walletIntentSummary(
      intent,
      this.options.store.walletIntents.listObservations(intent.id),
      coverage("wallet-intents", "current", intent.updatedAt),
      readOnly,
      previous && ["expired", "superseded"].includes(previous.state)
        ? `wallet-intent:${previous.id}`
        : null,
      ["expired", "superseded"].includes(intent.state) && next ? `wallet-intent:${next.id}` : null,
      true,
    );
    this.mergeDetailChainEvents(record);
    return record;
  }

  private engineDetailRecord(
    job: StoredTransactionJob,
    readOnly: boolean,
    now: Date,
  ): ActivityRecord {
    const previous = this.options.store.transactionEngine.getLogicalJobSupersededBy(job.jobId);
    const attempts = this.options.store.transactionEngine.listAttempts(job.jobId);
    const record = engineRecord(
      job,
      attempts,
      this.options.store.transactionEngine.listReconciliationObservations(job.jobId),
      coverage("transaction-engine", "current", job.updatedAt),
      readOnly,
      previous ? `engine-job:${previous.jobId}` : null,
      now,
      true,
    );
    record.aliases = [
      record.summary.activityId,
      ...record.summary.txids.map((txid) => chainActivityId(this.options.chainId, txid)),
    ].sort();
    this.mergeDetailChainEvents(record);
    return record;
  }

  private detailChainEvents(txid: string): StoredActivityChainEvent[] {
    return this.options.store.listManagerActivityChainEventsForTxid(
      this.options.chainId,
      this.options.managerPrincipal,
      txid,
      this.relatedActivityContracts(),
    );
  }

  private mergeDetailChainEvents(record: ActivityRecord): void {
    for (const txid of record.summary.txids) {
      const events = this.detailChainEvents(txid);
      if (events.length === 0) continue;
      const managerCoverage = this.indexedCoverage(events);
      const poolCoverage = this.poolIndexedCoverage(events);
      mergeChainRecord(
        record,
        chainEventRecord(
          this.options.chainId,
          txid,
          events,
          managerCoverage,
          poolCoverage,
          this.pox5ContractId(),
        ),
      );
    }
  }

  private load(
    readOnly: boolean,
    now: Date,
    includeTimelines: boolean,
  ): { records: ActivityRecord[]; coverage: ActivityCoverage[] } {
    const recentWalletIntents = this.options.store.walletIntents.listForActivity(
      maximumAuthorityRecords + 1,
    );
    const walletHistoryTruncated = recentWalletIntents.length > maximumAuthorityRecords;
    const activeWalletIntents = this.options.store.walletIntents.listActiveForActivity(
      maximumAuthorityRecords + 1,
    );
    requireBounded(activeWalletIntents, "Active wallet intent authority");
    const walletIntents = [
      ...new Map(
        [...recentWalletIntents.slice(0, maximumAuthorityRecords), ...activeWalletIntents].map(
          (intent) => [intent.id, intent],
        ),
      ).values(),
    ];

    const activeJobStates = [
      "prepared",
      "preflighted",
      "awaiting_approval",
      "nonce_reserved",
      "broadcast",
      "confirmed",
      "blocked",
      "ambiguous",
      "noncanonical_reobserve",
    ] as const satisfies readonly TransactionJobState[];
    const activeJobs: StoredTransactionJob[] = [];
    let cursor: string | undefined;
    while (activeJobs.length <= maximumAuthorityRecords) {
      const page = this.options.store.transactionEngine.listLogicalJobs({
        limit: 200,
        states: activeJobStates,
        ...(cursor === undefined ? {} : { cursor }),
      });
      activeJobs.push(...page.items);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    requireBounded(activeJobs, "Active transaction engine authority");

    const terminalJobs: StoredTransactionJob[] = [];
    cursor = undefined;
    let engineHistoryTruncated = false;
    while (terminalJobs.length <= maximumAuthorityRecords) {
      const page = this.options.store.transactionEngine.listLogicalJobs({
        limit: 200,
        states: ["reconciled", "superseded"],
        ...(cursor === undefined ? {} : { cursor }),
      });
      engineHistoryTruncated ||= page.total > maximumAuthorityRecords;
      terminalJobs.push(...page.items);
      if (page.nextCursor === null || terminalJobs.length > maximumAuthorityRecords) break;
      cursor = page.nextCursor;
    }
    const jobs = [
      ...new Map(
        [...activeJobs, ...terminalJobs.slice(0, maximumAuthorityRecords)].map((job) => [
          job.jobId,
          job,
        ]),
      ).values(),
    ];

    const recentChainEvents = this.options.store.listManagerActivityChainEvents(
      this.options.chainId,
      this.options.managerPrincipal,
      maximumAuthorityRecords + 1,
      this.relatedActivityContracts(),
    );
    const chainHistoryTruncated = recentChainEvents.length > maximumAuthorityRecords;
    const chainEvents = recentChainEvents.slice(0, maximumAuthorityRecords);
    const recentSettingsAudit = this.options.store.runtimeSettings.listAudit(
      maximumAuthorityRecords + 1,
    );
    const settingsHistoryTruncated = recentSettingsAudit.length > maximumAuthorityRecords;
    const settingsAudit = recentSettingsAudit.slice(0, maximumAuthorityRecords);

    const walletObservedAt = latestObservedAt(walletIntents);
    const walletCoverage = historyCoverage(
      "wallet-intents",
      walletObservedAt,
      walletHistoryTruncated,
    );
    const walletRecordCoverage = coverage("wallet-intents", "current", walletObservedAt);
    const engineObservedAt = latestObservedAt(jobs);
    const engineCoverage = historyCoverage(
      "transaction-engine",
      engineObservedAt,
      engineHistoryTruncated,
    );
    const engineRecordCoverage = coverage("transaction-engine", "current", engineObservedAt);
    const indexedCoverage = this.indexedCoverage(chainEvents, chainHistoryTruncated);
    const poolIndexedCoverage = this.poolIndexedCoverage(chainEvents, chainHistoryTruncated);
    const settingsObservedAt = settingsAudit[0]?.changedAt ?? null;
    const settingsCoverage = historyCoverage(
      "settings-audit",
      settingsObservedAt,
      settingsHistoryTruncated,
    );
    const settingsRecordCoverage = coverage("settings-audit", "current", settingsObservedAt);
    const observerCoverage = this.observerCoverage();

    const walletByScope = new Map<string, StoredWalletIntent[]>();
    for (const intent of walletIntents) {
      const key = `${intent.action}:${intent.scope}`;
      const values = walletByScope.get(key) ?? [];
      values.push(intent);
      walletByScope.set(key, values);
    }
    const latestWalletObservations = includeTimelines
      ? null
      : this.options.store.walletIntents.listLatestObservationsForActivity(
          walletIntents.map(({ id }) => id),
        );
    const walletRecords = walletIntents.map((intent) => {
      const related = [...(walletByScope.get(`${intent.action}:${intent.scope}`) ?? [])].sort(
        (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
      );
      const index = related.findIndex(({ id }) => id === intent.id);
      const previous = index > 0 ? related[index - 1] : undefined;
      const next = index >= 0 ? related[index + 1] : undefined;
      const latestObservation = latestWalletObservations?.get(intent.id);
      return walletIntentSummary(
        intent,
        includeTimelines
          ? this.options.store.walletIntents.listObservations(intent.id)
          : latestObservation
            ? [latestObservation]
            : [],
        walletRecordCoverage,
        readOnly,
        previous && ["expired", "superseded"].includes(previous.state)
          ? `wallet-intent:${previous.id}`
          : null,
        ["expired", "superseded"].includes(intent.state) && next
          ? `wallet-intent:${next.id}`
          : null,
        includeTimelines,
      );
    });

    const supersededEngineJobs = new Map<string, string>();
    for (const job of jobs) {
      if (job.supersededByJobId !== null) {
        supersededEngineJobs.set(job.supersededByJobId, `engine-job:${job.jobId}`);
      }
    }
    const attemptsByJob = includeTimelines
      ? null
      : this.options.store.transactionEngine.listAttemptsForActivity(
          jobs.map(({ jobId }) => jobId),
        );
    const engineRecords = jobs.map((job) =>
      engineRecord(
        job,
        includeTimelines
          ? this.options.store.transactionEngine.listAttempts(job.jobId)
          : (attemptsByJob?.get(job.jobId) ?? []),
        includeTimelines
          ? this.options.store.transactionEngine.listReconciliationObservations(job.jobId)
          : [],
        engineRecordCoverage,
        readOnly,
        supersededEngineJobs.get(job.jobId) ?? null,
        now,
        includeTimelines,
      ),
    );

    const groupedEvents = new Map<string, StoredActivityChainEvent[]>();
    for (const event of chainEvents) {
      const values = groupedEvents.get(event.txId) ?? [];
      values.push(event);
      groupedEvents.set(event.txId, values);
    }

    // Engine records use a chain-agnostic placeholder while being built. Bind their aliases to the
    // configured deployment chain here so absorbed chain-event links remain stable.
    for (const record of engineRecords) {
      record.aliases = [
        record.summary.activityId,
        ...record.summary.txids.map((txid) => chainActivityId(this.options.chainId, txid)),
      ].sort();
    }

    const operationByTxid = new Map<string, ActivityRecord>();
    for (const record of [...walletRecords, ...engineRecords]) {
      for (const txid of record.summary.txids) {
        // Wallet intents and engine jobs are separate operation authorities. If corrupt or
        // unexpected data assigns one transaction to more than one operation, keep the first
        // deterministic owner rather than duplicating verified chain evidence across the feed.
        if (!operationByTxid.has(txid)) operationByTxid.set(txid, record);
      }
    }
    const chainRecords: ActivityRecord[] = [];
    for (const [txid, events] of groupedEvents.entries()) {
      const chainRecord = chainEventRecord(
        this.options.chainId,
        txid,
        events,
        indexedCoverage,
        poolIndexedCoverage,
        this.pox5ContractId(),
      );
      const operation = operationByTxid.get(txid);
      if (!operation) {
        chainRecords.push(chainRecord);
        continue;
      }
      mergeChainRecord(operation, chainRecord);
    }

    const settingsRecords = settingsAudit.map((audit) =>
      settingsRecord(audit, settingsRecordCoverage),
    );

    return {
      records: [...walletRecords, ...engineRecords, ...chainRecords, ...settingsRecords],
      coverage: [
        walletCoverage,
        engineCoverage,
        indexedCoverage,
        poolIndexedCoverage,
        observerCoverage,
        settingsCoverage,
      ],
    };
  }

  private indexedCoverage(
    events: readonly StoredActivityChainEvent[],
    historyTruncated = false,
  ): ActivityCoverage {
    const generic = this.options.store.chainState.getCursor(
      this.options.sourceId(),
      managerEventStream(this.options.managerPrincipal, "generic-v1"),
    );
    const reference = this.options.store.chainState.getCursor(
      this.options.sourceId(),
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
    if (historyTruncated) {
      return coverage(
        "indexed-manager-history",
        "delayed",
        cursor.updatedAt,
        `Indexed manager Activity history is bounded to the newest ${maximumAuthorityRecords} records.`,
      );
    }
    return coverage(
      "indexed-manager-history",
      cursor.cursor === null ? "current" : "delayed",
      cursor.updatedAt,
      cursor.cursor === null ? null : "Indexed manager history synchronization is incomplete.",
    );
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
    historyTruncated = false,
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
    const cursor = this.options.store.chainState.getCursor(
      this.options.sourceId(),
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
    if (historyTruncated) {
      return coverage(
        "indexed-pool-history",
        "delayed",
        cursor.updatedAt,
        `Pool Activity history is bounded to the newest ${maximumAuthorityRecords} records.`,
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
