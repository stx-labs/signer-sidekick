import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import {
  type ActivityDetail,
  type ActivityResponse,
  type ApiError,
  browserWalletIntentSubmissionRequestSchema,
  type ConnectionAssessment,
  type DashboardAlert,
  type DeploymentRequirements,
  dashboardSnapshotSchema,
  deploymentRequirementsSchema,
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
  type EngineJobState,
  type EngineStatus,
  engineApprovalRequestSchema,
  engineDisableAdapterRequestSchema,
  engineForceObserveRequestSchema,
  engineInvalidateApprovalRequestSchema,
  type HealthSnapshot,
  healthSnapshotSchema,
  healthSourceTestRequestSchema,
  managerSignerGrantPrepareRequestSchema,
  type OperationReadiness,
  type OperationReadinessCheck,
  operationReadinessSchema,
  overviewPageSchema,
  type ReconciliationOperation,
  type ReconciliationSummary,
  reconciliationSummarySchema,
  recurringBrowserWalletIntentCreateRequestSchema,
  signerGrantVerifyRequestSchema,
  type WalletIntentAnchorMismatchError,
  type WalletIntentAnchorUnstableError,
} from "@stx-labs/signer-sidekick-api-contracts";
import { STACKS_CORE_4_0_1 } from "@stx-labs/signer-sidekick-protocol";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { ActivityProjectionError, type ActivityQuery } from "./activity-projection.js";
import {
  ChainAnchorError,
  type RateLimitApiSource,
  RateLimitedError,
  rateLimitInfo,
  UpstreamHttpError,
  UpstreamSchemaError,
  UpstreamUnavailableError,
} from "./chain-clients.js";
import { HealthSourceError } from "./health-http.js";
import type { ObserverRuntimeStatus } from "./observer-server.js";
import type {
  OperatorSynchronizationProgress,
  PoolRosterSort,
  RewardStakerSort,
  SortDirection,
} from "./operator-service.js";
import type { SnapshotRefreshMetricsTracker } from "./operator-snapshot-refresh.js";
import { projectOverview } from "./overview-projection.js";
import {
  InteractiveRequestCancelledError,
  InteractiveRequestDeadlineError,
  withInteractiveRequestDeadline,
  withOperatorRequestSignal,
} from "./request-context.js";
import {
  RosterReconciliationMetricsTracker,
  RosterReconciliationRetryError,
  startRosterReconciliationLoop,
} from "./roster-reconciliation-refresh.js";
import type { SignerGrantService } from "./signer-grant-service.js";
import { SignerStakerAnchorError } from "./signer-staker-sync.js";
import {
  createOperatorSupportBundle,
  type OperatorSupportApplication,
  operatorSupportApplication,
} from "./support-bundle.js";
import { TransactionEngineApiServiceError } from "./transaction-engine/api-service.js";
import { WalletIntentError, type WalletIntentService } from "./wallet-intent-service.js";
import { OperatorWorkflowError } from "./workflow-error.js";

const INTERACTIVE_REQUEST_DEADLINE_MS = 15_000;
const RECONCILIATION_SNAPSHOT_DEADLINE_MS = 60_000;

interface RosterRow {
  stakerPrincipal?: string;
  active?: boolean;
  bond?: null | { bondIndex?: string; amountSats?: string; isL1Lock?: boolean };
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
  readiness?: unknown;
  setup?: unknown;
  forecast?: unknown;
  rewards?: unknown;
  roster?: RosterRow[];
  activity?: { withdrawals?: unknown[] };
  alerts?: unknown[];
  freshness?: { status: "current" | "stale" };
}

interface OperatorSnapshotService {
  snapshot(force?: boolean): Promise<OperatorSnapshotShape>;
  supportSnapshot?(force?: boolean): Promise<OperatorSnapshotShape>;
  synchronize(options?: {
    signal?: AbortSignal;
    onProgress?(progress: OperatorSynchronizationProgress): void | Promise<void>;
  }): Promise<unknown>;
  activity?(options?: {
    claimLimit?: number;
    claimOffset?: number;
    claimSort?: "cycle" | "staker" | "amount" | "destination" | "block" | "transaction";
    claimDirection?: SortDirection;
    rewardCycle?: string | null;
    withdrawalLimit?: number;
    withdrawalOffset?: number;
    withdrawalSort?: "request" | "staker" | "amount" | "max-fee" | "state" | "block";
    withdrawalDirection?: SortDirection;
    withdrawalState?: "pending" | "settled" | "reclaimed" | null;
  }): Promise<unknown>;
  summary?(force?: boolean): Promise<OperatorSnapshotShape>;
  poolPage?(options?: {
    offset?: number;
    limit?: number;
    query?: string;
    sort?: PoolRosterSort;
    direction?: SortDirection;
  }): Promise<unknown>;
  rewardsPage?(options?: {
    offset?: number;
    limit?: number;
    sort?: RewardStakerSort;
    direction?: SortDirection;
  }): Promise<unknown>;
  rewardsHistory?(options?: {
    offset?: number;
    limit?: number;
    sort?:
      | "cycle"
      | "status"
      | "stakers"
      | "gross"
      | "net"
      | "fee"
      | "configured-fee"
      | "effective-fee"
      | "actionable"
      | "bitcoin-block";
    direction?: SortDirection;
  }): Promise<unknown>;
  stakerClaims?(options?: { offset?: number; limit?: number }): Promise<unknown>;
  settings?(): unknown;
  updateSettings?(input: unknown): unknown;
}

interface ActivityProjectionApiService {
  page(query: ActivityQuery, readOnly?: boolean): ActivityResponse;
  detail(activityId: string, readOnly?: boolean): ActivityDetail | null;
}

function observerAlerts(status: ObserverRuntimeStatus | undefined): DashboardAlert[] {
  if (!status?.enabled || status.gap?.status !== "degraded") return [];
  const nodeHeight = status.gap.nodeStacksHeight;
  const observerHeight = status.gap.observerStacksHeight;
  const silence = status.gap.observerSilenceSeconds;
  return [
    {
      id: "observer:callbacks-behind",
      severity: "warning",
      title: "Event Observer Is Behind",
      detail: `The local node is at Stacks ${nodeHeight ?? "an unknown height"}, but the latest node-verified callback is ${observerHeight ?? "not available"}${silence === null ? "" : ` (${Math.round(silence)} seconds old)`}. Sidekick is using polling fallback while callback delivery recovers.`,
    },
  ];
}

function withObserverAlerts(
  snapshot: OperatorSnapshotShape,
  status: ObserverRuntimeStatus | undefined,
): OperatorSnapshotShape {
  const additions = observerAlerts(status);
  if (additions.length === 0) return snapshot;
  const existing = Array.isArray(snapshot.alerts) ? snapshot.alerts : [];
  const ids = new Set(
    existing.flatMap((alert) =>
      alert && typeof alert === "object" && typeof (alert as { id?: unknown }).id === "string"
        ? [(alert as { id: string }).id]
        : [],
    ),
  );
  return { ...snapshot, alerts: [...existing, ...additions.filter(({ id }) => !ids.has(id))] };
}

function settingsNodeRpcUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const dataSources = (value as { dataSources?: unknown }).dataSources;
  if (!dataSources || typeof dataSources !== "object") return null;
  const nodeRpcUrl = (dataSources as { nodeRpcUrl?: unknown }).nodeRpcUrl;
  return typeof nodeRpcUrl === "string" ? nodeRpcUrl : null;
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

function snapshotBoolean(value: unknown, key: string): boolean | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : null;
}

