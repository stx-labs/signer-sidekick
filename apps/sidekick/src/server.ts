import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import {
  type ApiError,
  browserWalletIntentCreateRequestSchema,
  browserWalletIntentSubmissionRequestSchema,
  type EngineApprovalRequest,
  type EngineApprovalResponse,
  type EngineDisableAdapterRequest,
  type EngineDisableAdapterResponse,
  type EngineForceObserveRequest,
  type EngineForceObserveResponse,
  type EngineInvalidateApprovalRequest,
  type EngineInvalidateApprovalResponse,
  type EngineJobDetail,
  type EngineJobPage,
  type EngineStatus,
  engineApprovalRequestSchema,
  engineDisableAdapterRequestSchema,
  engineForceObserveRequestSchema,
  engineInvalidateApprovalRequestSchema,
  healthSourceTestRequestSchema,
  managerSignerGrantPrepareRequestSchema,
  type OperationReadiness,
  onboardingAttachRequestSchema,
  onboardingBrowserWalletIntentCreateRequestSchema,
  onboardingGrantVerifyRequestSchema,
  onboardingProgressRequestSchema,
  onboardingStartRequestSchema,
  operationReadinessSchema,
  poolCardGenerateRequestSchema,
  type ReconciliationOperation,
  type ReconciliationSummary,
  reconciliationSummarySchema,
  type WalletIntentAnchorMismatchError,
  type WalletIntentAnchorUnstableError,
} from "@stx-labs/signer-sidekick-api-contracts";
import { STACKS_CORE_4_0_1 } from "@stx-labs/signer-sidekick-protocol";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ChainAnchorError,
  RateLimitedError,
  UpstreamHttpError,
  UpstreamSchemaError,
  UpstreamUnavailableError,
} from "./chain-clients.js";
import { HealthSourceError } from "./health-http.js";
import type { OnboardingService } from "./onboarding-service.js";
import { OnboardingWalletIntentError } from "./onboarding-wallet-intent.js";
import type { OperatorSynchronizationProgress } from "./operator-service.js";
import {
  InteractiveRequestCancelledError,
  InteractiveRequestDeadlineError,
  withInteractiveRequestDeadline,
  withOperatorRequestSignal,
} from "./request-context.js";
import { SignerStakerAnchorError } from "./signer-staker-sync.js";
import { TransactionEngineApiServiceError } from "./transaction-engine/api-service.js";
import { OperatorWorkflowError } from "./workflow-error.js";

const INTERACTIVE_REQUEST_DEADLINE_MS = 15_000;
const RECONCILIATION_SNAPSHOT_DEADLINE_MS = 60_000;

interface RosterRow {
  stakerPrincipal?: string;
  active?: boolean;
  position?: null | {
    amountUstx?: string;
    firstRewardCycle?: string;
    numCycles?: string;
    unlockCycle?: string;
  };
}

interface OperatorSnapshotShape {
  generatedAt?: string;
  network?: string;
  config?: unknown;
  managerPrincipal?: string;
  preflight?: { status?: string };
  manager?: unknown;
  registration?: unknown;
  setup?: unknown;
  forecast?: unknown;
  rewards?: unknown;
  roster?: RosterRow[];
  activity?: { withdrawals?: unknown[] };
  alerts?: unknown[];
}

interface OperatorSnapshotService {
  snapshot(force?: boolean): Promise<OperatorSnapshotShape>;
  synchronize(options?: {
    signal?: AbortSignal;
    onProgress?(progress: OperatorSynchronizationProgress): void | Promise<void>;
  }): Promise<unknown>;
  activity?(options?: {
    claimLimit?: number;
    claimOffset?: number;
    rewardCycle?: string | null;
    withdrawalLimit?: number;
    withdrawalOffset?: number;
    withdrawalState?: "pending" | "settled" | "reclaimed" | null;
  }): Promise<unknown>;
  summary?(): Promise<OperatorSnapshotShape>;
  poolPage?(options?: { offset?: number; limit?: number; query?: string }): Promise<unknown>;
  poolHistory?(options?: { offset?: number; limit?: number }): Promise<unknown>;
  rewardsPage?(options?: { offset?: number; limit?: number }): Promise<unknown>;
  rewardsHistory?(options?: { offset?: number; limit?: number }): Promise<unknown>;
  settings?(): unknown;
  updateSettings?(input: unknown): unknown;
  poolCard?(mode: "live" | "static"): Promise<unknown>;
}

function snapshotStatus<const Status extends string>(
  value: unknown,
  allowed: readonly Status[],
): Status | null {
  if (!value || typeof value !== "object") return null;
  const status = (value as { status?: unknown }).status;
  if (typeof status !== "string" || !allowed.some((candidate) => candidate === status)) return null;
  return status as Status;
}

function operationReadiness(
  snapshot: OperatorSnapshotShape,
  engine: EngineStatus | null,
): OperationReadiness {
  const preflight = snapshotStatus(snapshot.preflight, ["pass", "warn", "fail"]);
  const setup = snapshotStatus(snapshot.setup, ["ready", "attention", "blocked"]);
  const engineAvailability = engine?.adapters.some((adapter) => adapter.availability === "blocked")
    ? "blocked"
    : engine?.adapters.some((adapter) => adapter.availability === "disabled")
      ? "attention"
      : engine
        ? "ready"
        : "attention";
  const checks: OperationReadiness["checks"] = [
    {
      id: "control-plane",
      status:
        preflight === "fail"
          ? "blocked"
          : preflight === "warn" || !preflight
            ? "attention"
            : "ready",
      detail:
        preflight === "pass"
          ? "Node, API, network, lag, and PoX-5 checks pass."
          : preflight === "warn"
            ? "One or more node, API, network, lag, or PoX-5 checks need review."
            : preflight === "fail"
              ? "Node, API, network, lag, or PoX-5 checks failed."
              : "No preflight result is available.",
    },
    {
      id: "setup",
      status: setup ?? "attention",
      detail:
        setup === "ready"
          ? "Manager setup is ready."
          : setup === "attention"
            ? "Manager setup needs operator attention."
            : setup === "blocked"
              ? "Manager setup is blocked."
              : "No manager setup result is available.",
    },
    {
      id: "engine",
      status: engineAvailability,
      detail:
        engineAvailability === "ready"
          ? "Transaction engine adapters are available."
          : engineAvailability === "blocked"
            ? (engine?.adapters.find((adapter) => adapter.availability === "blocked")
                ?.blockReason ?? "A transaction engine adapter is blocked.")
            : engine
              ? "A transaction engine adapter is disabled."
              : "Transaction engine status is unavailable.",
    },
  ];
  const status = checks.some((check) => check.status === "blocked")
    ? "blocked"
    : checks.some((check) => check.status === "attention")
      ? "attention"
      : "ready";
  return operationReadinessSchema.parse({
    schemaVersion: 1,
    status,
    generatedAt: snapshot.generatedAt ?? engine?.generatedAt ?? new Date().toISOString(),
    checks,
  });
}

