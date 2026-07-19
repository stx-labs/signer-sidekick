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
  onboardingAttachRequestSchema,
  onboardingBrowserWalletIntentCreateRequestSchema,
  onboardingGrantVerifyRequestSchema,
  onboardingProgressRequestSchema,
  onboardingStartRequestSchema,
  poolCardGenerateRequestSchema,
  type ReconciliationOperation,
  type ReconciliationSummary,
  reconciliationSummarySchema,
  type WalletIntentAnchorMismatchError,
  type WalletIntentAnchorUnstableError,
} from "@stx-labs/signer-sidekick-api-contracts";
import { STACKS_CORE_4_0_0 } from "@stx-labs/signer-sidekick-protocol";
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
    readonly retryable?: boolean,
  ) {
    super(responseCode);
    this.name = "OperatorApiError";
  }
}

interface SafeErrorClassification {
  statusCode: number;
  body: ApiError & Record<string, unknown>;
  retryAfterSeconds?: number;
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
    return {
      statusCode: error.statusCode,
      body: {
        error: error.responseCode,
        ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
      },
    };
  }
  if (error instanceof OperatorWorkflowError) {
    return {
      statusCode: error.statusCode,
      body: { error: error.responseCode, message: error.message, retryable: false },
    };
  }
  if (error instanceof TransactionEngineApiServiceError) {
    return { statusCode: error.statusCode, body: { error: error.responseCode } };
  }
  if (error instanceof ChainAnchorError) {
    if (error.retryable) {
      if (error.tips && chainSourcesDiffer(error)) {
        return {
          statusCode: 503,
          retryAfterSeconds: 1,
          body: {
            error: "chain_sources_out_of_sync",
            retryable: true,
            node: error.tips.node,
            api: error.tips.api,
            poxBurnBlockHeight: error.tips.poxBurnBlockHeight,
          },
        };
      }
      return {
        statusCode: 503,
        retryAfterSeconds: 1,
        body: { error: "chain_anchor_unstable", retryable: true },
      };
    }
    return {
      statusCode: 502,
      body: { error: "chain_anchor_invalid", retryable: false },
    };
  }
  if (error instanceof SignerStakerAnchorError) {
    return {
      statusCode: 503,
      retryAfterSeconds: 1,
      body: { error: "signer_staker_anchor_unstable", retryable: true },
    };
  }
  if (error instanceof RateLimitedError) {
    return {
      statusCode: 429,
      retryAfterSeconds: Math.min(
        30,
        Math.max(1, Math.ceil((error.retryAfterMs ?? 1_000) / 1_000)),
      ),
      body: { error: "upstream_rate_limited", retryable: true },
    };
  }
  if (error instanceof UpstreamUnavailableError) {
    return {
      statusCode: 503,
      retryAfterSeconds: 1,
      body: { error: "upstream_temporarily_unavailable", retryable: true },
    };
  }
  if (error instanceof UpstreamSchemaError) {
    return {
      statusCode: 502,
      body: { error: "upstream_response_invalid", retryable: false },
    };
  }
  if (error instanceof UpstreamHttpError) {
    return {
      statusCode: 502,
      body: { error: "upstream_request_rejected", retryable: false },
    };
  }
  if (error instanceof HealthSourceError) {
    if (error.code === "invalid-url") {
      return { statusCode: 400, body: { error: "invalid_health_source", retryable: false } };
    }
    if (error.code === "unsafe-address") {
      return {
        statusCode: 422,
        body: { error: "health_source_not_allowed", retryable: false },
      };
    }
    if (
      error.code === "dns-unavailable" ||
      error.code === "connection-failed" ||
      error.code === "timeout"
    ) {
      return {
        statusCode: 503,
        retryAfterSeconds: 1,
        body: { error: "health_source_temporarily_unavailable", retryable: true },
      };
    }
    return {
      statusCode: 502,
      body: { error: "health_source_response_invalid", retryable: false },
    };
  }
  if (
    error instanceof InteractiveRequestDeadlineError ||
    error instanceof InteractiveRequestCancelledError
  ) {
    return {
      statusCode: 503,
      retryAfterSeconds: 1,
      body: { error: "operator_request_temporarily_unavailable", retryable: true },
    };
  }
  if (error instanceof z.ZodError) {
    return { statusCode: 400, body: { error: "invalid_request", retryable: false } };
  }
  if (
    error instanceof Error &&
    typeof (error as FastifyError).statusCode === "number" &&
    ((error as FastifyError).statusCode ?? 500) < 500
  ) {
    return {
      statusCode: (error as FastifyError).statusCode ?? 400,
      body: { error: "request_error", retryable: false },
    };
  }
  return { statusCode: 500, body: { error: "internal_server_error" } };
}

