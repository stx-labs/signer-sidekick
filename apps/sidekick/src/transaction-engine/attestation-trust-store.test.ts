import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompatibilityTrustStoreFileError,
  loadCompatibilityAttestationTrustKeys,
} from "./attestation-trust-store.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sidekick-trust-store-"));
  directories.push(directory);
  return directory;
}

function publicKeyPem(): string {
  return generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
}

function key(overrides: Record<string, unknown> = {}) {
  return {
    keyId: "release-a",
    issuer: "stacks-labs",
    algorithm: "ed25519",
    publicKeyPem: publicKeyPem(),
    ...overrides,
  };
}

describe("compatibility attestation trust store", () => {
  it("loads a bounded regular public-key set and applies safe defaults", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "trust.json");
    await writeFile(path, JSON.stringify([key()]), { mode: 0o600 });

    await expect(loadCompatibilityAttestationTrustKeys(path)).resolves.toMatchObject([
      { keyId: "release-a", issuer: "stacks-labs", revoked: false },
    ]);
  });

  it("rejects relative paths, links, malformed input, duplicate identities, and oversized files", async () => {
    await expect(loadCompatibilityAttestationTrustKeys("trust.json")).rejects.toBeInstanceOf(
      CompatibilityTrustStoreFileError,
    );
    const directory = await temporaryDirectory();
    const path = join(directory, "trust.json");
    const link = join(directory, "trust-link.json");

    await writeFile(path, "not-json", { mode: 0o600 });
    await expect(loadCompatibilityAttestationTrustKeys(path)).rejects.toThrow("not valid JSON");

    await writeFile(path, JSON.stringify([key(), key()]), { mode: 0o600 });
    await expect(loadCompatibilityAttestationTrustKeys(path)).rejects.toThrow("schema validation");

    await writeFile(path, "[]".padEnd(128, " "), { mode: 0o600 });
    await expect(loadCompatibilityAttestationTrustKeys(path, 64)).rejects.toThrow("size limit");

    await writeFile(path, JSON.stringify([key()]), { mode: 0o600 });
    await symlink(path, link);
    await expect(loadCompatibilityAttestationTrustKeys(link)).rejects.toThrow("read safely");
    await chmod(path, 0o600);
  });
});
