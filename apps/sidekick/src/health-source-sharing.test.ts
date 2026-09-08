import { afterEach, describe, expect, it, vi } from "vitest";
import { readBackgroundApiHealth, readBackgroundApiStatus } from "./background-api-health.js";
import { RateLimitedError, StacksApiClient } from "./chain-clients.js";
import { indexedApiMatchesReference, type SidekickConfig } from "./config.js";
import { fetchHealthSource } from "./health-http.js";
import { collectHealthObservation } from "./health-monitoring-sources.js";

vi.mock("./health-http.js", async (original) => ({
  ...(await original<typeof import("./health-http.js")>()),
  fetchHealthSource: vi.fn(),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
const status = {
  server_version: "test",
  status: "ready",
  chain_tip: {
    block_height: 200,
    burn_block_height: 100,
    block_hash: `0x${"11".repeat(32)}`,
    index_block_hash: `0x${"22".repeat(32)}`,
  },
};
const config: SidekickConfig = {
  network: "mainnet",
  nodeRpcUrl: "http://node.invalid",
  apiUrl: "https://api.invalid",
  hiroReferenceApiUrl: "https://api.invalid",
  apiKeyHeader: "x-api-key",
  hiroReferenceApiKeyHeader: "x-api-key",
  maxApiBurnBlockLag: 12,
  forecastHorizonCycles: 6,
  stakerPageLimit: 200,
  eventPageLimit: 100,
  databasePath: ":memory:",
};

describe("compatible upstream status reads", () => {
  it.each([
    [{}, true],
    [{ hiroReferenceApiUrl: "https://api.invalid/other-path" }, false],
    [{ apiKey: "one", apiKeyOrigin: "https://api.invalid" }, true], // reference inherits the same origin-bound key
    [
      {
        apiKey: "one",
        apiKeyOrigin: "https://api.invalid",
        hiroReferenceApiKey: "one",
        hiroReferenceApiKeyOrigin: "https://api.invalid",
      },
      true,
    ],
    [
      {
        apiKey: "one",
        apiKeyOrigin: "https://api.invalid",
        hiroReferenceApiKey: "two",
        hiroReferenceApiKeyOrigin: "https://api.invalid",
      },
      false,
    ],
  ] as const)("matches complete endpoint/credential identity %j", (changes, expected) => {
    expect(indexedApiMatchesReference({ ...config, ...changes })).toBe(expected);
  });

  it("shares same-role status without rejuvenating its checked time or adding a status HTTP read", async () => {
    vi.mocked(fetchHealthSource).mockImplementation(async (url) => ({
      body: JSON.stringify(
        url.endsWith("/v2/info")
          ? { network_id: 1, burn_block_height: 100, stacks_tip_height: 200 }
          : {
              difference_from_max_peer: 0,
              max_stacks_height_of_neighbors: 200,
              node_stacks_tip_height: 200,
            },
      ),
      contentType: "application/json",
      latencyMs: 1,
      status: 200,
    }));
    const read = vi.fn(async () => ({ value: status, checkedAt: "2026-09-08T12:00:00.000Z" }));
    const result = await collectHealthObservation(config, "2026-09-08T12:00:20.000Z", {
      getIndexedApiStatus: read,
    });
    expect(read).toHaveBeenCalledOnce();
    expect(fetchHealthSource).toHaveBeenCalledTimes(2);
    expect(result.hiroSource?.checkedAt).toBe("2026-09-08T12:00:00.000Z");
    expect(result.hiro).toMatchObject({ status: status.status, chain_tip: { block_height: 200 } });
    expect(result.configuredApi).toBeNull(); // same physical source, not another witness
  });

  it("uses one physical attempt for a failed advisory read, not nested client retries", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 429, headers: { "retry-after": "0" } }),
    );
    const api = new StacksApiClient("https://rate-limit.invalid", undefined, "x-api-key", fetch);
    await expect(readBackgroundApiStatus(api)).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("budgets 120 status plus 120 info requests/hour across concurrent regular/comparison consumers", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async (input) =>
        new Response(
          JSON.stringify(
            String(input).endsWith("/v2/info")
              ? { network_id: 1, burn_block_height: 100, stacks_tip_height: 200 }
              : status,
          ),
        ),
    );
    const api = new StacksApiClient("https://budget.invalid", undefined, "x-api-key", fetch);
    for (let second = 0; second < 3600; second += 5) {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 8) + second * 1000));
      await Promise.all([
        readBackgroundApiStatus(api),
        readBackgroundApiStatus(api),
        readBackgroundApiHealth(api, new AbortController().signal),
      ]);
    }
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("/extended/v1/status")),
    ).toHaveLength(120);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/v2/info"))).toHaveLength(120);
  });
});
