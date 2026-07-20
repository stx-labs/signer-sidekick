import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type CompatibilityAttestationErrorCode,
  type CompatibilityAttestationPayload,
  type CompatibilityAttestationTrustKey,
  compatibilityAttestationPayloadSha256,
  compatibilityAttestationSigningBytes,
  type SignedCompatibilityAttestation,
  verifyCompatibilityAttestation,
} from "../src/compatibility-attestation.js";
import { POX5_TESTNET_COMPATIBILITY } from "../src/known-network-compatibility.js";

const now = new Date("2026-07-17T12:00:00.000Z");

function keyPair(keyId: string, issuer = "stacks-labs") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustKey: CompatibilityAttestationTrustKey = {
    keyId,
    issuer,
    algorithm: "ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  return { privateKey, trustKey };
}

function payload(overrides: Partial<CompatibilityAttestationPayload> = {}) {
  return {
    schemaVersion: 1,
    issuer: "stacks-labs",
    revision: 1,
    issuedAt: "2026-07-17T00:00:00.000Z",
    notBefore: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-07-18T00:00:00.000Z",
    profile: POX5_TESTNET_COMPATIBILITY,
    ...overrides,
  } as CompatibilityAttestationPayload;
}

function signed(
  value: CompatibilityAttestationPayload,
  keyId: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): SignedCompatibilityAttestation {
  return {
    schemaVersion: 1,
    algorithm: "ed25519",
    keyId,
    payload: value,
    signature: sign(null, compatibilityAttestationSigningBytes(value), privateKey).toString(
      "base64",
    ),
  };
}

