import {
  activityResponseSchema,
  type ConnectionAssessment,
  overviewPageSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityProjectionError } from "./activity-projection.js";
import { ChainAnchorError, RateLimitedError, UpstreamHttpError } from "./chain-clients.js";
import { HealthSourceError } from "./health-http.js";
import { SnapshotRefreshMetricsTracker } from "./operator-snapshot-refresh.js";
import { createServer, type TransactionEngineApiService } from "./server.js";
import { SignerStakerAnchorError } from "./signer-staker-sync.js";
import { operatorSupportApplication } from "./support-bundle.js";
import { TransactionEngineApiServiceError } from "./transaction-engine/api-service.js";
import { WalletIntentError } from "./wallet-intent-service.js";

const servers: ReturnType<typeof createServer>[] = [];
const walletIntentPrefixes = ["/api/v1/wallet-intents"] as const;
const walletIntentAnchorMismatch = {
  error: "wallet_intent_anchor_mismatch",
  retryable: true,
  node: { stacksTipHeight: 28_079, burnBlockHeight: 4_818 },
  api: { stacksTipHeight: 28_097, burnBlockHeight: 4_819 },
  poxBurnBlockHeight: 4_819,
} as const;
const chainSourcesOutOfSyncMessage =
  "The local node is behind or inconsistent with the configured chain sources. Check node synchronization and retry.";

function retryableWalletIntentAnchorError(): ChainAnchorError {
  return new ChainAnchorError("Node, API, and PoX tips do not describe one chain position", {
    retryable: true,
    tips: {
      node: walletIntentAnchorMismatch.node,
      api: walletIntentAnchorMismatch.api,
      poxBurnBlockHeight: walletIntentAnchorMismatch.poxBurnBlockHeight,
    },
  });
}

