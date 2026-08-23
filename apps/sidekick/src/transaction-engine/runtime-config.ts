import { isAbsolute } from "node:path";
import { compressPublicKey, getAddressFromPublicKey } from "@stacks/transactions";
import { validatePrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import type { SidekickNetwork } from "../config.js";

/** Engine execution modes. `assist` was retired by ADR 0010 in favour of `operator-run`. */
export type TransactionEngineMode = "observe" | "operator-run";

export interface TransactionEngineRuntimeConfig {
  requestedMode: TransactionEngineMode;
  gasPayer: null | {
    principal: string;
    publicKey: string;
    secretFilePath: string | null;
  };
  finalityDepth: number;
  maximumFeeUstx: bigint;
  maximumApprovalMinutes: number;
  maximumRunHours: number;
  maximumRunTransactions: number;
}

const compressedPublicKeySchema = z
  .string()
  .regex(/^(02|03)[0-9a-f]{64}$/i)
  .transform((value) => value.toLowerCase())
  .refine((value) => {
    try {
      return compressPublicKey(value).toLowerCase() === value;
    } catch {
      return false;
    }
  }, "Gas-payer public key must be a compressed secp256k1 public key");

function optionalValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function absoluteFilePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute file path`);
  return value;
}

/**
 * Parse only public engine policy and secret *paths*. Private material is deliberately rejected by
 * the main configuration loader and is never accepted through environment values.
 */
export function loadTransactionEngineRuntimeConfig(
  env: NodeJS.ProcessEnv,
  network: SidekickNetwork,
): TransactionEngineRuntimeConfig {
  const requestedModeValue = z
    .enum(["observe", "operator-run", "assist"])
    .default("observe")
    .parse(optionalValue(env, "SIDEKICK_ENGINE_MODE") ?? undefined);
  if (requestedModeValue === "assist") {
    // ADR 0010 retired the attestation-gated Assist mode. Operator-run needs no issuer attestation:
    // the gas wallet signs only inside a sealed recipe the operator approved per run.
    throw new Error(
      "SIDEKICK_ENGINE_MODE=assist is retired; use SIDEKICK_ENGINE_MODE=operator-run (see ADR 0010)",
    );
  }
  const requestedMode: TransactionEngineMode = requestedModeValue;
  const principal = optionalValue(env, "SIDEKICK_GAS_PAYER_PRINCIPAL");
  const publicKeyValue = optionalValue(env, "SIDEKICK_GAS_PAYER_PUBLIC_KEY");
  const secretFileValue = optionalValue(env, "SIDEKICK_GAS_PAYER_SECRET_FILE");
  if ((principal === null) !== (publicKeyValue === null)) {
    throw new Error("Gas-payer principal and public key must be configured together");
  }

  let gasPayer: TransactionEngineRuntimeConfig["gasPayer"] = null;
  if (principal !== null && publicKeyValue !== null) {
    if (!validatePrincipal(principal) || principal.includes(".")) {
      throw new Error("Gas-payer principal must be a valid standard Stacks principal");
    }
    const publicKey = compressedPublicKeySchema.parse(publicKeyValue);
    const transactionNetwork = network === "mainnet" ? "mainnet" : "testnet";
    if (getAddressFromPublicKey(publicKey, transactionNetwork) !== principal) {
      throw new Error("Gas-payer public key does not match the configured principal and network");
    }
    gasPayer = {
      principal,
      publicKey,
      secretFilePath:
        secretFileValue === null
          ? null
          : absoluteFilePath(secretFileValue, "SIDEKICK_GAS_PAYER_SECRET_FILE"),
    };
  } else if (secretFileValue !== null) {
    throw new Error("Gas-payer secret path requires the matching public identity");
  }

  if (
    optionalValue(env, "SIDEKICK_COMPATIBILITY_ATTESTATION_FILE") !== null ||
    optionalValue(env, "SIDEKICK_COMPATIBILITY_TRUST_KEYS_FILE") !== null
  ) {
    // The attestation-gated Assist path is retired (ADR 0010); refuse stale configuration rather
    // than silently ignoring files an operator believes are in force.
    throw new Error(
      "Compatibility attestation files are no longer used; remove SIDEKICK_COMPATIBILITY_ATTESTATION_FILE and SIDEKICK_COMPATIBILITY_TRUST_KEYS_FILE",
    );
  }

  return {
    requestedMode,
    gasPayer,
    finalityDepth: z.coerce
      .number()
      .int()
      .min(1)
      .max(144)
      .default(6)
      .parse(env.SIDEKICK_ENGINE_FINALITY_DEPTH),
    maximumFeeUstx: BigInt(
      z
        .string()
        .regex(/^[1-9]\d*$/)
        .refine((value) => BigInt(value) <= 10_000_000n, "Engine fee cap is too large")
        .default("100000")
        .parse(env.SIDEKICK_ENGINE_MAXIMUM_FEE_USTX),
    ),
    maximumApprovalMinutes: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(30)
      .parse(env.SIDEKICK_ENGINE_RUN_START_MINUTES ?? env.SIDEKICK_ENGINE_MAX_APPROVAL_MINUTES),
    maximumRunHours: z.coerce
      .number()
      .int()
      .min(1)
      .max(24)
      .default(6)
      .parse(env.SIDEKICK_ENGINE_MAX_RUN_HOURS),
    maximumRunTransactions: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(200)
      .parse(env.SIDEKICK_ENGINE_MAX_RUN_TRANSACTIONS),
  };
}
