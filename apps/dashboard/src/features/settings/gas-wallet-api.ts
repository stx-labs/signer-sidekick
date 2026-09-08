import {
  type GasWalletStatus,
  type GasWalletSweep,
  gasWalletStatusSchema,
  gasWalletSweepSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { apiJson, apiJsonOrUnavailable } from "../../api-client.js";

const base = "/api/v1/settings/gas-wallet";
const cacheKey = "signer-sidekick:gas-wallet-status:v2";
type CacheContext = { token: string; scope: string | null };
let context: CacheContext | null = null;
let memoryCache: GasWalletStatus | null | undefined;
let statusInFlight: Promise<GasWalletStatus | null> | null = null;

function selectContext(token: string, scope: string | null): CacheContext {
  if (context?.token === token && context.scope === scope) return context;
  context = { token, scope };
  memoryCache = undefined;
  statusInFlight = null;
  return context;
}

function readStoredStatus(expected: CacheContext): GasWalletStatus | null | undefined {
  if (!expected.scope) return undefined;
  if (memoryCache !== undefined) return memoryCache;
  if (typeof sessionStorage === "undefined") return undefined;
  try {
    const raw = sessionStorage.getItem(cacheKey);
    if (raw === null) return undefined;
    const stored = JSON.parse(raw);
    if (stored.scope !== expected.scope) return undefined;
    const parsed = gasWalletStatusSchema.safeParse(stored.status);
    if (parsed.success) {
      memoryCache = parsed.data;
      return parsed.data;
    }
  } catch {
    // A stale browser cache is disposable; the live request below replaces it.
  }
  try {
    sessionStorage.removeItem(cacheKey);
  } catch {
    /* Storage is optional. */
  }
  return undefined;
}

function rememberStatus(
  status: GasWalletStatus | null,
  expected: CacheContext | null,
): GasWalletStatus | null {
  if (context !== expected || !expected?.scope) return status;
  memoryCache = status;
  if (typeof sessionStorage !== "undefined") {
    try {
      if (status === null) sessionStorage.removeItem(cacheKey);
      else sessionStorage.setItem(cacheKey, JSON.stringify({ scope: expected.scope, status }));
    } catch {
      /* Storage restrictions must not turn a successful read into a failure. */
    }
  }
  return status;
}

async function rememberMutation(
  token: string,
  request: Promise<GasWalletStatus>,
): Promise<GasWalletStatus> {
  const expected = context;
  const result = await request;
  if (expected && context === expected && expected.token === token) {
    // An older status read must not overwrite an acknowledged mutation.
    context = { ...expected };
    statusInFlight = null;
    rememberStatus(result, context);
  }
  return result;
}

/** Last verified public status for immediate rendering while the live request refreshes it. */
export function cachedGasWalletStatus(
  token: string,
  scope: string | null,
): GasWalletStatus | null | undefined {
  return readStoredStatus(selectContext(token, scope));
}

/** Public gas-wallet identity and lifecycle (plan S2). Returns null when the feature is not wired. */
export async function loadGasWalletStatus(
  token: string,
  signal?: AbortSignal,
  scope: string | null = null,
): Promise<GasWalletStatus | null> {
  signal?.throwIfAborted();
  const expected = selectContext(token, scope);
  if (!statusInFlight) {
    // This bounded read is shared; one component's cancellation cannot cancel another's read.
    const request = apiJsonOrUnavailable(token, base, gasWalletStatusSchema)
      .then((status) => rememberStatus(status, expected))
      .finally(() => {
        if (statusInFlight === request) statusInFlight = null;
      });
    statusInFlight = request;
  }
  const result = await statusInFlight;
  signal?.throwIfAborted();
  if (
    context !== expected &&
    context?.token === token &&
    context.scope === scope &&
    memoryCache !== undefined
  ) {
    return memoryCache;
  }
  return result;
}

export async function createGasWallet(token: string): Promise<GasWalletStatus> {
  return rememberMutation(token, apiJson(token, base, gasWalletStatusSchema, { method: "POST" }));
}

export async function enableGasWallet(token: string): Promise<GasWalletStatus> {
  return rememberMutation(
    token,
    apiJson(token, `${base}/enable`, gasWalletStatusSchema, { method: "POST" }),
  );
}

export async function disableGasWallet(token: string): Promise<GasWalletStatus> {
  return rememberMutation(
    token,
    apiJson(token, `${base}/disable`, gasWalletStatusSchema, { method: "POST" }),
  );
}

export async function dismissGasWalletBanner(
  token: string,
  kind: "setup" | "low-balance",
): Promise<GasWalletStatus> {
  return rememberMutation(
    token,
    apiJson(token, `${base}/dismiss-banner`, gasWalletStatusSchema, {
      method: "POST",
      body: JSON.stringify({ kind }),
    }),
  );
}

export async function prepareGasWalletSweep(
  token: string,
  recipient: string,
): Promise<GasWalletSweep> {
  return apiJson(token, `${base}/sweep`, gasWalletSweepSchema, {
    method: "POST",
    body: JSON.stringify({ recipient }),
  });
}

export async function approveGasWalletSweep(
  token: string,
  sweepId: string,
): Promise<GasWalletSweep> {
  return apiJson(
    token,
    `${base}/sweep/${encodeURIComponent(sweepId)}/approve`,
    gasWalletSweepSchema,
    {
      method: "POST",
    },
  );
}

export async function cancelGasWalletSweep(
  token: string,
  sweepId: string,
): Promise<GasWalletSweep> {
  return apiJson(
    token,
    `${base}/sweep/${encodeURIComponent(sweepId)}/cancel`,
    gasWalletSweepSchema,
    {
      method: "POST",
    },
  );
}

export async function refreshGasWalletSweep(
  token: string,
  sweepId: string,
  signal?: AbortSignal,
): Promise<GasWalletSweep> {
  return apiJson(
    token,
    `${base}/sweep/${encodeURIComponent(sweepId)}`,
    gasWalletSweepSchema,
    signal ? { signal } : {},
  );
}
