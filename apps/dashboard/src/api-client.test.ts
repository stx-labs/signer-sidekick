import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  AUTH_REJECTED_EVENT,
  apiDownload,
  apiJson,
  apiJsonOrUnavailable,
  type ResponseSchema,
} from "./api-client.js";

const token = "test-operator-token-with-32-chars";

function schema<T>(predicate: (value: unknown) => value is T): ResponseSchema<T> {
  return {
    safeParse(value) {
      return predicate(value)
        ? { success: true, data: value }
        : { success: false, error: { message: "invalid test response" } };
    },
  };
}

const unknownSchema = schema((value): value is unknown => value !== undefined);
const readySchema = schema(
  (value): value is { status: "ready" } =>
    typeof value === "object" && value !== null && "status" in value && value.status === "ready",
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("dashboard API client", () => {
  it("injects the bearer token and validates JSON responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ready" }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiJson(token, "/api/v1/status", readySchema)).resolves.toEqual({
      status: "ready",
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves browser-managed authentication when no bearer token is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ready" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiJson("", "/api/v1/status", readySchema)).resolves.toEqual({
      status: "ready",
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).has("authorization")).toBe(false);
  });

  it("clears rejected credentials and emits the shared logout event", async () => {
    const removeItem = vi.fn();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("sessionStorage", { removeItem });
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const failure = await apiJson(token, "/api/v1/status", unknownSchema).catch((error) => error);
    expect(failure).toMatchObject({
      name: "ApiRequestError",
      kind: "authentication",
      status: 401,
      code: "unauthorized",
    });
    expect(removeItem).toHaveBeenCalledWith("sidekick-token");
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: AUTH_REJECTED_EVENT }),
    );
  });

  it("returns typed non-2xx errors and rejects invalid successful content", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: "invalid_query",
              message: "The requested page is outside the available range.",
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 42 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    );

    await expect(apiJson(token, "/api/v1/pool", unknownSchema)).rejects.toMatchObject({
      message: "Request failed: The requested page is outside the available range.",
      kind: "http",
      status: 400,
      code: "invalid_query",
    });
    await expect(apiJson(token, "/api/v1/status", readySchema)).rejects.toMatchObject({
      kind: "content",
      status: 200,
    });
  });

  it("preserves retryable chain-source details from an HTTP failure", async () => {
    const mismatch = {
      error: "wallet_intent_anchor_mismatch",
      retryable: true,
      node: { stacksTipHeight: 28_079, burnBlockHeight: 4_818 },
      api: { stacksTipHeight: 28_097, burnBlockHeight: 4_819 },
      poxBurnBlockHeight: 4_819,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mismatch), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(apiJson(token, "/api/v1/wallet-intents", unknownSchema)).rejects.toMatchObject({
      kind: "http",
      status: 503,
      code: "wallet_intent_anchor_mismatch",
      body: mismatch,
    });
  });

  it("maps only HTTP 501 to an unavailable optional surface", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "engine_not_implemented" }), {
            status: 501,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "engine_unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
        ),
    );

    await expect(apiJsonOrUnavailable(token, "/api/v1/engine", unknownSchema)).resolves.toBeNull();
    await expect(
      apiJsonOrUnavailable(token, "/api/v1/engine", unknownSchema),
    ).rejects.toMatchObject({ kind: "http", status: 503, code: "engine_unavailable" });
  });

  it("honors caller cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }),
    );
    const controller = new AbortController();
    const request = apiJson(token, "/api/v1/status", unknownSchema, {
      signal: controller.signal,
    });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports transport timeouts with the method and endpoint", async () => {
    const timeout = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout.reason));

    await expect(
      apiJson(token, "/api/v1/settings?include=audit", unknownSchema, {
        method: "PUT",
        body: "{}",
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({
      name: "ApiRequestError",
      kind: "transport",
      status: null,
      message: "Sidekick timed out during PUT /api/v1/settings.",
    });
  });

  it("reports an unreachable Sidekick without exposing the browser fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(apiJson(token, "/api/v1/status", unknownSchema)).rejects.toMatchObject({
      name: "ApiRequestError",
      kind: "transport",
      status: null,
      message: "Could not reach Sidekick during GET /api/v1/status. Check that it is running.",
    });
  });

  it("never saves a non-2xx download response", async () => {
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "artifact_not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      apiDownload(token, "/api/v1/support-bundle", {
        expectedContentTypes: ["application/json"],
        fallbackFilename: "sidekick-support.json",
      }),
    ).rejects.toMatchObject({ kind: "http", status: 404, code: "artifact_not_found" });
    expect(createElement).not.toHaveBeenCalled();
  });

  it("validates download media type and uses a sanitized server filename", async () => {
    const click = vi.fn();
    const anchor = { href: "", download: "", click };
    const createObjectURL = vi.fn().mockReturnValue("blob:artifact");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("document", { createElement: vi.fn().mockReturnValue(anchor) });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("staker_principal\nSP123", {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="../roster.csv"',
          },
        }),
      ),
    );

    await apiDownload(token, "/api/v1/pool/roster.csv", {
      expectedContentTypes: ["text/csv"],
      fallbackFilename: "signer-sidekick-roster.csv",
    });
    expect(anchor.download).toBe("roster.csv");
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:artifact");
  });

  it("exposes typed API errors", () => {
    expect(
      new ApiRequestError("failed", { kind: "http", status: 503, code: "unavailable" }),
    ).toMatchObject({ kind: "http", status: 503, code: "unavailable" });
  });
});
