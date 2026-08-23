import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyOperatorRunSecurityReview } from "./operator-run-security-review.mjs";

const fingerprint = "ab".repeat(32);

async function withRecord(record, run) {
  const directory = await mkdtemp(join(tmpdir(), "sidekick-security-review-"));
  const reviewPath = join(directory, "review.json");
  try {
    await writeFile(reviewPath, JSON.stringify(record));
    await run(reviewPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "approved",
    sourceFingerprint: fingerprint,
    reviewedCommit: "12".repeat(20),
    reviewedAt: "2026-08-22T20:00:00.000Z",
    reviewer: "independent-reviewer",
    reviewUrl: "https://github.com/stx-labs/signer-sidekick/pull/34",
    ...overrides,
  };
}

test("accepts an approved exact source review", async () => {
  await withRecord(record(), async (reviewPath) => {
    const review = await verifyOperatorRunSecurityReview({
      reviewPath,
      sourceFingerprint: fingerprint,
    });
    assert.equal(review.status, "approved");
  });
});

test("rejects pending and stale review records", async () => {
  await withRecord(record({ status: "pending" }), async (reviewPath) => {
    await assert.rejects(
      verifyOperatorRunSecurityReview({ reviewPath, sourceFingerprint: fingerprint }),
      /review is pending/,
    );
  });
  await withRecord(record(), async (reviewPath) => {
    await assert.rejects(
      verifyOperatorRunSecurityReview({ reviewPath, sourceFingerprint: "cd".repeat(32) }),
      /review is stale/,
    );
  });
});

test("rejects fields or review URLs the runtime parser would reject", async () => {
  await withRecord(record({ unexpected: true }), async (reviewPath) => {
    await assert.rejects(
      verifyOperatorRunSecurityReview({ reviewPath, sourceFingerprint: fingerprint }),
      /record is invalid/,
    );
  });
  await withRecord(record({ reviewUrl: "http://example.test/review" }), async (reviewPath) => {
    await assert.rejects(
      verifyOperatorRunSecurityReview({ reviewPath, sourceFingerprint: fingerprint }),
      /review is pending/,
    );
  });
});
