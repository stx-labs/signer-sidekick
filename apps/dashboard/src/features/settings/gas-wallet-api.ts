import {
  type GasWalletStatus,
  type GasWalletSweep,
  gasWalletStatusSchema,
  gasWalletSweepSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { apiJson, apiJsonOrUnavailable } from "../../api-client.js";

const base = "/api/v1/settings/gas-wallet";

/** Public gas-wallet identity and lifecycle (plan S2). Returns null when the feature is not wired. */
export async function loadGasWalletStatus(
  token: string,
  signal?: AbortSignal,
): Promise<GasWalletStatus | null> {
  return apiJsonOrUnavailable(token, base, gasWalletStatusSchema, signal ? { signal } : {});
}

export async function createGasWallet(token: string): Promise<GasWalletStatus> {
  return apiJson(token, base, gasWalletStatusSchema, { method: "POST" });
}

export async function enableGasWallet(token: string): Promise<GasWalletStatus> {
  return apiJson(token, `${base}/enable`, gasWalletStatusSchema, { method: "POST" });
}

export async function disableGasWallet(token: string): Promise<GasWalletStatus> {
  return apiJson(token, `${base}/disable`, gasWalletStatusSchema, { method: "POST" });
}

export async function dismissGasWalletBanner(
  token: string,
  kind: "setup" | "low-balance",
): Promise<GasWalletStatus> {
  return apiJson(token, `${base}/dismiss-banner`, gasWalletStatusSchema, {
    method: "POST",
    body: JSON.stringify({ kind }),
  });
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
