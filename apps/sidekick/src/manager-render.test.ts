import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { POX5_TESTNET_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import { afterEach, describe, expect, it } from "vitest";
import { assertManagerRenderPreflight, renderManagerDeployment } from "./manager-render.js";

const temporaryDirectories: string[] = [];
const contractsDirectory = resolve(import.meta.dirname, "../../../contracts");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("manager deployment rendering", () => {
  it("requires matched compatibility before rendering on a public network", () => {
    expect(() =>
      assertManagerRenderPreflight("testnet", {
        status: "warn",
        compatibility: {
          status: "unrecognized",
        },
      }),
    ).toThrow("requires a matched network compatibility profile");

    expect(() =>
      assertManagerRenderPreflight("mainnet", {
        status: "fail",
        compatibility: {
          status: "inconsistent",
        },
      }),
    ).toThrow("requires a successful connected preflight");
  });

  it("allows a matched public profile and capability-only local networks", () => {
    expect(() =>
      assertManagerRenderPreflight("testnet", {
        status: "warn",
        compatibility: {
          status: "matched",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertManagerRenderPreflight("devnet", {
        status: "warn",
        compatibility: {
          status: "unrecognized",
        },
      }),
    ).not.toThrow();
  });

  it("writes a reproducible source and external-signing manifest", async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), "sidekick-manager-"));
    temporaryDirectories.push(outputDirectory);

    const rendered = await renderManagerDeployment({
      network: "mainnet",
      adminPrincipal: "SP000000000000000000002Q6VF78",
      contractName: "my-signer-manager",
      contractsDirectory,
      outputDirectory,
    });

    expect(rendered.manifest).toMatchObject({
      managerPrincipal: "SP000000000000000000002Q6VF78.my-signer-manager",
      artifact: {
        sourceSha256: "05aaf409ed285f02d8b6d5d540f94feb8baea139a14263b7e7de7ba9f054d3c5",
      },
      transaction: {
        clarityVersion: 6,
        signingAuthority: "external-offline-admin",
      },
      operatorReviewRequired: true,
    });
    expect(await readFile(rendered.sourcePath, "utf8")).toContain("(define-public (register-self");
    expect(JSON.parse(await readFile(rendered.manifestPath, "utf8"))).toEqual(rendered.manifest);
    expect(JSON.stringify(rendered.manifest)).not.toMatch(/private.?key|mnemonic/i);
  });

  it("refuses to overwrite an existing deployment artifact", async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), "sidekick-manager-"));
    temporaryDirectories.push(outputDirectory);
    const options = {
      network: "mainnet" as const,
      adminPrincipal: "SP000000000000000000002Q6VF78",
      contractName: "my-signer-manager",
      contractsDirectory,
      outputDirectory,
    };

    await renderManagerDeployment(options);
    await expect(renderManagerDeployment(options)).rejects.toThrow("EEXIST");
  });

  it("renders an operator-profile manager without a compiled testnet artifact", async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), "sidekick-manager-"));
    temporaryDirectories.push(outputDirectory);

    const rendered = await renderManagerDeployment({
      network: "testnet",
      adminPrincipal: "ST000000000000000000002AMW42H",
      contractName: "signer-manager",
      contractsDirectory,
      outputDirectory,
      compatibilityProfile: POX5_TESTNET_COMPATIBILITY,
    });

    expect(rendered.manifest).toMatchObject({
      profile: {
        id: "stacks-pox5-testnet-4.0.1-reference-manager",
        compatibilityProfileId: POX5_TESTNET_COMPATIBILITY.id,
        compatibilityProfileRevision: 1,
      },
      artifact: { sourceSha256: POX5_TESTNET_COMPATIBILITY.referenceManager.sourceSha256 },
      operatorReviewRequired: true,
    });
  });

  it("rejects a manager admin from the wrong network", async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), "sidekick-manager-"));
    temporaryDirectories.push(outputDirectory);

    await expect(
      renderManagerDeployment({
        network: "testnet",
        adminPrincipal: "SP000000000000000000002Q6VF78",
        contractName: "manager",
        contractsDirectory,
        outputDirectory,
      }),
    ).rejects.toThrow(/reviewed manager profile|selected network/);
  });
});
