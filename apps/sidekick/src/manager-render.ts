import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { knownManagerArtifactsForNetwork } from "@stx-labs/signer-sidekick-protocol/known-managers";
import {
  canonicalizeClaritySource,
  claritySourceSha256,
} from "@stx-labs/signer-sidekick-protocol/manager-adapter";
import { generateManagerArtifact } from "@stx-labs/signer-sidekick-protocol/manager-artifact";
import { parseContractPrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import type { SidekickNetwork } from "./config.js";

export interface ManagerDeploymentManifest {
  schemaVersion: 1;
  network: SidekickNetwork;
  adminPrincipal: string;
  managerPrincipal: string;
  profile: {
    id: string;
    upstreamTag: string;
    upstreamCommit: string;
    productionApproved: boolean;
  };
  contracts: {
    pox5: string;
    sbtcDeployer: string;
  };
  artifact: {
    sourceFile: string;
    sourceSha256: string;
    canonicalSourceSha256: string;
    replacements: {
      pox5: number;
      sbtcDeployer: number;
    };
  };
  transaction: {
    type: "smart-contract-deploy";
    contractName: string;
    clarityVersion: 6;
    anchorMode: "any";
    postConditionMode: "deny";
    signingAuthority: "external-offline-admin";
  };
  deploymentAllowed: boolean;
  warnings: string[];
}

export interface RenderManagerOptions {
  network: SidekickNetwork;
  adminPrincipal: string;
  contractName: string;
  contractsDirectory: string;
  outputDirectory: string;
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

export async function buildManagerDeploymentArtifact(
  options: Omit<RenderManagerOptions, "outputDirectory">,
): Promise<ManagerDeploymentArtifact> {
  const artifacts = knownManagerArtifactsForNetwork(options.network);
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
  const warnings = reviewed.profile.productionApproved
    ? []
    : [`Profile ${reviewed.profile.id} is not production-approved; do not deploy this artifact`];
  const manifest: ManagerDeploymentManifest = {
    schemaVersion: 1,
    network: options.network,
    adminPrincipal: options.adminPrincipal,
    managerPrincipal,
    profile: {
      id: reviewed.profile.id,
      upstreamTag: reviewed.profile.upstream.tag,
      upstreamCommit: reviewed.profile.upstream.commit,
      productionApproved: reviewed.profile.productionApproved,
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
    deploymentAllowed: reviewed.profile.productionApproved,
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
