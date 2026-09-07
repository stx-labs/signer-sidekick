import { afterEach, describe, expect, it, vi } from "vitest";
import { StacksApiClient } from "./chain-clients.js";
import { PrometheusText, parsePrometheusText } from "./prometheus-text.js";
import { UpstreamRequestMetrics, upstreamRequestMetrics } from "./upstream-request-metrics.js";

afterEach(() => vi.restoreAllMocks());

describe("upstream request accounting", () => {
  it("normalizes routes and strips secrets and variable identifiers from labels", () => {
    const metrics = new UpstreamRequestMetrics();
    metrics.record(
      "https://user:secret@api.example.test/proxy/extended/v3/transactions/private-tx/events?api-key=secret",
      "GET",
      200,
    );
    metrics.record(
      "https://api.example.test/extended/v3/transactions/another-tx/events",
      "GET",
      200,
    );
    metrics.record("https://api.example.test/private-secret-path?token=secret", "GET", 429);
    const text = new PrometheusText();
    text.counter("sidekick_upstream_requests_total", "Test", metrics.samples());
    const rendered = text.render();
    expect(rendered).not.toContain("secret");
    expect(rendered).not.toContain("private-tx");
    const samples = parsePrometheusText(rendered);
    expect(samples).toContainEqual({
      name: "sidekick_upstream_requests_total",
      labels: {
        origin: "https://api.example.test",
        route: "/extended/v3/transactions/:txid/events",
        method: "GET",
        status: "200",
      },
      value: 2,
    });
  });

  it("bounds cardinality while retaining total attempt counts", () => {
    const metrics = new UpstreamRequestMetrics();
    for (let index = 0; index < 1_000; index += 1)
      metrics.record(`http://host-${index}.test/v2/info`, "GET", null);
    expect(metrics.samples()).toHaveLength(513);
    expect(metrics.samples().reduce((sum, [, value]) => sum + value, 0)).toBe(1_000);
  });

  it("counts retries at the chain transport boundary, without caching strict status reads", async () => {
    const record = vi.spyOn(upstreamRequestMetrics, "record");
    const status = {
      server_version: "api",
      status: "ready",
      chain_tip: {
        block_height: 1,
        burn_block_height: 1,
        block_hash: `0x${"11".repeat(32)}`,
        index_block_hash: `0x${"22".repeat(32)}`,
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "0" } }))
      .mockImplementation(async () => Response.json(status));
    const api = new StacksApiClient("https://api.example.test", "secret", "x-api-key", fetchImpl);
    await api.getStatus();
    await api.getStatus();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(record.mock.calls.map(([, , code]) => code)).toEqual([429, 200, 200]);
  });

  it("counts a cancelled in-flight attempt as no_response", async () => {
    const record = vi.spyOn(upstreamRequestMetrics, "record");
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    const api = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);
    await expect(api.getStatus({ signal: controller.signal })).rejects.toThrow();
    expect(record).toHaveBeenCalledExactlyOnceWith(
      "https://api.example.test/extended/v1/status",
      "GET",
      null,
    );
  });
});
