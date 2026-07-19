import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingService } from "./onboarding-service.js";
import { createServer, type TransactionEngineApiService } from "./server.js";
import { TransactionEngineApiServiceError } from "./transaction-engine/api-service.js";

const servers: ReturnType<typeof createServer>[] = [];
const walletIntentPrefixes = [
  "/api/v1/onboarding/wallet-intents",
  "/api/v1/wallet-intents",
] as const;

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
        stacksCoreTag: "4.0.0",
        stacksCoreCommit: "5595f08a244362cefc316f95b398510a2b8cb791",
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
      { error: "wallet_intent_not_found" },
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
      { error: "invalid_wallet_intent_submission" },
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
      { error: "invalid_wallet_intent_refresh" },
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
      { error: "invalid_wallet_intent_replacement" },
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
    expect(response.json()).toEqual({ error: "transaction_engine_unavailable" });
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
    expect(response.json()).toEqual({ error: "internal_server_error" });
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
    expect(conflicted.json()).toEqual({ error: "engine_state_conflict" });
    expect(conflicted.body).not.toContain("must-not-leak");

    const missing = await server.inject({ method: "GET", url: "/api/v1/engine", headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "engine_job_not_found" });
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
    expect(service.poolCard).toHaveBeenCalledWith("live");
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
