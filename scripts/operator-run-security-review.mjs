import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { calculateSourceFingerprint } from "./source-fingerprint.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;
const recordKeys = [
  "reviewUrl",
  "reviewedAt",
  "reviewedCommit",
  "reviewer",
  "schemaVersion",
  "sourceFingerprint",
  "status",
];

function validReviewFields(review) {
  return (
    (review.reviewedCommit === null || commit.test(review.reviewedCommit)) &&
    (review.reviewedAt === null ||
      (typeof review.reviewedAt === "string" && Number.isFinite(Date.parse(review.reviewedAt)))) &&
    (review.reviewer === null ||
      (typeof review.reviewer === "string" &&
        review.reviewer.length > 0 &&
        review.reviewer.length <= 200)) &&
    (review.reviewUrl === null ||
      (typeof review.reviewUrl === "string" &&
        URL.canParse(review.reviewUrl) &&
        new URL(review.reviewUrl).protocol === "https:"))
  );
}

/**
 * Verifies the committed review record the same way the runtime loader does: a malformed record
 * is invalid, a record without a complete approval is pending, and an approved record must match
 * the current source fingerprint exactly.
 *
 * `allowPending` lets release automation proceed while the review is pending — the runtime still
 * refuses mainnet operator-run until the record is approved — without ever accepting an invalid or
 * stale-approved record.
 */
export async function verifyOperatorRunSecurityReview(options = {}) {
  const reviewPath =
    options.reviewPath ?? resolve(root, "security/operator-run-mainnet-review.json");
  const allowPending = options.allowPending === true;
  let review;
  try {
    review = JSON.parse(await readFile(reviewPath, "utf8"));
  } catch (error) {
    throw new Error("Operator-run security review record could not be read", { cause: error });
  }
  if (
    review === null ||
    typeof review !== "object" ||
    Array.isArray(review) ||
    JSON.stringify(Object.keys(review).sort()) !== JSON.stringify(recordKeys) ||
    review.schemaVersion !== 1 ||
    !["pending", "approved"].includes(review.status) ||
    !sha256.test(review.sourceFingerprint ?? "") ||
    !validReviewFields(review)
  ) {
    throw new Error("Operator-run security review record is invalid");
  }
  if (
    review.status !== "approved" ||
    review.reviewedCommit === null ||
    review.reviewedAt === null ||
    review.reviewer === null ||
    review.reviewUrl === null
  ) {
    if (allowPending) return review;
    throw new Error("Operator-run security review is pending");
  }
  const sourceFingerprint = options.sourceFingerprint ?? (await calculateSourceFingerprint());
  if (review.sourceFingerprint !== sourceFingerprint) {
    throw new Error(
      `Operator-run security review is stale: reviewed ${review.sourceFingerprint}, current ${sourceFingerprint}`,
    );
  }
  return review;
}

async function main() {
  const allowPending = process.argv.includes("--allow-pending");
  const review = await verifyOperatorRunSecurityReview({ allowPending });
  process.stdout.write(
    review.status === "approved"
      ? `Verified operator-run security review ${review.sourceFingerprint} (${review.reviewUrl})\n`
      : `Operator-run security review is pending (${review.sourceFingerprint}); mainnet operator-run stays disabled at runtime until it is approved\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