function operationReadiness(
  snapshot: OperatorSnapshotShape,
  engine: EngineStatus | null,
): OperationReadiness {
  const preflight = snapshotStatus(snapshot.preflight, ["pass", "warn", "fail"]);
  const managerAttached = snapshotBoolean(snapshot.manager, "attachAllowed");
  const signerRegistered = snapshotBoolean(snapshot.registration, "registered");
  const signerGrantValid = snapshotBoolean(snapshot.registration, "signerKeyGrantValid");
  const engineAvailability = engine?.adapters.some((adapter) => adapter.availability === "blocked")
    ? "blocked"
    : engine?.adapters.some((adapter) => adapter.availability === "disabled")
      ? "attention"
      : engine
        ? "ready"
        : "attention";
  const checks: OperationReadinessCheck[] = [
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
          ? "Local node, network, PoX-5, and indexed API checks pass."
          : preflight === "warn"
            ? "Local operation remains available, but one or more optional or compatibility checks need review."
            : preflight === "fail"
              ? "The local node, network, or PoX-5 checks failed."
              : "No preflight result is available.",
    },
    {
      id: "manager",
      status:
        managerAttached === true ? "ready" : managerAttached === false ? "blocked" : "attention",
      detail:
        managerAttached === true
          ? "The configured manager is attached and satisfies the PoX-5 signer-manager trait."
          : managerAttached === false
            ? "The configured manager is missing, on the wrong network, or trait-incompatible."
            : "No manager attachment result is available.",
    },
    {
      id: "signer",
      status:
        signerRegistered === true && signerGrantValid === true
          ? "ready"
          : signerRegistered === false || signerGrantValid === false
            ? "blocked"
            : "attention",
      detail:
        signerRegistered === true && signerGrantValid === true
          ? "The manager is registered with an authorized signer key."
          : signerRegistered === false
            ? "The manager is not registered with a signer key."
            : signerGrantValid === false
              ? "The registered signer key grant is not valid."
              : "Signer registration or grant status is unavailable.",
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
    schemaVersion: 2,
    status,
    generatedAt: snapshot.generatedAt ?? engine?.generatedAt ?? new Date().toISOString(),
    checks,
  });
}

type ActivityOptions = Parameters<NonNullable<OperatorSnapshotService["activity"]>>[0];

export interface TransactionEngineApiService {
  status(): Promise<EngineStatus> | EngineStatus;
  listJobs(options: {
    cursor: string | null;
    limit: number;
    states?: readonly EngineJobState[];
  }): Promise<EngineJobPage>;
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
  activityProjection?: ActivityProjectionApiService;
  connection?: {
    current(): ConnectionAssessment | null;
    check(force?: boolean): Promise<ConnectionAssessment>;
  };
  deploymentRequirements?: {
    current(): DeploymentRequirements | null;
    check(force?: boolean): Promise<DeploymentRequirements>;
  };
  isOperational?(): boolean;
  onConnectionAssessed?(assessment: ConnectionAssessment): Promise<void> | void;
  authToken?: string;
  authTrustedHeader?: string;
  authBasicUsername?: string;
  getRateLimitSettings?(): RateLimitApiSource;
  logger?: boolean;
  staticDirectory?: string | null;
  wallet?: WalletIntentService;
  signerGrant?: SignerGrantService;
  health?: {
    current(): Promise<HealthSnapshot>;
    refresh(): Promise<HealthSnapshot>;
    testSource(
      kind: "node-metrics" | "signer-monitoring" | "hiro-reference",
      url: string,
    ): Promise<unknown>;
  };
  engine?: TransactionEngineApiService;
  supportApplication?(): OperatorSupportApplication;
  databaseStatus?(): unknown;
  observerStatus?(): ObserverRuntimeStatus;
  snapshotRefreshMetrics?: SnapshotRefreshMetricsTracker;
  rosterReconciliationIntervalMs?: number;
  rosterReconciliationInitialDelayMs?: number;
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

interface SupportDiagnosticEvent {
  recordedAt: string;
  severity: "warning" | "error";
  source: "operator-api" | "reconciliation";
  code: string;
  message: string;
  requestId: string | null;
}

const SAFE_OPERATOR_API_MESSAGES: Readonly<Record<string, string>> = {
  connection_required:
    "Sidekick has not established its configured local-node and signer-manager connection. Review the connection result and recheck.",
  operator_service_unavailable:
    "The operator service is unavailable. Restart Sidekick and review the startup logs.",
  unauthorized:
    "The operator credential is missing or invalid. Check proxy authentication or enter the configured credential and retry.",
  invalid_health_source: "Choose a supported health source and enter a valid URL.",
  invalid_pagination: "Pagination values are invalid. Correct the request and retry.",
  limit_must_be_positive:
    "Pagination limits must be positive whole numbers. Correct the request and retry.",
  limits_must_be_positive:
    "Activity page limits must be positive whole numbers. Correct the request and retry.",
  invalid_withdrawal_state: "Choose a pending, settled, or reclaimed withdrawal state.",
  invalid_query: "The activity query is invalid. Correct its filters and retry.",
  invalid_activity_query: "The Activity filters are invalid. Correct them and retry.",
  invalid_activity_cursor: "The Activity page changed or its cursor is invalid. Refresh Activity.",
  invalid_activity_id: "The Activity identifier is invalid. Refresh Activity and retry.",
  activity_not_found: "This Activity item no longer exists. Refresh Activity.",
  activity_projection_unavailable:
    "Activity is unavailable in this Sidekick deployment. Restart Sidekick and review the startup logs.",
  activity_authority_limit_exceeded:
    "Activity cannot safely project the complete operator record. Contact support before retrying.",
  signer_grant_sources_incompatible:
    "Signer grant preparation is blocked by node, API, or PoX-5 compatibility checks. Review preflight, resolve the failures, and retry.",
  signer_grant_unavailable:
    "Signer registration repair is unavailable. Restart Sidekick and review the startup logs.",
  signer_grant_not_prepared: "Generate a signer command before verifying its output.",
  signer_grant_changed:
    "A newer signer command replaced this authorization. Verify the latest command output.",
  invalid_manager_principal: "Enter a valid manager contract principal and retry.",
  invalid_signer_output: "Signer output is invalid. Paste the complete JSON output and retry.",
  invalid_signer_grant_input:
    "Enter a valid authorization ID and signer configuration path, then retry.",
  invalid_wallet_intent_action:
    "The wallet transaction request is invalid. Review the action fields and retry.",
  wallet_intent_unavailable:
    "Wallet-signed operations are unavailable. Restart Sidekick and review the startup logs.",
  wallet_intent_not_found:
    "The wallet transaction request was not found. Prepare a new transaction.",
  invalid_wallet_intent_submission:
    "The transaction submission is invalid. Enter a valid transaction ID and retry.",
  invalid_wallet_intent_refresh:
    "The wallet transaction request is invalid. Prepare a new transaction.",
  invalid_wallet_intent_replacement:
    "The wallet transaction request is invalid. Prepare a new transaction.",
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
    "The local node is behind or inconsistent with the configured chain sources. Check node synchronization and retry.",
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
    "The node or API returned a response this Sidekick version does not support. Check the configured endpoint and version; if it persists, review the Sidekick logs.",
  health_source_not_allowed:
    "Sidekick cannot use this URL because it points to a special-purpose network address (for example, link-local or multicast). Use a normal LAN, Tailnet, or public address for this service, or proxy it through one.",
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
      (tips.node.stacksTipHeight < tips.api.stacksTipHeight ||
        tips.node.burnBlockHeight < tips.api.burnBlockHeight ||
        tips.poxBurnBlockHeight !== tips.node.burnBlockHeight),
  );
}

function rateLimitMessage(info: NonNullable<ReturnType<typeof rateLimitInfo>>): string {
  switch (info.source) {
    case "hiro-api":
      return "Hiro API is rate limiting Sidekick. It will retry automatically.";
    case "stacks-api":
      return "The configured Stacks API is rate limiting Sidekick. It will retry automatically.";
    case "node":
      return "The local Stacks node is rate limiting Sidekick. It will retry automatically.";
  }
}

