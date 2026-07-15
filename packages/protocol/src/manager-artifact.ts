import { createHash } from "node:crypto";
import { canonicalizeClaritySource } from "./manager-adapter.js";
import type { ManagerProfile } from "./profile.js";

export const UPSTREAM_POX5 = "ST000000000000000000002AMW42H.pox-5";
export const UPSTREAM_SBTC_DEPLOYER = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";

export interface GeneratedManagerArtifact {
  source: string;
  metadata: {
    profileId: string;
    network: ManagerProfile["network"];
    upstreamTag: string;
    upstreamCommit: string;
    sourceSha256: string;
    outputSha256: string;
    canonicalOutputSha256: string;
    replacements: {
      pox5: number;
      sbtcDeployer: number;
    };
    productionApproved: boolean;
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function occurrenceCount(source: string, value: string): number {
  return source.split(value).length - 1;
}

export function generateManagerArtifact(
  upstreamSource: string,
  profile: ManagerProfile,
): GeneratedManagerArtifact {
  const sourceSha256 = hash(upstreamSource);
  if (sourceSha256 !== profile.upstream.sourceSha256) {
    throw new Error(
      `Reference manager source hash mismatch: expected ${profile.upstream.sourceSha256}, got ${sourceSha256}`,
    );
  }

  const replacements = {
    pox5: occurrenceCount(upstreamSource, UPSTREAM_POX5),
    sbtcDeployer: occurrenceCount(upstreamSource, UPSTREAM_SBTC_DEPLOYER),
  };

  if (replacements.pox5 !== profile.expectedReplacements.pox5) {
    throw new Error(
      `Expected ${profile.expectedReplacements.pox5} PoX-5 replacements, found ${replacements.pox5}`,
    );
  }
  if (replacements.sbtcDeployer !== profile.expectedReplacements.sbtcDeployer) {
    throw new Error(
      `Expected ${profile.expectedReplacements.sbtcDeployer} sBTC replacements, found ${replacements.sbtcDeployer}`,
    );
  }

  const generated = upstreamSource
    .split(UPSTREAM_POX5)
    .join(profile.contracts.pox5)
    .split(UPSTREAM_SBTC_DEPLOYER)
    .join(profile.contracts.sbtcDeployer);

  if (profile.contracts.pox5 !== UPSTREAM_POX5 && generated.includes(UPSTREAM_POX5)) {
    throw new Error("Generated manager still contains the upstream PoX-5 principal");
  }
  if (
    profile.contracts.sbtcDeployer !== UPSTREAM_SBTC_DEPLOYER &&
    generated.includes(UPSTREAM_SBTC_DEPLOYER)
  ) {
    throw new Error("Generated manager still contains the upstream sBTC deployer");
  }

  return {
    source: generated,
    metadata: {
      profileId: profile.id,
      network: profile.network,
      upstreamTag: profile.upstream.tag,
      upstreamCommit: profile.upstream.commit,
      sourceSha256,
      outputSha256: hash(generated),
      canonicalOutputSha256: hash(canonicalizeClaritySource(generated)),
      replacements,
      productionApproved: profile.productionApproved,
    },
  };
}