function sendClassifiedError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  const classified = classifySafeOperatorError(error);
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
  return reply.code(classified.statusCode).send(classified.body);
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
      message: "No reconciliation has run in this process",
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
              : "Synchronizing manager events"),
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
            message: "Refreshing operator state from the reconciled database",
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
            message: "Reconciliation complete",
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
            message: "Reconciliation failed",
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
    if (!options.service) {
      return reply.code(503).send({ error: "operator_service_unavailable" });
    }
    if (!authorized(request.headers.authorization, options.authToken ?? "")) {
      reply.header("www-authenticate", "Bearer");
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  server.get("/healthz", async () => ({
    status: "ok",
    phase: "read-only-control-plane",
    sourceLineage: {
      stacksCoreTag: STACKS_CORE_4_0_0.tag,
      stacksCoreCommit: STACKS_CORE_4_0_0.commit,
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
  server.post("/api/v1/health/test-source", async (request, reply) => {
    const health = requireFeature(options.health, "health_monitoring_unavailable");
    const parsed = healthSourceTestRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_health_source" });
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
  server.get("/api/v1/activity", async (request, reply) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    const activity = requireFeature(service.activity, "paginated_activity_unavailable");
    let activityOptions: ActivityOptions;
    try {
      const search = new URL(request.url, "http://sidekick.local").searchParams;
      const claimLimit = integerQuery(search, "claimLimit", 50, 200);
      const withdrawalLimit = integerQuery(search, "withdrawalLimit", 50, 200);
      if (claimLimit < 1 || withdrawalLimit < 1) {
        return reply.code(400).send({ error: "limits_must_be_positive" });
      }
      const state = search.get("withdrawalState");
      if (state !== null && !["pending", "settled", "reclaimed"].includes(state)) {
        return reply.code(400).send({ error: "invalid_withdrawal_state" });
      }
      activityOptions = {
        claimLimit,
        claimOffset: integerQuery(search, "claimOffset", 0, 10_000_000),
        rewardCycle: optionalUnsignedIntegerQuery(search, "rewardCycle"),
        withdrawalLimit,
        withdrawalOffset: integerQuery(search, "withdrawalOffset", 0, 10_000_000),
        withdrawalState: state as "pending" | "settled" | "reclaimed" | null,
      };
    } catch {
      return reply.code(400).send({ error: "invalid_query" });
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
  server.post("/api/v1/onboarding/start", async (request, reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = onboardingStartRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_onboarding_path" });
    return { onboarding: onboarding.start(parsed.data.path, parsed.data.reset ?? false) };
  });
  server.post("/api/v1/onboarding/attach/verify", async (request, reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = onboardingAttachRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_manager_principal" });
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
  server.post("/api/v1/onboarding/fresh/grant/verify", async (request, reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = onboardingGrantVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_signer_output" });
    return {
      onboarding: await interactive(request, async () =>
        onboarding.verifyGrant(parsed.data.signerOutput),
      ),
    };
  });
  server.post("/api/v1/manager/signer-grant/prepare", async (request, reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = managerSignerGrantPrepareRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_signer_grant_input" });
    return {
      onboarding: await interactive(request, async () =>
        onboarding.prepareManagerSignerGrant(parsed.data),
      ),
    };
  });
  server.post("/api/v1/manager/signer-grant/verify", async (request, reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = onboardingGrantVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_signer_output" });
    return {
      onboarding: await interactive(request, async () =>
        onboarding.verifyManagerSignerGrant(parsed.data.signerOutput),
      ),
    };
  });
  server.post("/api/v1/onboarding/wallet-intents", async (request, reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = onboardingBrowserWalletIntentCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_wallet_intent_action" });
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
        return reply.code(walletIntentHttpStatus(error)).send({ error: error.code });
      }
      throw error;
    }
  });
  server.post("/api/v1/wallet-intents", async (request, reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = browserWalletIntentCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_wallet_intent_action" });
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
        return reply.code(walletIntentHttpStatus(error)).send({ error: error.code });
      }
      throw error;
    }
  });
  const registerWalletIntentLifecycleRoutes = (prefix: string): void => {
    server.get(`${prefix}/:id`, async (request, reply) => {
      const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
      const parsed = z.object({ id: z.uuid() }).strict().safeParse(request.params);
      if (!parsed.success) return reply.code(404).send({ error: "wallet_intent_not_found" });
      try {
        return { intent: onboarding.wallet.get(parsed.data.id) };
      } catch (error) {
        if (error instanceof OnboardingWalletIntentError) {
          return reply.code(walletIntentHttpStatus(error)).send({ error: error.code });
        }
        throw error;
      }
    });
    server.post(`${prefix}/:id/submission`, async (request, reply) => {
      const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
      const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
      const body = browserWalletIntentSubmissionRequestSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "invalid_wallet_intent_submission" });
      }
      try {
        return {
          intent: await interactive(request, async () =>
            onboarding.wallet.submit(params.data.id, body.data.txid),
          ),
        };
      } catch (error) {
        if (error instanceof OnboardingWalletIntentError) {
          return reply.code(walletIntentHttpStatus(error)).send({ error: error.code });
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
        return reply.code(400).send({ error: "invalid_wallet_intent_refresh" });
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
          return reply.code(walletIntentHttpStatus(error)).send({ error: error.code });
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
        return reply.code(400).send({ error: "invalid_wallet_intent_replacement" });
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
          return reply.code(walletIntentHttpStatus(error)).send({ error: error.code });
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
  server.patch("/api/v1/onboarding/progress", async (request, reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = onboardingProgressRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_onboarding_step" });
    return { onboarding: onboarding.setCurrentStep(parsed.data.currentStep) };
  });
  server.get("/api/v1/onboarding/artifacts/:kind", async (request, reply) => {
    const onboarding = requireFeature(options.onboarding, "onboarding_unavailable");
    const parsed = z.object({ kind: z.enum(["source", "manifest"]) }).safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: "artifact_not_found" });
    const artifact = onboarding.artifact(parsed.data.kind);
    reply.type(artifact.contentType);
    reply.header("content-disposition", `attachment; filename="${artifact.filename}"`);
    return artifact.body;
  });
  server.post("/api/v1/pool-card/generate", async (request, reply) => {
    const service = requireFeature(options.service, "operator_service_unavailable");
    const poolCard = requireFeature(service.poolCard, "pool_card_generation_unavailable");
    const parsed = poolCardGenerateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_pool_card_mode" });
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
