import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChainAnchorError,
  RateLimitedError,
  UpstreamHttpError,
  UpstreamSchemaError,
} from "./chain-clients.js";
import { HealthSourceError } from "./health-http.js";
import type { OnboardingService } from "./onboarding-service.js";
import { OnboardingWalletIntentError } from "./onboarding-wallet-intent.js";
import { createServer, type TransactionEngineApiService } from "./server.js";
import { TransactionEngineApiServiceError } from "./transaction-engine/api-service.js";
import { OperatorWorkflowError } from "./workflow-error.js";

const servers: ReturnType<typeof createServer>[] = [];
const walletIntentPrefixes = [
  "/api/v1/onboarding/wallet-intents",
  "/api/v1/wallet-intents",
] as const;
const walletIntentAnchorMismatch = {
  error: "wallet_intent_anchor_mismatch",
  retryable: true,
  node: { stacksTipHeight: 28_079, burnBlockHeight: 4_818 },
  api: { stacksTipHeight: 28_097, burnBlockHeight: 4_819 },
  poxBurnBlockHeight: 4_819,
} as const;
const chainSourcesOutOfSyncMessage =
  "The node and API are temporarily out of sync. Retry after the indexed API catches up.";

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

  it("returns stable workflow codes with safe operator guidance", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const onboarding = {
      start: () => {
        throw new OperatorWorkflowError(
          409,
          "onboarding_reset_confirmation_required",
          "Switching onboarding paths requires explicit reset confirmation",
        );
      },
    } as unknown as OnboardingService;
    const server = createServer({ service, onboarding, authToken: token, logger: false });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/onboarding/start",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: "attach" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "onboarding_reset_confirmation_required",
      message: "Switching onboarding paths requires explicit reset confirmation",
      retryable: false,
    });
  });

  it("replaces code-only workflow messages with safe operator guidance", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: async () => ({}),
      synchronize: async () => ({}),
      poolCard: async () => {
        throw new OperatorWorkflowError(409, "pool_setup_not_complete");
      },
    };
    const server = createServer({ service, authToken: token, logger: false });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/pool-card/generate",
      headers: { authorization: `Bearer ${token}` },
      payload: { mode: "live" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "pool_setup_not_complete",
      message:
        "Pool information is unavailable until setup completes. Finish Initial Setup, then retry.",
      retryable: false,
    });
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
    const intent = { schemaVersion: 1, id: intentId, action: "deploy-manager" };
    const wallet = {
      prepare: vi.fn().mockResolvedValue(intent),
      get: vi.fn().mockReturnValue(intent),
      submit: vi.fn().mockResolvedValue({ ...intent, txid }),
      refresh: vi.fn().mockResolvedValue({ ...intent, txid, status: "mempool" }),
      replace: vi.fn().mockResolvedValue({ ...intent, id: `${intentId.slice(0, -1)}d` }),
    };
    const prepareManagerSignerGrant = vi.fn().mockResolvedValue({ path: "attach" });
    const verifyManagerSignerGrant = vi.fn().mockResolvedValue({ path: "attach" });
    const onboarding = {
      wallet,
      prepareManagerSignerGrant,
      verifyManagerSignerGrant,
    } as unknown as OnboardingService;
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({ service, onboarding, authToken: token, logger: false });
    servers.push(server);
    const headers = { authorization: `Bearer ${token}` };

    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/onboarding/wallet-intents",
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
          url: "/api/v1/onboarding/wallet-intents",
          headers,
          payload: { action: "deploy-manager" },
        })
      ).json(),
    ).toEqual({ intent });
    expect(wallet.prepare).toHaveBeenCalledWith({ action: "deploy-manager" });

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
    const onboarding = { wallet } as unknown as OnboardingService;
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({ service, onboarding, authToken: token, logger: false });
    servers.push(server);
    const payload =
      prefix === "/api/v1/onboarding/wallet-intents"
        ? { action: "deploy-manager" }
        : {
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
    const onboarding = { wallet } as unknown as OnboardingService;
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({ service, onboarding, authToken: token, logger: false });
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
    const onboarding = { wallet } as unknown as OnboardingService;
    const service = { snapshot: async () => ({}), synchronize: async () => ({}) };
    const server = createServer({ service, onboarding, authToken: token, logger: false });
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
    const error = new OnboardingWalletIntentError(
      "wallet_intent_conflict",
      "The wallet transaction changed. Prepare a new transaction.",
    );
    Object.assign(error, { internalDetail: "must-not-leak" });
    const onboarding = {
      wallet: { prepare: vi.fn().mockRejectedValue(error) },
    } as unknown as OnboardingService;
    const server = createServer({
      service: { snapshot: async () => ({}), synchronize: async () => ({}) },
      onboarding,
      authToken: token,
      logger: false,
    });
    servers.push(server);
    const payload =
      prefix === "/api/v1/onboarding/wallet-intents"
        ? { action: "deploy-manager" }
        : {
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
          new OnboardingWalletIntentError(
            "wallet_execution_unavailable",
            "Claim eligibility could not be refreshed. Retry in a moment.",
            true,
          ),
        )
        .mockRejectedValueOnce(
          new OnboardingWalletIntentError(
            "wallet_execution_unavailable",
            "This claim is not eligible for browser-wallet execution.",
          ),
        ),
    };
    const server = createServer({
      service: { snapshot: async () => ({}), synchronize: async () => ({}) },
      onboarding: { wallet } as unknown as OnboardingService,
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

  it("reports readiness and Prometheus counters without authentication", async () => {
    const service = {
      snapshot: async () => ({
        generatedAt: "2026-07-14T12:00:00.000Z",
        preflight: { status: "pass" },
      }),
      synchronize: async () => ({}),
    };
    const server = createServer({
      service,
      authToken: "test-operator-token-with-32-chars",
      logger: false,
    });
    servers.push(server);

    expect((await server.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
    const metrics = await server.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("sidekick_http_requests_total");
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

  it("classifies transient, content, malformed, and unexpected operator failures", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: async () => ({}),
      summary: vi
        .fn()
        .mockRejectedValueOnce(retryableWalletIntentAnchorError())
        .mockRejectedValueOnce(new Error("must-not-leak")),
      synchronize: async () => reconciliationResult(),
      updateSettings: vi.fn().mockRejectedValue(new RateLimitedError("limited", 3_000)),
      poolCard: vi.fn().mockRejectedValue(new UpstreamSchemaError("bad upstream body")),
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

    const invalidContent = await server.inject({
      method: "POST",
      url: "/api/v1/pool-card/generate",
      headers,
      payload: { mode: "live" },
    });
    expect([invalidContent.statusCode, invalidContent.json()]).toEqual([
      502,
      {
        error: "upstream_response_invalid",
        message:
          "A configured chain source returned data Sidekick could not validate. Check source compatibility before retrying.",
        retryable: false,
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
          url: "/api/v1/pool?offset=100&limit=50&query=SP2JX",
          headers,
        })
      ).json(),
    ).toMatchObject({ total: 500, offset: 100, limit: 50 });
    expect(service.poolPage).toHaveBeenCalledWith({ offset: 100, limit: 50, query: "SP2JX" });

    await server.inject({
      method: "GET",
      url: "/api/v1/pool/history?offset=25&limit=25",
      headers,
    });
    expect(service.poolHistory).toHaveBeenCalledWith({ offset: 25, limit: 25 });

    await server.inject({
      method: "GET",
      url: "/api/v1/rewards?offset=50&limit=50",
      headers,
    });
    expect(service.rewardsPage).toHaveBeenCalledWith({ offset: 50, limit: 50 });

    await server.inject({
      method: "GET",
      url: "/api/v1/rewards/history?offset=25&limit=25",
      headers,
    });
    expect(service.rewardsHistory).toHaveBeenCalledWith({ offset: 25, limit: 25 });

    await server.inject({
      method: "GET",
      url: "/api/v1/activity?claimOffset=150&claimLimit=50&rewardCycle=141&withdrawalOffset=20&withdrawalLimit=20&withdrawalState=pending",
      headers,
    });
    expect(service.activity).toHaveBeenCalledWith({
      claimOffset: 150,
      claimLimit: 50,
      rewardCycle: "141",
      withdrawalOffset: 20,
      withdrawalLimit: 20,
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
          url: "/api/v1/activity?withdrawalState=unknown",
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/api/v1/activity?rewardCycle=abc",
          headers,
        })
      ).statusCode,
    ).toBe(400);
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
        setup: { status: "ready" },
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
      status: "blocked",
      checks: [
        { id: "control-plane", status: "ready" },
        { id: "setup", status: "ready" },
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

  it("validates authenticated runtime settings and pool-card actions", async () => {
    const token = "test-operator-token-with-32-chars";
    const service = {
      snapshot: async () => ({ generatedAt: "2026-07-15T12:00:00.000Z" }),
      synchronize: async () => ({}),
      settings: vi.fn().mockReturnValue({ revision: 2, dataSources: { apiKeyConfigured: true } }),
      updateSettings: vi.fn().mockReturnValue({ revision: 3 }),
      poolCard: vi.fn().mockResolvedValue({
        mode: "live",
        filename: "signer-sidekick-pool.html",
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html>",
      }),
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

    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/pool-card/generate",
          headers,
          payload: { mode: "live" },
        })
      ).json(),
    ).toMatchObject({ filename: "signer-sidekick-pool.html" });
    // Absent means off: a public money-moving form is never opt-out.
    expect(service.poolCard).toHaveBeenCalledWith("live", {
      includeStakingForm: false,
      l1MaxFeeSats: null,
    });

    await server.inject({
      method: "POST",
      url: "/api/v1/pool-card/generate",
      headers,
      payload: { mode: "live", includeStakingForm: true, l1MaxFeeSats: 12_500 },
    });
    expect(service.poolCard).toHaveBeenLastCalledWith("live", {
      includeStakingForm: true,
      l1MaxFeeSats: 12_500,
    });

    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/pool-card/generate",
          headers,
          payload: { mode: "live", l1MaxFeeSats: -1 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/pool-card/generate",
          headers,
          payload: { mode: "dynamic" },
        })
      ).statusCode,
    ).toBe(400);
  });
});
