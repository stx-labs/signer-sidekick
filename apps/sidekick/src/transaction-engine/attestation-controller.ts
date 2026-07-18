import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import {
  type AcceptedCompatibilityAttestationState,
  type CompatibilityAttestationTrustKey,
  type SignedCompatibilityAttestation,
  signedCompatibilityAttestationSchema,
  type VerifiedCompatibilityAttestation,
  verifyCompatibilityAttestation,
} from "@stx-labs/signer-sidekick-protocol/compatibility-attestation";

export interface StoredCompatibilityAttestation {
  acceptedState: AcceptedCompatibilityAttestationState;
  document: SignedCompatibilityAttestation;
  acceptedAt: string;
}

export interface CompatibilityAttestationRepository {
  get(issuer: string): Promise<StoredCompatibilityAttestation | null>;
  accept(
    record: StoredCompatibilityAttestation,
    expected: AcceptedCompatibilityAttestationState | null,
  ): Promise<void>;
}

export interface CompatibilityAttestationScope {
  network: SignedCompatibilityAttestation["payload"]["profile"]["network"];
  networkId: number;
}

export class CompatibilityAttestationFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompatibilityAttestationFileError";
  }
}

async function readBoundedRegularFile(path: string, maximumBytes: number): Promise<unknown> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = await handle.stat();
    if (!file.isFile()) throw new CompatibilityAttestationFileError("Attestation is not a file");
    if (file.size < 1) throw new CompatibilityAttestationFileError("Attestation file is empty");
    if (file.size > maximumBytes) {
      throw new CompatibilityAttestationFileError("Attestation file exceeds the size limit");
    }
    const encoded = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(encoded, "utf8") > maximumBytes) {
      throw new CompatibilityAttestationFileError("Attestation file exceeds the size limit");
    }
    try {
      return JSON.parse(encoded) as unknown;
    } catch (error) {
      throw new CompatibilityAttestationFileError("Attestation file is not valid JSON", {
        cause: error,
      });
    }
  } catch (error) {
    if (error instanceof CompatibilityAttestationFileError) throw error;
    throw new CompatibilityAttestationFileError("Attestation file cannot be read safely", {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

export class CompatibilityAttestationController {
  constructor(
    private readonly repository: CompatibilityAttestationRepository,
    private readonly trustKeys: readonly CompatibilityAttestationTrustKey[],
    private readonly expectedScope: CompatibilityAttestationScope,
    private readonly maximumDocumentBytes = 64 * 1024,
  ) {}

  private assertExpectedScope(document: SignedCompatibilityAttestation): void {
    const { network, networkId } = document.payload.profile;
    if (network !== this.expectedScope.network || networkId !== this.expectedScope.networkId) {
      throw new CompatibilityAttestationFileError(
        `Attestation network ${network}:${networkId} does not match configured network ${this.expectedScope.network}:${this.expectedScope.networkId}`,
      );
    }
  }

  async acceptFile(path: string, now = new Date()): Promise<VerifiedCompatibilityAttestation> {
    const input = await readBoundedRegularFile(path, this.maximumDocumentBytes);
    const document = signedCompatibilityAttestationSchema.parse(input);
    this.assertExpectedScope(document);
    const previous = await this.repository.get(document.payload.issuer);
    const verified = verifyCompatibilityAttestation(document, {
      trustKeys: this.trustKeys,
      now,
      acceptedState: previous?.acceptedState ?? null,
      maximumDocumentBytes: this.maximumDocumentBytes,
    });
    await this.repository.accept(
      {
        acceptedState: verified.acceptedState,
        document: verified.document,
        acceptedAt: verified.verifiedAt,
      },
      previous?.acceptedState ?? null,
    );
    return verified;
  }

  async verifyCached(
    issuer: string,
    now = new Date(),
  ): Promise<VerifiedCompatibilityAttestation | null> {
    const cached = await this.repository.get(issuer);
    if (!cached) return null;
    this.assertExpectedScope(cached.document);
    const verified = verifyCompatibilityAttestation(cached.document, {
      trustKeys: this.trustKeys,
      now,
      acceptedState: cached.acceptedState,
      maximumDocumentBytes: this.maximumDocumentBytes,
    });
    await this.repository.accept(
      {
        ...cached,
        acceptedState: verified.acceptedState,
        acceptedAt: verified.verifiedAt,
      },
      cached.acceptedState,
    );
    return verified;
  }
}
