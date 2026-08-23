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

export async function verifyOperatorRunSecurityReview(options = {}) {
  const reviewPath =
    options.reviewPath ?? resolve(root, "security/operator-run-mainnet-review.json");
  const sourceFingerprint = options.sourceFingerprint ?? (await calculateSourceFingerprint());
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
    review?.schemaVersion !== 1 ||
    !["pending", "approved"].includes(review?.status) ||
    !sha256.test(review?.sourceFingerprint ?? "")
  ) {
    throw new Error("Operator-run security review record is invalid");
  }
  if (
    review.status !== "approved" ||
    !commit.test(review.reviewedCommit ?? "") ||
    typeof review.reviewedAt !== "string" ||
    !Number.isFinite(Date.parse(review.reviewedAt)) ||
    typeof review.reviewer !== "string" ||
    review.reviewer.length === 0 ||
    review.reviewer.length > 200 ||
    typeof review.reviewUrl !== "string" ||
    !URL.canParse(review.reviewUrl) ||
    new URL(review.reviewUrl).protocol !== "https:"
  ) {
    throw new Error("Operator-run security review is pending");
  }
  if (review.sourceFingerprint !== sourceFingerprint) {
    throw new Error(
      `Operator-run security review is stale: reviewed ${review.sourceFingerprint}, current ${sourceFingerprint}`,
    );
  }
  return review;
}

async function main() {
  const review = await verifyOperatorRunSecurityReview();
  process.stdout.write(
    `Verified operator-run security review ${review.sourceFingerprint} (${review.reviewUrl})\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