type ActivityOptions = Parameters<NonNullable<OperatorSnapshotService["activity"]>>[0];

export interface TransactionEngineApiService {
  status(): Promise<EngineStatus> | EngineStatus;
  listJobs(options: { cursor: string | null; limit: number }): Promise<EngineJobPage>;
  getJob(jobId: string): Promise<EngineJobDetail | null>;
  approve(
    jobId: string,
    request: EngineApprovalRequest,
    actor: string,
  ): Promise<EngineApprovalResponse>;
  invalidateApproval(
    jobId: string,
    request: EngineInvalidateApprovalRequest,
    actor: string,
  ): Promise<EngineInvalidateApprovalResponse>;
  forceObserve(
    request: EngineForceObserveRequest,
    actor: string,
  ): Promise<EngineForceObserveResponse>;
  disableAdapter(
    adapterId: string,
    request: EngineDisableAdapterRequest,
    actor: string,
  ): Promise<EngineDisableAdapterResponse>;
}

export interface ServerOptions {
  service?: OperatorSnapshotService;
  authToken?: string;
  logger?: boolean;
  staticDirectory?: string | null;
  onboarding?: OnboardingService;
  health?: {
    current(): Promise<unknown>;
    refresh(): Promise<unknown>;
    testSource(
      kind: "node-metrics" | "signer-monitoring" | "hiro-reference",
      url: string,
    ): Promise<unknown>;
  };
  engine?: TransactionEngineApiService;
}

class OperatorApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly responseCode: string,
    readonly retryable = false,
    message = safeOperatorApiMessage(statusCode, responseCode),
  ) {
    super(message);
    this.name = "OperatorApiError";
  }
}

interface SafeErrorClassification {
  statusCode: number;
  body: ApiError & Record<string, unknown>;
  retryAfterSeconds?: number;
}

const SAFE_OPERATOR_API_MESSAGES: Readonly<Record<string, string>> = {
  operator_service_unavailable:
    "The operator service is unavailable. Restart Sidekick and review the startup logs.",
  unauthorized:
    "The operator credential is missing or invalid. Enter the configured credential and retry.",
  invalid_health_source: "Choose a supported health source and enter a valid URL.",
  invalid_pagination: "Pagination values are invalid. Correct the request and retry.",
  limit_must_be_positive:
    "Pagination limits must be positive whole numbers. Correct the request and retry.",
  limits_must_be_positive:
    "Activity page limits must be positive whole numbers. Correct the request and retry.",
  invalid_withdrawal_state: "Choose a pending, settled, or reclaimed withdrawal state.",
  invalid_query: "The activity query is invalid. Correct its filters and retry.",
  invalid_onboarding_path: "Choose attach or fresh setup, then retry.",
  invalid_fresh_setup_input:
    "Enter a valid admin principal, contract name, authorization ID, and signer configuration path.",
  fresh_setup_sources_incompatible:
    "Fresh setup is blocked by node, API, PoX-5, or network compatibility checks. Review preflight, resolve the failures, and retry.",
  signer_grant_sources_incompatible:
    "Signer grant preparation is blocked by node, API, or PoX-5 compatibility checks. Review preflight, resolve the failures, and retry.",
  pool_setup_not_complete:
    "Pool information is unavailable until setup completes. Finish Initial Setup, then retry.",
  onboarding_not_started: "Setup has not started. Choose an onboarding path first.",
  onboarding_path_conflict:
    "This action belongs to the other onboarding path. Return to Initial Setup and choose the intended path.",
  invalid_manager_principal: "Enter a valid manager contract principal and retry.",
  invalid_signer_output: "Signer output is invalid. Paste the complete JSON output and retry.",
  invalid_signer_grant_input:
    "Enter a valid authorization ID and signer configuration path, then retry.",
  invalid_wallet_intent_action:
    "The wallet transaction request is invalid. Review the action fields and retry.",
  wallet_intent_not_found:
    "The wallet transaction request was not found. Prepare a new transaction.",
  invalid_wallet_intent_submission:
    "The transaction submission is invalid. Enter a valid transaction ID and retry.",
  invalid_wallet_intent_refresh:
    "The wallet transaction request is invalid. Prepare a new transaction.",
  invalid_wallet_intent_replacement:
    "The wallet transaction request is invalid. Prepare a new transaction.",
  invalid_onboarding_step: "The setup step is invalid. Refresh setup and retry.",
  artifact_not_found: "The setup artifact was not found. Generate deployment files and retry.",
  invalid_pool_card_mode: "Choose live or static pool card mode.",
  invalid_engine_pagination: "The transaction job page is invalid. Refresh Operations.",
  invalid_engine_job_id: "The transaction job ID is invalid. Refresh Operations and retry.",
  engine_job_not_found: "This transaction job no longer exists. Refresh Operations.",
  invalid_engine_approval: "The approval request is invalid. Review the job and retry.",
  invalid_engine_approval_invalidation:
    "The approval reset request is invalid. Refresh the job and retry.",
  invalid_force_observe_request:
    "The emergency Observe request is invalid. Confirm the decision and reason, then retry.",
  invalid_engine_adapter_id: "The transaction adapter ID is invalid. Refresh Operations.",
  invalid_adapter_disable_request:
    "The adapter disable request is invalid. Confirm the decision and reason, then retry.",
  chain_sources_out_of_sync:
    "The node and API are temporarily out of sync. Retry when their Stacks and Bitcoin heights match.",
  chain_anchor_unstable: "Chain data changed while Sidekick was reading it. Retry in a moment.",
  chain_anchor_invalid:
    "Node, API, or PoX data is inconsistent. Check the configured chain sources before retrying.",
  signer_staker_anchor_unstable:
    "Signer roster data changed during synchronization. Retry the chain data sync.",
  upstream_rate_limited:
    "A configured chain source is rate limiting Sidekick. Retry after the indicated delay.",
  upstream_temporarily_unavailable:
    "A configured chain source is unavailable. Check node and API connectivity, then retry.",
  upstream_response_invalid:
    "A configured chain source returned data Sidekick could not validate. Check source compatibility before retrying.",
  health_source_not_allowed:
    "The health source is not allowed. Use an endpoint permitted by Sidekick's health-source policy.",
  health_source_temporarily_unavailable:
    "The health source could not be reached. Check the endpoint, then retry.",
  health_source_response_invalid:
    "The health source returned data Sidekick could not validate. Check the endpoint type and version.",
  operator_request_temporarily_unavailable:
    "The operator request timed out. Retry; if it repeats, check the node, API, and Sidekick logs.",
  invalid_request: "The request is invalid. Correct it and retry.",
  request_error: "The request is invalid. Correct it and retry.",
  internal_server_error:
    "Sidekick could not complete the request. Review the operator logs before retrying.",
};

