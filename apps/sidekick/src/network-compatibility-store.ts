import { constants, type Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { BUILT_IN_NETWORK_COMPATIBILITY_PROFILES } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import {
  type NetworkCompatibilityProfile,
  networkCompatibilityProfileSchema,
} from "@stx-labs/signer-sidekick-protocol/network-compatibility";

const maximumProfileFiles = 50;
const maximumProfileBytes = 64 * 1024;

export type CompatibilityProfileOrigin = "built-in" | "operator-provided";

export interface LoadedNetworkCompatibilityProfile {
  profile: NetworkCompatibilityProfile;
  origin: CompatibilityProfileOrigin;
  fileName: string | null;
}

export interface NetworkCompatibilityLoadIssue {
  fileName: string | null;
  code:
    | "directory-unavailable"
    | "too-many-files"
    | "not-regular-file"
    | "file-too-large"
    | "invalid-json"
    | "invalid-profile"
    | "duplicate-profile"
    | "ambiguous-fingerprint";
  message: string;
}

export interface NetworkCompatibilityStore {
  directory: string | null;
  profiles: LoadedNetworkCompatibilityProfile[];
  issues: NetworkCompatibilityLoadIssue[];
}

export function compatibilityProfileByIdentity(
  store: NetworkCompatibilityStore,
  profileId: string | null,
  revision: number | null,
): LoadedNetworkCompatibilityProfile | null {
  if (!profileId || revision === null) return null;
  return (
    store.profiles.find(
      ({ profile }) => profile.id === profileId && profile.revision === revision,
    ) ?? null
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readBoundedRegularFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error("Path is not a regular file");
    if (fileStat.size > maximumProfileBytes) {
      throw new Error(`File exceeds ${maximumProfileBytes} bytes`);
    }
    const buffer = Buffer.alloc(maximumProfileBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximumProfileBytes) {
      throw new Error(`File exceeds ${maximumProfileBytes} bytes`);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function fingerprint(profile: NetworkCompatibilityProfile): string {
  return [
    profile.network,
    profile.networkId,
    profile.pox5.contractId,
    profile.pox5.sourceSha256,
    profile.sbtc.tokenContract,
    profile.sbtc.registryContract,
  ].join(":");
}

export async function loadNetworkCompatibilityProfiles(
  options: { directory?: string; builtIns?: readonly NetworkCompatibilityProfile[] } = {},
): Promise<NetworkCompatibilityStore> {
  const builtIns = (options.builtIns ?? BUILT_IN_NETWORK_COMPATIBILITY_PROFILES).map((profile) => ({
    profile,
    origin: "built-in" as const,
    fileName: null,
  }));
  const directory = options.directory ? resolve(options.directory) : null;
  const issues: NetworkCompatibilityLoadIssue[] = [];
  if (!directory) return { directory, profiles: builtIns, issues };

  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    issues.push({
      fileName: null,
      code: "directory-unavailable",
      message: `Compatibility profile directory is unavailable: ${describeError(error)}`,
    });
    return { directory, profiles: builtIns, issues };
  }
  const jsonEntries = entries.filter((entry) => entry.name.endsWith(".json"));
  if (jsonEntries.length > maximumProfileFiles) {
    issues.push({
      fileName: null,
      code: "too-many-files",
      message: `Compatibility profile directory contains ${jsonEntries.length} JSON files; maximum is ${maximumProfileFiles}`,
    });
    return { directory, profiles: builtIns, issues };
  }

  const candidates: LoadedNetworkCompatibilityProfile[] = [];
  for (const entry of jsonEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fileName = basename(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      issues.push({
        fileName,
        code: "not-regular-file",
        message: "Compatibility profiles must be regular JSON files; symlinks are not accepted",
      });
      continue;
    }
    let input: unknown;
    try {
      input = JSON.parse(await readBoundedRegularFile(resolve(directory, fileName))) as unknown;
    } catch (error) {
      const tooLarge = describeError(error).includes("exceeds");
      issues.push({
        fileName,
        code: tooLarge ? "file-too-large" : "invalid-json",
        message: tooLarge
          ? `Compatibility profile exceeds ${maximumProfileBytes} bytes`
          : "Compatibility profile is unreadable or invalid JSON; contents were not logged",
      });
      continue;
    }
    const parsed = networkCompatibilityProfileSchema.safeParse(input);
    if (!parsed.success) {
      issues.push({
        fileName,
        code: "invalid-profile",
        message: "Compatibility profile failed strict schema validation; contents were not logged",
      });
      continue;
    }
    candidates.push({ profile: parsed.data, origin: "operator-provided", fileName });
  }

  const byRevision = new Map<string, LoadedNetworkCompatibilityProfile[]>();
  for (const candidate of candidates) {
    const key = `${candidate.profile.id}:${candidate.profile.revision}`;
    byRevision.set(key, [...(byRevision.get(key) ?? []), candidate]);
  }
  const uniqueCandidates = candidates.filter((candidate) => {
    const key = `${candidate.profile.id}:${candidate.profile.revision}`;
    if ((byRevision.get(key)?.length ?? 0) <= 1) return true;
    issues.push({
      fileName: candidate.fileName,
      code: "duplicate-profile",
      message: "Profile ID and revision are duplicated; all conflicting files were ignored",
    });
    return false;
  });

  const latestById = new Map<string, LoadedNetworkCompatibilityProfile>();
  for (const candidate of [...builtIns, ...uniqueCandidates]) {
    const current = latestById.get(candidate.profile.id);
    if (!current || candidate.profile.revision > current.profile.revision) {
      latestById.set(candidate.profile.id, candidate);
    }
  }
  const latest = [...latestById.values()];
  const byFingerprint = new Map<string, LoadedNetworkCompatibilityProfile[]>();
  for (const candidate of latest) {
    const key = fingerprint(candidate.profile);
    byFingerprint.set(key, [...(byFingerprint.get(key) ?? []), candidate]);
  }
  const profiles = latest.filter((candidate) => {
    const conflicts = byFingerprint.get(fingerprint(candidate.profile)) ?? [];
    if (conflicts.length <= 1) return true;
    if (candidate.origin === "operator-provided") {
      issues.push({
        fileName: candidate.fileName,
        code: "ambiguous-fingerprint",
        message:
          "Profile fingerprint is already claimed by another profile; use a higher revision of the existing profile ID",
      });
      return false;
    }
    return true;
  });

  return {
    directory,
    profiles: profiles.sort((left, right) => left.profile.id.localeCompare(right.profile.id)),
    issues,
  };
}
