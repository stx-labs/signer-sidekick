import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compressPublicKey,
  getAddressFromPublicKey,
  privateKeyToPublic,
} from "@stacks/transactions";
import { afterEach, describe, expect, it } from "vitest";
import { loadTransactionEngineRuntimeConfig } from "./runtime-config.js";

const privateKey = "11".repeat(32);
const publicKey = compressPublicKey(privateKeyToPublic(privateKey));
const principal = getAddressFromPublicKey(publicKey, "testnet");
const reviewDirectories: string[] = [];

afterEach(() => {
  for (const directory of reviewDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function reviewedBuildEnvironment(status: "pending" | "approved" = "approved") {
  const directory = mkdtempSync(join(tmpdir(), "sidekick-reviewed-build-"));
  reviewDirectories.push(directory);
  const sourceFingerprint = "ab".repeat(32);
  const sourceFingerprintPath = join(directory, "SOURCE_FINGERPRINT");
  const reviewPath = join(directory, "review.json");
  writeFileSync(sourceFingerprintPath, sourceFingerprint);
  writeFileSync(
    reviewPath,
    JSON.stringify({
      schemaVersion: 1,
      status,
      sourceFingerprint,
      reviewedCommit: status === "approved" ? "12".repeat(20) : null,
      reviewedAt: status === "approved" ? "2026-08-22T20:00:00.000Z" : null,
      reviewer: status === "approved" ? "independent-reviewer" : null,
      reviewUrl:
        status === "approved" ? "https://github.com/stx-labs/signer-sidekick/pull/34" : null,
    }),
  );
  return {
    SIDEKICK_OPERATOR_RUN_REVIEW_PATH: reviewPath,
    SIDEKICK_SOURCE_FINGERPRINT_PATH: sourceFingerprintPath,
  };
}

function operatorRunEnvironment(): NodeJS.ProcessEnv {
  return {
    SIDEKICK_ENGINE_MODE: "operator-run",
    SIDEKICK_GAS_PAYER_PRINCIPAL: principal,
    SIDEKICK_GAS_PAYER_PUBLIC_KEY: publicKey,
    SIDEKICK_GAS_PAYER_SECRET_FILE: "/run/secrets/sidekick-gas-payer",
  };
}

describe("transaction-engine runtime config", () => {
  it("defaults to Observe without introducing a signer dependency", () => {
    expect(loadTransactionEngineRuntimeConfig({}, "mainnet")).toEqual({
      requestedMode: "observe",
      gasPayer: null,
      finalityDepth: 6,
      maximumFeeUstx: 100_000n,
      runStartWindowMinutes: 30,
      maximumRunHours: 6,
      maximumRunTransactions: 200,
    });
  });

  it("bounds the absolute per-attempt fee cap", () => {
    expect(
      loadTransactionEngineRuntimeConfig({ SIDEKICK_ENGINE_MAXIMUM_FEE_USTX: "250000" }, "testnet")
        .maximumFeeUstx,
    ).toBe(250_000n);
    expect(() =>
      loadTransactionEngineRuntimeConfig(
        { SIDEKICK_ENGINE_MAXIMUM_FEE_USTX: "10000001" },
        "testnet",
      ),
    ).toThrow("Engine fee cap is too large");
  });

  it("accepts a matching public gas identity and secret path for operator-run", () => {
    expect(loadTransactionEngineRuntimeConfig(operatorRunEnvironment(), "regtest")).toMatchObject({
      requestedMode: "operator-run",
      gasPayer: {
        principal,
        publicKey: publicKey.toLowerCase(),
        secretFilePath: "/run/secrets/sidekick-gas-payer",
      },
    });
  });

  it("starts operator-run without a gas payer so the wallet can be generated later", () => {
    expect(
      loadTransactionEngineRuntimeConfig({ SIDEKICK_ENGINE_MODE: "operator-run" }, "testnet"),
    ).toMatchObject({ requestedMode: "operator-run", gasPayer: null });
  });

  it("requires an exact approved build for mainnet operator-run only", () => {
    expect(() =>
      loadTransactionEngineRuntimeConfig(
        { SIDEKICK_ENGINE_MODE: "operator-run", ...reviewedBuildEnvironment() },
        "mainnet",
      ),
    ).not.toThrow();
    expect(() =>
      loadTransactionEngineRuntimeConfig({ SIDEKICK_ENGINE_MODE: "operator-run" }, "mainnet"),
    ).toThrow("requires an approved security-reviewed build");
    expect(() =>
      loadTransactionEngineRuntimeConfig(
        { SIDEKICK_ENGINE_MODE: "operator-run", ...reviewedBuildEnvironment("pending") },
        "mainnet",
      ),
    ).toThrow("security review is pending");
  });

  it("permits Observe planning with a public identity and no private-key path", () => {
    expect(
      loadTransactionEngineRuntimeConfig(
        {
          SIDEKICK_GAS_PAYER_PRINCIPAL: principal,
          SIDEKICK_GAS_PAYER_PUBLIC_KEY: publicKey,
        },
        "testnet",
      ).gasPayer,
    ).toEqual({ principal, publicKey: publicKey.toLowerCase(), secretFilePath: null });
  });

  it.each([
    [{ SIDEKICK_ENGINE_MODE: "assist" }, "SIDEKICK_ENGINE_MODE=assist is retired"],
    [
      {
        SIDEKICK_ENGINE_MODE: "operator-run",
        SIDEKICK_COMPATIBILITY_ATTESTATION_FILE: "/etc/sidekick/compatibility.json",
        SIDEKICK_COMPATIBILITY_TRUST_KEYS_FILE: "/etc/sidekick/attestation-keys.json",
      },
      "Compatibility attestation files are no longer used",
    ],
    [
      { SIDEKICK_GAS_PAYER_PRINCIPAL: principal },
      "principal and public key must be configured together",
    ],
    [
      {
        SIDEKICK_GAS_PAYER_PRINCIPAL: principal,
        SIDEKICK_GAS_PAYER_PUBLIC_KEY: publicKey,
        SIDEKICK_GAS_PAYER_SECRET_FILE: "relative-secret",
      },
      "must be an absolute file path",
    ],
    [
      { SIDEKICK_COMPATIBILITY_ATTESTATION_FILE: "/tmp/attestation.json" },
      "Compatibility attestation files are no longer used",
    ],
  ])("fails closed for partial or unsafe configuration", (environment, message) => {
    expect(() => loadTransactionEngineRuntimeConfig(environment, "testnet")).toThrow(message);
  });
});
