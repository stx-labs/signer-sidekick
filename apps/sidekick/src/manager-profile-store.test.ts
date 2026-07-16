import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstalledManagerProfileStore } from "./manager-profile-store.js";

const directories: string[] = [];
const profile = {
  schemaVersion: 1,
  id: "private-1-reference-manager",
  managerPrincipal: "ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ.signer-manager",
  network: "testnet",
  networkId: 256,
  sourceSha256: "a".repeat(64),
  canonicalSha256: "b".repeat(64),
  createdAt: "2026-07-16T12:00:00.000Z",
  proofVersion: 1,
  tier: "custom-observe",
} as const;

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "sidekick-profiles-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("installed manager profile store", () => {
  it("loads bounded strict JSON profiles in deterministic order", async () => {
    const path = await directory();
    await writeFile(join(path, "b.json"), JSON.stringify({ ...profile, id: "profile-b" }));
    await writeFile(
      join(path, "a.json"),
      JSON.stringify({
        ...profile,
        id: "profile-a",
        managerPrincipal: "ST000000000000000000002AMW42H.second-manager",
        sourceSha256: "c".repeat(64),
        canonicalSha256: "d".repeat(64),
      }),
    );
    const store = await loadInstalledManagerProfileStore(path);
    expect(store.profiles.map(({ fileName }) => fileName)).toEqual(["a.json", "b.json"]);
    expect(store.issues).toEqual([]);
  });

  it("rejects symlinks, malformed profiles, duplicates, and built-in shadowing", async () => {
    const path = await directory();
    const secretPrefix = "hunter2-my-secret";
    await writeFile(join(path, "target.txt"), "{}");
    await symlink(join(path, "target.txt"), join(path, "linked.json"));
    await writeFile(join(path, "bad.json"), secretPrefix);
    await writeFile(join(path, "secret-shaped.json"), JSON.stringify({ token: secretPrefix }));
    await writeFile(join(path, "one.json"), JSON.stringify(profile));
    await writeFile(join(path, "two.json"), JSON.stringify({ ...profile, id: "duplicate-hash" }));
    await writeFile(
      join(path, "shadow.json"),
      JSON.stringify({
        ...profile,
        id: "stacks-4.0.0-mainnet-reference-manager",
        sourceSha256: "c".repeat(64),
        canonicalSha256: "d".repeat(64),
      }),
    );
    const store = await loadInstalledManagerProfileStore(path);
    expect(store.profiles).toEqual([]);
    expect(store.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "not-regular-file",
        "invalid-json",
        "invalid-profile",
        "duplicate-profile",
        "built-in-shadow",
      ]),
    );
    expect(JSON.stringify(store)).not.toContain(secretPrefix);
  });

  it("fails closed when the configured directory is unreadable", async () => {
    const store = await loadInstalledManagerProfileStore(join(tmpdir(), randomMissingName()));
    expect(store.profiles).toEqual([]);
    expect(store.issues).toMatchObject([{ code: "directory-unreadable" }]);
  });

  it("rejects oversized files and fails closed when the directory exceeds its file bound", async () => {
    const oversizedDirectory = await directory();
    await writeFile(join(oversizedDirectory, "oversized.json"), "x".repeat(64 * 1024 + 1));
    const oversized = await loadInstalledManagerProfileStore(oversizedDirectory);
    expect(oversized.profiles).toEqual([]);
    expect(oversized.issues).toMatchObject([{ code: "file-too-large" }]);

    const crowdedDirectory = await directory();
    const standardPrincipal = profile.managerPrincipal.split(".")[0];
    await Promise.all(
      Array.from({ length: 65 }, async (_, index) => {
        const suffix = index.toString().padStart(2, "0");
        await writeFile(
          join(crowdedDirectory, `${suffix}.json`),
          JSON.stringify({
            ...profile,
            id: `profile-${suffix}`,
            managerPrincipal: `${standardPrincipal}.manager-${suffix}`,
            sourceSha256: index.toString(16).padStart(64, "0"),
            canonicalSha256: (index + 100).toString(16).padStart(64, "0"),
          }),
        );
      }),
    );
    const crowded = await loadInstalledManagerProfileStore(crowdedDirectory);
    expect(crowded.profiles).toEqual([]);
    expect(crowded.issues).toMatchObject([{ code: "too-many-files" }]);
  });
});

function randomMissingName(): string {
  return `missing-sidekick-profile-dir-${Date.now()}-${Math.random()}`;
}
