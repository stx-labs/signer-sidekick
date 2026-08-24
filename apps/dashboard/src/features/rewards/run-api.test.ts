import { describe, expect, it } from "vitest";
import { rewardRunFixture } from "./reward-run.fixture.js";
import {
  ACTIVE_RUN_STATUSES,
  IN_PROGRESS_RUN_STATUSES,
  operationsForKind,
  summarizeRunSteps,
} from "./run-api.js";

describe("reward run helpers", () => {
  it("maps the primary-button vocabulary onto recipe operations", () => {
    expect(operationsForKind("collect-and-distribute")).toEqual([
      "claim-rewards",
      "claim-staker-rewards",
    ]);
    expect(operationsForKind("distribute")).toEqual(["claim-staker-rewards"]);
    expect(operationsForKind("collect")).toEqual(["claim-rewards"]);
    expect(operationsForKind("calculate")).toEqual(["calculate-rewards"]);
    expect(operationsForKind("finish-bitcoin-payouts")).toEqual([
      "settle-accepted-withdrawal",
      "reclaim-failed-withdrawal",
    ]);
  });

  it("treats drafts as holding the wallet and only approved-or-later as in progress", () => {
    expect([...ACTIVE_RUN_STATUSES]).toEqual([
      "awaiting-approval",
      "approved",
      "running",
      "paused",
      "halted",
    ]);
    expect(IN_PROGRESS_RUN_STATUSES.has("awaiting-approval")).toBe(false);
    expect(IN_PROGRESS_RUN_STATUSES.has("halted")).toBe(true);
    expect(IN_PROGRESS_RUN_STATUSES.has("completed")).toBe(false);
  });

  it("summarizes recipe children per operation with progress and reviewed amounts", () => {
    const steps = summarizeRunSteps(rewardRunFixture());
    expect(steps).toEqual([
      {
        operation: "claim-rewards",
        label: "Collect into the manager",
        count: 1,
        done: 1,
        amountSats: "1287000",
      },
      {
        operation: "claim-staker-rewards",
        label: "Distribute payments",
        count: 2,
        done: 1,
        amountSats: "427200",
      },
    ]);
  });
});
