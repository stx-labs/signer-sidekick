import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyMainnetOperatorRunSecurityReview } from "./operator-run-security-review.js";

const directories: string[] = [];
const fingerprint = "ab".repeat(32);

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function reviewFiles(input: { status?: "pending" | "approved"; reviewedFingerprint?: string }) {
  const directory = mkdtempSync(join(tmpdir(), "sidekick-operator-run-review-"));
  directories.push(directory);
  const reviewPath = join(directory, "review.json");
  const sourceFingerprintPath = join(directory, "SOURCE_FINGERPRINT");
  const approved = (input.status ?? "approved") === "approved";
  writeFileSync(sourceFingerprintPath, `${fingerprint}\n`, { mode: 0o600 });
  writeFileSync(
    reviewPath,
    `${JSON.stringify({
      schemaVersion: 1,
      status: input.status ?? "approved",
      sourceFingerprint: input.reviewedFingerprint ?? fingerprint,
      reviewedCommit: approved ? "12".repeat(20) : null,
      reviewedAt: approved ? "2026-08-22T20:00:00.000Z" : null,
      reviewer: approved ? "independent-reviewer" : null,
      reviewUrl: approved ? "https://github.com/stx-labs/signer-sidekick/pull/34" : null,
    })}\n`,
    { mode: 0o600 },
  );
  return { reviewPath, sourceFingerprintPath };
}

describe("mainnet operator-run security review", () => {
  it("accepts an approved review of the exact source fingerprint", () => {
    expect(() => verifyMainnetOperatorRunSecurityReview(reviewFiles({}))).not.toThrow();
  });

  it("fails closed for missing, pending, malformed, or stale review evidence", () => {
    expect(() =>
      verifyMainnetOperatorRunSecurityReview({ reviewPath: null, sourceFingerprintPath: null }),
    ).toThrow("requires an approved security-reviewed build");
    expect(() =>
      verifyMainnetOperatorRunSecurityReview(reviewFiles({ status: "pending" })),
    ).toThrow("security review is pending");
    expect(() =>
      verifyMainnetOperatorRunSecurityReview(reviewFiles({ reviewedFingerprint: "cd".repeat(32) })),
    ).toThrow("source changed after security review");
  });

  it("rejects non-HTTPS review evidence", () => {
    const paths = reviewFiles({});
    const review = JSON.parse(readFileSync(paths.reviewPath, "utf8"));
    writeFileSync(
      paths.reviewPath,
      JSON.stringify({ ...review, reviewUrl: "http://example.test" }),
    );
    expect(() => verifyMainnetOperatorRunSecurityReview(paths)).toThrow("record is invalid");
  });
});