function reconciliationResult() {
  return {
    observedAt: "2026-07-19T18:00:00.000Z",
    stakers: {
      runId: "must-not-cross-api",
      resumed: false,
      status: "completed",
      authoritative: true,
      pagesProcessed: 2,
      itemsProcessed: 125,
      activeStakers: 120,
      nodeVerifiedStxPositions: 118,
      unverifiedStxDiscoveries: 2,
      discrepanciesObservedThisInvocation: [{ principal: "must-not-cross-api" }],
    },
    events: {
      stream: "must-not-cross-api",
      resumed: true,
      pagesProcessed: 1,
      eventsProcessed: 20,
      newEvents: 3,
      replayedEvents: 17,
      decodeFailures: 0,
      reorgedEvents: 0,
      stoppedAtKnownOverlap: true,
    },
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("local API", () => {
  it("reports the exact protocol pin", async () => {
    const server = createServer();
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      sourceLineage: {
        stacksCoreTag: "4.0.1",
        stacksCoreCommit: "62e03cc5551bfc574223c2b78ce04ceca30cec37",
      },
    });
    expect(response.json()).not.toHaveProperty("protocol");
  });

  it("protects operator data with a bearer token", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: async () => ({
        generatedAt: "2026-07-14T12:00:00.000Z",
        network: "mainnet",
        managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
        preflight: { status: "pass" },
        activity: { withdrawals: [] },
        alerts: [],
        roster: [],
      }),
      synchronize: async () => ({ status: "complete" }),
    };
    const server = createServer({ service, authToken: token, logger: false });
    servers.push(server);

    const denied = await server.inject({ method: "GET", url: "/api/v1/status" });
    expect(denied.statusCode).toBe(401);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ network: "mainnet", preflight: { status: "pass" } });
  });

  it("serves the strict Overview projection from cached state without running reconciliation", async () => {
    const token = "test-operator-token-with-32-chars";
    const generatedAt = "2026-08-14T12:00:00.000Z";
    const snapshot = vi.fn(async () => ({
      schemaVersion: 1,
      generatedAt: "2026-08-14T12:00:00.000Z",
      network: "mainnet",
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      setup: null,
      preflight: {
        status: "pass",
        node: {
          serverVersion: "4.0.1",
          version: "4.0.1",
          commit: null,
          networkId: 1,
          burnBlockHeight: 962_300,
          stacksTipHeight: 8_750_000,
        },
        api: {
          serverVersion: "api",
          burnBlockHeight: 962_298,
          stacksTipHeight: 8_749_998,
          burnBlockLag: 2,
        },
        pox: {
          activationState: "active",
          blocksUntilActivation: 0,
          rewardCycleId: 141,
          pox5Available: true,
          pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
        },
        cycle: {
          currentId: 141,
          nextId: 142,
          preparePhaseStartBurnHeight: 963_300,
          blocksUntilPreparePhase: 1_000,
          rewardPhaseStartBurnHeight: 963_400,
          blocksUntilRewardPhase: 1_100,
          isPreparePhase: false,
        },
        compatibility: {
          status: "matched",
          profileId: "mainnet",
          profileRevision: 1,
          profileLabel: "Mainnet",
          origin: "built-in",
          nodeBuildPreviouslyTested: true,
          reason: "matched",
        },
        checks: [],
      },
      manager: {
        capabilities: {
          signerManagerTrait: { compatible: true, reason: "matched" },
          observedFunctions: { public: [], readOnly: [] },
          sourceReview: { exactReviewed: true, reason: "reviewed" },
          eventVocabulary: {
            id: "reference-manager-v1",
            normalizationAvailable: true,
            adapter: null,
            reason: "reviewed",
          },
          actions: [],
        },
      },
      registration: null,
      forecast: null,
      rewards: null,
      activity: { withdrawals: [] },
      roster: [],
      alerts: [],
    }));
    const synchronize = vi.fn(async () => ({}));
    const projectedActivity = activityResponseSchema.parse({
      schemaVersion: 1,
      generatedAt,
      active: [],
      items: [],
      nextCursor: null,
      coverage: [
        {
          source: "transaction-engine",
          status: "current",
          observedAt: generatedAt,
          anchor: null,
          reason: null,
        },
      ],
    });
    const activityProjection = {
      page: vi.fn(() => projectedActivity),
      detail: vi.fn(() => null),
    };
    const server = createServer({
      service: { snapshot, supportSnapshot: snapshot, synchronize },
      activityProjection,
      authToken: token,
      logger: false,
    });
    servers.push(server);

    expect((await server.inject({ method: "GET", url: "/api/v1/overview" })).statusCode).toBe(401);
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/overview",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(() => overviewPageSchema.parse(response.json())).not.toThrow();
    expect(response.json()).toMatchObject({
      schemaVersion: 1,
      monitoring: { network: "mainnet" },
      cycle: { rewardCycleId: 141 },
      pool: { status: "unavailable" },
      rewards: { status: "unavailable" },
    });
    expect(snapshot).toHaveBeenCalledWith(false);
    expect(synchronize).not.toHaveBeenCalled();
    expect(activityProjection.page).toHaveBeenCalledWith(
      {
        status: "all",
        type: "all",
        domain: "all",
        time: "all",
        search: null,
        cursor: null,
        limit: 1,
      },
      false,
    );

    activityProjection.page.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    const unavailableResponse = await server.inject({
      method: "GET",
      url: "/api/v1/overview",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unavailableResponse.statusCode).toBe(200);
    expect(unavailableResponse.json()).toMatchObject({
      attention: [
        {
          attentionId: "sidekick:activity-unavailable",
          tier: "needs-attention",
          primaryAction: { kind: "recheck", target: "activity" },
        },
      ],
    });
  });

  it("serves connection recovery independently and gates operational routes", async () => {
    const token = "test-operator-token-with-32-chars";
    const blocked = {
      status: "blocked",
      outcomeCode: "manager-not-deployed",
      checkedAt: "2026-08-13T12:00:00.000Z",
      stale: false,
    } as unknown as ConnectionAssessment;
    const connected = {
      ...blocked,
      status: "connected",
      outcomeCode: null,
    } as unknown as ConnectionAssessment;
    const check = vi.fn(async (force = false) => (force ? connected : blocked));
    const onConnectionAssessed = vi.fn();
    const service = {
      snapshot: vi.fn(async () => ({ preflight: { status: "pass" } })),
      synchronize: vi.fn(async () => ({})),
      settings: vi.fn(() => ({ schemaVersion: 1 })),
    };
    const server = createServer({
      service,
      connection: { current: () => blocked, check },
      isOperational: () => false,
      onConnectionAssessed,
      authToken: token,
      logger: false,
    });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    const connection = await server.inject({ method: "GET", url: "/api/v1/connection", headers });
    expect(connection.statusCode).toBe(200);
    expect(connection.json()).toMatchObject({
      status: "blocked",
      outcomeCode: "manager-not-deployed",
    });
    expect(check).toHaveBeenCalledWith();

    const status = await server.inject({ method: "GET", url: "/api/v1/status", headers });
    expect(status.statusCode).toBe(503);
    expect(status.json()).toMatchObject({ error: "connection_required", retryable: true });
    expect(service.snapshot).not.toHaveBeenCalled();

    const settings = await server.inject({ method: "GET", url: "/api/v1/settings", headers });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toEqual({ schemaVersion: 1 });

    const ready = await server.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({
      status: "not-ready",
      code: "manager-not-deployed",
    });

    const recheck = await server.inject({
      method: "POST",
      url: "/api/v1/connection/recheck",
      headers,
    });
    expect(recheck.statusCode).toBe(200);
    expect(recheck.json()).toMatchObject({ status: "connected", outcomeCode: null });
    expect(check).toHaveBeenLastCalledWith(true);
    expect(onConnectionAssessed).toHaveBeenLastCalledWith(connected);
  });

  it("preserves read-only operator evidence after a proved connection becomes unavailable", async () => {
    const token = "test-operator-token-with-32-chars";
    const unavailable = {
      status: "unavailable",
      outcomeCode: "node-unreachable",
      checkedAt: "2026-08-13T12:05:00.000Z",
      stale: true,
      lastSuccessful: {
        managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      },
    } as ConnectionAssessment;
    const service = {
      snapshot: vi.fn(async () => ({ preflight: { status: "pass" } })),
      synchronize: vi.fn(async () => ({})),
    };
    const server = createServer({
      service,
      connection: { current: () => unavailable, check: async () => unavailable },
      isOperational: () => false,
      authToken: token,
      logger: false,
    });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    const status = await server.inject({ method: "GET", url: "/api/v1/status", headers });
    expect(status.statusCode).toBe(200);
    expect(service.snapshot).toHaveBeenCalledWith(false);

    const synchronization = await server.inject({
      method: "POST",
      url: "/api/v1/sync",
      headers,
    });
    expect(synchronization.statusCode).toBe(503);
    expect(synchronization.json()).toMatchObject({ error: "connection_required" });
    expect(service.synchronize).not.toHaveBeenCalled();
  });

  it("allows an unavailable node URL to be repaired without weakening blocked identity mode", async () => {
    const token = "test-operator-token-with-32-chars";
    const unavailable = {
      status: "unavailable",
      outcomeCode: "node-unreachable",
      checkedAt: "2026-08-13T12:05:00.000Z",
      stale: false,
      lastSuccessful: null,
    } as ConnectionAssessment;
    const connected = {
      ...unavailable,
      status: "connected",
      outcomeCode: null,
    } as ConnectionAssessment;
    const check = vi.fn(async () => connected);
    const updateSettings = vi.fn(() => ({ nodeRpcUrl: "http://new-node:20443" }));
    const onConnectionAssessed = vi.fn();
    const server = createServer({
      service: {
        snapshot: async () => ({}),
        synchronize: async () => ({}),
        settings: () => ({}),
        updateSettings,
      },
      connection: { current: () => unavailable, check },
      isOperational: () => false,
      onConnectionAssessed,
      authToken: token,
      logger: false,
    });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers,
      payload: { nodeRpcUrl: "http://new-node:20443" },
    });
    expect(response.statusCode).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({ nodeRpcUrl: "http://new-node:20443" });
    expect(check).toHaveBeenCalledWith(true);
    expect(onConnectionAssessed).toHaveBeenCalledWith(connected);

    const blocked = { ...unavailable, status: "blocked" } as ConnectionAssessment;
    const blockedServer = createServer({
      service: {
        snapshot: async () => ({}),
        synchronize: async () => ({}),
        updateSettings,
      },
      connection: { current: () => blocked, check },
      isOperational: () => false,
      authToken: token,
      logger: false,
    });
    servers.push(blockedServer);
    const denied = await blockedServer.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers,
      payload: { nodeRpcUrl: "http://attacker:20443" },
    });
    expect(denied.statusCode).toBe(503);
  });

  it("rechecks deployment identity when a connected settings update changes the node URL", async () => {
    const token = "test-operator-token-with-32-chars";
    const connected = {
      status: "connected",
      outcomeCode: null,
      checkedAt: "2026-08-13T12:05:00.000Z",
      stale: false,
    } as ConnectionAssessment;
    const check = vi.fn(async () => connected);
    const onConnectionAssessed = vi.fn();
    const server = createServer({
      service: {
        snapshot: async () => ({}),
        synchronize: async () => ({}),
        settings: () => ({ dataSources: { nodeRpcUrl: "http://old-node:20443" } }),
        updateSettings: () => ({ dataSources: { nodeRpcUrl: "http://new-node:20443" } }),
      },
      connection: { current: () => connected, check },
      isOperational: () => true,
      onConnectionAssessed,
      authToken: token,
      logger: false,
    });
    servers.push(server);

    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { authorization: `Bearer ${token}` },
      payload: { dataSources: { nodeRpcUrl: "http://new-node:20443" } },
    });
    expect(response.statusCode).toBe(200);
    expect(check).toHaveBeenCalledWith(true);
    expect(onConnectionAssessed).toHaveBeenCalledWith(connected);
  });

  it("downloads a server-collected support bundle without requiring every source", async () => {
    const token = "test-operator-token-with-32-chars";
    const supportSnapshot = vi.fn(async () => ({
      schemaVersion: 1,
      generatedAt: "2026-08-13T12:00:00.000Z",
      network: "mainnet",
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      preflight: { status: "pass" },
      manager: {
        capabilities: {
          signerManagerTrait: { compatible: true, reason: "Exact trait signature" },
          observedFunctions: { public: [], readOnly: [] },
          sourceReview: { exactReviewed: false, reason: "Observe-only fixture" },
          eventVocabulary: {
            id: "reference-manager-v1",
            normalizationAvailable: false,
            adapter: null,
            reason: "Observe-only fixture",
          },
          actions: [],
        },
      },
      activity: { withdrawals: [] },
      roster: [],
      alerts: [],
    }));
    const service = {
      snapshot: async () => ({}),
      supportSnapshot,
      synchronize: async () => ({}),
    };
    const server = createServer({
      service,
      authToken: token,
      logger: false,
      databaseStatus: () => ({
        schemaVersion: 21,
        journalMode: "wal",
        synchronous: 2,
        foreignKeys: true,
      }),
      supportApplication: () =>
        operatorSupportApplication(
          { SIDEKICK_BUILD_VERSION: "1.2.3", SIDEKICK_BUILD_COMMIT: "abcdef1" },
          new Date("2026-08-13T12:01:00.000Z"),
          120,
        ),
    });
    servers.push(server);

    expect((await server.inject({ method: "GET", url: "/api/v1/support-bundle" })).statusCode).toBe(
      401,
    );
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/support-bundle",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-disposition"]).toMatch(
      /^attachment; filename="signer-sidekick-support-.+\.json"$/,
    );
    expect(response.json()).toMatchObject({
      documentType: "signer-sidekick-operator-support-bundle",
      collectionStatus: "partial",
      application: { version: "1.2.3", buildCommit: "abcdef1" },
      sections: {
        operator: { status: "ok", data: { network: "mainnet" } },
        nodeAndSignerHealth: { status: "unavailable", data: null },
        recentSidekickErrors: {
          status: "ok",
          data: [{ severity: "warning", source: "operator-api", code: "unauthorized" }],
        },
        database: { status: "ok", data: { schemaVersion: 21 } },
        automation: { status: "ok" },
      },
    });
    expect(response.body).not.toContain(token);
    expect(supportSnapshot).toHaveBeenCalledWith(true);
  });

  it("accepts the API key from an explicitly configured trusted proxy header", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({
      service,
      authToken: token,
      authTrustedHeader: "X-Sidekick-Operator",
      logger: false,
    });
    servers.push(server);

    const denied = await server.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { "x-sidekick-operator": "wrong-operator-token-with-32-chars" },
    });
    expect(denied.statusCode).toBe(401);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { "x-sidekick-operator": token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: true, method: "trusted-header" });
  });

  it("accepts HTTP Basic with the configured username and API key password", async () => {
    const token = "test-operator-token-with-32-chars";
    const username = "operator";
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({
      service,
      authToken: token,
      authBasicUsername: username,
      logger: false,
    });
    servers.push(server);

    const denied = await server.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:wrong-operator-token-with-32-chars`).toString("base64")}`,
      },
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["www-authenticate"]).toContain("Basic");

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: true, method: "basic" });
  });

  it("treats a normal one-block node lead as an unstable anchor, not source drift", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: async () => ({}),
      summary: async () => {
        throw new ChainAnchorError("tip moved", {
          retryable: true,
          tips: {
            node: { stacksTipHeight: 8_667_384, burnBlockHeight: 960_263 },
            api: { stacksTipHeight: 8_667_384, burnBlockHeight: 960_262 },
            poxBurnBlockHeight: 960_263,
          },
        });
      },
      synchronize: async () => ({}),
    };
    const server = createServer({ service, authToken: token, logger: false });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "chain_anchor_unstable",
      retryable: true,
      node: { stacksTipHeight: 8_667_384, burnBlockHeight: 960_263 },
      api: { stacksTipHeight: 8_667_384, burnBlockHeight: 960_262 },
      poxBurnBlockHeight: 960_263,
    });
  });

  it("forces a fresh status snapshot when the operator requests refresh", async () => {
    const token = "test-operator-token-with-32-chars";
    const summary = vi.fn(async () => ({ network: "mainnet", activity: { withdrawals: [] } }));
    const service = { snapshot: vi.fn(), summary, synchronize: async () => ({}) };
    const server = createServer({ service, authToken: token, logger: false });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/status?refresh=1",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(summary).toHaveBeenCalledWith(true);
  });

  it("protects and forwards signer health reads, refreshes, and source tests", async () => {
    const token = "test-operator-token-with-32-chars";
    const health = {
      current: vi.fn().mockResolvedValue({ overallStatus: "healthy" }),
      refresh: vi.fn().mockResolvedValue({ overallStatus: "partial" }),
      testSource: vi.fn().mockResolvedValue({ status: "connected", signals: 7 }),
    };
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({ service, health, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    expect((await server.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/api/v1/health", headers })).json()).toEqual(
      { overallStatus: "healthy" },
    );
    expect(
      (await server.inject({ method: "POST", url: "/api/v1/health/refresh", headers })).json(),
    ).toEqual({ overallStatus: "partial" });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/health/test-source",
          headers,
          payload: { kind: "signer-monitoring", url: "http://signer.internal:9153" },
        })
      ).json(),
    ).toEqual({ status: "connected", signals: 7 });
    expect(health.testSource).toHaveBeenCalledWith(
      "signer-monitoring",
      "http://signer.internal:9153",
    );
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/health/test-source",
          headers,
          payload: { kind: "unknown", url: "http://signer.internal:9153" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("accepts only sealed wallet-intent actions and txids", async () => {
    const token = "test-operator-token-with-32-chars";
    const intentId = "4e011bf7-f291-42c4-a35b-ab299a87ff8c";
    const txid = `0x${"ab".repeat(32)}`;
    const intent = { schemaVersion: 2, id: intentId, action: "update-fees" };
    const wallet = {
      prepare: vi.fn().mockResolvedValue(intent),
      get: vi.fn().mockReturnValue(intent),
      submit: vi.fn().mockResolvedValue({ ...intent, txid }),
      refresh: vi.fn().mockResolvedValue({ ...intent, txid, status: "mempool" }),
      replace: vi.fn().mockResolvedValue({ ...intent, id: `${intentId.slice(0, -1)}d` }),
    };
    const prepareManagerSignerGrant = vi
      .fn()
      .mockResolvedValue({ preparation: {}, verified: null });
    const verifyManagerSignerGrant = vi.fn().mockResolvedValue({ preparation: {}, verified: {} });
    const signerGrant = {
      prepare: prepareManagerSignerGrant,
      verify: verifyManagerSignerGrant,
    };
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({ service, wallet, signerGrant, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/wallet-intents",
          headers,
          payload: { action: "deploy-manager", transaction: "arbitrary" },
        })
      ).statusCode,
    ).toBe(400);
    expect(wallet.prepare).not.toHaveBeenCalled();

    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/wallet-intents",
          headers,
          payload: { action: "update-fees", feeBips: "250" },
        })
      ).statusCode,
    ).toBe(400);
    await server.inject({
      method: "POST",
      url: "/api/v1/wallet-intents",
      headers,
      payload: {
        action: "update-fees",
        actorPrincipal: "SP000000000000000000002Q6VF78",
        feeBips: "250",
      },
    });
    expect(wallet.prepare).toHaveBeenLastCalledWith({
      action: "update-fees",
      actorPrincipal: "SP000000000000000000002Q6VF78",
      feeBips: "250",
    });

    await server.inject({
      method: "POST",
      url: "/api/v1/wallet-intents",
      headers,
      payload: {
        action: "claim-rewards",
        actorPrincipal: "SP000000000000000000002Q6VF78",
        jobId: "10000000-0000-4000-8000-000000000001",
      },
    });
    expect(wallet.prepare).toHaveBeenLastCalledWith({
      action: "claim-rewards",
      actorPrincipal: "SP000000000000000000002Q6VF78",
      jobId: "10000000-0000-4000-8000-000000000001",
    });

    await server.inject({
      method: "POST",
      url: "/api/v1/wallet-intents",
      headers,
      payload: {
        action: "calculate-rewards",
        actorPrincipal: "SP000000000000000000002Q6VF78",
      },
    });
    expect(wallet.prepare).toHaveBeenLastCalledWith({
      action: "calculate-rewards",
      actorPrincipal: "SP000000000000000000002Q6VF78",
    });

    await server.inject({
      method: "POST",
      url: "/api/v1/manager/signer-grant/prepare",
      headers,
      payload: { authId: "9", signerConfigPath: "/etc/stacks-signer/signer.toml" },
    });
    expect(prepareManagerSignerGrant).toHaveBeenCalledWith({
      authId: "9",
      signerConfigPath: "/etc/stacks-signer/signer.toml",
    });
    const signerOutput = { signerKey: "external-output" };
    await server.inject({
      method: "POST",
      url: "/api/v1/manager/signer-grant/verify",
      headers,
      payload: { signerOutput },
    });
    expect(verifyManagerSignerGrant).toHaveBeenCalledWith(signerOutput);
  });

  it.each(
    walletIntentPrefixes,
  )("returns retryable chain-source heights while preparing at %s", async (prefix) => {
    const token = "test-operator-token-with-32-chars";
    const wallet = {
      prepare: vi.fn().mockRejectedValue(retryableWalletIntentAnchorError()),
    };
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({ service, wallet, authToken: token, logger: false });
    servers.push(server);
    const payload = {
      action: "update-fees",
      actorPrincipal: "SP000000000000000000002Q6VF78",
      feeBips: "250",
    };

    const response = await server.inject({
      method: "POST",
      url: prefix,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.json()).toEqual(walletIntentAnchorMismatch);

    for (const transient of [
      new ChainAnchorError("Chain position moved during setup snapshot", { retryable: true }),
      new ChainAnchorError("API tip changed at the same height", {
        retryable: true,
        tips: {
          node: { stacksTipHeight: 28_100, burnBlockHeight: 4_819 },
          api: { stacksTipHeight: 28_100, burnBlockHeight: 4_819 },
          poxBurnBlockHeight: 4_819,
        },
      }),
    ]) {
      wallet.prepare.mockRejectedValueOnce(transient);
      const unstable = await server.inject({
        method: "POST",
        url: prefix,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(unstable.statusCode).toBe(503);
      expect(unstable.headers["retry-after"]).toBe("1");
      expect(unstable.json()).toEqual({
        error: "wallet_intent_anchor_unstable",
        retryable: true,
      });
    }

    wallet.prepare.mockRejectedValueOnce(new Error("unexpected failure"));
    const generic = await server.inject({
      method: "POST",
      url: prefix,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(generic.statusCode).toBe(500);
    expect(generic.json()).toMatchObject({
      error: "internal_server_error",
      message: expect.stringContaining("Check operator logs for request"),
      requestId: expect.any(String),
      retryable: false,
    });
  });

  it("returns the same retryable mismatch while revalidating or replacing an intent", async () => {
    const token = "test-operator-token-with-32-chars";
    const intentId = "4e011bf7-f291-42c4-a35b-ab299a87ff8c";
    const wallet = {
      refresh: vi.fn().mockRejectedValue(retryableWalletIntentAnchorError()),
      replace: vi.fn().mockRejectedValue(retryableWalletIntentAnchorError()),
    };
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({ service, wallet, authToken: token, logger: false });
    servers.push(server);

    for (const prefix of walletIntentPrefixes) {
      for (const operation of ["refresh", "replacement"] as const) {
        const response = await server.inject({
          method: "POST",
          url: `${prefix}/${intentId}/${operation}`,
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        });
        expect(response.statusCode).toBe(503);
        expect(response.headers["retry-after"]).toBe("1");
        expect(response.json()).toEqual(walletIntentAnchorMismatch);
      }
    }
  });

  it.each(
    walletIntentPrefixes,
  )("serves the sealed wallet-intent lifecycle at %s", async (prefix) => {
    const token = "test-operator-token-with-32-chars";
    const intentId = "4e011bf7-f291-42c4-a35b-ab299a87ff8c";
    const txid = `0x${"ab".repeat(32)}`;
    const intent = { schemaVersion: 2, id: intentId, action: "update-fees" };
    const wallet = {
      prepare: vi.fn(),
      get: vi.fn().mockReturnValue(intent),
      submit: vi.fn().mockResolvedValue({ ...intent, txid }),
      refresh: vi.fn().mockResolvedValue({ ...intent, txid, status: "mempool" }),
      replace: vi.fn().mockResolvedValue({ ...intent, id: `${intentId.slice(0, -1)}d` }),
    };
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({ service, wallet, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    const invalidRead = await server.inject({ method: "GET", url: `${prefix}/invalid`, headers });
    expect([invalidRead.statusCode, invalidRead.json()]).toEqual([
      404,
      {
        error: "wallet_intent_not_found",
        message: "The wallet transaction request was not found. Prepare a new transaction.",
        retryable: false,
      },
    ]);
    expect(wallet.get).not.toHaveBeenCalled();
    expect(
      (await server.inject({ method: "GET", url: `${prefix}/${intentId}`, headers })).json(),
    ).toEqual({ intent });
    expect(wallet.get).toHaveBeenCalledWith(intentId);

    const invalidSubmission = await server.inject({
      method: "POST",
      url: `${prefix}/${intentId}/submission`,
      headers,
      payload: { txid, signedTransaction: "must-not-be-accepted" },
    });
    expect([invalidSubmission.statusCode, invalidSubmission.json()]).toEqual([
      400,
      {
        error: "invalid_wallet_intent_submission",
        message: "The transaction submission is invalid. Enter a valid transaction ID and retry.",
        retryable: false,
      },
    ]);
    expect(wallet.submit).not.toHaveBeenCalled();
    await server.inject({
      method: "POST",
      url: `${prefix}/${intentId}/submission`,
      headers,
      payload: { txid },
    });
    expect(wallet.submit).toHaveBeenCalledWith(intentId, txid);

    const invalidRefresh = await server.inject({
      method: "POST",
      url: `${prefix}/${intentId}/refresh`,
      headers,
      payload: { unexpected: true },
    });
    expect([invalidRefresh.statusCode, invalidRefresh.json()]).toEqual([
      400,
      {
        error: "invalid_wallet_intent_refresh",
        message: "The wallet transaction request is invalid. Prepare a new transaction.",
        retryable: false,
      },
    ]);
    expect(wallet.refresh).not.toHaveBeenCalled();
    await server.inject({
      method: "POST",
      url: `${prefix}/${intentId}/refresh`,
      headers,
      payload: {},
    });
    expect(wallet.refresh).toHaveBeenCalledWith(intentId);

    const invalidReplacement = await server.inject({
      method: "POST",
      url: `${prefix}/${intentId}/replacement`,
      headers,
      payload: { txid },
    });
    expect([invalidReplacement.statusCode, invalidReplacement.json()]).toEqual([
      400,
      {
        error: "invalid_wallet_intent_replacement",
        message: "The wallet transaction request is invalid. Prepare a new transaction.",
        retryable: false,
      },
    ]);
    expect(wallet.replace).not.toHaveBeenCalled();
    await server.inject({
      method: "POST",
      url: `${prefix}/${intentId}/replacement`,
      headers,
      payload: {},
    });
    expect(wallet.replace).toHaveBeenCalledWith(intentId);
  });

  it.each(
    walletIntentPrefixes,
  )("returns safe wallet-intent guidance at %s without internal details", async (prefix) => {
    const token = "test-operator-token-with-32-chars";
    const error = new WalletIntentError(
      "wallet_intent_conflict",
      "The wallet transaction changed. Prepare a new transaction.",
    );
    Object.assign(error, { internalDetail: "must-not-leak" });
    const wallet = { prepare: vi.fn().mockRejectedValue(error) };
    const server = createServer({
      service: { snapshot: async () => ({}), synchronize: async () => ({}) },
      wallet,
      authToken: token,
      logger: false,
    });
    servers.push(server);
    const payload = {
      action: "update-fees",
      actorPrincipal: "SP000000000000000000002Q6VF78",
      feeBips: "250",
    };

    const response = await server.inject({
      method: "POST",
      url: prefix,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "wallet_intent_conflict",
      message: "The wallet transaction changed. Prepare a new transaction.",
      retryable: false,
    });
    expect(response.body).not.toContain("must-not-leak");
  });

  it("uses explicit wallet-intent retryability for transient and permanent failures", async () => {
    const token = "test-operator-token-with-32-chars";
    const wallet = {
      prepare: vi
        .fn()
        .mockRejectedValueOnce(
          new WalletIntentError(
            "wallet_execution_unavailable",
            "Claim eligibility could not be refreshed. Retry in a moment.",
            true,
          ),
        )
        .mockRejectedValueOnce(
          new WalletIntentError(
            "wallet_execution_unavailable",
            "This claim is not eligible for browser-wallet execution.",
          ),
        ),
    };
    const server = createServer({
      service: { snapshot: async () => ({}), synchronize: async () => ({}) },
      wallet,
      authToken: token,
      logger: false,
    });
    servers.push(server);
    const request = {
      method: "POST" as const,
      url: "/api/v1/wallet-intents",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: "update-fees",
        actorPrincipal: "SP000000000000000000002Q6VF78",
        feeBips: "250",
      },
    };

    const transient = await server.inject(request);
    expect(transient.statusCode).toBe(503);
    expect(transient.headers["retry-after"]).toBe("1");
    expect(transient.json()).toEqual({
      error: "wallet_execution_unavailable",
      message: "Claim eligibility could not be refreshed. Retry in a moment.",
      retryable: true,
    });

    const permanent = await server.inject(request);
    expect(permanent.statusCode).toBe(422);
    expect(permanent.headers["retry-after"]).toBeUndefined();
    expect(permanent.json()).toEqual({
      error: "wallet_execution_unavailable",
      message: "This claim is not eligible for browser-wallet execution.",
      retryable: false,
    });
  });

  it("rejects the documented placeholder bearer token", () => {
    expect(() =>
      createServer({
        service: { snapshot: async () => ({}), synchronize: async () => ({}) },
        authToken: "replace-with-at-least-24-random-characters",
        logger: false,
      }),
    ).toThrow("SIDEKICK_AUTH_TOKEN");
  });

  it("rejects unsafe automatic-authentication settings", () => {
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const authToken = "test-operator-token-with-32-chars";
    expect(() =>
      createServer({ service, authToken, authTrustedHeader: "Authorization", logger: false }),
    ).toThrow("SIDEKICK_AUTH_TRUSTED_HEADER");
    expect(() =>
      createServer({ service, authToken, authBasicUsername: "bad:user", logger: false }),
    ).toThrow("SIDEKICK_AUTH_BASIC_USERNAME");
  });

  it("reports readiness and Prometheus counters without authentication", async () => {
    const service = {
      snapshot: async () => ({
        generatedAt: "2026-07-14T12:00:00.000Z",
        preflight: { status: "pass" },
      }),
      synchronize: async () => ({}),
    };
    const snapshotRefreshMetrics = new SnapshotRefreshMetricsTracker(() =>
      Date.parse("2026-07-14T12:00:10.000Z"),
    );
    snapshotRefreshMetrics.recordAttempt();
    snapshotRefreshMetrics.recordSuccess({
      generatedAt: "2026-07-14T12:00:00.000Z",
      preflight: {
        node: { stacksTipHeight: 100, burnBlockHeight: 50 },
        api: { stacksTipHeight: 99, burnBlockHeight: 50 },
        pox: { burnBlockHeight: 49, rewardCycleId: 141 },
      },
    });
    const server = createServer({
      service,
      authToken: "test-operator-token-with-32-chars",
      logger: false,
      snapshotRefreshMetrics,
      observerStatus: () => ({
        schemaVersion: 1,
        enabled: true,
        listening: true,
        listener: { host: "127.0.0.1", port: 3700, maxBodyBytes: 4_194_304 },
        inbox: {
          schemaVersion: 1,
          uniqueDeliveries: 3,
          deliveryAttempts: 4,
          processingAttempts: 2,
          duplicates: 1,
          queueDepth: 2,
          processing: 0,
          nodeVerified: 1,
          quarantined: 0,
          expired: 0,
          retainedPayloadBytes: 1024,
          prunedPayloads: 0,
          lastReceivedAt: "2026-07-14T12:00:09.000Z",
          lastProcessedAt: "2026-07-14T12:00:10.000Z",
          oldestPendingAt: "2026-07-14T12:00:08.000Z",
          lastClaimedStacksBlock: null,
          lastVerifiedStacksBlock: null,
          lastClaimedBurnBlock: null,
          lastQuarantine: null,
        },
        reconciliation: {
          schemaVersion: 1,
          started: true,
          domains: {
            current: {
              pending: false,
              running: false,
              requests: 4,
              coalescedRequests: 2,
              successes: 2,
              failuresTotal: 0,
              consecutiveFailures: 0,
              requestedStacksHeight: 100,
              requestedBurnHeight: 50,
              lastRequestedAt: "2026-07-14T12:00:09.000Z",
              lastStartedAt: "2026-07-14T12:00:09.000Z",
              lastSuccessAt: "2026-07-14T12:00:10.000Z",
              lastFailureAt: null,
              lastError: null,
              nextRetryAt: null,
              callbackLatency: {
                samples: 2,
                sumSeconds: 2.5,
                maxSeconds: 1.5,
                lastSeconds: 1,
                withinTwoSeconds: 2,
                buckets: { le1: 1, le2: 2, le5: 2, le10: 2, le30: 2 },
              },
            },
            "manager-activity": {
              pending: true,
              running: false,
              requests: 3,
              coalescedRequests: 1,
              successes: 1,
              failuresTotal: 1,
              consecutiveFailures: 1,
              requestedStacksHeight: 100,
              requestedBurnHeight: null,
              lastRequestedAt: "2026-07-14T12:00:09.000Z",
              lastStartedAt: "2026-07-14T12:00:09.000Z",
              lastSuccessAt: "2026-07-14T12:00:00.000Z",
              lastFailureAt: "2026-07-14T12:00:10.000Z",
              lastError: "API unavailable",
              nextRetryAt: "2026-07-14T12:00:25.000Z",
              callbackLatency: {
                samples: 1,
                sumSeconds: 3,
                maxSeconds: 3,
                lastSeconds: 3,
                withinTwoSeconds: 0,
                buckets: { le1: 0, le2: 0, le5: 1, le10: 1, le30: 1 },
              },
            },
            rewards: {
              pending: false,
              running: false,
              requests: 2,
              coalescedRequests: 0,
              successes: 2,
              failuresTotal: 0,
              consecutiveFailures: 0,
              requestedStacksHeight: 100,
              requestedBurnHeight: null,
              lastRequestedAt: "2026-07-14T12:00:09.000Z",
              lastStartedAt: "2026-07-14T12:00:09.000Z",
              lastSuccessAt: "2026-07-14T12:00:10.000Z",
              lastFailureAt: null,
              lastError: null,
              nextRetryAt: null,
              callbackLatency: {
                samples: 1,
                sumSeconds: 1.25,
                maxSeconds: 1.25,
                lastSeconds: 1.25,
                withinTwoSeconds: 1,
                buckets: { le1: 0, le2: 1, le5: 1, le10: 1, le30: 1 },
              },
            },
            roster: {
              pending: false,
              running: false,
              requests: 1,
              coalescedRequests: 0,
              successes: 1,
              failuresTotal: 0,
              consecutiveFailures: 0,
              requestedStacksHeight: 100,
              requestedBurnHeight: null,
              lastRequestedAt: "2026-07-14T12:00:09.000Z",
              lastStartedAt: "2026-07-14T12:00:09.000Z",
              lastSuccessAt: "2026-07-14T12:00:10.000Z",
              lastFailureAt: null,
              lastError: null,
              nextRetryAt: null,
              callbackLatency: {
                samples: 1,
                sumSeconds: 1.5,
                maxSeconds: 1.5,
                lastSeconds: 1.5,
                withinTwoSeconds: 1,
                buckets: { le1: 0, le2: 1, le5: 1, le10: 1, le30: 1 },
              },
            },
          },
        },
        gap: {
          schemaVersion: 1,
          started: true,
          status: "degraded",
          reason: "observer-behind-node",
          intervalSeconds: 15,
          checksTotal: 10,
          failuresTotal: 1,
          consecutiveFailures: 0,
          startedAt: "2026-07-14T11:59:00.000Z",
          checkedAt: "2026-07-14T12:00:10.000Z",
          baselineStacksHeight: 98,
          nodeStacksHeight: 100,
          observerStacksHeight: 99,
          stacksGap: 1,
          observerSilenceSeconds: 16,
          lastError: null,
        },
      }),
    });
    servers.push(server);

    expect((await server.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
    const metrics = await server.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("sidekick_http_requests_total");
    expect(metrics.body).toContain("sidekick_operator_snapshot_refresh_successes_total 1");
    expect(metrics.body).toContain("sidekick_operator_snapshot_age_seconds 10");
    expect(metrics.body).toContain(
      'sidekick_operator_snapshot_source_stacks_height{source="node"} 100',
    );
    expect(metrics.body).toContain(
      'sidekick_operator_snapshot_source_burn_height{source="pox"} 49',
    );
    expect(metrics.body).toContain("sidekick_observer_deliveries_total 4");
    expect(metrics.body).toContain("sidekick_observer_listening 1");
    expect(metrics.body).toContain("sidekick_observer_duplicates_total 1");
    expect(metrics.body).toContain("sidekick_observer_processing_attempts_total 2");
    expect(metrics.body).toContain("sidekick_observer_queue_depth 2");
    expect(metrics.body).toContain("sidekick_observer_processing 0");
    expect(metrics.body).toContain("sidekick_observer_node_verified 1");
    expect(metrics.body).toContain("sidekick_observer_expired 0");
    expect(metrics.body).toContain("sidekick_observer_retained_payload_bytes 1024");
    expect(metrics.body).toContain("sidekick_observer_pruned_payloads 0");
    expect(metrics.body).toContain("sidekick_observer_last_received_timestamp_seconds 1784030409");
    expect(metrics.body).toContain("sidekick_observer_last_processed_timestamp_seconds 1784030410");
    expect(metrics.body).toContain(
      'sidekick_observer_reconciliation_requests_total{domain="current"} 4',
    );
    expect(metrics.body).toContain(
      'sidekick_observer_reconciliation_pending{domain="manager-activity"} 1',
    );
    expect(metrics.body).toContain(
      'sidekick_observer_reconciliation_successes_total{domain="rewards"} 2',
    );
    expect(metrics.body).toContain(
      'sidekick_observer_reconciliation_latency_seconds_bucket{domain="current",le="2"} 2',
    );
    expect(metrics.body).toContain("sidekick_observer_gap_degraded 1");
    expect(metrics.body).toContain("sidekick_observer_stacks_gap_blocks 1");
    expect(metrics.body).toContain("sidekick_observer_silence_seconds 16");
    const status = await server.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: { authorization: "Bearer test-operator-token-with-32-chars" },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().alerts).toContainEqual({
      id: "observer:callbacks-behind",
      severity: "warning",
      title: "Event Observer Is Behind",
      detail:
        "The local node is at Stacks 100, but the latest node-verified callback is 99 (16 seconds old). Sidekick is using polling fallback while callback delivery recovers.",
    });
  });

  it("keeps readiness available from a recent stale observation", async () => {
    const service = {
      snapshot: async () => {
        throw new Error("A stale summary should be used instead");
      },
      summary: async () => ({
        generatedAt: "2026-07-14T12:00:00.000Z",
        preflight: { status: "pass" },
        freshness: { status: "stale" as const },
      }),
      synchronize: async () => ({}),
    };
    const server = createServer({
      service,
      authToken: "test-operator-token-with-32-chars",
      logger: false,
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ready", freshness: "stale" });
  });

  it("runs reconciliation asynchronously with process-local single-flight progress", async () => {
    const token = "test-operator-token-with-32-chars";
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const synchronize = vi.fn(async (options?: { onProgress?(progress: unknown): unknown }) => {
      await options?.onProgress?.({
        phase: "stakers-verification",
        completed: 25,
        total: 120,
      });
      await gate;
      await options?.onProgress?.({ phase: "events", completed: 1, total: 1 });
      return reconciliationResult();
    });
    const service = {
      snapshot: vi.fn().mockResolvedValue({ generatedAt: "2026-07-19T18:00:02.000Z" }),
      synchronize,
    };
    const server = createServer({ service, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    const idle = await server.inject({ method: "GET", url: "/api/v1/sync", headers });
    expect(idle.json().operation).toMatchObject({
      operationId: null,
      trigger: null,
      status: "idle",
      phase: "idle",
      processLocal: true,
    });

    const first = await server.inject({ method: "POST", url: "/api/v1/sync", headers });
    const second = await server.inject({ method: "POST", url: "/api/v1/sync", headers });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().operation.operationId).toBe(first.json().operation.operationId);
    expect(synchronize).toHaveBeenCalledOnce();

    const running = await server.inject({ method: "GET", url: "/api/v1/sync", headers });
    expect(running.json().operation).toMatchObject({
      trigger: "manual",
      status: "running",
      phase: "reconciling-stakers-verification",
      processLocal: true,
      progress: { itemsCompleted: 25, itemsTotal: 120 },
    });

    release?.();
    await vi.waitFor(async () => {
      const completed = await server.inject({ method: "GET", url: "/api/v1/sync", headers });
      expect(completed.json().operation.status).toBe("succeeded");
    });
    const completed = (await server.inject({ method: "GET", url: "/api/v1/sync", headers })).json()
      .operation;
    expect(completed.result).toMatchObject({
      snapshotGeneratedAt: "2026-07-19T18:00:02.000Z",
      reconciliation: {
        stakers: { discrepanciesObserved: 1 },
        events: { eventsProcessed: 20 },
      },
    });
    expect(JSON.stringify(completed)).not.toContain("must-not-cross-api");

    const metrics = await server.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain("sidekick_sync_total 1");
    expect(metrics.body).toContain("sidekick_sync_requests_total 2");
  });

  it("reconciles a configured roster automatically even when setup needs attention", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: vi.fn().mockResolvedValue({
        generatedAt: "2026-07-19T18:00:02.000Z",
        setup: { status: "attention" },
      }),
      synchronize: vi.fn().mockResolvedValue(reconciliationResult()),
    };
    const server = createServer({
      service,
      authToken: token,
      logger: false,
      rosterReconciliationInitialDelayMs: 1,
      rosterReconciliationIntervalMs: 30 * 60_000,
    });
    servers.push(server);
    await server.ready();

    await vi.waitFor(() => expect(service.synchronize).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/sync",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.json().operation).toMatchObject({
        trigger: "automatic",
        status: "succeeded",
      });
    });

    const metrics = await server.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain("sidekick_sync_total 1");
    expect(metrics.body).toContain("sidekick_sync_requests_total 0");
    expect(metrics.body).toContain("sidekick_roster_reconciliation_attempts_total 1");
    expect(metrics.body).toContain("sidekick_roster_reconciliation_successes_total 1");
  });

  it("skips automatic reconciliation until manager setup is ready", async () => {
    const service = {
      snapshot: vi.fn().mockResolvedValue({
        generatedAt: "2026-07-19T18:00:02.000Z",
        setup: { status: "blocked" },
      }),
      synchronize: vi.fn().mockResolvedValue(reconciliationResult()),
    };
    const server = createServer({
      service,
      authToken: "test-operator-token-with-32-chars",
      logger: false,
      rosterReconciliationInitialDelayMs: 1,
      rosterReconciliationIntervalMs: 30 * 60_000,
    });
    servers.push(server);
    await server.ready();

    await vi.waitFor(async () => {
      const metrics = await server.inject({ method: "GET", url: "/metrics" });
      expect(metrics.body).toContain("sidekick_roster_reconciliation_skips_total 1");
    });
    expect(service.synchronize).not.toHaveBeenCalled();
  });

  it("skips automatic reconciliation while a proved connection is temporarily unavailable", async () => {
    const unavailable = {
      status: "unavailable",
      lastSuccessful: {
        managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      },
    } as ConnectionAssessment;
    const service = {
      snapshot: vi.fn().mockResolvedValue({
        generatedAt: "2026-08-13T12:00:00.000Z",
        setup: { status: "ready" },
      }),
      synchronize: vi.fn().mockResolvedValue(reconciliationResult()),
    };
    const server = createServer({
      service,
      connection: { current: () => unavailable, check: async () => unavailable },
      isOperational: () => true,
      authToken: "test-operator-token-with-32-chars",
      logger: false,
      rosterReconciliationInitialDelayMs: 1,
      rosterReconciliationIntervalMs: 30 * 60_000,
    });
    servers.push(server);
    await server.ready();

    await vi.waitFor(async () => {
      const metrics = await server.inject({ method: "GET", url: "/metrics" });
      expect(metrics.body).toContain("sidekick_roster_reconciliation_skips_total 1");
    });
    expect(service.snapshot).not.toHaveBeenCalled();
    expect(service.synchronize).not.toHaveBeenCalled();
  });

  it("stores structured retryable reconciliation failures for polling", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: async () => ({ generatedAt: "2026-07-19T18:00:00.000Z" }),
      synchronize: async () => {
        throw retryableWalletIntentAnchorError();
      },
    };
    const server = createServer({ service, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    expect((await server.inject({ method: "POST", url: "/api/v1/sync", headers })).statusCode).toBe(
      202,
    );
    await vi.waitFor(async () => {
      const response = await server.inject({ method: "GET", url: "/api/v1/sync", headers });
      expect(response.json().operation.status).toBe("failed");
    });
    const operation = (await server.inject({ method: "GET", url: "/api/v1/sync", headers })).json()
      .operation;
    expect(operation.error).toEqual({
      error: "chain_sources_out_of_sync",
      message: chainSourcesOutOfSyncMessage,
      retryable: true,
      node: walletIntentAnchorMismatch.node,
      api: walletIntentAnchorMismatch.api,
      poxBurnBlockHeight: walletIntentAnchorMismatch.poxBurnBlockHeight,
    });
  });

  it("returns sanitized anchor evidence for signer-staker reconciliation failures", async () => {
    const token = "test-operator-token-with-32-chars";
    const evidence = {
      anchor: {
        stacksBlockHeight: 8_600_000,
        indexBlockHash: `0x${"11".repeat(32)}`,
        burnBlockHeight: 960_240,
      },
      apiTipBefore: {
        stacksBlockHeight: 8_600_005,
        indexBlockHash: `0x${"22".repeat(32)}`,
        burnBlockHeight: 960_240,
      },
      indexedBlock: {
        canonical: false,
        stacksBlockHeight: 8_600_000,
        indexBlockHash: `0x${"33".repeat(32)}`,
        burnBlockHeight: 960_240,
      },
    };
    const service = {
      snapshot: async () => ({ generatedAt: "2026-07-19T18:00:00.000Z" }),
      synchronize: async () => {
        throw new SignerStakerAnchorError("sealed anchor changed", { evidence });
      },
    };
    const server = createServer({ service, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    await server.inject({ method: "POST", url: "/api/v1/sync", headers });
    await vi.waitFor(async () => {
      const response = await server.inject({ method: "GET", url: "/api/v1/sync", headers });
      expect(response.json().operation.status).toBe("failed");
    });
    const operation = (await server.inject({ method: "GET", url: "/api/v1/sync", headers })).json()
      .operation;
    expect(operation.error).toEqual({
      error: "signer_staker_anchor_unstable",
      message: "Signer roster data changed during synchronization. Retry the chain data sync.",
      retryable: true,
      anchorEvidence: evidence,
    });
  });

  it("cancels and awaits background reconciliation during server shutdown", async () => {
    const token = "test-operator-token-with-32-chars";
    const aborted = vi.fn();
    const service = {
      snapshot: async () => ({ generatedAt: "2026-07-19T18:00:00.000Z" }),
      synchronize: async (options?: { signal?: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted();
              reject(options.signal?.reason);
            },
            { once: true },
          );
        }),
    };
    const server = createServer({ service, authToken: token, logger: false });
    servers.push(server);
    await server.inject({
      method: "POST",
      url: "/api/v1/sync",
      headers: { authorization: `Bearer ${token}` },
    });

    await server.close();
    expect(aborted).toHaveBeenCalledOnce();
    servers.splice(servers.indexOf(server), 1);
  });

  it("classifies transient, malformed, and unexpected operator failures", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: async () => ({}),
      summary: vi
        .fn()
        .mockRejectedValueOnce(retryableWalletIntentAnchorError())
        .mockRejectedValueOnce(new Error("must-not-leak")),
      synchronize: async () => reconciliationResult(),
      updateSettings: vi.fn().mockRejectedValue(new RateLimitedError("limited", 3_000)),
    };
    const health = {
      current: async () => ({}),
      refresh: async () => ({}),
      testSource: vi.fn().mockRejectedValue(new HealthSourceError("timeout", "dns timed out")),
    };
    const server = createServer({ service, health, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    const mismatch = await server.inject({ method: "GET", url: "/api/v1/status", headers });
    expect([mismatch.statusCode, mismatch.headers["retry-after"], mismatch.json()]).toEqual([
      503,
      "1",
      {
        error: "chain_sources_out_of_sync",
        message: chainSourcesOutOfSyncMessage,
        retryable: true,
        node: walletIntentAnchorMismatch.node,
        api: walletIntentAnchorMismatch.api,
        poxBurnBlockHeight: walletIntentAnchorMismatch.poxBurnBlockHeight,
      },
    ]);

    const unavailable = await server.inject({
      method: "POST",
      url: "/api/v1/health/test-source",
      headers,
      payload: { kind: "node-metrics", url: "http://node.internal:9153" },
    });
    expect([
      unavailable.statusCode,
      unavailable.headers["retry-after"],
      unavailable.json(),
    ]).toEqual([
      503,
      "1",
      {
        error: "health_source_temporarily_unavailable",
        message: "The health source could not be reached. Check the endpoint, then retry.",
        retryable: true,
      },
    ]);

    const limited = await server.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers,
      payload: {},
    });
    expect([limited.statusCode, limited.headers["retry-after"], limited.json()]).toEqual([
      429,
      "3",
      {
        error: "upstream_rate_limited",
        message:
          "A configured chain source is rate limiting Sidekick. Retry after the indicated delay.",
        retryable: true,
      },
    ]);

    const malformed = await server.inject({
      method: "POST",
      url: "/api/v1/health/test-source",
      headers,
      payload: { kind: "unknown", url: "not-a-url" },
    });
    expect([malformed.statusCode, malformed.json()]).toEqual([
      400,
      {
        error: "invalid_health_source",
        message: "Choose a supported health source and enter a valid URL.",
        retryable: false,
      },
    ]);

    const unexpected = await server.inject({ method: "GET", url: "/api/v1/status", headers });
    expect(unexpected.statusCode).toBe(500);
    expect(unexpected.json()).toMatchObject({
      error: "internal_server_error",
      message: expect.stringContaining("Check operator logs for request"),
      requestId: expect.any(String),
      retryable: false,
    });
    expect(unexpected.body).not.toContain("must-not-leak");
  });

  it("explains a Hiro API rate limit without exposing the configured endpoint", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: async () => ({}),
      updateSettings: async () => {
        throw new RateLimitedError(
          "limited",
          3_000,
          "https://api.mainnet.hiro.so/extended/v1/status",
        );
      },
    };
    const server = createServer({
      service,
      authToken: token,
      getRateLimitSettings: () => ({
        apiUrl: "https://api.mainnet.hiro.so",
        apiKeyConfigured: false,
      }),
      logger: false,
    });
    servers.push(server);

    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect([response.statusCode, response.headers["retry-after"], response.json()]).toEqual([
      429,
      "3",
      {
        error: "upstream_rate_limited",
        message: "Hiro API is rate limiting Sidekick. It will retry automatically.",
        retryable: true,
        rateLimit: {
          source: "hiro-api",
          retryAfterSeconds: 3,
          apiKeyConfigured: false,
        },
      },
    ]);
  });

  it("explains how to replace a special-purpose health address", async () => {
    const token = "test-operator-token-with-32-chars";
    const server = createServer({
      service: { snapshot: async () => ({}) },
      health: {
        current: async () => ({}),
        refresh: async () => ({}),
        testSource: async () => {
          throw new HealthSourceError("unsafe-address", "blocked");
        },
      },
      authToken: token,
      logger: false,
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/health/test-source",
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "node-metrics", url: "http://169.254.169.254/latest" },
    });

    expect([response.statusCode, response.json()]).toEqual([
      422,
      {
        error: "health_source_not_allowed",
        message:
          "Sidekick cannot use this URL because it points to a special-purpose network address (for example, link-local or multicast). Use a normal LAN, Tailnet, or public address for this service, or proxy it through one.",
        retryable: false,
      },
    ]);
  });

  it("classifies retryable and rejected upstream HTTP responses without leaking bodies", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: async () => ({}),
      summary: vi
        .fn()
        .mockRejectedValueOnce(new UpstreamHttpError("temporary body must-not-leak", 425))
        .mockRejectedValueOnce(new UpstreamHttpError("auth body must-not-leak", 401)),
      synchronize: async () => ({}),
    };
    const server = createServer({ service, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    const retryable = await server.inject({ method: "GET", url: "/api/v1/status", headers });
    expect(retryable.statusCode).toBe(503);
    expect(retryable.headers["retry-after"]).toBe("1");
    expect(retryable.json()).toEqual({
      error: "upstream_temporarily_unavailable",
      message: "A configured chain source returned HTTP 425. Retry in a moment.",
      retryable: true,
    });

    const rejected = await server.inject({ method: "GET", url: "/api/v1/status", headers });
    expect(rejected.statusCode).toBe(502);
    expect(rejected.json()).toEqual({
      error: "upstream_request_rejected",
      message:
        "A configured chain source rejected the request with HTTP 401. Verify its URL and access settings.",
      retryable: false,
    });
    expect(`${retryable.body}${rejected.body}`).not.toContain("must-not-leak");
  });

  it("validates and forwards bounded pagination for large operator datasets", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: vi.fn().mockResolvedValue({ generatedAt: "2026-07-14T12:00:00.000Z" }),
      summary: vi.fn().mockResolvedValue({ rosterTotal: 500, roster: [] }),
      synchronize: vi.fn().mockResolvedValue({}),
      poolPage: vi.fn().mockResolvedValue({ total: 500, offset: 100, limit: 50, roster: [] }),
      poolHistory: vi.fn().mockResolvedValue({ total: 96, offset: 25, limit: 25, items: [] }),
      rewardsPage: vi.fn().mockResolvedValue({ total: 500, offset: 50, limit: 50, rewards: {} }),
      rewardsHistory: vi.fn().mockResolvedValue({ total: 96, offset: 25, limit: 25, items: [] }),
      activity: vi.fn().mockResolvedValue({ claimTotal: 4_000, withdrawalTotal: 400 }),
    };
    const server = createServer({ service, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    expect(
      (
        await server.inject({
          method: "GET",
          url: "/api/v1/pool?offset=100&limit=50&query=SP2JX&sort=amount&direction=desc",
          headers,
        })
      ).json(),
    ).toMatchObject({ total: 500, offset: 100, limit: 50 });
    expect(service.poolPage).toHaveBeenCalledWith({
      offset: 100,
      limit: 50,
      query: "SP2JX",
      sort: "amount",
      direction: "desc",
    });

    await server.inject({
      method: "GET",
      url: "/api/v1/pool/history?offset=25&limit=25",
      headers,
    });
    expect(service.poolHistory).toHaveBeenCalledWith({ offset: 25, limit: 25 });

    await server.inject({
      method: "GET",
      url: "/api/v1/rewards?offset=50&limit=50&sort=net&direction=desc",
      headers,
    });
    expect(service.rewardsPage).toHaveBeenCalledWith({
      offset: 50,
      limit: 50,
      sort: "net",
      direction: "desc",
    });

    await server.inject({
      method: "GET",
      url: "/api/v1/rewards/history?offset=25&limit=25&sort=gross&direction=desc",
      headers,
    });
    expect(service.rewardsHistory).toHaveBeenCalledWith({
      offset: 25,
      limit: 25,
      sort: "gross",
      direction: "desc",
    });

    await server.inject({
      method: "GET",
      url: "/api/v1/rewards/activity?claimOffset=150&claimLimit=50&claimSort=amount&claimDirection=desc&rewardCycle=141&withdrawalOffset=20&withdrawalLimit=20&withdrawalSort=max-fee&withdrawalDirection=asc&withdrawalState=pending",
      headers,
    });
    expect(service.activity).toHaveBeenCalledWith({
      claimOffset: 150,
      claimLimit: 50,
      claimSort: "amount",
      claimDirection: "desc",
      rewardCycle: "141",
      withdrawalOffset: 20,
      withdrawalLimit: 20,
      withdrawalSort: "max-fee",
      withdrawalDirection: "asc",
      withdrawalState: "pending",
    });

    expect(
      (
        await server.inject({
          method: "GET",
          url: "/api/v1/pool?limit=201",
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/api/v1/pool?sort=unknown",
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/api/v1/rewards/activity?withdrawalState=unknown",
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/api/v1/rewards/activity?rewardCycle=abc",
          headers,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("serves the typed Activity projection in read-only connection mode", async () => {
    const token = "test-operator-token-with-32-chars";
    const generatedAt = "2026-08-14T12:00:00.000Z";
    const projected = activityResponseSchema.parse({
      schemaVersion: 1,
      generatedAt,
      active: [],
      items: [],
      nextCursor: null,
      coverage: [
        {
          source: "wallet-intents",
          status: "current",
          observedAt: generatedAt,
          anchor: null,
          reason: null,
        },
      ],
    });
    const activityProjection = {
      page: vi.fn(() => projected),
      detail: vi.fn(() => ({ canonical: true })),
    };
    const unavailable = {
      status: "unavailable",
      outcomeCode: "node-unreachable",
      checkedAt: generatedAt,
      stale: true,
      lastSuccessful: null,
    } as ConnectionAssessment;
    const server = createServer({
      activityProjection,
      connection: { current: () => unavailable, check: async () => unavailable },
      isOperational: () => false,
      authToken: token,
      logger: false,
    });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    const page = await server.inject({
      method: "GET",
      url: "/api/v1/activity?status=needs-attention&type=actions&domain=rewards&time=7d&search=claim&limit=20",
      headers,
    });
    expect(page.statusCode).toBe(200);
    expect(activityResponseSchema.parse(page.json())).toEqual(projected);
    expect(activityProjection.page).toHaveBeenCalledWith(
      {
        status: "needs-attention",
        type: "actions",
        domain: "rewards",
        time: "7d",
        search: "claim",
        cursor: null,
        limit: 20,
      },
      true,
    );

    const detail = await server.inject({
      method: "GET",
      url: `/api/v1/activity/${encodeURIComponent("chain-tx:1:0xabc")}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(activityProjection.detail).toHaveBeenCalledWith("chain-tx:1:0xabc", true);
  });

  it("maps invalid Activity input and bounded-authority failures without leaking internals", async () => {
    const token = "test-operator-token-with-32-chars";
    const detail = vi.fn(() => null);
    const page = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new ActivityProjectionError("invalid_activity_cursor", "secret cursor body");
      })
      .mockImplementationOnce(() => {
        throw new ActivityProjectionError(
          "activity_authority_limit_exceeded",
          "secret database cardinality",
        );
      });
    const server = createServer({
      activityProjection: { page, detail },
      authToken: token,
      logger: false,
    });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    const badQuery = await server.inject({
      method: "GET",
      url: "/api/v1/activity?status=unknown",
      headers,
    });
    expect(badQuery.statusCode).toBe(400);
    expect(badQuery.json()).toMatchObject({ error: "invalid_activity_query", retryable: false });

    const badCursor = await server.inject({ method: "GET", url: "/api/v1/activity", headers });
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json()).toMatchObject({ error: "invalid_activity_cursor", retryable: false });

    const bounded = await server.inject({ method: "GET", url: "/api/v1/activity", headers });
    expect(bounded.statusCode).toBe(503);
    expect(bounded.json()).toMatchObject({
      error: "activity_authority_limit_exceeded",
      retryable: true,
    });

    const missing = await server.inject({
      method: "GET",
      url: "/api/v1/activity/wallet-intent%3Amissing",
      headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "activity_not_found", retryable: false });
    expect(`${badCursor.body}${bounded.body}`).not.toContain("secret");
  });

  it("validates and forwards the authenticated transaction-engine API", async () => {
    const token = "test-operator-token-with-32-chars";
    const jobId = "00000000-0000-4000-8000-000000000001";
    const hash = "a".repeat(64);
    const engine = {
      status: vi.fn().mockResolvedValue({ schemaVersion: 1, mode: "observe" }),
      listJobs: vi
        .fn()
        .mockResolvedValue({ schemaVersion: 1, items: [], nextCursor: null, total: 0 }),
      getJob: vi.fn().mockResolvedValue({ schemaVersion: 1, jobId }),
      approve: vi.fn().mockResolvedValue({ created: true }),
      invalidateApproval: vi.fn().mockResolvedValue({}),
      forceObserve: vi.fn().mockResolvedValue({}),
      disableAdapter: vi.fn().mockResolvedValue({}),
    } as unknown as TransactionEngineApiService;
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({ service, engine, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    expect((await server.inject({ method: "GET", url: "/api/v1/engine" })).statusCode).toBe(401);
    expect(
      (await server.inject({ method: "GET", url: "/api/v1/engine", headers })).statusCode,
    ).toBe(200);
    await server.inject({
      method: "GET",
      url: "/api/v1/engine/jobs?cursor=next-page&limit=20",
      headers,
    });
    expect(engine.listJobs).toHaveBeenCalledWith({ cursor: "next-page", limit: 20 });

    await server.inject({ method: "GET", url: `/api/v1/engine/jobs/${jobId}`, headers });
    expect(engine.getJob).toHaveBeenCalledWith(jobId);

    const approval = {
      decision: "approve",
      intentSha256: hash,
      policySha256: hash,
      expiresAt: "2026-07-17T19:00:00.000Z",
    };
    await server.inject({
      method: "POST",
      url: `/api/v1/engine/jobs/${jobId}/approval`,
      headers,
      payload: approval,
    });
    expect(engine.approve).toHaveBeenCalledWith(jobId, approval, "local-operator");

    await server.inject({
      method: "POST",
      url: `/api/v1/engine/jobs/${jobId}/approval/invalidate`,
      headers,
      payload: { decision: "invalidate", reason: "Facts changed" },
    });
    expect(engine.invalidateApproval).toHaveBeenCalledWith(
      jobId,
      { decision: "invalidate", reason: "Facts changed" },
      "local-operator",
    );

    await server.inject({
      method: "POST",
      url: "/api/v1/engine/force-observe",
      headers,
      payload: { decision: "force-observe", reason: "Emergency stop" },
    });
    expect(engine.forceObserve).toHaveBeenCalledWith(
      { decision: "force-observe", reason: "Emergency stop" },
      "local-operator",
    );

    await server.inject({
      method: "POST",
      url: "/api/v1/engine/adapters/reference-manager-claim-rewards/disable",
      headers,
      payload: { decision: "disable", reason: "Adapter review" },
    });
    expect(engine.disableAdapter).toHaveBeenCalledWith(
      "reference-manager-claim-rewards",
      { decision: "disable", reason: "Adapter review" },
      "local-operator",
    );

    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/v1/engine/jobs/${jobId}/approval`,
          headers,
          payload: { decision: "broadcast", transaction: "arbitrary" },
        })
      ).statusCode,
    ).toBe(400);
    expect(engine.approve).toHaveBeenCalledTimes(1);
  });

  it("reports an unavailable transaction engine without weakening the operator API", async () => {
    const token = "test-operator-token-with-32-chars";
    const server = createServer({
      service: { snapshot: async () => ({}), synchronize: async () => ({}) },
      authToken: token,
      logger: false,
    });
    servers.push(server);
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/engine",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({
      error: "transaction_engine_unavailable",
      message: "The requested feature is unavailable in this Sidekick deployment.",
      retryable: false,
    });
  });

  it("reports engine blockers through authenticated operation readiness without failing control-plane readiness", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: async () => ({
        generatedAt: "2026-07-17T12:00:00.000Z",
        preflight: { status: "pass" },
        manager: { attachAllowed: true },
        registration: { registered: true, signerKeyGrantValid: true },
      }),
      synchronize: async () => ({}),
    };
    const engine = {
      status: () => ({
        schemaVersion: 1,
        mode: "observe" as const,
        forcedObserve: { active: false, reason: null, actor: null, forcedAt: null },
        adapters: [
          {
            adapter: { id: "reference-manager-claim-rewards", revision: 1 },
            label: "Reference manager claim rewards",
            mode: "observe" as const,
            enabled: true,
            availability: "blocked" as const,
            blockReason: "Chain tips disagree",
          },
        ],
        jobs: { active: 0, awaitingApproval: 0, ambiguous: 0 },
        generatedAt: "2026-07-17T12:00:00.000Z",
      }),
      listJobs: async () => ({ schemaVersion: 1, items: [], nextCursor: null, total: 0 }),
      getJob: async () => null,
      approve: async () => ({}),
      invalidateApproval: async () => ({}),
      forceObserve: async () => ({}),
      disableAdapter: async () => ({}),
    } as unknown as TransactionEngineApiService;
    const server = createServer({ service, engine, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    expect((await server.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
    expect(
      (await server.inject({ method: "GET", url: "/api/v1/operations/readiness" })).statusCode,
    ).toBe(401);
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/operations/readiness",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: 2,
      status: "blocked",
      checks: [
        { id: "control-plane", status: "ready" },
        { id: "manager", status: "ready" },
        { id: "signer", status: "ready" },
        { id: "engine", status: "blocked", detail: "Chain tips disagree" },
      ],
    });
  });

  it("returns a generic 500 body when an operator service rejects", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: async () => ({}),
      synchronize: async () => ({}),
      poolPage: async () => {
        throw new Error("https://upstream.example/private/path?api_key=must-not-leak");
      },
    };
    const server = createServer({ service, authToken: token, logger: false });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/pool",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body).toMatchObject({
      error: "internal_server_error",
      message: expect.stringContaining("Check operator logs for request"),
      requestId: expect.any(String),
      retryable: false,
    });
    expect(body.message).toContain(body.requestId);
    expect(response.body).not.toContain("must-not-leak");
  });

  it("maps typed transaction-engine conflicts and not-found errors without leaking details", async () => {
    const token = "test-operator-token-with-32-chars";
    const conflict = new TransactionEngineApiServiceError(409, "engine_state_conflict");
    Object.assign(conflict, { internalDetail: "must-not-leak" });
    const notFound = new TransactionEngineApiServiceError(404, "engine_job_not_found");
    const engine = {
      status: vi.fn().mockRejectedValueOnce(conflict).mockRejectedValueOnce(notFound),
    } as unknown as TransactionEngineApiService;
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({ service, engine, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    const conflicted = await server.inject({ method: "GET", url: "/api/v1/engine", headers });
    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json()).toEqual({
      error: "engine_state_conflict",
      message: "Transaction state changed. Refresh and try again",
      retryable: false,
    });
    expect(conflicted.body).not.toContain("must-not-leak");

    const missing = await server.inject({ method: "GET", url: "/api/v1/engine", headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: "engine_job_not_found",
      message: "This transaction job no longer exists. Refresh Operations",
      retryable: false,
    });
  });

  it("validates authenticated runtime settings", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: async () => ({ generatedAt: "2026-07-15T12:00:00.000Z" }),
      synchronize: async () => ({}),
      settings: vi.fn().mockReturnValue({ revision: 2, dataSources: { apiKeyConfigured: true } }),
      updateSettings: vi.fn().mockReturnValue({ revision: 3 }),
    };
    const server = createServer({ service, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    expect(
      (await server.inject({ method: "GET", url: "/api/v1/settings", headers })).json(),
    ).toMatchObject({ revision: 2, dataSources: { apiKeyConfigured: true } });
    const settingsBody = { pool: { displayName: "Pool" } };
    expect(
      (
        await server.inject({
          method: "PUT",
          url: "/api/v1/settings",
          headers,
          payload: settingsBody,
        })
      ).json(),
    ).toEqual({ revision: 3 });
    expect(service.updateSettings).toHaveBeenCalledWith(settingsBody);
  });
});
