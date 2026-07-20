import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { knownManagerArtifactsForNetwork } from "@stx-labs/signer-sidekick-protocol/known-managers";
import {
  canonicalizeClaritySource,
  claritySourceSha256,
} from "@stx-labs/signer-sidekick-protocol/manager-adapter";
import { generateManagerArtifact } from "@stx-labs/signer-sidekick-protocol/manager-artifact";
import type { NetworkCompatibilityProfile } from "@stx-labs/signer-sidekick-protocol/network-compatibility";
import { managerArtifactFromNetworkProfile } from "@stx-labs/signer-sidekick-protocol/network-manager-artifact";
import { parseContractPrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import type { SidekickNetwork } from "./config.js";
import type { PreflightResult } from "./preflight.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const managerDeploymentManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    network: z.enum(["mainnet", "testnet", "devnet", "regtest"]),
    adminPrincipal: z.string().min(1).max(500),
    managerPrincipal: z.string().min(1).max(500),
    profile: z
      .object({
        id: z.string().min(1).max(100),
        upstreamTag: z.string().min(1).max(100),
        upstreamCommit: z.string().regex(/^[0-9a-f]{40}$/),
        compatibilityProfileId: z.string().min(1).max(100).nullable(),
        compatibilityProfileRevision: z.number().int().positive().nullable(),
      })
      .strict()
      .refine(
        (profile) =>
          (profile.compatibilityProfileId === null) ===
          (profile.compatibilityProfileRevision === null),
        "Compatibility profile ID and revision must both be present or both be null",
      ),
    contracts: z
      .object({
        pox5: z.string().min(1).max(500),
        sbtcDeployer: z.string().min(1).max(500),
      })
      .strict(),
    artifact: z
      .object({
        sourceFile: z.string().min(1).max(500),
        sourceSha256: sha256Schema,
        canonicalSourceSha256: sha256Schema,
        replacements: z
          .object({
            pox5: z.number().int().positive(),
            sbtcDeployer: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    transaction: z
      .object({
        type: z.literal("smart-contract-deploy"),
        contractName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,39}$/),
        clarityVersion: z.literal(6),
        anchorMode: z.literal("any"),
        postConditionMode: z.literal("deny"),
        signingAuthority: z.literal("external-offline-admin"),
      })
      .strict(),
    operatorReviewRequired: z.literal(true),
    warnings: z.array(z.string().min(1).max(1_000)).max(20),
  })
  .strict();

export type ManagerDeploymentManifest = z.infer<typeof managerDeploymentManifestSchema>;

export interface RenderManagerOptions {
  network: SidekickNetwork;
  adminPrincipal: string;
  contractName: string;
  contractsDirectory: string;
  outputDirectory: string;
  compatibilityProfile?: NetworkCompatibilityProfile;
}

export interface RenderedManagerDeployment {
  manifest: ManagerDeploymentManifest;
  sourcePath: string;
  manifestPath: string;
}

export interface ManagerDeploymentArtifact {
  manifest: ManagerDeploymentManifest;
  source: string;
}

export function assertManagerRenderPreflight(
  network: SidekickNetwork,
  preflight: Pick<PreflightResult, "status"> & {
    compatibility: Pick<PreflightResult["compatibility"], "status">;
  },
): void {
  if (preflight.status === "fail") {
    throw new Error("Manager rendering requires a successful connected preflight");
  }
  if (
    (network === "mainnet" || network === "testnet") &&
    preflight.compatibility.status !== "matched"
  ) {
    throw new Error(
      "Manager rendering on a public network requires a matched network compatibility profile",
    );
  }
}

export async function buildManagerDeploymentArtifact(
  options: Omit<RenderManagerOptions, "outputDirectory">,
): Promise<ManagerDeploymentArtifact> {
  if (
    options.compatibilityProfile?.network !== undefined &&
    options.compatibilityProfile.network !== options.network
  ) {
    throw new Error("Network compatibility profile does not match the selected network");
  }
  const artifacts = options.compatibilityProfile
    ? [managerArtifactFromNetworkProfile(options.compatibilityProfile)]
    : knownManagerArtifactsForNetwork(options.network);
  if (artifacts.length !== 1) {
    throw new Error(
      `Expected exactly one reviewed manager profile for ${options.network}; found ${artifacts.length}`,
    );
  }
  const reviewed = artifacts[0];
  if (!reviewed) throw new Error(`No manager profile is available for ${options.network}`);

  const managerPrincipal = `${options.adminPrincipal}.${options.contractName}`;
  const principal = parseContractPrincipal(managerPrincipal);
  const expectedPrincipalNetwork = options.network === "mainnet" ? "mainnet" : "testnet";
  if (principal.network !== expectedPrincipalNetwork) {
    throw new Error("Manager admin principal does not match the selected network");
  }

  const upstreamPath = resolve(
    options.contractsDirectory,
    "reference-manager/upstream/signer-manager.clar",
  );
  const upstreamSource = await readFile(upstreamPath, "utf8");
  const artifact = generateManagerArtifact(upstreamSource, reviewed.profile);
  const canonicalSourceSha256 = claritySourceSha256(canonicalizeClaritySource(artifact.source));
  if (
    artifact.metadata.outputSha256 !== reviewed.sourceSha256 ||
    canonicalSourceSha256 !== reviewed.canonicalSha256
  ) {
    throw new Error("Rendered manager does not match the immutable reviewed artifact registry");
  }

  const sourceFile = `${options.contractName}.clar`;
  const warnings = [
    "Review the network, contract principals, and source hashes before signing externally; Sidekick does not sign or broadcast this deployment",
  ];
  const manifest: ManagerDeploymentManifest = {
    schemaVersion: 1,
    network: options.network,
    adminPrincipal: options.adminPrincipal,
    managerPrincipal,
    profile: {
      id: reviewed.profile.id,
      upstreamTag: reviewed.profile.upstream.tag,
      upstreamCommit: reviewed.profile.upstream.commit,
      compatibilityProfileId: options.compatibilityProfile?.id ?? null,
      compatibilityProfileRevision: options.compatibilityProfile?.revision ?? null,
    },
    contracts: {
      pox5: reviewed.profile.contracts.pox5,
      sbtcDeployer: reviewed.profile.contracts.sbtcDeployer,
    },
    artifact: {
      sourceFile,
      sourceSha256: artifact.metadata.outputSha256,
      canonicalSourceSha256,
      replacements: artifact.metadata.replacements,
    },
    transaction: {
      type: "smart-contract-deploy",
      contractName: options.contractName,
      clarityVersion: 6,
      anchorMode: "any",
      postConditionMode: "deny",
      signingAuthority: "external-offline-admin",
    },
    operatorReviewRequired: true,
    warnings,
  };

  return { manifest, source: artifact.source };
}

export async function renderManagerDeployment(
  options: RenderManagerOptions,
): Promise<RenderedManagerDeployment> {
  const { manifest, source } = await buildManagerDeploymentArtifact(options);
  const outputDirectory = resolve(options.outputDirectory);
  const sourceFile = manifest.artifact.sourceFile;
  const manifestFile = `${manifest.transaction.contractName}.deployment.json`;
  const sourcePath = join(outputDirectory, sourceFile);
  const manifestPath = join(outputDirectory, manifestFile);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(sourcePath, source, { flag: "wx", mode: 0o644 });
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
  } catch (error) {
    throw new Error(
      `Manager source was written to ${sourcePath}, but the manifest could not be written: ${String(error)}`,
    );
  }

  return { manifest, sourcePath, manifestPath };
}
