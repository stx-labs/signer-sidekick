import { afterEach, describe, expect, it } from "vitest";
import { openSidekickStore, type SidekickStore } from "../storage/store.js";
import {
  legacyManagerClaimFacts,
  seedLegacyManagerClaimJob,
} from "./legacy-manager-claim.fixture.js";
import {
  type ManagerClaimObserveFacts,
  ObserveManagerClaimPlanner,
} from "./manager-claim-observer.js";

const initial = "2026-07-17T12:00:00.000Z";
const later = "2026-07-17T12:01:00.000Z";
const openStores: SidekickStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
});

async function memoryStore(): Promise<SidekickStore> {
  const { store } = await openSidekickStore(":memory:", initial);
  openStores.push(store);
  return store;
}

/** Authoritative facts that prove an external caller completed the claim one block later. */
function completedFacts(): ManagerClaimObserveFacts {
  const completed = legacyManagerClaimFacts();
  completed.observedAt = later;
  completed.chainAnchor = {
    ...completed.chainAnchor,
    stacksBlockHeight: 9_001,
    burnBlockHeight: 4_101,
    cyclePosition: 51,
    indexBlockHash: `0x${"cd".repeat(32)}`,
  };
  completed.feeSnapshot = { state: "present", effectiveFeeBips: 500n };
  completed.observedSignerEarnedSats = 0n;
  completed.effect = { remaining: false, completionEvidenceSha256: "56".repeat(32) };
  return completed;
}

describe("retired reference-manager claim planner", () => {
  it("reconciles an external caller winning the race without creating another job", async () => {
    const store = await memoryStore();
    const { job } = await seedLegacyManagerClaimJob(store, { state: "preflighted" });
    const planner = new ObserveManagerClaimPlanner(store.transactionEngine);

    const reconciled = await planner.observe(completedFacts());
    const duplicate = await planner.observe(completedFacts());

    expect(reconciled).toMatchObject({
      status: "reconciled",
      created: false,
      job: { jobId: job.jobId, state: "reconciled" },
      plan: null,
    });
    expect(duplicate.job.jobId).toBe(job.jobId);
    expect(
      store.transactionEngine.getLatestLogicalJobForScope(job.operationScopeKey),
    ).toMatchObject({ jobId: job.jobId, state: "reconciled" });
    expect(store.transactionEngine.listReconciliationObservations(job.jobId)).toMatchObject([
      { outcome: "pending", effectRemaining: true },
      { outcome: "external_success", effectRemaining: false },
    ]);
    expect(store.transactionEngine.logicalJobStats().total).toBe(1);
  });

  it("does not fabricate a retrospective job for completion with no matching local work", async () => {
    const store = await memoryStore();

    await expect(
      new ObserveManagerClaimPlanner(store.transactionEngine).observe(completedFacts()),
    ).rejects.toThrow("no matching durable logical job");
    expect(store.transactionEngine.logicalJobStats().total).toBe(0);
  });
});
