import { describe, expect, it } from "vitest";
import { rewardRunSchema } from "./run-api.js";

describe("reward run reader", () => {
  it("accepts the planned S3 run shape and ignores unknown fields", () => {
    const parsed = rewardRunSchema.safeParse({
      runId: "run-1",
      kind: "collect-and-distribute",
      cycle: 141,
      distribution: 2,
      state: "running",
      steps: [
        {
          kind: "collect",
          label: "Collect 0.0129 sBTC into the manager",
          transactions: 1,
          amountSats: "1287000",
          state: "done",
        },
        {
          kind: "distribute",
          label: "Distribute 40 payments",
          detail: "one at a time",
          transactions: 40,
          amountSats: "1222650",
          asset: "sBTC",
          state: "running",
        },
        { not: "a step" },
      ],
      transactions: 41,
      transactionsDone: 13,
      estimatedGasUstx: "420000",
      gasUsedUstx: "120000",
      approvalExpiresAt: "2026-08-22T12:30:00.000Z",
      extra: { ignored: true },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      runId: "run-1",
      kind: "collect-and-distribute",
      cycle: 141,
      distribution: 2,
      state: "running",
      transactions: 41,
      transactionsDone: 13,
      estimatedGasUstx: "420000",
      gasUsedUstx: "120000",
      approvalExpiresAt: "2026-08-22T12:30:00.000Z",
      startedAt: null,
      haltReason: null,
    });
    expect(parsed.data.steps).toHaveLength(2);
    expect(parsed.data.steps[1]).toMatchObject({
      kind: "distribute",
      asset: "sBTC",
      state: "running",
      detail: "one at a time",
    });
  });

  it("rejects runs without an identity", () => {
    expect(rewardRunSchema.safeParse({ kind: "collect" }).success).toBe(false);
    expect(rewardRunSchema.safeParse(null).success).toBe(false);
  });
});
