import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AcceptedCompatibilityAttestationState,
  type CompatibilityAttestationPayload,
  type CompatibilityAttestationTrustKey,
  compatibilityAttestationSigningBytes,
  type SignedCompatibilityAttestation,
} from "@stx-labs/signer-sidekick-protocol/compatibility-attestation";
import {
  MAINNET_4_0_1_COMPATIBILITY,
  POX5_TESTNET_COMPATIBILITY,
} from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import { describe, expect, it } from "vitest";
import {
  CompatibilityAttestationController,
  CompatibilityAttestationFileError,
  type CompatibilityAttestationRepository,
  type StoredCompatibilityAttestation,
} from "./attestation-controller.js";

const now = new Date("2026-07-17T12:00:00.000Z");
const expectedScope = {
  network: POX5_TESTNET_COMPATIBILITY.network,
  networkId: POX5_TESTNET_COMPATIBILITY.networkId,
} as const;

function keyPair() {
  const keys = generateKeyPairSync("ed25519");
  const trustKey: CompatibilityAttestationTrustKey = {
    keyId: "release-a",
    issuer: "stacks-labs",
    algorithm: "ed25519",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  return { privateKey: keys.privateKey, trustKey };
}

function payload(revision = 1): CompatibilityAttestationPayload {
  return {
    schemaVersion: 1,
    issuer: "stacks-labs",
    revision,
    issuedAt: "2026-07-17T00:00:00.000Z",
    notBefore: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-07-18T00:00:00.000Z",
    profile: POX5_TESTNET_COMPATIBILITY,
  };
}

function signed(
  value: CompatibilityAttestationPayload,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): SignedCompatibilityAttestation {
  return {
    schemaVersion: 1,
    algorithm: "ed25519",
    keyId: "release-a",
    payload: value,
    signature: sign(null, compatibilityAttestationSigningBytes(value), privateKey).toString(
      "base64",
    ),
  };
}

class MemoryRepository implements CompatibilityAttestationRepository {
  readonly records = new Map<string, StoredCompatibilityAttestation>();

  async get(issuer: string): Promise<StoredCompatibilityAttestation | null> {
    return this.records.get(issuer) ?? null;
  }

  async accept(
    record: StoredCompatibilityAttestation,
    expected: AcceptedCompatibilityAttestationState | null,
  ): Promise<void> {
    const current = this.records.get(record.acceptedState.issuer);
    if (
      (current === undefined) !== (expected === null) ||
      (current &&
        expected &&
        (current.acceptedState.revision !== expected.revision ||
          current.acceptedState.payloadSha256 !== expected.payloadSha256))
    ) {
      throw new Error("attestation acceptance changed concurrently");
    }
    this.records.set(record.acceptedState.issuer, structuredClone(record));
  }
}

async function writeDocument(directory: string, document: unknown, name = "attestation.json") {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  return path;
}

describe("compatibility attestation controller", () => {
  it("accepts a signed file and verifies its durable cached copy after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-attestation-"));
    const keys = keyPair();
    const repository = new MemoryRepository();
    const path = await writeDocument(directory, signed(payload(), keys.privateKey));
    const controller = new CompatibilityAttestationController(
      repository,
      [keys.trustKey],
      expectedScope,
    );

    const accepted = await controller.acceptFile(path, now);
    const restarted = new CompatibilityAttestationController(
      repository,
      [keys.trustKey],
      expectedScope,
    );
    const cached = await restarted.verifyCached("stacks-labs", now);

    expect(cached?.payloadSha256).toBe(accepted.payloadSha256);
    expect(repository.records.get("stacks-labs")?.document).toEqual(accepted.document);
  });

  it("rejects downgrade through durable accepted state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-attestation-"));
    const keys = keyPair();
    const repository = new MemoryRepository();
    const controller = new CompatibilityAttestationController(
      repository,
      [keys.trustKey],
      expectedScope,
    );
    await controller.acceptFile(
      await writeDocument(directory, signed(payload(2), keys.privateKey), "revision-2.json"),
      now,
    );

    await expect(
      controller.acceptFile(
        await writeDocument(directory, signed(payload(1), keys.privateKey), "revision-1.json"),
        now,
      ),
    ).rejects.toMatchObject({ code: "revision-downgrade" });
  });

  it("rejects the wrong network before changing durable revision state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-attestation-"));
    const keys = keyPair();
    const repository = new MemoryRepository();
    const controller = new CompatibilityAttestationController(
      repository,
      [keys.trustKey],
      expectedScope,
    );
    const wrongNetwork = {
      ...payload(2),
      profile: MAINNET_4_0_1_COMPATIBILITY,
    };

    await expect(
      controller.acceptFile(
        await writeDocument(directory, signed(wrongNetwork, keys.privateKey), "mainnet.json"),
        now,
      ),
    ).rejects.toThrow("does not match configured network");
    expect(repository.records.size).toBe(0);

    await expect(
      controller.acceptFile(
        await writeDocument(directory, signed(payload(1), keys.privateKey), "testnet.json"),
        now,
      ),
    ).resolves.toMatchObject({ document: { payload: { revision: 1 } } });
  });

  it("fails closed for malformed, oversized, empty, and symlinked input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-attestation-"));
    const keys = keyPair();
    const controller = new CompatibilityAttestationController(
      new MemoryRepository(),
      [keys.trustKey],
      expectedScope,
      128,
    );
    const malformed = join(directory, "malformed.json");
    await writeFile(malformed, "{", { mode: 0o600 });
    const oversized = join(directory, "oversized.json");
    await writeFile(oversized, "x".repeat(129), { mode: 0o600 });
    const empty = join(directory, "empty.json");
    await writeFile(empty, "", { mode: 0o600 });
    const link = join(directory, "link.json");
    await symlink(malformed, link);

    for (const path of [malformed, oversized, empty, link]) {
      await expect(controller.acceptFile(path, now)).rejects.toBeInstanceOf(
        CompatibilityAttestationFileError,
      );
    }
  });

  it("reads an opened file snapshot even when its path is replaced later", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-attestation-"));
    const keys = keyPair();
    const path = await writeDocument(directory, signed(payload(), keys.privateKey));
    await chmod(path, 0o400);
    const controller = new CompatibilityAttestationController(
      new MemoryRepository(),
      [keys.trustKey],
      expectedScope,
    );

    await expect(controller.acceptFile(path, now)).resolves.toMatchObject({
      document: { payload: { revision: 1 } },
    });
  });
});