function classifySafeOperatorError(
  error: unknown,
  configuredApi?: RateLimitApiSource,
): SafeErrorClassification {
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
  if (error instanceof WalletIntentError) {
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
        ...(error.tips
          ? {
              details: {
                node: error.tips.node,
                api: error.tips.api,
                poxBurnBlockHeight: error.tips.poxBurnBlockHeight,
              },
            }
          : {}),
      });
    }
    return safeClassification(502, "chain_anchor_invalid");
  }
  if (error instanceof SignerStakerAnchorError) {
    return safeClassification(503, "signer_staker_anchor_unstable", {
      retryable: true,
      retryAfterSeconds: 1,
      ...(error.evidence ? { details: { anchorEvidence: error.evidence } } : {}),
    });
  }
  if (error instanceof RateLimitedError) {
    const info = configuredApi ? rateLimitInfo(error, configuredApi) : null;
    return safeClassification(429, "upstream_rate_limited", {
      ...(info ? { message: rateLimitMessage(info), details: { rateLimit: info } } : {}),
      retryable: true,
      retryAfterSeconds:
        info?.retryAfterSeconds ??
        Math.min(30, Math.max(1, Math.ceil((error.retryAfterMs ?? 1_000) / 1_000))),
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
  configuredApi?: RateLimitApiSource,
  recordDiagnostic?: (event: SupportDiagnosticEvent) => void,
): FastifyReply {
  const classified = classifySafeOperatorError(error, configuredApi);
  const body =
    classified.statusCode === 500
      ? {
          ...classified.body,
          message: `Sidekick could not complete the request. Check operator logs for request ${request.id}.`,
          requestId: request.id,
        }
      : classified.body;
  recordDiagnostic?.({
    recordedAt: new Date().toISOString(),
    severity: classified.statusCode >= 500 ? "error" : "warning",
    source: "operator-api",
    code: body.error,
    message: body.message ?? body.error,
    requestId: request.id,
  });
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

function walletIntentHttpStatus(error: WalletIntentError): number {
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
      (tips.node.stacksTipHeight < tips.api.stacksTipHeight ||
        tips.node.burnBlockHeight < tips.api.burnBlockHeight ||
        tips.poxBurnBlockHeight !== tips.node.burnBlockHeight);
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

type OperatorAuthMethod = "bearer" | "trusted-header" | "basic";

function secureEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return providedBuffer.length === wanted.length && timingSafeEqual(providedBuffer, wanted);
}

function bearerAuthorized(header: string | undefined, expected: string): boolean {
  return Boolean(header?.startsWith("Bearer ") && secureEqual(header.slice(7), expected));
}

function basicAuthorized(
  header: string | undefined,
  expectedUsername: string | undefined,
  expectedPassword: string,
): boolean {
  if (!expectedUsername || !header?.startsWith("Basic ")) return false;
  const encoded = header.slice(6);
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(encoded)) {
    return false;
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) return false;
  const separator = decoded.indexOf(0x3a);
  if (separator < 0) return false;
  return (
    secureEqual(decoded.subarray(0, separator).toString("utf8"), expectedUsername) &&
    secureEqual(decoded.subarray(separator + 1).toString("utf8"), expectedPassword)
  );
}

function operatorAuthMethod(
  headers: FastifyRequest["headers"],
  options: ServerOptions,
): OperatorAuthMethod | null {
  const expected = options.authToken ?? "";
  if (bearerAuthorized(headers.authorization, expected)) return "bearer";
  if (options.authTrustedHeader) {
    const provided = headers[options.authTrustedHeader];
    if (typeof provided === "string" && secureEqual(provided, expected)) return "trusted-header";
  }
  if (basicAuthorized(headers.authorization, options.authBasicUsername, expected)) return "basic";
  return null;
}

function authenticationChallenges(options: ServerOptions): string {
  return options.authBasicUsername
    ? 'Basic realm="Signer Sidekick", charset="UTF-8", Bearer'
    : "Bearer";
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

function parseActivityQuery(requestUrl: string): ActivityQuery {
  try {
    const search = new URL(requestUrl, "http://sidekick.local").searchParams;
    const status = z
      .enum(["all", "action-required", "needs-attention", "in-progress", "resolved"])
      .parse(search.get("status") ?? "all");
    const type = z
      .enum(["all", "actions", "chain-events", "configuration"])
      .parse(search.get("type") ?? "all");
    const domain = z
      .enum(["all", "manager", "pool", "rewards", "node", "signer", "network", "sidekick"])
      .parse(search.get("domain") ?? "all");
    const time = z.enum(["24h", "7d", "30d", "all"]).parse(search.get("time") ?? "30d");
    const searchText = search.get("search");
    const cursor = search.get("cursor");
    if (searchText !== null && (searchText.length < 1 || searchText.length > 500))
      throw new Error();
    if (cursor !== null && (cursor.length < 1 || cursor.length > 2_000)) throw new Error();
    const limit = integerQuery(search, "limit", 50, 100);
    if (limit < 1) throw new Error();
    return { status, type, domain, time, search: searchText, cursor, limit };
  } catch {
    throw new OperatorApiError(400, "invalid_activity_query");
  }
}

function parseSort<Key extends string>(
  requestUrl: string,
  keys: readonly Key[],
  names: { sort: string; direction: string } = { sort: "sort", direction: "direction" },
): { sort: Key; direction: SortDirection } | null {
  const search = new URL(requestUrl, "http://sidekick.local").searchParams;
  const sort = search.get(names.sort);
  if (sort === null) return null;
  if (!keys.includes(sort as Key)) throw new OperatorApiError(400, "invalid_sort");
  const direction = search.get(names.direction) ?? "asc";
  if (direction !== "asc" && direction !== "desc") {
    throw new OperatorApiError(400, "invalid_sort_direction");
  }
  return { sort: sort as Key, direction };
}

function engineActor(): string {
  return "local-operator";
}

export function createServer(options: ServerOptions = {}) {
  if (
    (options.service ||
      options.connection ||
      options.deploymentRequirements ||
      options.activityProjection) &&
    (!options.authToken ||
      options.authToken.length < 24 ||
      options.authToken === "replace-with-at-least-24-random-characters")
  ) {
    throw new Error("The operator API requires SIDEKICK_AUTH_TOKEN with at least 24 characters");
  }
  if (
    options.authTrustedHeader &&
    (!/^[!#$%&'*+.^_`|~\w-]+$/.test(options.authTrustedHeader) ||
      ["authorization", "cookie", "host"].includes(options.authTrustedHeader.toLowerCase()))
  ) {
    throw new Error("SIDEKICK_AUTH_TRUSTED_HEADER must be a valid non-standard HTTP header name");
  }
  if (
    options.authBasicUsername !== undefined &&
    (!options.authBasicUsername ||
      options.authBasicUsername.includes(":") ||
      options.authBasicUsername.length > 128)
  ) {
    throw new Error(
      "SIDEKICK_AUTH_BASIC_USERNAME must be 1 through 128 characters and must not contain a colon",
    );
  }
  if (options.authTrustedHeader) {
    options = { ...options, authTrustedHeader: options.authTrustedHeader.toLowerCase() };
  }
  const server = Fastify({ logger: options.logger ?? true });
  const rateLimitSettings = (): RateLimitApiSource | undefined => {
    try {
      return options.getRateLimitSettings?.();
    } catch {
      return undefined;
    }
  };
  let requestCount = 0;
  let syncRequestCount = 0;
  let syncCount = 0;
  let syncFailureCount = 0;
  const recentSidekickErrors: SupportDiagnosticEvent[] = [];
  const recordDiagnostic = (event: SupportDiagnosticEvent) => {
    recentSidekickErrors.push(event);
    if (recentSidekickErrors.length > 50)
      recentSidekickErrors.splice(0, recentSidekickErrors.length - 50);
  };
  const rosterReconciliationMetrics = new RosterReconciliationMetricsTracker();
  let rosterReconciliationLoop: { stop(): void } | null = null;
  const idleReconciliationOperation = (): ReconciliationOperation => ({
    schemaVersion: 1,
    operationId: null,
    trigger: null,
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
  let reconciliationRetryAfterSeconds: number | null = null;

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
    service: OperatorSnapshotService,
    trigger: "manual" | "automatic",
    logger: Pick<FastifyRequest["log"], "warn">,
  ): ReconciliationOperation {
    if (reconciliationTask) return reconciliationOperation;
    syncCount += 1;
    reconciliationRetryAfterSeconds = null;
    const controller = new AbortController();
    reconciliationController = controller;
    const startedAt = new Date().toISOString();
    reconciliationOperation = {
      schemaVersion: 1,
      operationId: randomUUID(),
      trigger,
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
        message:
          trigger === "automatic"
            ? "Starting automatic signer delegation discovery"
            : "Starting signer delegation discovery",
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
        const classified = classifySafeOperatorError(error, rateLimitSettings());
        recordDiagnostic({
          recordedAt: failedAt,
          severity: "error",
          source: "reconciliation",
          code: classified.body.error,
          message: classified.body.message ?? classified.body.error,
          requestId: null,
        });
        reconciliationRetryAfterSeconds =
          error instanceof RateLimitedError
            ? Math.max(1, Math.ceil((error.retryAfterMs ?? 60_000) / 1_000))
            : null;
        logger.warn(
          {
            err: error,
            responseCode: classified.body.error,
            ...(error instanceof SignerStakerAnchorError && error.evidence
              ? { anchorEvidence: error.evidence }
              : {}),
          },
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

  async function runAutomaticRosterReconciliation(
    service: OperatorSnapshotService,
  ): Promise<"synchronized" | "skipped"> {
    if (options.isOperational?.() === false) return "skipped";
    if (options.connection && options.connection.current()?.status !== "connected")
      return "skipped";
    if (reconciliationTask) return "skipped";
    const snapshot = await service.snapshot();
    const setup = snapshotStatus(snapshot.setup, ["ready", "attention", "blocked"]);
    if (setup === null || setup === "blocked") return "skipped";
    if (reconciliationTask) return "skipped";
    startReconciliation(service, "automatic", server.log);
    const task = reconciliationTask;
    if (!task) return "skipped";
    await task;
    if (reconciliationOperation.status === "succeeded") return "synchronized";
    throw new RosterReconciliationRetryError(
      reconciliationOperation.error?.message ?? "Automatic roster reconciliation failed",
      reconciliationRetryAfterSeconds === null ? null : reconciliationRetryAfterSeconds * 1_000,
    );
  }

  server.setErrorHandler((error: FastifyError, request, reply) => {
    return sendClassifiedError(request, reply, error, rateLimitSettings(), recordDiagnostic);
  });

  server.addHook("onReady", async () => {
    const service = options.service;
    if (!service) return;
    rosterReconciliationLoop = startRosterReconciliationLoop(
      { reconcileRoster: async () => runAutomaticRosterReconciliation(service) },
      server.log,
      {
        metrics: rosterReconciliationMetrics,
        ...(options.rosterReconciliationIntervalMs === undefined
          ? {}
          : { intervalMs: options.rosterReconciliationIntervalMs }),
        ...(options.rosterReconciliationInitialDelayMs === undefined
          ? {}
          : { initialDelayMs: options.rosterReconciliationInitialDelayMs }),
      },
    );
  });

  server.addHook("onClose", async () => {
    rosterReconciliationLoop?.stop();
    reconciliationController?.abort(new InteractiveRequestCancelledError());
    await reconciliationTask;
  });

  server.addHook("onRequest", async (request, reply) => {
    requestCount += 1;
    if (!request.url.startsWith("/api/")) return;
    if (!operatorAuthMethod(request.headers, options)) {
      reply.header("www-authenticate", authenticationChallenges(options));
      throw new OperatorApiError(401, "unauthorized");
    }
    const pathname = new URL(request.url, "http://sidekick.local").pathname;
    const connection = options.connection?.current();
    const safeWhileDisconnected =
      pathname === "/api/v1/auth/session" ||
      pathname === "/api/v1/connection" ||
      pathname === "/api/v1/connection/recheck" ||
      pathname === "/api/v1/deployment-requirements" ||
      pathname === "/api/v1/deployment-requirements/refresh" ||
      pathname === "/api/v1/support-bundle" ||
      (pathname === "/api/v1/health" && (request.method === "GET" || request.method === "HEAD")) ||
      ((pathname === "/api/v1/activity" || pathname.startsWith("/api/v1/activity/")) &&
        (request.method === "GET" || request.method === "HEAD")) ||
      (pathname === "/api/v1/settings" &&
        (request.method === "GET" ||
          (request.method === "PUT" && connection?.status === "unavailable")));
    const retainedReadOnlyAccess =
      connection?.status === "unavailable" &&
      connection.lastSuccessful !== null &&
      (request.method === "GET" || request.method === "HEAD");
    const connectionBlocksRequest =
      connection !== undefined && connection?.status !== "connected" && !retainedReadOnlyAccess;
    if (
      !safeWhileDisconnected &&
      (connectionBlocksRequest || (options.isOperational?.() === false && !retainedReadOnlyAccess))
    ) {
      throw new OperatorApiError(503, "connection_required", true);
    }
    if (!options.service && !safeWhileDisconnected) {
      throw new OperatorApiError(503, "operator_service_unavailable");
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
  server.get("/api/v1/auth/session", async (request) => ({
    authenticated: true,
    method: operatorAuthMethod(request.headers, options),
  }));
  server.get("/api/v1/connection", async (request) => {
    const connection = requireFeature(options.connection, "operator_service_unavailable");
    const result = await interactive(request, async () => await connection.check());
    await options.onConnectionAssessed?.(result);
    return result;
  });
  server.post("/api/v1/connection/recheck", async (request) => {
    const connection = requireFeature(options.connection, "operator_service_unavailable");
    const result = await interactive(request, async () => await connection.check(true));
    await options.onConnectionAssessed?.(result);
    return result;
  });
  server.get("/api/v1/deployment-requirements", async (request, reply) => {
    const requirements = requireFeature(
      options.deploymentRequirements,
      "operator_service_unavailable",
    );
    const result = await interactive(request, async () =>
      deploymentRequirementsSchema.parse(await requirements.check()),
    );
    return reply.header("cache-control", "no-store").send(result);
  });
  server.post("/api/v1/deployment-requirements/refresh", async (request, reply) => {
    const requirements = requireFeature(
      options.deploymentRequirements,
      "operator_service_unavailable",
    );
    const result = await interactive(request, async () =>
      deploymentRequirementsSchema.parse(await requirements.check(true)),
    );
    return reply.header("cache-control", "no-store").send(result);
  });
  server.get("/health/ready", async (request, reply) => {
    if (options.connection) {
      const connection = await interactive(request, async () => await options.connection?.check());
      if (!connection) return reply.code(503).send({ status: "not-ready" });
      if (connection.status !== "connected") {
        return reply.code(503).send({
          status: "not-ready",
          code: connection.outcomeCode,
          checkedAt: connection.checkedAt,
          stale: connection.stale,
        });
      }
    }
    if (!options.service) return reply.code(503).send({ status: "not-ready" });
    const service = options.service;
    try {
      const snapshot = await interactive(request, () =>
        service.summary ? service.summary() : service.snapshot(),
      );
      const preflight = snapshot.preflight as { status?: string } | undefined;
      const ready = preflight?.status !== "fail";
      return reply.code(ready ? 200 : 503).send({
        status: ready ? "ready" : "not-ready",
        generatedAt: snapshot.generatedAt,
        freshness: snapshot.freshness?.status ?? "current",
      });
    } catch (error) {
      request.log.warn({ err: error }, "readiness snapshot failed");
      return reply.code(503).send({ status: "not-ready" });
    }
  });
  server.get("/metrics", async (_request, reply) => {
    reply.type("text/plain; version=0.0.4; charset=utf-8");
    const health = options.health ? await options.health.current().catch(() => null) : null;
    const refresh = options.snapshotRefreshMetrics?.snapshot() ?? {
      attemptsTotal: 0,
      successesTotal: 0,
      failuresTotal: 0,
      consecutiveFailures: 0,
      retryBackoffSeconds: 0,
      lastSuccessTimestampSeconds: 0,
      snapshotGeneratedTimestampSeconds: 0,
      snapshotAgeSeconds: 0,
      snapshotFresh: 0 as const,
      sourcePositions: null,
    };
    const rosterRefresh = rosterReconciliationMetrics.snapshot();
    const observer = options.observerStatus?.();
    const metrics = [
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
      "# HELP sidekick_roster_reconciliation_attempts_total Automatic roster reconciliation attempts.",
      "# TYPE sidekick_roster_reconciliation_attempts_total counter",
      `sidekick_roster_reconciliation_attempts_total ${rosterRefresh.attemptsTotal}`,
      "# HELP sidekick_roster_reconciliation_successes_total Successful automatic roster reconciliations.",
      "# TYPE sidekick_roster_reconciliation_successes_total counter",
      `sidekick_roster_reconciliation_successes_total ${rosterRefresh.successesTotal}`,
      "# HELP sidekick_roster_reconciliation_skips_total Automatic roster reconciliations skipped because setup was incomplete or another sync was running.",
      "# TYPE sidekick_roster_reconciliation_skips_total counter",
      `sidekick_roster_reconciliation_skips_total ${rosterRefresh.skipsTotal}`,
      "# HELP sidekick_roster_reconciliation_failures_total Failed automatic roster reconciliations.",
      "# TYPE sidekick_roster_reconciliation_failures_total counter",
      `sidekick_roster_reconciliation_failures_total ${rosterRefresh.failuresTotal}`,
      "# HELP sidekick_roster_reconciliation_consecutive_failures Consecutive automatic roster reconciliation failures.",
      "# TYPE sidekick_roster_reconciliation_consecutive_failures gauge",
      `sidekick_roster_reconciliation_consecutive_failures ${rosterRefresh.consecutiveFailures}`,
      "# HELP sidekick_roster_reconciliation_retry_backoff_seconds Delay before retrying a failed automatic roster reconciliation.",
      "# TYPE sidekick_roster_reconciliation_retry_backoff_seconds gauge",
      `sidekick_roster_reconciliation_retry_backoff_seconds ${rosterRefresh.retryBackoffSeconds}`,
      "# HELP sidekick_roster_reconciliation_last_success_timestamp_seconds Unix timestamp of the last successful automatic roster reconciliation.",
      "# TYPE sidekick_roster_reconciliation_last_success_timestamp_seconds gauge",
      `sidekick_roster_reconciliation_last_success_timestamp_seconds ${rosterRefresh.lastSuccessTimestampSeconds}`,
      "# HELP sidekick_roster_reconciliation_next_attempt_timestamp_seconds Unix timestamp of the next automatic roster reconciliation attempt.",
      "# TYPE sidekick_roster_reconciliation_next_attempt_timestamp_seconds gauge",
      `sidekick_roster_reconciliation_next_attempt_timestamp_seconds ${rosterRefresh.nextAttemptTimestampSeconds}`,
      "# HELP sidekick_operator_snapshot_refresh_attempts_total Autonomous snapshot refresh attempts.",
      "# TYPE sidekick_operator_snapshot_refresh_attempts_total counter",
      `sidekick_operator_snapshot_refresh_attempts_total ${refresh.attemptsTotal}`,
      "# HELP sidekick_operator_snapshot_refresh_successes_total Successful autonomous snapshot refreshes.",
      "# TYPE sidekick_operator_snapshot_refresh_successes_total counter",
      `sidekick_operator_snapshot_refresh_successes_total ${refresh.successesTotal}`,
      "# HELP sidekick_operator_snapshot_refresh_failures_total Failed autonomous snapshot refreshes.",
      "# TYPE sidekick_operator_snapshot_refresh_failures_total counter",
      `sidekick_operator_snapshot_refresh_failures_total ${refresh.failuresTotal}`,
      "# HELP sidekick_operator_snapshot_refresh_consecutive_failures Consecutive autonomous snapshot refresh failures.",
      "# TYPE sidekick_operator_snapshot_refresh_consecutive_failures gauge",
      `sidekick_operator_snapshot_refresh_consecutive_failures ${refresh.consecutiveFailures}`,
      "# HELP sidekick_operator_snapshot_retry_backoff_seconds Delay before the next autonomous refresh attempt.",
      "# TYPE sidekick_operator_snapshot_retry_backoff_seconds gauge",
      `sidekick_operator_snapshot_retry_backoff_seconds ${refresh.retryBackoffSeconds}`,
      "# HELP sidekick_operator_snapshot_last_success_timestamp_seconds Unix timestamp of the last successful autonomous refresh.",
      "# TYPE sidekick_operator_snapshot_last_success_timestamp_seconds gauge",
      `sidekick_operator_snapshot_last_success_timestamp_seconds ${refresh.lastSuccessTimestampSeconds}`,
      "# HELP sidekick_operator_snapshot_generated_timestamp_seconds Unix timestamp carried by the retained operator snapshot.",
      "# TYPE sidekick_operator_snapshot_generated_timestamp_seconds gauge",
      `sidekick_operator_snapshot_generated_timestamp_seconds ${refresh.snapshotGeneratedTimestampSeconds}`,
      "# HELP sidekick_operator_snapshot_age_seconds Age of the retained operator snapshot.",
      "# TYPE sidekick_operator_snapshot_age_seconds gauge",
      `sidekick_operator_snapshot_age_seconds ${refresh.snapshotAgeSeconds}`,
      "# HELP sidekick_operator_snapshot_fresh Whether the autonomous snapshot refresh is current and healthy.",
      "# TYPE sidekick_operator_snapshot_fresh gauge",
      `sidekick_operator_snapshot_fresh ${refresh.snapshotFresh}`,
    ];
    if (health) {
      const findingsByClassification = new Map<string, number>();
      for (const finding of health.findings) {
        findingsByClassification.set(
          finding.classification,
          (findingsByClassification.get(finding.classification) ?? 0) + 1,
        );
      }
      metrics.push(
        "# HELP sidekick_signer_health_diagnosis Current evidence-backed diagnosis as a one-hot classified gauge.",
        "# TYPE sidekick_signer_health_diagnosis gauge",
        ...[
          "healthy",
          "likely-local-node",
          "likely-local-signer",
          "source-disagreement",
          "suspected-network-wide",
          "insufficient-evidence",
        ].map(
          (classification) =>
            `sidekick_signer_health_diagnosis{classification="${classification}"} ${health.diagnosis.classification === classification ? 1 : 0}`,
        ),
        "# HELP sidekick_signer_health_active_findings Active health findings by evidence-backed classification.",
        "# TYPE sidekick_signer_health_active_findings gauge",
        ...[
          "likely-local-node",
          "likely-local-signer",
          "source-disagreement",
          "suspected-network-wide",
          "insufficient-evidence",
        ].map(
          (classification) =>
            `sidekick_signer_health_active_findings{classification="${classification}"} ${findingsByClassification.get(classification) ?? 0}`,
        ),
        "# HELP sidekick_signer_health_observations Retained raw observations for the active configuration.",
        "# TYPE sidekick_signer_health_observations gauge",
        `sidekick_signer_health_observations ${health.history.observationCount}`,
        "# HELP sidekick_signer_health_generated_timestamp_seconds Timestamp of the latest local health observation.",
        "# TYPE sidekick_signer_health_generated_timestamp_seconds gauge",
        `sidekick_signer_health_generated_timestamp_seconds ${Date.parse(health.generatedAt) / 1_000}`,
        "# HELP sidekick_signer_health_source_available Whether a configured health source is currently reachable.",
        "# TYPE sidekick_signer_health_source_available gauge",
        `sidekick_signer_health_source_available{source="node-rpc"} ${health.node.rpc.status === "healthy" ? 1 : 0}`,
        `sidekick_signer_health_source_available{source="node-metrics"} ${health.node.metrics.status === "healthy" ? 1 : 0}`,
        `sidekick_signer_health_source_available{source="signer-info"} ${health.signer.infoSource.status === "healthy" ? 1 : 0}`,
        `sidekick_signer_health_source_available{source="signer-heartbeat"} ${health.signer.heartbeat.status === "healthy" ? 1 : 0}`,
        `sidekick_signer_health_source_available{source="signer-metrics"} ${health.signer.metrics.status === "healthy" ? 1 : 0}`,
        `sidekick_signer_health_source_available{source="reference-api"} ${health.hiro.source.status === "healthy" ? 1 : 0}`,
        `sidekick_signer_health_source_available{source="configured-api"} ${health.configuredApi.source.status === "healthy" ? 1 : 0}`,
      );
      if (health.signer.last15Minutes.responseGap !== null) {
        metrics.push(
          "# HELP sidekick_signer_response_gap Unaccounted-for proposals in the rolling 15-minute window.",
          "# TYPE sidekick_signer_response_gap gauge",
          `sidekick_signer_response_gap ${health.signer.last15Minutes.responseGap}`,
        );
      }
      if (health.signer.last15Minutes.rejectionPercent !== null) {
        metrics.push(
          "# HELP sidekick_signer_rejection_percent Rejected signer responses in the rolling 15-minute window.",
          "# TYPE sidekick_signer_rejection_percent gauge",
          `sidekick_signer_rejection_percent ${health.signer.last15Minutes.rejectionPercent}`,
        );
      }
      if (health.signer.last15Minutes.responseP95Seconds !== null) {
        metrics.push(
          "# HELP sidekick_signer_response_p95_seconds Diagnostic-only approximate signer response p95 in the rolling 15-minute window; this does not open health findings.",
          "# TYPE sidekick_signer_response_p95_seconds gauge",
          `sidekick_signer_response_p95_seconds ${health.signer.last15Minutes.responseP95Seconds}`,
        );
      }
      if (health.signer.last15Minutes.validationP95Seconds !== null) {
        metrics.push(
          "# HELP sidekick_signer_validation_p95_seconds Approximate node-reported successful block-validation p95 in the rolling 15-minute window.",
          "# TYPE sidekick_signer_validation_p95_seconds gauge",
          `sidekick_signer_validation_p95_seconds ${health.signer.last15Minutes.validationP95Seconds}`,
        );
      }
    }
    if (observer) {
      metrics.push(
        "# HELP sidekick_observer_enabled Whether the private Stacks event listener is configured.",
        "# TYPE sidekick_observer_enabled gauge",
        `sidekick_observer_enabled ${observer.enabled ? 1 : 0}`,
        "# HELP sidekick_observer_listening Whether the private Stacks event listener is accepting callbacks.",
        "# TYPE sidekick_observer_listening gauge",
        `sidekick_observer_listening ${observer.listening ? 1 : 0}`,
        "# HELP sidekick_observer_deliveries_total Event callback delivery attempts durably recorded.",
        "# TYPE sidekick_observer_deliveries_total counter",
        `sidekick_observer_deliveries_total ${observer.inbox.deliveryAttempts}`,
        "# HELP sidekick_observer_duplicates_total Duplicate event callback delivery attempts.",
        "# TYPE sidekick_observer_duplicates_total counter",
        `sidekick_observer_duplicates_total ${observer.inbox.duplicates}`,
        "# HELP sidekick_observer_processing_attempts_total Durable callback verification attempts.",
        "# TYPE sidekick_observer_processing_attempts_total counter",
        `sidekick_observer_processing_attempts_total ${observer.inbox.processingAttempts}`,
        "# HELP sidekick_observer_queue_depth Observer-claimed callbacks awaiting verification.",
        "# TYPE sidekick_observer_queue_depth gauge",
        `sidekick_observer_queue_depth ${observer.inbox.queueDepth}`,
        "# HELP sidekick_observer_processing Observer callbacks currently claimed by the verification worker.",
        "# TYPE sidekick_observer_processing gauge",
        `sidekick_observer_processing ${observer.inbox.processing}`,
        "# HELP sidekick_observer_quarantined Event callbacks currently quarantined before projection.",
        "# TYPE sidekick_observer_quarantined gauge",
        `sidekick_observer_quarantined ${observer.inbox.quarantined}`,
        "# HELP sidekick_observer_node_verified Event callbacks currently retained after node verification.",
        "# TYPE sidekick_observer_node_verified gauge",
        `sidekick_observer_node_verified ${observer.inbox.nodeVerified}`,
        "# HELP sidekick_observer_expired Event callbacks currently retained as expired triggers.",
        "# TYPE sidekick_observer_expired gauge",
        `sidekick_observer_expired ${observer.inbox.expired}`,
        "# HELP sidekick_observer_retained_payload_bytes Raw callback JSON bytes retained for support evidence.",
        "# TYPE sidekick_observer_retained_payload_bytes gauge",
        `sidekick_observer_retained_payload_bytes ${observer.inbox.retainedPayloadBytes}`,
        "# HELP sidekick_observer_pruned_payloads Terminal callback rows whose raw JSON was pruned.",
        "# TYPE sidekick_observer_pruned_payloads gauge",
        `sidekick_observer_pruned_payloads ${observer.inbox.prunedPayloads}`,
        "# HELP sidekick_observer_oldest_pending_age_seconds Age of the oldest callback awaiting verification.",
        "# TYPE sidekick_observer_oldest_pending_age_seconds gauge",
        `sidekick_observer_oldest_pending_age_seconds ${observer.inbox.oldestPendingAt ? Math.max(0, (Date.now() - Date.parse(observer.inbox.oldestPendingAt)) / 1_000) : 0}`,
        "# HELP sidekick_observer_last_received_timestamp_seconds Last durable callback receipt time.",
        "# TYPE sidekick_observer_last_received_timestamp_seconds gauge",
        `sidekick_observer_last_received_timestamp_seconds ${observer.inbox.lastReceivedAt ? Date.parse(observer.inbox.lastReceivedAt) / 1_000 : 0}`,
        "# HELP sidekick_observer_last_processed_timestamp_seconds Last callback verification attempt time.",
        "# TYPE sidekick_observer_last_processed_timestamp_seconds gauge",
        `sidekick_observer_last_processed_timestamp_seconds ${observer.inbox.lastProcessedAt ? Date.parse(observer.inbox.lastProcessedAt) / 1_000 : 0}`,
      );
      if (observer.reconciliation) {
        metrics.push(
          "# HELP sidekick_observer_reconciliation_pending Whether observer-triggered domain work is retained for execution.",
          "# TYPE sidekick_observer_reconciliation_pending gauge",
          "# HELP sidekick_observer_reconciliation_running Whether observer-triggered domain work is executing.",
          "# TYPE sidekick_observer_reconciliation_running gauge",
          "# HELP sidekick_observer_reconciliation_requests_total Observer reconciliation requests, including coalesced prompts.",
          "# TYPE sidekick_observer_reconciliation_requests_total counter",
          "# HELP sidekick_observer_reconciliation_successes_total Successful observer-triggered reconciliations.",
          "# TYPE sidekick_observer_reconciliation_successes_total counter",
          "# HELP sidekick_observer_reconciliation_failures_total Failed observer-triggered reconciliation attempts.",
          "# TYPE sidekick_observer_reconciliation_failures_total counter",
          "# HELP sidekick_observer_reconciliation_consecutive_failures Consecutive observer-triggered reconciliation failures.",
          "# TYPE sidekick_observer_reconciliation_consecutive_failures gauge",
          "# HELP sidekick_observer_reconciliation_latency_seconds Callback receipt to successful domain projection latency.",
          "# TYPE sidekick_observer_reconciliation_latency_seconds histogram",
          "# HELP sidekick_observer_reconciliation_within_two_seconds_total Successful callback projections completed within two seconds.",
          "# TYPE sidekick_observer_reconciliation_within_two_seconds_total counter",
        );
        for (const domain of ["current", "manager-activity", "rewards", "roster"] as const) {
          const status = observer.reconciliation.domains[domain];
          if (!status) continue;
          metrics.push(
            `sidekick_observer_reconciliation_pending{domain="${domain}"} ${status.pending ? 1 : 0}`,
            `sidekick_observer_reconciliation_running{domain="${domain}"} ${status.running ? 1 : 0}`,
            `sidekick_observer_reconciliation_requests_total{domain="${domain}"} ${status.requests}`,
            `sidekick_observer_reconciliation_successes_total{domain="${domain}"} ${status.successes}`,
            `sidekick_observer_reconciliation_failures_total{domain="${domain}"} ${status.failuresTotal}`,
            `sidekick_observer_reconciliation_consecutive_failures{domain="${domain}"} ${status.consecutiveFailures}`,
            `sidekick_observer_reconciliation_latency_seconds_bucket{domain="${domain}",le="1"} ${status.callbackLatency.buckets.le1}`,
            `sidekick_observer_reconciliation_latency_seconds_bucket{domain="${domain}",le="2"} ${status.callbackLatency.buckets.le2}`,
            `sidekick_observer_reconciliation_latency_seconds_bucket{domain="${domain}",le="5"} ${status.callbackLatency.buckets.le5}`,
            `sidekick_observer_reconciliation_latency_seconds_bucket{domain="${domain}",le="10"} ${status.callbackLatency.buckets.le10}`,
            `sidekick_observer_reconciliation_latency_seconds_bucket{domain="${domain}",le="30"} ${status.callbackLatency.buckets.le30}`,
            `sidekick_observer_reconciliation_latency_seconds_bucket{domain="${domain}",le="+Inf"} ${status.callbackLatency.samples}`,
            `sidekick_observer_reconciliation_latency_seconds_sum{domain="${domain}"} ${status.callbackLatency.sumSeconds}`,
            `sidekick_observer_reconciliation_latency_seconds_count{domain="${domain}"} ${status.callbackLatency.samples}`,
            `sidekick_observer_reconciliation_within_two_seconds_total{domain="${domain}"} ${status.callbackLatency.withinTwoSeconds}`,
          );
        }
      }
      if (observer.gap) {
        metrics.push(
          "# HELP sidekick_observer_gap_degraded Whether the local node advanced without a timely observer callback.",
          "# TYPE sidekick_observer_gap_degraded gauge",
          `sidekick_observer_gap_degraded ${observer.gap.status === "degraded" ? 1 : 0}`,
          "# HELP sidekick_observer_gap_checks_total Local node-only observer gap checks.",
          "# TYPE sidekick_observer_gap_checks_total counter",
          `sidekick_observer_gap_checks_total ${observer.gap.checksTotal}`,
          "# HELP sidekick_observer_gap_failures_total Failed observer gap checks caused by node read errors.",
          "# TYPE sidekick_observer_gap_failures_total counter",
          `sidekick_observer_gap_failures_total ${observer.gap.failuresTotal}`,
          "# HELP sidekick_observer_stacks_gap_blocks Difference between the local node and latest node-verified observer Stacks heights.",
          "# TYPE sidekick_observer_stacks_gap_blocks gauge",
          `sidekick_observer_stacks_gap_blocks ${observer.gap.stacksGap ?? 0}`,
          "# HELP sidekick_observer_silence_seconds Seconds since the latest node-verified observer callback or monitor startup.",
          "# TYPE sidekick_observer_silence_seconds gauge",
          `sidekick_observer_silence_seconds ${observer.gap.observerSilenceSeconds ?? 0}`,
        );
      }
    }
    if (refresh.sourcePositions) {
      metrics.push(
        "# HELP sidekick_operator_snapshot_source_stacks_height Stacks height observed in the last successful refresh.",
        "# TYPE sidekick_operator_snapshot_source_stacks_height gauge",
        `sidekick_operator_snapshot_source_stacks_height{source="node"} ${refresh.sourcePositions.nodeStacksHeight}`,
        `sidekick_operator_snapshot_source_stacks_height{source="api"} ${refresh.sourcePositions.apiStacksHeight}`,
        "# HELP sidekick_operator_snapshot_source_burn_height Bitcoin burn height observed in the last successful refresh.",
        "# TYPE sidekick_operator_snapshot_source_burn_height gauge",
        `sidekick_operator_snapshot_source_burn_height{source="node"} ${refresh.sourcePositions.nodeBurnHeight}`,
        `sidekick_operator_snapshot_source_burn_height{source="api"} ${refresh.sourcePositions.apiBurnHeight}`,
        `sidekick_operator_snapshot_source_burn_height{source="pox"} ${refresh.sourcePositions.poxBurnHeight}`,
        "# HELP sidekick_operator_snapshot_pox_reward_cycle PoX reward cycle observed in the last successful refresh.",
        "# TYPE sidekick_operator_snapshot_pox_reward_cycle gauge",
        `sidekick_operator_snapshot_pox_reward_cycle ${refresh.sourcePositions.poxRewardCycle}`,
      );
    }
    metrics.push("");
    return metrics.join("\n");
  });

  server.get("/api/v1/status", async (request) => {
    const refresh = (request.query as { refresh?: unknown }).refresh === "1";
    const service = requireFeature(options.service, "operator_service_unavailable");
    const snapshot = await interactive(request, async () =>
      service.summary ? service.summary(refresh) : service.snapshot(refresh),
    );
    return withObserverAlerts(snapshot, options.observerStatus?.());
  });
  server.get("/api/v1/overview", async (request, reply) => {
    const refresh = (request.query as { refresh?: unknown }).refresh === "1";
    const service = requireFeature(options.service, "operator_service_unavailable");
    const result = await interactive(request, async () => {
      const activityObservedAt = new Date().toISOString();
      const activityProjection = options.activityProjection;
      const readOnly =
        options.connection !== undefined && options.connection.current()?.status !== "connected";
      const [snapshotResult, healthResult, activityResult] = await Promise.allSettled([
        service.supportSnapshot ? service.supportSnapshot(refresh) : service.snapshot(refresh),
        options.health
          ? refresh
            ? options.health.refresh()
            : options.health.current()
          : Promise.resolve(null),
        activityProjection
          ? Promise.resolve().then(() =>
              activityProjection.page(
                {
                  status: "all",
                  type: "all",
                  domain: "all",
                  time: "all",
                  search: null,
                  cursor: null,
                  limit: 1,
                },
                readOnly,
              ),
            )
          : Promise.resolve(null),
      ]);
      if (snapshotResult.status === "rejected") throw snapshotResult.reason;
      const snapshot = dashboardSnapshotSchema.parse(snapshotResult.value);
      const parsedHealth =
        healthResult.status === "fulfilled" && healthResult.value !== null
          ? healthSnapshotSchema.safeParse(healthResult.value)
          : null;
      const health = parsedHealth?.success ? parsedHealth.data : null;
      const activityAvailable =
        activityResult.status === "fulfilled" && activityResult.value !== null;
      const activity = activityAvailable ? activityResult.value : null;
      return overviewPageSchema.parse(
        projectOverview({
          snapshot,
          health,
          connection: options.connection?.current() ?? null,
          activity,
          activitySource: {
            status: activityAvailable ? "current" : "unavailable",
            observedAt: activityObservedAt,
            reason: activityAvailable
              ? null
              : activityProjection
                ? "Sidekick could not read active operation state."
                : "The Activity projection is not configured.",
          },
          observerGap: options.observerStatus?.().gap ?? null,
        }),
      );
    });
    return reply.header("cache-control", "no-store").send(result);
  });
  server.get("/api/v1/support-bundle", async (_request, reply) => {
    const service = options.service;
    const operational = options.isOperational?.() !== false;
    const connectionCurrent =
      options.connection === undefined || options.connection.current()?.status === "connected";
    const application = options.supportApplication?.() ?? operatorSupportApplication();
    const bundle = await createOperatorSupportBundle({
      application,
      ...(options.connection ? { connection: async () => await options.connection?.check() } : {}),
      ...(options.deploymentRequirements
        ? { deploymentRequirements: async () => await options.deploymentRequirements?.check() }
        : {}),
      ...(service?.settings ? { runtimeSettings: () => service.settings?.() } : {}),
      ...(service && operational
        ? {
            operator: async () =>
              service.supportSnapshot
                ? service.supportSnapshot(connectionCurrent)
                : service.summary
                  ? service.summary(connectionCurrent)
                  : service.snapshot(connectionCurrent),
          }
        : {}),
      ...(options.health
        ? {
            health: async () =>
              connectionCurrent ? options.health?.refresh() : options.health?.current(),
          }
        : {}),
      ...(options.engine && operational
        ? {
            engine: async () => options.engine?.status(),
            recentOperations: async () => options.engine?.listJobs({ cursor: null, limit: 50 }),
          }
        : {}),
      ...(options.databaseStatus ? { database: options.databaseStatus } : {}),
      ...(options.observerStatus ? { observer: options.observerStatus } : {}),
      recentSidekickErrors: () => recentSidekickErrors,
      automation: () => ({
        processRequests: {
          total: requestCount,
          syncRequests: syncRequestCount,
          syncRuns: syncCount,
          syncFailures: syncFailureCount,
        },
        operatorSnapshotRefresh: options.snapshotRefreshMetrics?.snapshot() ?? {
          attemptsTotal: 0,
          successesTotal: 0,
          failuresTotal: 0,
          consecutiveFailures: 0,
          retryBackoffSeconds: 0,
          lastSuccessTimestampSeconds: 0,
          snapshotGeneratedTimestampSeconds: 0,
          snapshotAgeSeconds: 0,
          snapshotFresh: 0,
          sourcePositions: null,
        },
        rosterReconciliation: rosterReconciliationMetrics.snapshot(),
        currentReconciliation: reconciliationOperation,
      }),
    });
    const timestamp = bundle.generatedAt.replaceAll(":", "-").replace(".000Z", "Z");
    return reply
      .header("cache-control", "no-store")
      .header(
        "content-disposition",
        `attachment; filename="signer-sidekick-support-${timestamp}.json"`,
      )
      .type("application/json; charset=utf-8")
      .send(bundle);
  });
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
  server.get("/api/v1/pool", async (request, _reply) => {
    if (options.service?.poolPage) {
      const pageOptions = parsePagination(request.url, { includeQuery: true });
      const sort = parseSort(request.url, [
        "staker",
        "amount",
        "first-cycle",
        "last-cycle",
        "unlock-height",
        "bond",
        "status",
      ] as const);
      if (sort) Object.assign(pageOptions, sort);
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
      "bond_index",
      "bond_amount_sats",
      "bond_collateral",
    ];
    const rows = roster.map((staker) => [
      staker.stakerPrincipal,
      staker.position?.amountUstx,
      staker.position?.firstRewardCycle,
      staker.position?.numCycles,
      staker.position?.unlockCycle,
      staker.active,
      staker.bond?.bondIndex,
      staker.bond?.amountSats,
      staker.bond ? (staker.bond.isL1Lock ? "bitcoin-l1" : "sbtc") : undefined,
    ]);
    reply.type("text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="signer-sidekick-roster.csv"');
    return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  });
  server.get("/api/v1/pool/roster.json", async (request, reply) => {
    const snapshot = await interactive(request, async () => options.service?.snapshot());
    reply.type("application/json; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="signer-sidekick-roster.json"');
    return snapshot?.roster ?? [];
  });
  server.get("/api/v1/rewards", async (request, _reply) => {
    if (options.service?.rewardsPage) {
      const pageOptions = parsePagination(request.url);
      const sort = parseSort(request.url, [
        "staker",
        "gross",
        "fee",
        "net",
        "destination",
        "status",
      ] as const);
      if (sort) Object.assign(pageOptions, sort);
      return await interactive(request, async () => options.service?.rewardsPage?.(pageOptions));
    }
    const snapshot = await interactive(request, async () => options.service?.snapshot());
    return {
      generatedAt: snapshot?.generatedAt,
      rewards: snapshot?.rewards,
      activity: snapshot?.activity,
    };
  });
  server.get("/api/v1/rewards/staker-claims", async (request, _reply) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    const stakerClaims = requireFeature(service.stakerClaims, "staker_claims_unavailable");
    return await interactive(request, async () =>
      stakerClaims.call(service, parsePagination(request.url)),
    );
  });
  server.get("/api/v1/rewards/history", async (request, _reply) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    const rewardsHistory = requireFeature(service.rewardsHistory, "reward_history_unavailable");
    const pageOptions = parsePagination(request.url);
    const sort = parseSort(request.url, [
      "cycle",
      "status",
      "stakers",
      "gross",
      "net",
      "fee",
      "configured-fee",
      "effective-fee",
      "actionable",
      "bitcoin-block",
    ] as const);
    if (sort) Object.assign(pageOptions, sort);
    return await interactive(request, async () => rewardsHistory.call(service, pageOptions));
  });
  server.get("/api/v1/rewards/activity", async (request) => {
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
      const claimSort = parseSort(
        request.url,
        ["cycle", "staker", "amount", "destination", "block", "transaction"] as const,
        { sort: "claimSort", direction: "claimDirection" },
      );
      const withdrawalSort = parseSort(
        request.url,
        ["request", "staker", "amount", "max-fee", "state", "block"] as const,
        { sort: "withdrawalSort", direction: "withdrawalDirection" },
      );
      activityOptions = {
        claimLimit,
        claimOffset: integerQuery(search, "claimOffset", 0, 10_000_000),
        ...(claimSort ? { claimSort: claimSort.sort, claimDirection: claimSort.direction } : {}),
        rewardCycle: optionalUnsignedIntegerQuery(search, "rewardCycle"),
        withdrawalLimit,
        withdrawalOffset: integerQuery(search, "withdrawalOffset", 0, 10_000_000),
        ...(withdrawalSort
          ? { withdrawalSort: withdrawalSort.sort, withdrawalDirection: withdrawalSort.direction }
          : {}),
        withdrawalState: state as "pending" | "settled" | "reclaimed" | null,
      };
    } catch (error) {
      if (error instanceof OperatorApiError) throw error;
      throw new OperatorApiError(400, "invalid_query");
    }
    return await interactive(request, async () => activity.call(service, activityOptions));
  });
  server.get("/api/v1/activity", async (request) => {
    const activity = requireFeature(options.activityProjection, "activity_projection_unavailable");
    const readOnly =
      options.connection !== undefined && options.connection.current()?.status !== "connected";
    try {
      return activity.page(parseActivityQuery(request.url), readOnly);
    } catch (error) {
      if (error instanceof ActivityProjectionError) {
        throw new OperatorApiError(
          error.code === "invalid_activity_cursor" ? 400 : 503,
          error.code,
          error.code !== "invalid_activity_cursor",
        );
      }
      throw error;
    }
  });
  server.get("/api/v1/activity/:activityId", async (request) => {
    const activity = requireFeature(options.activityProjection, "activity_projection_unavailable");
    const params = z.object({ activityId: z.string().min(1).max(500) }).safeParse(request.params);
    if (!params.success) throw new OperatorApiError(400, "invalid_activity_id");
    const readOnly =
      options.connection !== undefined && options.connection.current()?.status !== "connected";
    const detail = activity.detail(params.data.activityId, readOnly);
    if (detail === null) throw new OperatorApiError(404, "activity_not_found");
    return detail;
  });
  server.get("/api/v1/settings", async (_request, _reply) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    return requireFeature(service.settings, "runtime_settings_unavailable").call(service);
  });
  server.put("/api/v1/settings", async (request) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    const updateSettings = requireFeature(service.updateSettings, "runtime_settings_unavailable");
    const wasUnavailable = options.connection?.current()?.status === "unavailable";
    const previousNodeRpcUrl = settingsNodeRpcUrl(service.settings?.());
    const result = await interactive(request, async () =>
      updateSettings.call(service, request.body),
    );
    const nextNodeRpcUrl = settingsNodeRpcUrl(result);
    const nodeRpcUrlChanged =
      previousNodeRpcUrl !== null &&
      nextNodeRpcUrl !== null &&
      previousNodeRpcUrl !== nextNodeRpcUrl;
    if ((wasUnavailable || nodeRpcUrlChanged) && options.connection) {
      const assessment = await interactive(
        request,
        async () => await options.connection?.check(true),
      );
      if (assessment) await options.onConnectionAssessed?.(assessment);
    }
    return result;
  });
  server.post("/api/v1/manager/signer-grant/prepare", async (request) => {
    const signerGrant = requireFeature(options.signerGrant, "signer_grant_unavailable");
    const parsed = managerSignerGrantPrepareRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_signer_grant_input");
    return {
      signerGrant: await interactive(request, async () => signerGrant.prepare(parsed.data)),
    };
  });
  server.post("/api/v1/manager/signer-grant/verify", async (request) => {
    const signerGrant = requireFeature(options.signerGrant, "signer_grant_unavailable");
    const parsed = signerGrantVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_signer_output");
    return {
      signerGrant: await interactive(request, async () =>
        signerGrant.verify(parsed.data.signerOutput),
      ),
    };
  });
  server.post("/api/v1/wallet-intents", async (request, reply) => {
    const wallet = requireFeature(options.wallet, "wallet_intent_unavailable");
    const parsed = recurringBrowserWalletIntentCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new OperatorApiError(400, "invalid_wallet_intent_action");
    try {
      return {
        intent: await interactive(request, async () => wallet.prepare(parsed.data)),
      };
    } catch (error) {
      const anchorReply = replyToWalletIntentAnchorError(request, reply, error, {
        action: parsed.data.action,
      });
      if (anchorReply) return anchorReply;
      if (error instanceof WalletIntentError) {
        return sendClassifiedError(request, reply, error);
      }
      throw error;
    }
  });
  const registerWalletIntentLifecycleRoutes = (prefix: string): void => {
    server.get(`${prefix}/:id`, async (request, reply) => {
      const wallet = requireFeature(options.wallet, "wallet_intent_unavailable");
      const parsed = z.object({ id: z.uuid() }).strict().safeParse(request.params);
      if (!parsed.success) throw new OperatorApiError(404, "wallet_intent_not_found");
      try {
        return { intent: wallet.get(parsed.data.id) };
      } catch (error) {
        if (error instanceof WalletIntentError) {
          return sendClassifiedError(request, reply, error);
        }
        throw error;
      }
    });
    server.post(`${prefix}/:id/submission`, async (request, reply) => {
      const wallet = requireFeature(options.wallet, "wallet_intent_unavailable");
      const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
      const body = browserWalletIntentSubmissionRequestSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        throw new OperatorApiError(400, "invalid_wallet_intent_submission");
      }
      try {
        return {
          intent: await interactive(request, async () =>
            wallet.submit(params.data.id, body.data.txid),
          ),
        };
      } catch (error) {
        if (error instanceof WalletIntentError) {
          return sendClassifiedError(request, reply, error);
        }
        throw error;
      }
    });
    server.post(`${prefix}/:id/refresh`, async (request, reply) => {
      const wallet = requireFeature(options.wallet, "wallet_intent_unavailable");
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
          intent: await interactive(request, async () => wallet.refresh(params.data.id)),
        };
      } catch (error) {
        const anchorReply = replyToWalletIntentAnchorError(request, reply, error, {
          intentId: params.data.id,
          operation: "refresh",
        });
        if (anchorReply) return anchorReply;
        if (error instanceof WalletIntentError) {
          return sendClassifiedError(request, reply, error);
        }
        throw error;
      }
    });
    server.post(`${prefix}/:id/replacement`, async (request, reply) => {
      const wallet = requireFeature(options.wallet, "wallet_intent_unavailable");
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
          intent: await interactive(request, async () => wallet.replace(params.data.id)),
        };
      } catch (error) {
        const anchorReply = replyToWalletIntentAnchorError(request, reply, error, {
          intentId: params.data.id,
          operation: "replacement",
        });
        if (anchorReply) return anchorReply;
        if (error instanceof WalletIntentError) {
          return sendClassifiedError(request, reply, error);
        }
        throw error;
      }
    });
  };

  registerWalletIntentLifecycleRoutes("/api/v1/wallet-intents");
  server.post("/api/v1/sync", async (request, reply) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    syncRequestCount += 1;
    return reply.code(202).send({ operation: startReconciliation(service, "manual", request.log) });
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
