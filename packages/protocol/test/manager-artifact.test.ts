import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAINNET_REFERENCE_MANAGER } from "../src/known-managers.js";
import {
  generateManagerArtifact,
  UPSTREAM_POX5,
  UPSTREAM_SBTC_DEPLOYER,
} from "../src/manager-artifact.js";
import { parseManagerProfile } from "../src/profile.js";

const root = resolve(import.meta.dirname, "../../..");

describe("reference manager artifact generation", () => {
  it("generates the pinned mainnet artifact with exact replacement counts", async () => {
    const source = await readFile(
      resolve(root, "contracts/reference-manager/upstream/signer-manager.clar"),
      "utf8",
    );
    const profile = parseManagerProfile(
      JSON.parse(
        await readFile(resolve(root, "contracts/reference-manager/profiles/mainnet.json"), "utf8"),
      ),
    );
    const generatedMetadata = JSON.parse(
      await readFile(
        resolve(root, "contracts/reference-manager/generated/mainnet/signer-manager.metadata.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;

    const artifact = generateManagerArtifact(source, profile);

    expect(artifact.metadata.replacements).toEqual({ pox5: 8, sbtcDeployer: 13 });
    expect(artifact.metadata.outputSha256).toBe(
      "c0a2cc8e83de2b1bc60e07c5e0f5da8991c6f79eb05d077bba8cb984eee226b3",
    );
    expect(artifact.metadata.canonicalOutputSha256).toBe(
      "7fd58a7591ff0ae1643eb7e71ea2867385bcac237a3ea819f52301310c0d2e27",
    );
    expect(MAINNET_REFERENCE_MANAGER.profile).toEqual(profile);
    expect(MAINNET_REFERENCE_MANAGER.sourceSha256).toBe(generatedMetadata.outputSha256);
    expect(MAINNET_REFERENCE_MANAGER.canonicalSha256).toBe(generatedMetadata.canonicalOutputSha256);
    expect(artifact.source).toContain("SP000000000000000000002Q6VF78.pox-5");
    expect(artifact.source).not.toContain(UPSTREAM_POX5);
    expect(artifact.metadata.productionApproved).toBe(false);
  });

  it("rejects a modified upstream source", async () => {
    const source = await readFile(
      resolve(root, "contracts/reference-manager/upstream/signer-manager.clar"),
      "utf8",
    );
    const profile = parseManagerProfile(
      JSON.parse(
        await readFile(resolve(root, "contracts/reference-manager/profiles/mainnet.json"), "utf8"),
      ),
    );

    expect(() => generateManagerArtifact(`${source}\n;; modified`, profile)).toThrow(
      "source hash mismatch",
    );
  });

  it("substitutes a non-identity sBTC deployer in a synthetic non-production profile", () => {
    const source = `(define-constant pox '${UPSTREAM_POX5})\n(define-constant sbtc '${UPSTREAM_SBTC_DEPLOYER})\n`;
    const profile = parseManagerProfile({
      id: "synthetic-mainnet",
      network: "mainnet",
      upstream: {
        tag: "test",
        commit: "0".repeat(40),
        sourceSha256: createHash("sha256").update(source).digest("hex"),
      },
      contracts: {
        pox5: "SP000000000000000000002Q6VF78.pox-5",
        sbtcDeployer: "SP000000000000000000002Q6VF78",
      },
      expectedReplacements: { pox5: 1, sbtcDeployer: 1 },
      productionApproved: false,
    });

    const artifact = generateManagerArtifact(source, profile);
    expect(artifact.source).toContain("'SP000000000000000000002Q6VF78)");
    expect(artifact.source).not.toContain(UPSTREAM_SBTC_DEPLOYER);
  });

  it("rejects a profile whose PoX-5 boot contract does not match its network", () => {
    expect(() =>
      parseManagerProfile({
        id: "wrong-network",
        network: "mainnet",
        upstream: { tag: "test", commit: "0".repeat(40), sourceSha256: "0".repeat(64) },
        contracts: {
          pox5: "ST000000000000000000002AMW42H.pox-5",
          sbtcDeployer: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4",
        },
        expectedReplacements: { pox5: 1, sbtcDeployer: 1 },
        productionApproved: false,
      }),
    ).toThrow("canonical mainnet PoX-5 boot contract");
  });
});
