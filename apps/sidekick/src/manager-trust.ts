import { randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseManagerProfile } from "@stx-labs/signer-sidekick-protocol";
import type { InstalledManagerProfile } from "@stx-labs/signer-sidekick-protocol/installed-manager-profile";
import { parseInstalledManagerProfile } from "@stx-labs/signer-sidekick-protocol/installed-manager-profile";
import {
  KNOWN_MANAGER_ARTIFACTS,
  knownManagerArtifactsForNetwork,
} from "@stx-labs/signer-sidekick-protocol/known-managers";
import {
  canonicalizeClaritySource,
  claritySourceSha256,
} from "@stx-labs/signer-sidekick-protocol/manager-adapter";
import { generateManagerArtifact } from "@stx-labs/signer-sidekick-protocol/manager-artifact";
import type { ContractInterface, ContractSource } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import { verifyManagerArtifact } from "./manager-verification.js";

const principalPattern = "S[PMTN][0-9A-HJKMNP-TV-Z]+";

function uniqueMatches(source: string, pattern: RegExp): string[] {
  return [
    ...new Set([...source.matchAll(pattern)].map((match) => match[1]).filter(Boolean)),
  ] as string[];
}

export function inferReferencePrincipals(source: string): {
  pox5: string;
  sbtcDeployer: string;
} {
  const pox5Deployers = uniqueMatches(
    source,
    new RegExp(`'?(${principalPattern})\\.pox-5(?:\\.|\\b)`, "g"),
  );
  const sbtcDeployers = uniqueMatches(
    source,
    new RegExp(`'?(${principalPattern})\\.sbtc-(?:token|withdrawal|registry)(?:\\.|\\b)`, "g"),
  );
  if (pox5Deployers.length !== 1) {
    throw new Error(`Expected exactly one embedded PoX-5 deployer, found ${pox5Deployers.length}`);
  }
  if (sbtcDeployers.length !== 1) {
    throw new Error(`Expected exactly one embedded sBTC deployer, found ${sbtcDeployers.length}`);
  }
  return {
    pox5: `${pox5Deployers[0]}.pox-5`,
    sbtcDeployer: sbtcDeployers[0] as string,
  };
}

function chooseUpstreamProfile(network: SidekickConfig["network"]) {
  return (
    knownManagerArtifactsForNetwork(network)[0] ??
    KNOWN_MANAGER_ARTIFACTS.find(({ profile }) => profile.network === "mainnet") ??
    KNOWN_MANAGER_ARTIFACTS[0]
  );
}

