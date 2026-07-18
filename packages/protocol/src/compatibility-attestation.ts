import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import {
  type NetworkCompatibilityProfile,
  networkCompatibilityProfileSchema,
} from "./network-compatibility.js";

const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const signatureDomain = "signer-sidekick:compatibility-attestation:v1";
const base64SignatureSchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{86}==$/)
  .refine((value) => Buffer.from(value, "base64").length === 64, "Expected Ed25519 signature");

export const compatibilityAttestationPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    issuer: identifierSchema,
    revision: z.number().int().positive(),
    issuedAt: z.iso.datetime(),
    notBefore: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    profile: networkCompatibilityProfileSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    const issuedAt = Date.parse(payload.issuedAt);
    const notBefore = Date.parse(payload.notBefore);
    const expiresAt = Date.parse(payload.expiresAt);
    if (issuedAt > notBefore) {
      context.addIssue({
        code: "custom",
        path: ["notBefore"],
        message: "notBefore must be at or after issuedAt",
      });
    }
    if (notBefore >= expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must be after notBefore",
      });
    }
  });

export const signedCompatibilityAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("ed25519"),
    keyId: identifierSchema,
    payload: compatibilityAttestationPayloadSchema,
    signature: base64SignatureSchema,
  })
  .strict();

export const compatibilityAttestationTrustKeySchema = z
  .object({
    keyId: identifierSchema,
    issuer: identifierSchema,
    algorithm: z.literal("ed25519"),
    publicKeyPem: z.string().min(1).max(10_000),
    notBefore: z.iso.datetime().optional(),
    notAfter: z.iso.datetime().optional(),
    revoked: z.boolean().default(false),
  })
  .strict();

export type CompatibilityAttestationPayload = z.infer<typeof compatibilityAttestationPayloadSchema>;
export type SignedCompatibilityAttestation = z.infer<typeof signedCompatibilityAttestationSchema>;
export type CompatibilityAttestationTrustKey = z.input<
  typeof compatibilityAttestationTrustKeySchema
>;

export type CompatibilityAttestationErrorCode =
  | "document-too-large"
  | "invalid-document"
  | "unknown-key"
  | "issuer-mismatch"
  | "revoked-key"
  | "key-not-current"
  | "clock-regression"
  | "not-yet-valid"
  | "expired"
  | "invalid-signature"
  | "revision-downgrade"
  | "revision-conflict";

export class CompatibilityAttestationError extends Error {
  constructor(
    readonly code: CompatibilityAttestationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CompatibilityAttestationError";
  }
}

export interface AcceptedCompatibilityAttestationState {
  issuer: string;
  revision: number;
  payloadSha256: string;
  verifiedAt: string;
}

export interface VerifiedCompatibilityAttestation {
  document: SignedCompatibilityAttestation;
  profile: NetworkCompatibilityProfile;
  payloadSha256: string;
  verifiedAt: string;
  acceptedState: AcceptedCompatibilityAttestationState;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON accepts only parsed JSON values");
}

export function compatibilityAttestationSigningBytes(
  payload: CompatibilityAttestationPayload,
): Uint8Array {
  const parsed = compatibilityAttestationPayloadSchema.parse(payload);
  return Buffer.from(`${signatureDomain}\0${canonicalJson(parsed)}`, "utf8");
}

export function compatibilityAttestationPayloadSha256(
  payload: CompatibilityAttestationPayload,
): string {
  return createHash("sha256").update(compatibilityAttestationSigningBytes(payload)).digest("hex");
}