function safeOperatorApiMessage(statusCode: number, responseCode: string): string {
  const message = SAFE_OPERATOR_API_MESSAGES[responseCode];
  if (message) return message;
  if (statusCode === 404) {
    return "The requested resource was not found. Refresh and retry.";
  }
  if (statusCode === 409) {
    return "The request conflicts with current Sidekick state. Refresh before retrying.";
  }
  if (statusCode === 422) {
    return "The request is not available for the current configuration. Review Settings and retry.";
  }
  if (statusCode === 501) {
    return "The requested feature is unavailable in this Sidekick deployment.";
  }
  return "The request is invalid. Correct it and retry.";
}

function safeErrorBody(error: string, message: string, retryable = false): ApiError {
  return { error, message, retryable };
}

function safeClassification(
  statusCode: number,
  error: string,
  options: {
    message?: string;
    retryable?: boolean;
    retryAfterSeconds?: number;
    details?: Record<string, unknown>;
  } = {},
): SafeErrorClassification {
  return {
    statusCode,
    body: {
      ...safeErrorBody(
        error,
        options.message ?? safeOperatorApiMessage(statusCode, error),
        options.retryable,
      ),
      ...options.details,
    },
    ...(options.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: options.retryAfterSeconds }),
  };
}

function chainSourcesDiffer(error: ChainAnchorError): boolean {
  const { tips } = error;
  return Boolean(
    tips &&
      (tips.node.stacksTipHeight !== tips.api.stacksTipHeight ||
        tips.node.burnBlockHeight !== tips.api.burnBlockHeight ||
        tips.poxBurnBlockHeight !== tips.api.burnBlockHeight),
  );
}

function classifySafeOperatorError(error: unknown): SafeErrorClassification {
  if (error instanceof OperatorApiError) {
    return safeClassification(error.statusCode, error.responseCode, {
      message: error.message,
      retryable: error.retryable,
    });
  }
  if (error instanceof OperatorWorkflowError) {
    return safeClassification(error.statusCode, error.responseCode, {
      ...(error.message === error.responseCode ? {} : { message: error.message }),
    });
  }
  if (error instanceof TransactionEngineApiServiceError) {
    return safeClassification(error.statusCode, error.responseCode, {
      ...(error.message === error.responseCode ? {} : { message: error.message }),
    });
  }
  if (error instanceof OnboardingWalletIntentError) {
    return safeClassification(error.retryable ? 503 : walletIntentHttpStatus(error), error.code, {
      message: error.message,
      retryable: error.retryable,
      ...(error.retryable ? { retryAfterSeconds: 1 } : {}),
    });
  }
  if (error instanceof ChainAnchorError) {
    if (error.retryable) {
      if (error.tips && chainSourcesDiffer(error)) {
        return safeClassification(503, "chain_sources_out_of_sync", {
          retryable: true,
          retryAfterSeconds: 1,
          details: {
            node: error.tips.node,
            api: error.tips.api,
            poxBurnBlockHeight: error.tips.poxBurnBlockHeight,
          },
        });
      }
      return safeClassification(503, "chain_anchor_unstable", {
        retryable: true,
        retryAfterSeconds: 1,
      });
    }
    return safeClassification(502, "chain_anchor_invalid");
  }
  if (error instanceof SignerStakerAnchorError) {
    return safeClassification(503, "signer_staker_anchor_unstable", {
      retryable: true,
      retryAfterSeconds: 1,
    });
  }
  if (error instanceof RateLimitedError) {
    return safeClassification(429, "upstream_rate_limited", {
      retryable: true,
      retryAfterSeconds: Math.min(
        30,
        Math.max(1, Math.ceil((error.retryAfterMs ?? 1_000) / 1_000)),
      ),
    });
  }
  if (error instanceof UpstreamUnavailableError) {
    return safeClassification(503, "upstream_temporarily_unavailable", {
      retryable: true,
      retryAfterSeconds: 1,
    });
  }
  if (error instanceof UpstreamSchemaError) {
    return safeClassification(502, "upstream_response_invalid");
  }
  if (error instanceof UpstreamHttpError) {
    if (error.status === 408 || error.status === 425) {
      return safeClassification(503, "upstream_temporarily_unavailable", {
        message: `A configured chain source returned HTTP ${error.status}. Retry in a moment.`,
        retryable: true,
        retryAfterSeconds: 1,
      });
    }
    return safeClassification(502, "upstream_request_rejected", {
      message: `A configured chain source rejected the request with HTTP ${error.status}. Verify its URL and access settings.`,
    });
  }
  if (error instanceof HealthSourceError) {
    if (error.code === "invalid-url") {
      return safeClassification(400, "invalid_health_source");
    }
    if (error.code === "unsafe-address") {
      return safeClassification(422, "health_source_not_allowed");
    }
    if (
      error.code === "dns-unavailable" ||
      error.code === "connection-failed" ||
      error.code === "timeout"
    ) {
      return safeClassification(503, "health_source_temporarily_unavailable", {
        retryable: true,
        retryAfterSeconds: 1,
      });
    }
    return safeClassification(502, "health_source_response_invalid");
  }
  if (
    error instanceof InteractiveRequestDeadlineError ||
    error instanceof InteractiveRequestCancelledError
  ) {
    return safeClassification(503, "operator_request_temporarily_unavailable", {
      retryable: true,
      retryAfterSeconds: 1,
    });
  }
  if (error instanceof z.ZodError) {
    return safeClassification(400, "invalid_request");
  }
  if (
    error instanceof Error &&
    typeof (error as FastifyError).statusCode === "number" &&
    ((error as FastifyError).statusCode ?? 500) < 500
  ) {
    return safeClassification((error as FastifyError).statusCode ?? 400, "request_error");
  }
  return safeClassification(500, "internal_server_error");
}

