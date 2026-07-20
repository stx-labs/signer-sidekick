import { isAbsolute } from "node:path";
import { compressPublicKey, getAddressFromPublicKey } from "@stacks/transactions";
import { validatePrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import type { SidekickNetwork } from "../config.js";

export type TransactionEngineMode = "observe" | "assist";

export interface TransactionEngineRuntimeConfig {
  requestedMode: TransactionEngineMode;
  gasPayer: null | {
    principal: string;
    publicKey: string;
    secretFilePath: string | null;
  };
  attestation: null | {
    documentFilePath: string;
    trustKeysFilePath: string;
  };
  finalityDepth: number;
  maximumFeeUstx: bigint;
  maximumApprovalMinutes: number;
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
  const requestedMode = z
    .enum(["observe", "assist"])
    .default("observe")
    .parse(optionalValue(env, "SIDEKICK_ENGINE_MODE") ?? undefined);
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

  const attestationFile = optionalValue(env, "SIDEKICK_COMPATIBILITY_ATTESTATION_FILE");
  const trustKeysFile = optionalValue(env, "SIDEKICK_COMPATIBILITY_TRUST_KEYS_FILE");
  if ((attestationFile === null) !== (trustKeysFile === null)) {
    throw new Error("Compatibility attestation and trust-key files must be configured together");
  }
  const attestation =
    attestationFile === null || trustKeysFile === null
      ? null
      : {
          documentFilePath: absoluteFilePath(
            attestationFile,
            "SIDEKICK_COMPATIBILITY_ATTESTATION_FILE",
          ),
          trustKeysFilePath: absoluteFilePath(
            trustKeysFile,
            "SIDEKICK_COMPATIBILITY_TRUST_KEYS_FILE",
          ),
        };

  if (requestedMode === "assist") {
    if (!gasPayer?.secretFilePath) {
      throw new Error("Assist mode requires a dedicated gas-payer secret file and public identity");
    }
    if (!attestation) {
      throw new Error("Assist mode requires compatibility attestation and trust-key files");
    }
  }

  return {
    requestedMode,
    gasPayer,
    attestation,
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
      .parse(env.SIDEKICK_ENGINE_MAX_APPROVAL_MINUTES),
  };
}
