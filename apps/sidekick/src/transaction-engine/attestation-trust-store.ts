import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  type CompatibilityAttestationTrustKey,
  compatibilityAttestationTrustKeySchema,
} from "@stx-labs/signer-sidekick-protocol/compatibility-attestation";
import { z } from "zod";

const trustKeySetSchema = z
  .array(compatibilityAttestationTrustKeySchema)
  .min(1)
  .max(32)
  .superRefine((keys, context) => {
    const identities = new Set<string>();
    for (const [index, key] of keys.entries()) {
      const identity = `${key.issuer}:${key.keyId}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: [index, "keyId"],
          message: "Attestation trust-key identities must be unique",
        });
      }
      identities.add(identity);
    }
  });

export class CompatibilityTrustStoreFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompatibilityTrustStoreFileError";
  }
}

/** Load a small public-key trust store without following a final-component symbolic link. */
export async function loadCompatibilityAttestationTrustKeys(
  path: string,
  maximumBytes = 64 * 1024,
): Promise<readonly CompatibilityAttestationTrustKey[]> {
  if (!isAbsolute(path)) {
    throw new CompatibilityTrustStoreFileError("Attestation trust store path must be absolute");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1024 * 1024) {
    throw new CompatibilityTrustStoreFileError("Attestation trust store size limit is invalid");
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new CompatibilityTrustStoreFileError("Attestation trust store is not a file");
    }
    if (before.size < 1 || before.size > maximumBytes) {
      throw new CompatibilityTrustStoreFileError(
        "Attestation trust store is empty or exceeds the size limit",
      );
    }
    const encoded = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new CompatibilityTrustStoreFileError(
        "Attestation trust store changed while it was being read",
      );
    }
    if (Buffer.byteLength(encoded, "utf8") > maximumBytes) {
      throw new CompatibilityTrustStoreFileError("Attestation trust store exceeds the size limit");
    }
    let input: unknown;
    try {
      input = JSON.parse(encoded) as unknown;
    } catch (error) {
      throw new CompatibilityTrustStoreFileError("Attestation trust store is not valid JSON", {
        cause: error,
      });
    }
    const parsed = trustKeySetSchema.safeParse(input);
    if (!parsed.success) {
      throw new CompatibilityTrustStoreFileError(
        "Attestation trust store schema validation failed",
        { cause: parsed.error },
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof CompatibilityTrustStoreFileError) throw error;
    throw new CompatibilityTrustStoreFileError("Attestation trust store cannot be read safely", {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}