export function createInstalledManagerProfile(input: {
  config: SidekickConfig;
  managerPrincipal: string;
  contractSource: ContractSource;
  contractInterface: ContractInterface;
  upstreamSource: string | null;
  observeOnly: boolean;
  createdAt?: string;
}): {
  profile: InstalledManagerProfile | null;
  status: "created" | "already-built-in";
  summary: string;
} {
  const verification = verifyManagerArtifact(
    input.config.network,
    input.managerPrincipal,
    input.contractSource,
    input.contractInterface,
  );
  if (!verification.attachAllowed) {
    throw new Error(`Manager cannot attach: ${verification.reasons.join("; ")}`);
  }
  if (verification.source.tier === "reference-built-in") {
    return {
      profile: null,
      status: "already-built-in",
      summary: `Manager already matches built-in profile ${verification.source.profileId}`,
    };
  }

  const sourceSha256 = claritySourceSha256(input.contractSource.source);
  const canonicalSha256 = claritySourceSha256(
    canonicalizeClaritySource(input.contractSource.source),
  );
  const common = {
    schemaVersion: 1 as const,
    id: `operator-${input.config.network}-${sourceSha256.slice(0, 16)}`,
    managerPrincipal: input.managerPrincipal,
    network: input.config.network,
    ...(input.config.expectedNetworkId !== undefined
      ? { networkId: input.config.expectedNetworkId }
      : {}),
    sourceSha256,
    canonicalSha256,
    createdAt: input.createdAt ?? new Date().toISOString(),
    proofVersion: 1 as const,
  };

  let referenceFailure: string | null = null;
  try {
    if (!input.upstreamSource) throw new Error("Pinned reference-manager source is unavailable");
    const upstreamArtifact = chooseUpstreamProfile(input.config.network);
    if (!upstreamArtifact) throw new Error("No pinned built-in upstream profile is available");
    const principals = inferReferencePrincipals(input.contractSource.source);
    const renderProfile = parseManagerProfile({
      id: common.id,
      network: input.config.network,
      upstream: upstreamArtifact.profile.upstream,
      contracts: principals,
      expectedReplacements: upstreamArtifact.profile.expectedReplacements,
      productionApproved: false,
    });
    if (input.config.network === "mainnet") {
      const mainnet = knownManagerArtifactsForNetwork("mainnet")[0];
      if (
        !mainnet ||
        principals.pox5 !== mainnet.profile.contracts.pox5 ||
        principals.sbtcDeployer !== mainnet.profile.contracts.sbtcDeployer
      ) {
        throw new Error("Mainnet renders must use the fixed canonical PoX-5 and sBTC principals");
      }
    }
    const rendered = generateManagerArtifact(input.upstreamSource, renderProfile);
    const referenceMatch =
      sourceSha256 === rendered.metadata.outputSha256 ||
      canonicalSha256 === rendered.metadata.canonicalOutputSha256;
    if (!referenceMatch) {
      throw new Error("Deployed source differs from the permitted pinned-source render");
    }
    const profile = parseInstalledManagerProfile({
      ...common,
      tier: "reference-render",
      reference: {
        upstreamProfileId: upstreamArtifact.profile.id,
        upstream: upstreamArtifact.profile.upstream,
        pox5: principals.pox5,
        sbtcDeployer: principals.sbtcDeployer,
      },
    });
    return {
      profile,
      status: "created",
      summary: `Reference render proven from ${upstreamArtifact.profile.id}; Sidekick will independently re-run this proof when loading the profile`,
    };
  } catch (error) {
    referenceFailure = error instanceof Error ? error.message : String(error);
  }

  if (!input.observeOnly) {
    throw new Error(
      `Manager is interface-compatible but is not a reproducible reference render: ${referenceFailure}. Re-run with --observe-only to identify it as custom read-only`,
    );
  }
  return {
    profile: parseInstalledManagerProfile({
      ...common,
      tier: "custom-observe",
    }),
    status: "created",
    summary: `Custom manager profile created for attach and read-only monitoring only; reference-manager Assist remains disabled (${referenceFailure})`,
  };
}

export function parseManagerTrustArguments(arguments_: readonly string[]): {
  managerPrincipal: string;
  outputPath: string;
  observeOnly: boolean;
} {
  const [managerPrincipal, ...options] = arguments_;
  if (!managerPrincipal || managerPrincipal.startsWith("--")) {
    throw new Error(
      "Usage: sidekick manager trust <manager-principal> --output <profile.json> [--observe-only]",
    );
  }
  let outputPath: string | null = null;
  let observeOnly = false;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--output") {
      if (outputPath !== null) throw new Error("--output may only be provided once");
      const value = options[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output requires a file path");
      outputPath = value;
      index += 1;
    } else if (option === "--observe-only") {
      if (observeOnly) throw new Error("--observe-only may only be provided once");
      observeOnly = true;
    } else {
      throw new Error(`Unknown manager trust option: ${option}`);
    }
  }
  if (!outputPath) throw new Error("--output requires a file path");
  return { managerPrincipal, outputPath, observeOnly };
}

export async function writeInstalledManagerProfile(
  path: string,
  profile: InstalledManagerProfile,
): Promise<string> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(profile, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
  } catch (error) {
    throw new Error(`Refusing to overwrite trusted-manager profile ${destination}`, {
      cause: error,
    });
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return destination;
}
