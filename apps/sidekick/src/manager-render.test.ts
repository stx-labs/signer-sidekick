import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderManagerDeployment } from "./manager-render.js";

const temporaryDirectories: string[] = [];
const contractsDirectory = resolve(import.meta.dirname, "../../../contracts");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("manager deployment rendering", () => {
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
      profile: { productionApproved: false },
      artifact: {
        sourceSha256: "c0a2cc8e83de2b1bc60e07c5e0f5da8991c6f79eb05d077bba8cb984eee226b3",
      },
      transaction: {
        clarityVersion: 6,
        signingAuthority: "external-offline-admin",
      },
      deploymentAllowed: false,
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
