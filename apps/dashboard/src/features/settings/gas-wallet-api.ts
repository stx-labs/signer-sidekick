import {
  type GasWalletStatus,
  type GasWalletSweep,
  gasWalletStatusSchema,
  gasWalletSweepSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { apiJson, apiJsonOrUnavailable } from "../../api-client.js";

const base = "/api/v1/settings/gas-wallet";
const cacheKey = "signer-sidekick:gas-wallet-status:v1";
let memoryCache: GasWalletStatus | null | undefined;
let statusInFlight: Promise<GasWalletStatus | null> | null = null;

function readStoredStatus(): GasWalletStatus | null | undefined {
  if (memoryCache !== undefined) return memoryCache;
  if (typeof sessionStorage === "undefined") return undefined;
  try {
    const raw = sessionStorage.getItem(cacheKey);
    if (raw === null) return undefined;
    const parsed = gasWalletStatusSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      memoryCache = parsed.data;
      return parsed.data;
    }
  } catch {
    // A stale browser cache is disposable; the live request below replaces it.
  }
  sessionStorage.removeItem(cacheKey);
  return undefined;
}

function rememberStatus(status: GasWalletStatus | null): GasWalletStatus | null {
  memoryCache = status;
  if (typeof sessionStorage !== "undefined") {
    if (status === null) sessionStorage.removeItem(cacheKey);
    else sessionStorage.setItem(cacheKey, JSON.stringify(status));
  }
  return status;
}

function rememberAvailableStatus(status: GasWalletStatus): GasWalletStatus {
  rememberStatus(status);
  return status;
}

/** Last verified public status for immediate rendering while the live request refreshes it. */
export function cachedGasWalletStatus(): GasWalletStatus | null | undefined {
  return readStoredStatus();
}

/** Public gas-wallet identity and lifecycle (plan S2). Returns null when the feature is not wired. */
export async function loadGasWalletStatus(
  token: string,
  signal?: AbortSignal,
): Promise<GasWalletStatus | null> {
  if (statusInFlight && !signal) return await statusInFlight;
  const request = apiJsonOrUnavailable(
    token,
    base,
    gasWalletStatusSchema,
    signal ? { signal } : {},
  ).then(rememberStatus);
  if (!signal) {
    statusInFlight = request.finally(() => {
      statusInFlight = null;
    });
    return await statusInFlight;
  }
  return await request;
}

export async function createGasWallet(token: string): Promise<GasWalletStatus> {
  return rememberAvailableStatus(
    await apiJson(token, base, gasWalletStatusSchema, { method: "POST" }),
  );
}

export async function enableGasWallet(token: string): Promise<GasWalletStatus> {
  return rememberAvailableStatus(
    await apiJson(token, `${base}/enable`, gasWalletStatusSchema, { method: "POST" }),
  );
}

export async function disableGasWallet(token: string): Promise<GasWalletStatus> {
  return rememberAvailableStatus(
    await apiJson(token, `${base}/disable`, gasWalletStatusSchema, { method: "POST" }),
  );
}

export async function dismissGasWalletBanner(
  token: string,
  kind: "setup" | "low-balance",
): Promise<GasWalletStatus> {
  return rememberAvailableStatus(
    await apiJson(token, `${base}/dismiss-banner`, gasWalletStatusSchema, {
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