function sendClassifiedError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  const classified = classifySafeOperatorError(error);
  const body =
    classified.statusCode === 500
      ? {
          ...classified.body,
          message: `Sidekick could not complete the request. Check operator logs for request ${request.id}.`,
          requestId: request.id,
        }
      : classified.body;
  if (classified.retryAfterSeconds !== undefined) {
    reply.header("retry-after", String(classified.retryAfterSeconds));
  }
  if (classified.statusCode >= 500) {
    if (classified.statusCode === 500) {
      request.log.error(
        { err: error, responseCode: classified.body.error },
        "operator API request failed",
      );
    } else {
      request.log.warn(
        { err: error, responseCode: classified.body.error },
        "operator API request failed",
      );
    }
  }
  return reply.code(classified.statusCode).send(body);
}

function requireFeature<T>(value: T | undefined, responseCode: string): T {
  if (value === undefined) throw new OperatorApiError(501, responseCode);
  return value;
}

function walletIntentHttpStatus(error: OnboardingWalletIntentError): number {
  if (error.code === "wallet_intent_not_found") return 404;
  if (error.code === "wallet_intent_conflict" || error.code === "wallet_intent_expired") return 409;
  if (error.code === "wallet_execution_unavailable") return 422;
  return 400;
}

function walletIntentAnchorError(
  error: unknown,
): WalletIntentAnchorMismatchError | WalletIntentAnchorUnstableError | null {
  if (error instanceof ChainAnchorError && error.retryable) {
    const { tips } = error;
    const sourcesDiffer =
      tips !== null &&
      (tips.node.stacksTipHeight !== tips.api.stacksTipHeight ||
        tips.node.burnBlockHeight !== tips.api.burnBlockHeight ||
        tips.poxBurnBlockHeight !== tips.api.burnBlockHeight);
    return sourcesDiffer
      ? {
          error: "wallet_intent_anchor_mismatch",
          retryable: true,
          node: tips.node,
          api: tips.api,
          poxBurnBlockHeight: tips.poxBurnBlockHeight,
        }
      : { error: "wallet_intent_anchor_unstable", retryable: true };
  }
  return null;
}

function replyToWalletIntentAnchorError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  context: Record<string, unknown>,
): FastifyReply | null {
  const body = walletIntentAnchorError(error);
  if (!body) return null;
  request.log.warn({ ...context, ...body }, "wallet sources out of sync");
  reply.header("retry-after", "1");
  return reply.code(503).send(body);
}

function authorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function reconciliationSummary(value: unknown): ReconciliationSummary {
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const stakers =
    root.stakers && typeof root.stakers === "object"
      ? (root.stakers as Record<string, unknown>)
      : {};
  const events =
    root.events && typeof root.events === "object" ? (root.events as Record<string, unknown>) : {};
  const candidate = {
    observedAt: root.observedAt,
    stakers: {
      resumed: stakers.resumed,
      status: stakers.status,
      authoritative: stakers.authoritative,
      pagesProcessed: stakers.pagesProcessed,
      itemsProcessed: stakers.itemsProcessed,
      activeStakers: stakers.activeStakers,
      nodeVerifiedStxPositions: stakers.nodeVerifiedStxPositions,
      unverifiedStxDiscoveries: stakers.unverifiedStxDiscoveries,
      discrepanciesObserved: Array.isArray(stakers.discrepanciesObservedThisInvocation)
        ? stakers.discrepanciesObservedThisInvocation.length
        : undefined,
    },
    events: {
      resumed: events.resumed,
      pagesProcessed: events.pagesProcessed,
      eventsProcessed: events.eventsProcessed,
      newEvents: events.newEvents,
      replayedEvents: events.replayedEvents,
      decodeFailures: events.decodeFailures,
      reorgedEvents: events.reorgedEvents,
      stoppedAtKnownOverlap: events.stoppedAtKnownOverlap,
    },
  };
  const parsed = reconciliationSummarySchema.safeParse(candidate);
  if (!parsed.success) throw new Error("Operator reconciliation returned an invalid summary");
  return parsed.data;
}

function integerQuery(
  search: URLSearchParams,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = search.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be an integer from 0 through ${maximum}`);
  }
  return value;
}

function optionalUnsignedIntegerQuery(search: URLSearchParams, name: string): string | null {
  const value = search.get(name);
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${name} must be an unsigned integer`);
  }
  return value;
}

function parsePagination(
  requestUrl: string,
  options: { invalidCode?: string; includeQuery?: boolean } = {},
): { offset: number; limit: number; query?: string } {
  try {
    const search = new URL(requestUrl, "http://sidekick.local").searchParams;
    const limit = integerQuery(search, "limit", 50, 200);
    if (limit < 1) throw new OperatorApiError(400, "limit_must_be_positive");
    const pagination: { offset: number; limit: number; query?: string } = {
      offset: integerQuery(search, "offset", 0, 10_000_000),
      limit,
    };
    if (options.includeQuery) pagination.query = search.get("query") ?? "";
    return pagination;
  } catch (error) {
    if (error instanceof OperatorApiError) throw error;
    throw new OperatorApiError(400, options.invalidCode ?? "invalid_pagination");
  }
}

function engineActor(): string {
  return "local-operator";
}