function expectCode(run: () => unknown, code: CompatibilityAttestationErrorCode) {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected compatibility attestation error ${code}`);
}

describe("compatibility attestations", () => {
  it("keeps the V1 signature domain and fixed vector stable", () => {
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"),
      ]),
      format: "der",
      type: "pkcs8",
    });
    const signingBytes = compatibilityAttestationSigningBytes(payload());

    expect(createHash("sha256").update(signingBytes).digest("hex")).toBe(
      "1b3a8d1cc7a94a45d49b5017b109751d4ac5f5be48f5e6014ba984c0f9a90d4e",
    );
    expect(sign(null, signingBytes, privateKey).toString("base64")).toBe(
      "8b43SMbjzmvzfKXzzRoEVOE6cqMCDUadNHes0l69hBAuZDovc7Wy4Uwsufi7bjL5smhRsJ3+c2z5HvLshtJdBA==",
    );
  });

  it("rejects a signature over the bare canonical payload", () => {
    const signer = keyPair("release-2026-a");
    const value = payload();
    const signingBytes = Buffer.from(compatibilityAttestationSigningBytes(value));
    const separator = signingBytes.indexOf(0);
    expect(separator).toBeGreaterThan(0);
    const document = signed(value, signer.trustKey.keyId, signer.privateKey);
    document.signature = sign(
      null,
      signingBytes.subarray(separator + 1),
      signer.privateKey,
    ).toString("base64");

    expectCode(
      () => verifyCompatibilityAttestation(document, { trustKeys: [signer.trustKey], now }),
      "invalid-signature",
    );
  });

  it("verifies an exact signed profile and returns durable accepted state", () => {
    const { privateKey, trustKey } = keyPair("release-2026-a");
    const value = payload();
    const result = verifyCompatibilityAttestation(signed(value, trustKey.keyId, privateKey), {
      trustKeys: [trustKey],
      now,
    });

    expect(result.profile).toEqual(POX5_TESTNET_COMPATIBILITY);
    expect(result.payloadSha256).toBe(compatibilityAttestationPayloadSha256(value));
    expect(result.acceptedState).toEqual({
      issuer: "stacks-labs",
      revision: 1,
      payloadSha256: result.payloadSha256,
      verifiedAt: now.toISOString(),
    });
  });

  it("rejects payload tampering and unknown document fields", () => {
    const { privateKey, trustKey } = keyPair("release-2026-a");
    const document = signed(payload(), trustKey.keyId, privateKey);
    const tampered = {
      ...document,
      payload: {
        ...document.payload,
        profile: {
          ...document.payload.profile,
          provenance: { ...document.payload.profile.provenance, notes: "tampered" },
        },
      },
    };

    expectCode(
      () => verifyCompatibilityAttestation(tampered, { trustKeys: [trustKey], now }),
      "invalid-signature",
    );
    expectCode(
      () =>
        verifyCompatibilityAttestation(
          { ...document, adapter: "arbitrary-call" },
          { trustKeys: [trustKey], now },
        ),
      "invalid-document",
    );
  });

  it("rejects unknown, mismatched, revoked, and inactive trust keys", () => {
    const signer = keyPair("release-2026-a");
    const document = signed(payload(), signer.trustKey.keyId, signer.privateKey);

    expectCode(
      () => verifyCompatibilityAttestation(document, { trustKeys: [], now }),
      "unknown-key",
    );
    expectCode(
      () =>
        verifyCompatibilityAttestation(document, {
          trustKeys: [{ ...signer.trustKey, issuer: "someone-else" }],
          now,
        }),
      "issuer-mismatch",
    );
    expectCode(
      () =>
        verifyCompatibilityAttestation(document, {
          trustKeys: [{ ...signer.trustKey, revoked: true }],
          now,
        }),
      "revoked-key",
    );
    expectCode(
      () =>
        verifyCompatibilityAttestation(document, {
          trustKeys: [{ ...signer.trustKey, notBefore: "2026-07-18T00:00:00.000Z" }],
          now,
        }),
      "key-not-current",
    );
  });

  it("accepts an overlapping rotated key and rejects an invalid signature", () => {
    const oldKey = keyPair("release-2026-a");
    const newKey = keyPair("release-2026-b");
    const value = payload({ revision: 2 });
    const document = signed(value, newKey.trustKey.keyId, newKey.privateKey);

    expect(
      verifyCompatibilityAttestation(document, {
        trustKeys: [oldKey.trustKey, newKey.trustKey],
        now,
      }).document.keyId,
    ).toBe("release-2026-b");
    expectCode(
      () =>
        verifyCompatibilityAttestation(
          { ...document, keyId: oldKey.trustKey.keyId },
          { trustKeys: [oldKey.trustKey, newKey.trustKey], now },
        ),
      "invalid-signature",
    );
  });

  it("rejects not-yet-valid, expired, and oversized documents", () => {
    const { privateKey, trustKey } = keyPair("release-2026-a");
    expectCode(
      () =>
        verifyCompatibilityAttestation(
          signed(
            payload({
              issuedAt: "2026-07-17T13:00:00.000Z",
              notBefore: "2026-07-17T13:00:00.000Z",
            }),
            trustKey.keyId,
            privateKey,
          ),
          { trustKeys: [trustKey], now },
        ),
      "not-yet-valid",
    );
    expectCode(
      () =>
        verifyCompatibilityAttestation(
          signed(
            payload({
              issuedAt: "2026-07-15T00:00:00.000Z",
              notBefore: "2026-07-15T00:00:00.000Z",
              expiresAt: "2026-07-16T00:00:00.000Z",
            }),
            trustKey.keyId,
            privateKey,
          ),
          { trustKeys: [trustKey], now },
        ),
      "expired",
    );
    expectCode(
      () =>
        verifyCompatibilityAttestation(signed(payload(), trustKey.keyId, privateKey), {
          trustKeys: [trustKey],
          now,
          maximumDocumentBytes: 10,
        }),
      "document-too-large",
    );
  });

  it("rejects downgrade, same-revision conflict, and clock regression", () => {
    const { privateKey, trustKey } = keyPair("release-2026-a");
    const acceptedPayload = payload({ revision: 2 });
    const acceptedState = {
      issuer: "stacks-labs",
      revision: 2,
      payloadSha256: compatibilityAttestationPayloadSha256(acceptedPayload),
      verifiedAt: "2026-07-17T11:00:00.000Z",
    };

    expectCode(
      () =>
        verifyCompatibilityAttestation(signed(payload(), trustKey.keyId, privateKey), {
          trustKeys: [trustKey],
          now,
          acceptedState,
        }),
      "revision-downgrade",
    );
    const conflict = payload({ revision: 2, expiresAt: "2026-07-19T00:00:00.000Z" });
    expectCode(
      () =>
        verifyCompatibilityAttestation(signed(conflict, trustKey.keyId, privateKey), {
          trustKeys: [trustKey],
          now,
          acceptedState,
        }),
      "revision-conflict",
    );
    expectCode(
      () =>
        verifyCompatibilityAttestation(signed(acceptedPayload, trustKey.keyId, privateKey), {
          trustKeys: [trustKey],
          now: new Date("2026-07-17T10:00:00.000Z"),
          acceptedState,
        }),
      "clock-regression",
    );
  });
});
