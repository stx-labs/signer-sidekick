import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAINNET_4_0_1_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import { afterEach, describe, expect, it } from "vitest";
import { loadNetworkCompatibilityProfiles } from "./network-compatibility-store.js";

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sidekick-compatibility-"));
  directories.push(root);
  const profiles = join(root, "profiles");
  await mkdir(profiles);
  return profiles;
}

describe("network compatibility profile store", () => {
  it("loads a strict operator-provided data profile", async () => {
    const directory = await fixture();
    const profile = {
      ...MAINNET_4_0_1_COMPATIBILITY,
      id: "operator-mainnet-launch",
      revision: 2,
    };
    await writeFile(join(directory, "mainnet.json"), JSON.stringify(profile));

    const result = await loadNetworkCompatibilityProfiles({ directory, builtIns: [] });

    expect(result.issues).toEqual([]);
    expect(result.profiles).toMatchObject([
      {
        origin: "operator-provided",
        profile: { id: "operator-mainnet-launch", revision: 2 },
      },
    ]);
  });

  it("rejects executable or policy authority in an operator profile", async () => {
    const directory = await fixture();
    await writeFile(
      join(directory, "authority.json"),
      JSON.stringify({
        ...MAINNET_4_0_1_COMPATIBILITY,
        policy: { deploymentAllowed: true, referenceAutomationCompatible: true },
      }),
    );

    const result = await loadNetworkCompatibilityProfiles({ directory, builtIns: [] });

    expect(result.profiles).toEqual([]);
    expect(result.issues).toMatchObject([{ code: "invalid-profile" }]);
  });

  it("rejects symlinks and duplicate revisions", async () => {
    const directory = await fixture();
    const document = JSON.stringify(MAINNET_4_0_1_COMPATIBILITY);
    await writeFile(join(directory, "one.json"), document);
    await writeFile(join(directory, "two.json"), document);
    await symlink(join(directory, "one.json"), join(directory, "linked.json"));

    const result = await loadNetworkCompatibilityProfiles({ directory, builtIns: [] });

    expect(result.profiles).toEqual([]);
    expect(result.issues.map(({ code }) => code)).toEqual([
      "not-regular-file",
      "duplicate-profile",
      "duplicate-profile",
    ]);
  });

  it("allows a higher operator revision to supersede bootstrap data without a Sidekick release", async () => {
    const directory = await fixture();
    const profile = {
      ...MAINNET_4_0_1_COMPATIBILITY,
      revision: 2,
      publishedAt: "2026-07-20T00:00:00.000Z",
      testedNodeBuilds: ["stacks-node 4.0.2.0.0 (1234567, release build, linux [x86_64])"],
    };
    await writeFile(join(directory, "revision-2.json"), JSON.stringify(profile));

    const result = await loadNetworkCompatibilityProfiles({
      directory,
      builtIns: [MAINNET_4_0_1_COMPATIBILITY],
    });

    expect(result.issues).toEqual([]);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]).toMatchObject({
      origin: "operator-provided",
      profile: { id: MAINNET_4_0_1_COMPATIBILITY.id, revision: 2 },
    });
  });

  it("does not let a second profile ID ambiguously claim a built-in fingerprint", async () => {
    const directory = await fixture();
    const profile = { ...MAINNET_4_0_1_COMPATIBILITY, id: "renamed-launch-profile" };
    await writeFile(join(directory, "renamed.json"), JSON.stringify(profile));

    const result = await loadNetworkCompatibilityProfiles({
      directory,
      builtIns: [MAINNET_4_0_1_COMPATIBILITY],
    });

    expect(result.profiles).toMatchObject([{ origin: "built-in" }]);
    expect(result.issues).toMatchObject([{ code: "ambiguous-fingerprint" }]);
  });
});