export function createServer(options: ServerOptions = {}) {
  if (
    options.service &&
    (!options.authToken ||
      options.authToken.length < 24 ||
      options.authToken === "replace-with-at-least-24-random-characters")
  ) {
    throw new Error("The operator API requires SIDEKICK_AUTH_TOKEN with at least 24 characters");
  }
  const server = Fastify({ logger: options.logger ?? true });
  let requestCount = 0;
  let syncRequestCount = 0;
  let syncCount = 0;
  let syncFailureCount = 0;
  const idleReconciliationOperation = (): ReconciliationOperation => ({
    schemaVersion: 1,
    operationId: null,
    status: "idle",
    phase: "idle",
    processLocal: true,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    progress: {
      completedSteps: 0,
      totalSteps: 4,
      itemsCompleted: null,
      itemsTotal: null,
      message: "No chain data sync has run in this process",
    },
    result: null,
    error: null,
  });
  let reconciliationOperation = idleReconciliationOperation();
  let reconciliationTask: Promise<void> | null = null;
  let reconciliationController: AbortController | null = null;

  async function interactive<T>(request: FastifyRequest, work: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const cancel = () => {
      if (!controller.signal.aborted) controller.abort(new InteractiveRequestCancelledError());
    };
    const cancelOnClosedConnection = () => {
      if (request.raw.aborted || request.raw.socket.destroyed) cancel();
    };
    request.raw.once("aborted", cancel);
    request.raw.once("close", cancelOnClosedConnection);
    try {
      return await withInteractiveRequestDeadline(
        INTERACTIVE_REQUEST_DEADLINE_MS,
        work,
        controller.signal,
      );
    } finally {
      request.raw.off("aborted", cancel);
      request.raw.off("close", cancelOnClosedConnection);
    }
  }

  function updateReconciliationProgress(progress: OperatorSynchronizationProgress): void {
    if (reconciliationOperation.status !== "running") return;
    const now = new Date().toISOString();
    const discovery = progress.phase === "stakers-discovery";
    const verification = progress.phase === "stakers-verification";
    reconciliationOperation = {
      ...reconciliationOperation,
      phase: discovery
        ? "reconciling-stakers-discovery"
        : verification
          ? "reconciling-stakers-verification"
          : "reconciling-events",
      updatedAt: now,
      progress: {
        completedSteps: discovery ? 0 : verification ? 1 : 2,
        totalSteps: 4,
        itemsCompleted: progress.completed,
        itemsTotal: progress.total,
        message:
          progress.message ??
          (discovery
            ? "Discovering indexed signer delegations"
            : verification
              ? "Verifying signer delegations against the node"
              : "Syncing manager events"),
      },
    };
  }

  function startReconciliation(
    request: FastifyRequest,
    service: OperatorSnapshotService,
  ): ReconciliationOperation {
    syncRequestCount += 1;
    if (reconciliationTask) return reconciliationOperation;
    syncCount += 1;
    const controller = new AbortController();
    reconciliationController = controller;
    const startedAt = new Date().toISOString();
    reconciliationOperation = {
      schemaVersion: 1,
      operationId: randomUUID(),
      status: "running",
      phase: "reconciling-stakers-discovery",
      processLocal: true,
      startedAt,
      updatedAt: startedAt,
      completedAt: null,
      progress: {
        completedSteps: 0,
        totalSteps: 4,
        itemsCompleted: 0,
        itemsTotal: null,
        message: "Starting signer delegation discovery",
      },
      result: null,
      error: null,
    };
    reconciliationTask = (async () => {
      try {
        const reconciliation = await withOperatorRequestSignal(controller.signal, async () =>
          service.synchronize({
            signal: controller.signal,
            onProgress: async (progress) => updateReconciliationProgress(progress),
          }),
        );
        const refreshingAt = new Date().toISOString();
        reconciliationOperation = {
          ...reconciliationOperation,
          phase: "refreshing-snapshot",
          updatedAt: refreshingAt,
          progress: {
            completedSteps: 3,
            totalSteps: 4,
            itemsCompleted: null,
            itemsTotal: null,
            message: "Refreshing operator state from synced chain data",
          },
        };
        const snapshot = await withInteractiveRequestDeadline(
          RECONCILIATION_SNAPSHOT_DEADLINE_MS,
          async () => service.snapshot(true),
          controller.signal,
        );
        const completedAt = new Date().toISOString();
        reconciliationOperation = {
          ...reconciliationOperation,
          status: "succeeded",
          phase: "complete",
          updatedAt: completedAt,
          completedAt,
          progress: {
            completedSteps: 4,
            totalSteps: 4,
            itemsCompleted: null,
            itemsTotal: null,
            message: "Chain data sync complete",
          },
          result: {
            reconciliation: reconciliationSummary(reconciliation),
            snapshotGeneratedAt: snapshot?.generatedAt ?? completedAt,
          },
          error: null,
        };
      } catch (error) {
        syncFailureCount += 1;
        const failedAt = new Date().toISOString();
        const classified = classifySafeOperatorError(error);
        request.log.warn(
          { err: error, responseCode: classified.body.error },
          "background reconciliation failed",
        );
        reconciliationOperation = {
          ...reconciliationOperation,
          status: "failed",
          phase: "failed",
          updatedAt: failedAt,
          completedAt: failedAt,
          progress: {
            ...reconciliationOperation.progress,
            message: "Chain data sync failed",
          },
          result: null,
          error: { ...classified.body, retryable: classified.body.retryable ?? false },
        };
      }
    })().finally(() => {
      reconciliationTask = null;
      reconciliationController = null;
    });
    return reconciliationOperation;
  }

  server.setErrorHandler((error: FastifyError, request, reply) => {
    return sendClassifiedError(request, reply, error);
  });

  server.addHook("onClose", async () => {
    reconciliationController?.abort(new InteractiveRequestCancelledError());
    await reconciliationTask;
  });

  server.addHook("onRequest", async (request, reply) => {
    requestCount += 1;
    if (!request.url.startsWith("/api/")) return;
    if (!options.service) throw new OperatorApiError(503, "operator_service_unavailable");
    if (!authorized(request.headers.authorization, options.authToken ?? "")) {
      reply.header("www-authenticate", "Bearer");
      throw new OperatorApiError(401, "unauthorized");
    }
  });

  server.get("/healthz", async () => ({
    status: "ok",
    phase: "read-only-control-plane",
    sourceLineage: {
      stacksCoreTag: STACKS_CORE_4_0_1.tag,
      stacksCoreCommit: STACKS_CORE_4_0_1.commit,
    },
  }));
  server.get("/health/live", async () => ({ status: "ok" }));
  server.get("/health/ready", async (request, reply) => {
    if (!options.service) return reply.code(503).send({ status: "not-ready" });
    const service = options.service;
    try {
      const snapshot = await interactive(request, () => service.snapshot());
      const preflight = snapshot.preflight as { status?: string } | undefined;
      const ready = preflight?.status !== "fail";
      return reply.code(ready ? 200 : 503).send({
        status: ready ? "ready" : "not-ready",
        generatedAt: snapshot.generatedAt,
      });
    } catch (error) {
      request.log.warn({ err: error }, "readiness snapshot failed");
      return reply.code(503).send({ status: "not-ready" });
    }
  });
  server.get("/metrics", async (_request, reply) => {
    reply.type("text/plain; version=0.0.4; charset=utf-8");
    return [
      "# HELP sidekick_http_requests_total HTTP requests handled by this process.",
      "# TYPE sidekick_http_requests_total counter",
      `sidekick_http_requests_total ${requestCount}`,
      "# HELP sidekick_sync_total Synchronization attempts.",
      "# TYPE sidekick_sync_total counter",
      `sidekick_sync_total ${syncCount}`,
      "# HELP sidekick_sync_requests_total Synchronization requests accepted by this process.",
      "# TYPE sidekick_sync_requests_total counter",
      `sidekick_sync_requests_total ${syncRequestCount}`,
      "# HELP sidekick_sync_failures_total Failed synchronization attempts.",
      "# TYPE sidekick_sync_failures_total counter",
      `sidekick_sync_failures_total ${syncFailureCount}`,
      "",
    ].join("\n");
  });

  server.get(
    "/api/v1/status",
    async (request) =>
      await interactive(request, async () =>
        options.service?.summary ? options.service.summary() : options.service?.snapshot(),
      ),
  );
  server.get("/api/v1/engine", async () => {
    return await requireFeature(options.engine, "transaction_engine_unavailable").status();
  });
  server.get("/api/v1/operations/readiness", async (request) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    const snapshot = await interactive(request, async () => await service.snapshot());
    const engine = options.engine ? await options.engine.status() : null;
    return operationReadiness(snapshot, engine);
  });
  server.get("/api/v1/engine/jobs", async (request) => {
    const engine = requireFeature(options.engine, "transaction_engine_unavailable");
    let query: { cursor: string | null; limit: number };
    try {
      const search = new URL(request.url, "http://sidekick.local").searchParams;
      const cursor = search.get("cursor");
      if (cursor !== null && (cursor.length < 1 || cursor.length > 2_000)) throw new Error();
      query = { cursor, limit: integerQuery(search, "limit", 20, 100) };
      if (query.limit < 1) throw new Error();
    } catch {
      throw new OperatorApiError(400, "invalid_engine_pagination");
    }
    return await engine.listJobs(query);
  });
  server.get("/api/v1/engine/jobs/:jobId", async (request) => {
    const engine = requireFeature(options.engine, "transaction_engine_unavailable");
    const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new OperatorApiError(400, "invalid_engine_job_id");
    const job = await engine.getJob(params.data.jobId);
    if (!job) throw new OperatorApiError(404, "engine_job_not_found");
    return job;
  });
  server.post("/api/v1/engine/jobs/:jobId/approval", async (request) => {
    const engine = requireFeature(options.engine, "transaction_engine_unavailable");
    const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new OperatorApiError(400, "invalid_engine_job_id");
    const body = engineApprovalRequestSchema.safeParse(request.body);
    if (!body.success) throw new OperatorApiError(400, "invalid_engine_approval");
    return await engine.approve(params.data.jobId, body.data, engineActor());
  });
  server.post("/api/v1/engine/jobs/:jobId/approval/invalidate", async (request) => {
    const engine = requireFeature(options.engine, "transaction_engine_unavailable");
    const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new OperatorApiError(400, "invalid_engine_job_id");
    const body = engineInvalidateApprovalRequestSchema.safeParse(request.body);
    if (!body.success) throw new OperatorApiError(400, "invalid_engine_approval_invalidation");
    return await engine.invalidateApproval(params.data.jobId, body.data, engineActor());
  });
  server.post("/api/v1/engine/force-observe", async (request) => {
    const engine = requireFeature(options.engine, "transaction_engine_unavailable");
    const body = engineForceObserveRequestSchema.safeParse(request.body);
    if (!body.success) throw new OperatorApiError(400, "invalid_force_observe_request");
    return await engine.forceObserve(body.data, engineActor());
  });
  server.post("/api/v1/engine/adapters/:adapterId/disable", async (request) => {
    const engine = requireFeature(options.engine, "transaction_engine_unavailable");
    const params = z
      .object({ adapterId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/) })
      .safeParse(request.params);
    if (!params.success) throw new OperatorApiError(400, "invalid_engine_adapter_id");
    const body = engineDisableAdapterRequestSchema.safeParse(request.body);
    if (!body.success) throw new OperatorApiError(400, "invalid_adapter_disable_request");
    return await engine.disableAdapter(params.data.adapterId, body.data, engineActor());
  });
  server.get("/api/v1/health", async (request, _reply) => {
    return await interactive(request, async () =>
      requireFeature(options.health, "health_monitoring_unavailable").current(),
    );
  });
  server.post("/api/v1/health/refresh", async (request, _reply) => {
    return await interactive(request, async () =>
      requireFeature(options.health, "health_monitoring_unavailable").refresh(),
    );
  });
  server.post("/api/v1/health/test-source", async (request) => {
    const health = requireFeature(options.health, "health_monitoring_unavailable");
    const parsed = healthSourceTestRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_health_source");
    return await interactive(request, async () =>
      health.testSource(parsed.data.kind, parsed.data.url),
    );
  });
  server.get("/api/v1/registration", async (request) => {
    const snapshot = await interactive(request, async () => options.service?.snapshot());
    return {
      generatedAt: snapshot?.generatedAt,
      network: snapshot?.network,
      managerPrincipal: snapshot?.managerPrincipal,
      preflight: snapshot?.preflight,
      manager: snapshot?.manager,
      registration: snapshot?.registration,
      setup: snapshot?.setup,
    };
  });
  server.get("/api/v1/pool", async (request, _reply) => {
    if (options.service?.poolPage) {
      const pageOptions = parsePagination(request.url, { includeQuery: true });
      return await interactive(request, async () => options.service?.poolPage?.(pageOptions));
    }
    const snapshot = await interactive(request, async () => options.service?.snapshot());
    return {
      generatedAt: snapshot?.generatedAt,
      forecast: snapshot?.forecast,
      roster: snapshot?.roster,
    };
  });
  server.get("/api/v1/pool/roster.csv", async (request, reply) => {
    const snapshot = await interactive(request, async () => options.service?.snapshot());
    const roster = snapshot?.roster ?? [];
    const header = [
      "staker_principal",
      "amount_ustx",
      "first_reward_cycle",
      "num_cycles",
      "unlock_cycle",
      "active",
    ];
    const rows = roster.map((staker) => [
      staker.stakerPrincipal,
      staker.position?.amountUstx,
      staker.position?.firstRewardCycle,
      staker.position?.numCycles,
      staker.position?.unlockCycle,
      staker.active,
    ]);
    reply.type("text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="signer-sidekick-roster.csv"');
    return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  });
  server.get("/api/v1/pool/history", async (request, _reply) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    const poolHistory = requireFeature(service.poolHistory, "pool_history_unavailable");
    return await interactive(request, async () =>
      poolHistory.call(service, parsePagination(request.url)),
    );
  });
  server.get("/api/v1/pool/roster.json", async (request, reply) => {
    const snapshot = await interactive(request, async () => options.service?.snapshot());
    reply.type("application/json; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="signer-sidekick-roster.json"');
    return snapshot?.roster ?? [];
  });
  server.get("/api/v1/rewards", async (request, _reply) => {
    if (options.service?.rewardsPage) {
      return await interactive(request, async () =>
        options.service?.rewardsPage?.(parsePagination(request.url)),
      );
    }
    const snapshot = await interactive(request, async () => options.service?.snapshot());
    return {
      generatedAt: snapshot?.generatedAt,
      rewards: snapshot?.rewards,
      activity: snapshot?.activity,
    };
  });
  server.get("/api/v1/withdrawals", async (request) => {
    const snapshot = await interactive(request, async () => options.service?.snapshot());
    return {
      generatedAt: snapshot?.generatedAt,
      withdrawals: snapshot?.activity?.withdrawals ?? [],
    };
  });
  server.get("/api/v1/rewards/history", async (request, _reply) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    const rewardsHistory = requireFeature(service.rewardsHistory, "reward_history_unavailable");
    return await interactive(request, async () =>
      rewardsHistory.call(service, parsePagination(request.url)),
    );
  });
  server.get("/api/v1/alerts", async (request) => {
    const snapshot = await interactive(request, async () => options.service?.snapshot());
    return { generatedAt: snapshot?.generatedAt, alerts: snapshot?.alerts ?? [] };
  });
  server.get("/api/v1/activity", async (request) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    const activity = requireFeature(service.activity, "paginated_activity_unavailable");
    let activityOptions: ActivityOptions;
    try {
      const search = new URL(request.url, "http://sidekick.local").searchParams;
      const claimLimit = integerQuery(search, "claimLimit", 50, 200);
      const withdrawalLimit = integerQuery(search, "withdrawalLimit", 50, 200);
      if (claimLimit < 1 || withdrawalLimit < 1) {
        throw new OperatorApiError(400, "limits_must_be_positive");
      }
      const state = search.get("withdrawalState");
      if (state !== null && !["pending", "settled", "reclaimed"].includes(state)) {
        throw new OperatorApiError(400, "invalid_withdrawal_state");
      }
      activityOptions = {
        claimLimit,
        claimOffset: integerQuery(search, "claimOffset", 0, 10_000_000),
        rewardCycle: optionalUnsignedIntegerQuery(search, "rewardCycle"),
        withdrawalLimit,
        withdrawalOffset: integerQuery(search, "withdrawalOffset", 0, 10_000_000),
        withdrawalState: state as "pending" | "settled" | "reclaimed" | null,
      };
    } catch (error) {
      if (error instanceof OperatorApiError) throw error;
      throw new OperatorApiError(400, "invalid_query");
    }
    return await interactive(request, async () => activity.call(service, activityOptions));
  });
  server.get("/api/v1/setup", async (request) => {
    const snapshot = await interactive(request, async () => options.service?.snapshot());
    return {
      generatedAt: snapshot?.generatedAt,
      network: snapshot?.network,
      managerPrincipal: snapshot?.managerPrincipal,
      preflight: snapshot?.preflight,
      manager: snapshot?.manager,
      registration: snapshot?.registration,
      setup: snapshot?.setup,
      onboarding: options.onboarding?.get() ?? null,
    };
  });
  server.get("/api/v1/settings", async (_request, _reply) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    return requireFeature(service.settings, "runtime_settings_unavailable").call(service);
  });
  server.put("/api/v1/settings", async (request) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    const updateSettings = requireFeature(service.updateSettings, "runtime_settings_unavailable");
    return await interactive(request, async () => updateSettings.call(service, request.body));
  });
  server.get("/api/v1/onboarding", async (_request, _reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    return {
      onboarding: onboarding.get(),
      wizard: onboarding.wizardState(),
    };
  });
  server.post("/api/v1/onboarding/dismiss", async (_request, _reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    return {
      onboarding: onboarding.get(),
      wizard: onboarding.dismissWizard(),
    };
  });
  server.post("/api/v1/onboarding/resume", async (_request, _reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    return {
      onboarding: onboarding.get(),
      wizard: onboarding.resumeWizard(),
    };
  });
  server.post("/api/v1/onboarding/start", async (request) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = onboardingStartRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_onboarding_path");
    return { onboarding: onboarding.start(parsed.data.path, parsed.data.reset ?? false) };
  });
  server.post("/api/v1/onboarding/attach/verify", async (request) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = onboardingAttachRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_manager_principal");
    return {
      onboarding: await interactive(request, async () =>
        onboarding.verifyAttach(parsed.data.managerPrincipal),
      ),
    };
  });
  server.post("/api/v1/onboarding/fresh/prepare", async (request) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    return {
      onboarding: await interactive(request, async () => onboarding.prepareFresh(request.body)),
    };
  });
  server.post("/api/v1/onboarding/fresh/grant/prepare", async (request) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    return {
      onboarding: await interactive(request, async () => onboarding.prepareGrant()),
    };
  });
  server.post("/api/v1/onboarding/fresh/grant/verify", async (request) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = onboardingGrantVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_signer_output");
    return {
      onboarding: await interactive(request, async () =>
        onboarding.verifyGrant(parsed.data.signerOutput),
      ),
    };
  });
  server.post("/api/v1/manager/signer-grant/prepare", async (request) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = managerSignerGrantPrepareRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_signer_grant_input");
    return {
      onboarding: await interactive(request, async () =>
        onboarding.prepareManagerSignerGrant(parsed.data),
      ),
    };
  });
  server.post("/api/v1/manager/signer-grant/verify", async (request) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = onboardingGrantVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_signer_output");
    return {
      onboarding: await interactive(request, async () =>
        onboarding.verifyManagerSignerGrant(parsed.data.signerOutput),
      ),
    };
  });
  server.post("/api/v1/onboarding/wallet-intents", async (request, reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = onboardingBrowserWalletIntentCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_wallet_intent_action");
    try {
      return {
        intent: await interactive(request, async () => onboarding.wallet.prepare(parsed.data)),
      };
    } catch (error) {
      const anchorReply = replyToWalletIntentAnchorError(request, reply, error, {
        action: parsed.data.action,
      });
      if (anchorReply) return anchorReply;
      if (error instanceof OnboardingWalletIntentError) {
        return sendClassifiedError(request, reply, error);
      }
      throw error;
    }
  });
  server.post("/api/v1/wallet-intents", async (request, reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = browserWalletIntentCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_wallet_intent_action");
    try {
      return {
        intent: await interactive(request, async () => onboarding.wallet.prepare(parsed.data)),
      };
    } catch (error) {
      const anchorReply = replyToWalletIntentAnchorError(request, reply, error, {
        action: parsed.data.action,
      });
      if (anchorReply) return anchorReply;
      if (error instanceof OnboardingWalletIntentError) {
        return sendClassifiedError(request, reply, error);
      }
      throw error;
    }
  });
  const registerWalletIntentLifecycleRoutes = (prefix: string): void => {
    server.get(`${prefix}/:id`, async (request, reply) => {
      const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
      const parsed = z.object({ id: z.uuid() }).strict().safeParse(request.params);
      if (!parsed.success) throw new OperatorApiError(404, "wallet_intent_not_found");
      try {
        return { intent: onboarding.wallet.get(parsed.data.id) };
      } catch (error) {
        if (error instanceof OnboardingWalletIntentError) {
          return sendClassifiedError(request, reply, error);
        }
        throw error;
      }
    });
    server.post(`${prefix}/:id/submission`, async (request, reply) => {
      const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
      const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
      const body = browserWalletIntentSubmissionRequestSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        throw new OperatorApiError(400, "invalid_wallet_intent_submission");
      }
      try {
        return {
          intent: await interactive(request, async () =>
            onboarding.wallet.submit(params.data.id, body.data.txid),
          ),
        };
      } catch (error) {
        if (error instanceof OnboardingWalletIntentError) {
          return sendClassifiedError(request, reply, error);
        }
        throw error;
      }
    });
    server.post(`${prefix}/:id/refresh`, async (request, reply) => {
      const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
      const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
      const body = z
        .object({})
        .strict()
        .safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        throw new OperatorApiError(400, "invalid_wallet_intent_refresh");
      }
      try {
        return {
          intent: await interactive(request, async () => onboarding.wallet.refresh(params.data.id)),
        };
      } catch (error) {
        const anchorReply = replyToWalletIntentAnchorError(request, reply, error, {
          intentId: params.data.id,
          operation: "refresh",
        });
        if (anchorReply) return anchorReply;
        if (error instanceof OnboardingWalletIntentError) {
          return sendClassifiedError(request, reply, error);
        }
        throw error;
      }
    });
    server.post(`${prefix}/:id/replacement`, async (request, reply) => {
      const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
      const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
      const body = z
        .object({})
        .strict()
        .safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        throw new OperatorApiError(400, "invalid_wallet_intent_replacement");
      }
      try {
        return {
          intent: await interactive(request, async () => onboarding.wallet.replace(params.data.id)),
        };
      } catch (error) {
        const anchorReply = replyToWalletIntentAnchorError(request, reply, error, {
          intentId: params.data.id,
          operation: "replacement",
        });
        if (anchorReply) return anchorReply;
        if (error instanceof OnboardingWalletIntentError) {
          return sendClassifiedError(request, reply, error);
        }
        throw error;
      }
    });
  };

  for (const prefix of ["/api/v1/onboarding/wallet-intents", "/api/v1/wallet-intents"] as const) {
    registerWalletIntentLifecycleRoutes(prefix);
  }
  server.post("/api/v1/onboarding/fresh/refresh", async (request) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    return await interactive(request, async () => onboarding.refreshFresh());
  });
  server.patch("/api/v1/onboarding/progress", async (request) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = onboardingProgressRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_onboarding_step");
    return { onboarding: onboarding.setCurrentStep(parsed.data.currentStep) };
  });
  server.get("/api/v1/onboarding/artifacts/:kind", async (request, reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = z.object({ kind: z.enum(["source", "manifest"]) }).safeParse(request.params);
    if (!parsed.success) throw new OperatorApiError(404, "artifact_not_found");
    const artifact = onboarding.artifact(parsed.data.kind);
    reply.type(artifact.contentType);
    reply.header("content-disposition", `attachment; filename="${artifact.filename}"`);
    return artifact.body;
  });
  server.post("/api/v1/pool-card/generate", async (request) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    const poolCard = requireFeature(service.poolCard, "pool_card_generation_unavailable");
    const parsed = poolCardGenerateRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_pool_card_mode");
    return await interactive(request, async () => poolCard.call(service, parsed.data.mode));
  });
  server.post("/api/v1/sync", async (request, reply) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    return reply.code(202).send({ operation: startReconciliation(request, service) });
  });
  server.get("/api/v1/sync", async () => {
    requireFeature(options.service, "operator_service_unavailable");
    return { operation: reconciliationOperation };
  });

  const staticDirectory =
    options.staticDirectory === undefined
      ? resolve(import.meta.dirname, "../../dashboard/dist")
      : options.staticDirectory;
  if (staticDirectory && existsSync(staticDirectory)) {
    server.register(fastifyStatic, {
      root: staticDirectory,
      prefix: "/",
      index: ["index.html"],
    });
  }

  return server;
}
