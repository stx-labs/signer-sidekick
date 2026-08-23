import { MANAGER_CLAIM_REWARDS_FUNCTION_NAME } from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import { afterEach, describe, expect, it } from "vitest";
import { openSidekickStore, type SidekickStore } from "../storage/store.js";
import { legacyClaimManager, seedLegacyManagerClaimJob } from "./legacy-manager-claim.fixture.js";
import {
  managerClaimWalletJobStatus,
  readBoundManagerClaimWalletIntent,
} from "./manager-claim-wallet-intent.js";

const observedAt = "2026-07-17T12:00:00.000Z";
const actor = "ST2NEB84ASENDXKYGJPQW86YXQCEFEX2ZQPG87ND";
const network = { name: "pox5-testnet", kind: "testnet", chainId: 0x8000_0005 } as const;
const openStores: SidekickStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
});

async function memoryStore(): Promise<SidekickStore> {
  const { store } = await openSidekickStore(":memory:", observedAt);
  openStores.push(store);
  return store;
}

describe("retired manager-claim browser-wallet binding", () => {
  it("reconstructs the bound claim facts of a stored Observe job without replanning", async () => {
    const store = await memoryStore();
    const { job, records } = await seedLegacyManagerClaimJob(store, { state: "preflighted" });

    const bound = readBoundManagerClaimWalletIntent({
      repository: store.transactionEngine,
      jobId: job.jobId,
      actorPrincipal: actor,
      network,
      managerPrincipal: legacyClaimManager,
    });

    expect(bound).toMatchObject({
      scope: `manager-claim-wallet:${job.jobId}`,
      requiredSender: actor,
      network: "pox5-testnet",
      chainId: 0x8000_0005,
      facts: {
        kind: "reference-manager-claim-rewards-wallet",
        actorPrincipal: actor,
        managerPrincipal: legacyClaimManager,
        job: {
          jobId: job.jobId,
          operationScopeKey: job.operationScopeKey,
          intentSha256: job.intentSha256,
          policySha256: job.policySha256,
          sealedPlanIntentHash: records.plan.intentHash,
          unsignedTransactionSha256: records.plan.unsignedTransactionSha256,
          reconciliationSha256: records.reconciliationSha256,
        },
        expectedEffect: { amountSats: "1234", recipient: legacyClaimManager },
      },
      transaction: {
        method: "stx_callContract",
        params: {
          contract: legacyClaimManager,
          functionName: MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
          address: actor,
          sponsored: false,
          postConditionMode: "deny",
        },
      },
    });
    expect(bound.transaction.params.postConditions).toHaveLength(1);
    expect(store.transactionEngine.logicalJobStats().total).toBe(1);
  });

  it("classifies the bound job by its durable state and never mutates it", async () => {
    const store = await memoryStore();
    const { job, records } = await seedLegacyManagerClaimJob(store, { state: "preflighted" });
    const binding = readBoundManagerClaimWalletIntent({
      repository: store.transactionEngine,
      jobId: job.jobId,
      actorPrincipal: actor,
      network,
      managerPrincipal: legacyClaimManager,
    }).facts.job;
    const status = () =>
      managerClaimWalletJobStatus({ repository: store.transactionEngine, binding });

    expect(status()).toBe("prepared");
    const confirmed = store.transactionEngine.transitionLogicalJob({
      jobId: job.jobId,
      expectedState: "preflighted",
      expectedStateVersion: job.stateVersion,
      nextState: "confirmed",
      changedAt: "2026-07-17T12:01:00.000Z",
    });
    expect(status()).toBe("awaiting-reconciliation");
    store.transactionEngine.appendReconciliationObservation({
      jobId: job.jobId,
      predicate: records.reconciliation,
      predicateSha256: records.reconciliationSha256,
      chainAnchor: job.chainAnchor,
      authoritative: true,
      canonical: true,
      finalityDepth: 6,
      outcome: "external_success",
      effectRemaining: false,
      observedAt: "2026-07-17T12:02:00.000Z",
    });
    store.transactionEngine.transitionLogicalJob({
      jobId: job.jobId,
      expectedState: "confirmed",
      expectedStateVersion: confirmed.stateVersion,
      nextState: "reconciled",
      changedAt: "2026-07-17T12:02:00.000Z",
    });
    expect(status()).toBe("complete");
    expect(
      managerClaimWalletJobStatus({
        repository: store.transactionEngine,
        binding: { ...binding, reconciliationSha256: "00".repeat(32) },
      }),
    ).toBe("superseded");
    expect(
      managerClaimWalletJobStatus({
        repository: store.transactionEngine,
        binding: { ...binding, jobId: "00000000-0000-4000-8000-00000000dead" },
      }),
    ).toBe("superseded");
    expect(store.transactionEngine.getLogicalJob(job.jobId)?.state).toBe("reconciled");
  });

  it("rejects a stored manager mismatch and a payer on the wrong network", async () => {
    const store = await memoryStore();
    const { job } = await seedLegacyManagerClaimJob(store, { state: "preflighted" });

    expect(() =>
      readBoundManagerClaimWalletIntent({
        repository: store.transactionEngine,
        jobId: job.jobId,
        actorPrincipal: actor,
        network,
        managerPrincipal: "ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ.other-manager",
      }),
    ).toThrow("no longer matches its stored manager binding");
    expect(() =>
      readBoundManagerClaimWalletIntent({
        repository: store.transactionEngine,
        jobId: job.jobId,
        actorPrincipal: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
        network,
        managerPrincipal: legacyClaimManager,
      }),
    ).toThrow("different network");
  });
});
