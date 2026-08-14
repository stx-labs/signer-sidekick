import type { ActivityGroupSummary } from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it } from "vitest";
import {
  activityFilterSearch,
  activityStatusBadge,
  groupActivityHistory,
  parseActivityFilters,
} from "./activity-presentation.js";

function item(activityId: string, updatedAt: string): ActivityGroupSummary {
  return {
    schemaVersion: 1,
    activityId,
    kind: "operation",
    domain: "rewards",
    code: "claim-rewards",
    title: "Claim rewards",
    summary: "Operator activity",
    stage: "complete",
    operationScope: "claim-rewards:141",
    displayStatus: "complete",
    outcome: "succeeded",
    occurredAt: updatedAt,
    updatedAt,
    deadline: null,
    urgencyAt: null,
    actorPrincipal: null,
    txids: [],
    anchor: null,
    supersedesActivityId: null,
    supersededByActivityId: null,
    primaryAction: null,
    coverage: [
      {
        source: "wallet-intents",
        status: "current",
        observedAt: updatedAt,
        anchor: null,
        reason: null,
      },
    ],
  };
}

describe("Activity presentation", () => {
  it("round-trips only closed bookmarkable filters and ignores unknown values", () => {
    const filters = parseActivityFilters(
      "status=needs-attention&type=actions&domain=rewards&time=7d&search=0xabc",
    );
    expect(filters).toEqual({
      status: "needs-attention",
      type: "actions",
      domain: "rewards",
      time: "7d",
      search: "0xabc",
    });
    expect(activityFilterSearch(filters)).toBe(
      "status=needs-attention&type=actions&domain=rewards&time=7d&search=0xabc",
    );
    expect(parseActivityFilters("status=unknown&type=nope")).toMatchObject({
      status: "all",
      type: "all",
      time: "30d",
    });
  });

  it("uses the approved status emphasis instead of one generic badge", () => {
    expect(activityStatusBadge("action-required")).toBe("accent");
    expect(activityStatusBadge("in-progress")).toBe("info");
    expect(activityStatusBadge("needs-attention")).toBe("error");
    expect(activityStatusBadge("complete")).toBe("success");
  });

  it("groups history under textual local-day headings", () => {
    const now = new Date(2026, 7, 14, 12, 0, 0);
    const today = item("today", new Date(2026, 7, 14, 10, 0, 0).toISOString());
    const yesterday = item("yesterday", new Date(2026, 7, 13, 10, 0, 0).toISOString());
    const older = item("older", new Date(2026, 7, 10, 10, 0, 0).toISOString());

    expect(groupActivityHistory([today, yesterday, older], now).map(({ label }) => label)).toEqual([
      "Today",
      "Yesterday",
      new Date(older.updatedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    ]);
  });
});
