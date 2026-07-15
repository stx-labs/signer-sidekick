import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";

const servers: ReturnType<typeof createServer>[] = [];

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
      protocol: {
        stacksCoreTag: "4.0.0",
        stacksCoreCommit: "5595f08a244362cefc316f95b398510a2b8cb791",
      },
    });
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
  });
});
