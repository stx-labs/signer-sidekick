import { createHash } from "node:crypto";
import type { ManagerProfile } from "./profile.js";

export type SourceMatch = "exact" | "canonical" | "unknown";

export interface ManagerRecognition {
  match: SourceMatch;
  profileId: string | null;
  sourceSha256: string;
  canonicalSha256: string;
  automationAllowed: boolean;
  reason: string;
}

export interface ManagerAdapter {
  readonly profile: ManagerProfile;
  readonly reviewedSourceSha256: string;
  readonly reviewedCanonicalSha256: string;
  recognizeSource(source: string): ManagerRecognition;
  assertAutomationCompatible(source: string): ManagerRecognition;
}

export interface ReviewedManagerArtifact {
  profile: ManagerProfile;
  sourceSha256: string;
  canonicalSha256: string;
}

export function claritySourceSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function managerProfileAllowsAssist(
  profile: Pick<ManagerProfile, "network" | "productionApproved">,
): boolean {
  return profile.network !== "mainnet" || profile.productionApproved;
}

/**
 * Remove line comments and collapse whitespace while preserving string contents.
 * This is deliberately lexical. It does not parse Clarity or attempt semantic equivalence.
 */
export function canonicalizeClaritySource(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let pendingWhitespace = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) continue;

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      if (pendingWhitespace && result.length > 0) result += " ";
      pendingWhitespace = false;
      inString = true;
      result += character;
      continue;
    }

    if (character === ";" && source[index + 1] === ";") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      pendingWhitespace = true;
      continue;
    }

    if (/\s/.test(character)) {
      pendingWhitespace = true;
      continue;
    }

    if (pendingWhitespace && result.length > 0) result += " ";
    pendingWhitespace = false;
    result += character;
  }

  if (inString) throw new Error("Cannot canonicalize Clarity source with an unterminated string");
  return result.trim();
}

export function createReferenceManagerAdapter(
  profile: ManagerProfile,
  reviewedSource: string,
): ManagerAdapter {
  return createManagerAdapterFromHashes({
    profile,
    sourceSha256: claritySourceSha256(reviewedSource),
    canonicalSha256: claritySourceSha256(canonicalizeClaritySource(reviewedSource)),
  });
}

export function createManagerAdapterFromHashes(artifact: ReviewedManagerArtifact): ManagerAdapter {
  const {
    profile,
    sourceSha256: reviewedSourceSha256,
    canonicalSha256: reviewedCanonicalSha256,
  } = artifact;

  function recognizeSource(source: string): ManagerRecognition {
    const sourceSha256 = claritySourceSha256(source);
    const canonicalSha256 = claritySourceSha256(canonicalizeClaritySource(source));
    const match: SourceMatch =
      sourceSha256 === reviewedSourceSha256
        ? "exact"
        : canonicalSha256 === reviewedCanonicalSha256
          ? "canonical"
          : "unknown";
    const matched = match !== "unknown";
    const automationAllowed = matched && managerProfileAllowsAssist(profile);

    let reason = "Source is not a reviewed reference-manager artifact";
    if (automationAllowed) {
      reason =
        profile.network === "mainnet"
          ? `Source matches production-approved profile ${profile.id} (${match})`
          : `Source matches non-mainnet profile ${profile.id} (${match}); production approval is not required for Assist on ${profile.network}`;
    } else if (matched) {
      reason = `Source matches mainnet profile ${profile.id}, but that profile is not production-approved`;
    }

    return {
      match,
      profileId: matched ? profile.id : null,
      sourceSha256,
      canonicalSha256,
      automationAllowed,
      reason,
    };
  }

  return {
    profile,
    reviewedSourceSha256,
    reviewedCanonicalSha256,
    recognizeSource,
    assertAutomationCompatible(source: string) {
      const recognition = recognizeSource(source);
      if (!recognition.automationAllowed) throw new Error(recognition.reason);
      return recognition;
    },
  };
}
