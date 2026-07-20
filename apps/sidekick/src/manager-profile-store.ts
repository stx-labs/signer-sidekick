import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { InstalledManagerProfile } from "@stx-labs/signer-sidekick-protocol/installed-manager-profile";
import { parseInstalledManagerProfile } from "@stx-labs/signer-sidekick-protocol/installed-manager-profile";
import { KNOWN_MANAGER_ARTIFACTS } from "@stx-labs/signer-sidekick-protocol/known-managers";
import type { ReviewedManagerArtifact } from "@stx-labs/signer-sidekick-protocol/manager-adapter";

const maximumProfileFiles = 64;
const maximumProfileBytes = 64 * 1024;

export interface LoadedInstalledManagerProfile {
  fileName: string;
  profile: InstalledManagerProfile;
}

export interface ManagerProfileLoadIssue {
  fileName: string | null;
  code:
    | "directory-unreadable"
    | "too-many-files"
    | "not-regular-file"
    | "file-too-large"
    | "invalid-json"
    | "invalid-profile"
    | "duplicate-profile"
    | "built-in-shadow";
  message: string;
}

export interface InstalledManagerProfileStore {
  directory: string | null;
  profiles: readonly LoadedInstalledManagerProfile[];
  issues: readonly ManagerProfileLoadIssue[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shadowsBuiltIn(
  profile: InstalledManagerProfile,
  artifacts: readonly ReviewedManagerArtifact[],
): boolean {
  return artifacts.some(
    (artifact) =>
      artifact.profile.id === profile.id ||
      (artifact.profile.network === profile.network &&
        (artifact.sourceSha256 === profile.sourceSha256 ||
          artifact.canonicalSha256 === profile.canonicalSha256)),
  );
}

export async function loadInstalledManagerProfileStore(
  directory: string | undefined,
  artifacts: readonly ReviewedManagerArtifact[] = KNOWN_MANAGER_ARTIFACTS,
): Promise<InstalledManagerProfileStore> {
  if (!directory) return { directory: null, profiles: [], issues: [] };
  const resolvedDirectory = resolve(directory);
  const issues: ManagerProfileLoadIssue[] = [];
  const entries = await readdir(resolvedDirectory, { withFileTypes: true }).catch((error) => {
    issues.push({
      fileName: null,
      code: "directory-unreadable",
      message: `Trusted-manager profile directory is unreadable: ${describeError(error)}`,
    });
    return null;
  });
  if (!entries) return { directory: resolvedDirectory, profiles: [], issues };

  const jsonEntries = entries
    .filter((entry) => entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (jsonEntries.length > maximumProfileFiles) {
    issues.push({
      fileName: null,
      code: "too-many-files",
      message: `Trusted-manager profile directory contains ${jsonEntries.length} JSON files; maximum is ${maximumProfileFiles}`,
    });
    return { directory: resolvedDirectory, profiles: [], issues };
  }

  const candidates: LoadedInstalledManagerProfile[] = [];
  for (const entry of jsonEntries) {
    const fileName = basename(entry.name);
    const path = resolve(resolvedDirectory, fileName);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      issues.push({
        fileName,
        code: "not-regular-file",
        message: "Trusted-manager profiles must be regular files; symlinks are not accepted",
      });
      continue;
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
      issues.push({
        fileName,
        code: "not-regular-file",
        message: `Could not safely open trusted-manager profile: ${describeError(error)}`,
      });
      return null;
    });
    if (!handle) continue;
    let text: string;
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) {
        issues.push({
          fileName,
          code: "not-regular-file",
          message: "Trusted-manager profiles must be regular files",
        });
        continue;
      }
      if (fileStat.size > maximumProfileBytes) {
        issues.push({
          fileName,
          code: "file-too-large",
          message: `Trusted-manager profile exceeds ${maximumProfileBytes} bytes`,
        });
        continue;
      }
      const buffer = Buffer.alloc(maximumProfileBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maximumProfileBytes) {
        issues.push({
          fileName,
          code: "file-too-large",
          message: `Trusted-manager profile exceeds ${maximumProfileBytes} bytes`,
        });
        continue;
      }
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    let input: unknown;
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      issues.push({
        fileName,
        code: "invalid-json",
        message: "Trusted-manager profile is not valid JSON; file contents were not logged",
      });
      continue;
    }
    try {
      const profile = parseInstalledManagerProfile(input);
      if (shadowsBuiltIn(profile, artifacts)) {
        issues.push({
          fileName,
          code: "built-in-shadow",
          message: "Installed profile conflicts with a built-in profile ID or source hash",
        });
        continue;
      }
      candidates.push({ fileName, profile });
    } catch {
      issues.push({
        fileName,
        code: "invalid-profile",
        message:
          "Trusted-manager profile failed strict schema validation; file contents were not logged",
      });
    }
  }

  const duplicateKeys = new Set<string>();
  const keyCounts = new Map<string, number>();
  for (const { profile } of candidates) {
    for (const key of [
      `id:${profile.id}`,
      `manager:${profile.network}:${profile.managerPrincipal}`,
      `source:${profile.network}:${profile.sourceSha256}`,
      `canonical:${profile.network}:${profile.canonicalSha256}`,
    ]) {
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of keyCounts) if (count > 1) duplicateKeys.add(key);

  const profiles = candidates.filter(({ fileName, profile }) => {
    const hasDuplicate = [
      `id:${profile.id}`,
      `manager:${profile.network}:${profile.managerPrincipal}`,
      `source:${profile.network}:${profile.sourceSha256}`,
      `canonical:${profile.network}:${profile.canonicalSha256}`,
    ].some((key) => duplicateKeys.has(key));
    if (hasDuplicate) {
      issues.push({
        fileName,
        code: "duplicate-profile",
        message: "Profile ID or source hash is duplicated; all conflicting profiles were ignored",
      });
    }
    return !hasDuplicate;
  });

  return { directory: resolvedDirectory, profiles, issues };
}
