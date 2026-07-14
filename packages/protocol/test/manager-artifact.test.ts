import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateManagerArtifact, UPSTREAM_POX5 } from "../src/manager-artifact.js";
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

    const artifact = generateManagerArtifact(source, profile);

    expect(artifact.metadata.replacements).toEqual({ pox5: 8, sbtcDeployer: 13 });
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
});
