import { readFileSync } from "node:fs";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const operatorRunSecurityReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["pending", "approved"]),
    sourceFingerprint: sha256Schema,
    reviewedCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    reviewedAt: z.iso.datetime().nullable(),
    reviewer: z.string().min(1).max(200).nullable(),
    reviewUrl: z
      .url()
      .refine((value) => new URL(value).protocol === "https:", "Review URL must use HTTPS")
      .nullable(),
  })
  .strict();

export interface OperatorRunSecurityReviewPaths {
  reviewPath: string | null;
  sourceFingerprintPath: string | null;
}

function readText(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new Error(`Mainnet operator-run ${label} could not be read`, { cause: error });
  }
}

/**
 * Mainnet operator-run is available only in a build whose exact source fingerprint received the
 * scoped review in ADR 0010. This is a release/process gate, not a boundary against host root.
 */
export function verifyMainnetOperatorRunSecurityReview(
  paths: OperatorRunSecurityReviewPaths,
): void {
  if (paths.reviewPath === null || paths.sourceFingerprintPath === null) {
    throw new Error(
      "Mainnet operator-run requires an approved security-reviewed build; use Observe or an official reviewed release",
    );
  }

  let review: z.infer<typeof operatorRunSecurityReviewSchema>;
  try {
    review = operatorRunSecurityReviewSchema.parse(
      JSON.parse(readText(paths.reviewPath, "security review record")),
    );
  } catch (error) {
    throw new Error("Mainnet operator-run security review record is invalid", { cause: error });
  }

  if (
    review.status !== "approved" ||
    review.reviewedCommit === null ||
    review.reviewedAt === null ||
    review.reviewer === null ||
    review.reviewUrl === null
  ) {
    throw new Error("Mainnet operator-run security review is pending");
  }

  const sourceFingerprint = readText(
    paths.sourceFingerprintPath,
    "source fingerprint",
  ).toLowerCase();
  if (!sha256Schema.safeParse(sourceFingerprint).success) {
    throw new Error("Mainnet operator-run source fingerprint is invalid");
  }
  if (sourceFingerprint !== review.sourceFingerprint) {
    throw new Error(
      "Mainnet operator-run source changed after security review; use Observe until the current build is reviewed",
    );
  }
}
