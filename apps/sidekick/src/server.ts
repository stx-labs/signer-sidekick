import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { STACKS_CORE_4_0_0 } from "@stx-labs/signer-sidekick-protocol";
import Fastify from "fastify";

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
  synchronize(): Promise<unknown>;
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
}

export interface ServerOptions {
  service?: OperatorSnapshotService;
  authToken?: string;
  logger?: boolean;
  staticDirectory?: string | null;
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

export function createServer(options: ServerOptions = {}) {
  if (options.service && (!options.authToken || options.authToken.length < 24)) {
    throw new Error("The operator API requires SIDEKICK_AUTH_TOKEN with at least 24 characters");
  }
  const server = Fastify({ logger: options.logger ?? true });
  let requestCount = 0;
  let syncCount = 0;
  let syncFailureCount = 0;

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
    protocol: {
      stacksCoreTag: STACKS_CORE_4_0_0.tag,
      stacksCoreCommit: STACKS_CORE_4_0_0.commit,
    },
  }));
  server.get("/health/live", async () => ({ status: "ok" }));
  server.get("/health/ready", async (request, reply) => {
    if (!options.service) return reply.code(503).send({ status: "not-ready" });
    try {
      const snapshot = await options.service.snapshot();
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
      "# HELP sidekick_sync_failures_total Failed synchronization attempts.",
      "# TYPE sidekick_sync_failures_total counter",
      `sidekick_sync_failures_total ${syncFailureCount}`,
      "",
    ].join("\n");
  });

  server.get("/api/v1/status", async () =>
    options.service?.summary ? options.service.summary() : options.service?.snapshot(),
  );
  server.get("/api/v1/registration", async () => {
    const snapshot = await options.service?.snapshot();
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
  server.get("/api/v1/pool", async (request, reply) => {
    if (options.service?.poolPage) {
      try {
        const search = new URL(request.url, "http://sidekick.local").searchParams;
        const limit = integerQuery(search, "limit", 50, 200);
        if (limit < 1) return reply.code(400).send({ error: "limit_must_be_positive" });
        return options.service.poolPage({
          offset: integerQuery(search, "offset", 0, 10_000_000),
          limit,
          query: search.get("query") ?? "",
        });
      } catch (error) {
        return reply.code(400).send({ error: "invalid_pagination", detail: String(error) });
      }
    }
    const snapshot = await options.service?.snapshot();
    return {
      generatedAt: snapshot?.generatedAt,
      forecast: snapshot?.forecast,
      roster: snapshot?.roster,
    };
  });
  server.get("/api/v1/pool/roster.csv", async (_request, reply) => {
    const snapshot = await options.service?.snapshot();
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
  server.get("/api/v1/pool/history", async (request, reply) => {
    if (!options.service?.poolHistory) {
      return reply.code(501).send({ error: "pool_history_unavailable" });
    }
    try {
      const search = new URL(request.url, "http://sidekick.local").searchParams;
      const limit = integerQuery(search, "limit", 50, 200);
      if (limit < 1) return reply.code(400).send({ error: "limit_must_be_positive" });
      return options.service.poolHistory({
        offset: integerQuery(search, "offset", 0, 10_000_000),
        limit,
      });
    } catch (error) {
      return reply.code(400).send({ error: "invalid_pagination", detail: String(error) });
    }
  });
  server.get("/api/v1/pool/roster.json", async (_request, reply) => {
    const snapshot = await options.service?.snapshot();
    reply.type("application/json; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="signer-sidekick-roster.json"');
    return snapshot?.roster ?? [];
  });
  server.get("/api/v1/rewards", async (request, reply) => {
    if (options.service?.rewardsPage) {
      try {
        const search = new URL(request.url, "http://sidekick.local").searchParams;
        const limit = integerQuery(search, "limit", 50, 200);
        if (limit < 1) return reply.code(400).send({ error: "limit_must_be_positive" });
        return options.service.rewardsPage({
          offset: integerQuery(search, "offset", 0, 10_000_000),
          limit,
        });
      } catch (error) {
        return reply.code(400).send({ error: "invalid_pagination", detail: String(error) });
      }
    }
    const snapshot = await options.service?.snapshot();
    return {
      generatedAt: snapshot?.generatedAt,
      rewards: snapshot?.rewards,
      activity: snapshot?.activity,
    };
  });
  server.get("/api/v1/withdrawals", async () => {
    const snapshot = await options.service?.snapshot();
    return {
      generatedAt: snapshot?.generatedAt,
      withdrawals: snapshot?.activity?.withdrawals ?? [],
    };
  });
  server.get("/api/v1/rewards/history", async (request, reply) => {
    if (!options.service?.rewardsHistory) {
      return reply.code(501).send({ error: "reward_history_unavailable" });
    }
    try {
      const search = new URL(request.url, "http://sidekick.local").searchParams;
      const limit = integerQuery(search, "limit", 50, 200);
      if (limit < 1) return reply.code(400).send({ error: "limit_must_be_positive" });
      return options.service.rewardsHistory({
        offset: integerQuery(search, "offset", 0, 10_000_000),
        limit,
      });
    } catch (error) {
      return reply.code(400).send({ error: "invalid_pagination", detail: String(error) });
    }
  });
  server.get("/api/v1/alerts", async () => {
    const snapshot = await options.service?.snapshot();
    return { generatedAt: snapshot?.generatedAt, alerts: snapshot?.alerts ?? [] };
  });
  server.get("/api/v1/activity", async (request, reply) => {
    if (!options.service?.activity) {
      return reply.code(501).send({ error: "paginated_activity_unavailable" });
    }
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
      return options.service.activity({
        claimLimit,
        claimOffset: integerQuery(search, "claimOffset", 0, 10_000_000),
        rewardCycle: search.get("rewardCycle"),
        withdrawalLimit,
        withdrawalOffset: integerQuery(search, "withdrawalOffset", 0, 10_000_000),
        withdrawalState: state as "pending" | "settled" | "reclaimed" | null,
      });
    } catch (error) {
      return reply.code(400).send({ error: "invalid_pagination", detail: String(error) });
    }
  });
  server.get("/api/v1/setup", async () => {
    const snapshot = await options.service?.snapshot();
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
  server.post("/api/v1/sync", async (_request, reply) => {
    syncCount += 1;
    try {
      const result = await options.service?.synchronize();
      const snapshot = await options.service?.snapshot(true);
      return reply.code(200).send({ result, snapshot });
    } catch (error) {
      syncFailureCount += 1;
      throw error;
    }
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