function attestationError(
  code: CompatibilityAttestationErrorCode,
  message: string,
  cause?: unknown,
): CompatibilityAttestationError {
  return new CompatibilityAttestationError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function parseInstant(value: string, label: string): number {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw attestationError("invalid-document", `${label} is invalid`);
  return instant;
}

export function verifyCompatibilityAttestation(
  input: unknown,
  options: {
    trustKeys: readonly CompatibilityAttestationTrustKey[];
    now?: Date;
    acceptedState?: AcceptedCompatibilityAttestationState | null;
    maximumDocumentBytes?: number;
  },
): VerifiedCompatibilityAttestation {
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch (error) {
    throw attestationError("invalid-document", "Attestation must be JSON-serializable", error);
  }
  const maximumDocumentBytes = options.maximumDocumentBytes ?? 64 * 1024;
  if (Buffer.byteLength(encoded, "utf8") > maximumDocumentBytes) {
    throw attestationError("document-too-large", "Attestation exceeds the configured size limit");
  }

  const parsed = signedCompatibilityAttestationSchema.safeParse(input);
  if (!parsed.success) {
    throw attestationError(
      "invalid-document",
      "Attestation schema validation failed",
      parsed.error,
    );
  }
  const document = parsed.data;
  const trustKeys = options.trustKeys.map((key) => {
    const result = compatibilityAttestationTrustKeySchema.safeParse(key);
    if (!result.success) {
      throw attestationError("invalid-document", "Attestation trust key is invalid", result.error);
    }
    return result.data;
  });
  const trustKey = trustKeys.find((key) => key.keyId === document.keyId);
  if (!trustKey) throw attestationError("unknown-key", `Unknown attestation key ${document.keyId}`);
  if (trustKey.issuer !== document.payload.issuer) {
    throw attestationError("issuer-mismatch", "Attestation issuer does not match its trust key");
  }
  if (trustKey.revoked) {
    throw attestationError("revoked-key", `Attestation key ${document.keyId} is revoked`);
  }

  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs))
    throw attestationError("invalid-document", "Verification time is invalid");
  const verifiedAt = now.toISOString();
  const acceptedState = options.acceptedState ?? null;
  if (acceptedState && nowMs < parseInstant(acceptedState.verifiedAt, "acceptedState.verifiedAt")) {
    throw attestationError("clock-regression", "Verification clock moved behind accepted state");
  }
  if (trustKey.notBefore && nowMs < parseInstant(trustKey.notBefore, "trustKey.notBefore")) {
    throw attestationError("key-not-current", "Attestation key is not active yet");
  }
  if (trustKey.notAfter && nowMs >= parseInstant(trustKey.notAfter, "trustKey.notAfter")) {
    throw attestationError("key-not-current", "Attestation key is no longer active");
  }
  if (nowMs < parseInstant(document.payload.notBefore, "payload.notBefore")) {
    throw attestationError("not-yet-valid", "Attestation is not valid yet");
  }
  if (nowMs >= parseInstant(document.payload.expiresAt, "payload.expiresAt")) {
    throw attestationError("expired", "Attestation has expired");
  }

  const signingBytes = compatibilityAttestationSigningBytes(document.payload);
  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      signingBytes,
      createPublicKey(trustKey.publicKeyPem),
      Buffer.from(document.signature, "base64"),
    );
  } catch (error) {
    throw attestationError(
      "invalid-signature",
      "Attestation signature could not be verified",
      error,
    );
  }
  if (!signatureValid) {
    throw attestationError("invalid-signature", "Attestation signature is invalid");
  }

  const payloadSha256 = createHash("sha256").update(signingBytes).digest("hex");
  if (acceptedState?.issuer === document.payload.issuer) {
    if (document.payload.revision < acceptedState.revision) {
      throw attestationError(
        "revision-downgrade",
        "Attestation revision is older than accepted state",
      );
    }
    if (
      document.payload.revision === acceptedState.revision &&
      payloadSha256 !== acceptedState.payloadSha256
    ) {
      throw attestationError(
        "revision-conflict",
        "Attestation revision conflicts with accepted state",
      );
    }
  }

  return {
    document,
    profile: document.payload.profile,
    payloadSha256,
    verifiedAt,
    acceptedState: {
      issuer: document.payload.issuer,
      revision: document.payload.revision,
      payloadSha256,
      verifiedAt,
    },
  };
}
