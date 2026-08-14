import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openSidekickStore, type SidekickStore } from "./store.js";
import {
  type CreateWalletIntentInput,
  canonicalJsonSha256,
  WalletIntentRepositoryError,
} from "./wallet-intent-repository.js";

const createdAt = "2026-07-18T12:00:00.000Z";
const expiresAt = "2026-07-18T12:10:00.000Z";
const beforeExpiry = "2026-07-18T12:09:59.999Z";
const afterSubmission = "2026-07-18T12:05:00.000Z";
const requiredSender = "SP000000000000000000002Q6VF78";
const manager = `${requiredSender}.signer-manager`;
const txidOne = `0x${"11".repeat(32)}`;
const txidTwo = `0x${"22".repeat(32)}`;
const indexBlockHash = `0x${"33".repeat(32)}`;
const stores: SidekickStore[] = [];
const directories: string[] = [];

const deploymentManifest = {
  schemaVersion: 1,
  action: "deploy-manager",
  request: {
    name: "signer-manager",
    clarityVersion: 6,
    postConditionMode: "deny",
  },
};

function intentInput(overrides: Partial<CreateWalletIntentInput> = {}): CreateWalletIntentInput {
  const manifest = overrides.manifest ?? deploymentManifest;
  return {
    action: "deploy-manager",
    scope: "fresh:SP000000000000000000002Q6VF78.signer-manager",
    factsSha256: "aa".repeat(32),
    manifestSha256: canonicalJsonSha256(manifest),
    manifest,
    requiredSender,
    network: "mainnet",
    chainId: 1,
    createdAt,
    expiresAt,
    ...overrides,
  };
}

async function memoryStore(): Promise<SidekickStore> {
  const { store } = await openSidekickStore(":memory:", createdAt);
  stores.push(store);
  return store;
}

function closeTracked(store: SidekickStore): void {
  const index = stores.indexOf(store);
  if (index !== -1) stores.splice(index, 1);
  store.close();
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("WalletIntentRepository", () => {
  it("persists manager wallet actions added by migration 17", async () => {
    const store = await memoryStore();
    const manifest = {
      schemaVersion: 2,
      action: "add-admin",
      request: { actorPrincipal: requiredSender, adminPrincipal: requiredSender },
    };
    const intent = store.walletIntents.create(
      intentInput({
        action: "add-admin",
        scope: manager,
        manifest,
        manifestSha256: canonicalJsonSha256(manifest),
      }),
    ).intent;

    expect(store.schemaVersion()).toBe(29);
    expect(store.walletIntents.get(intent.id)).toMatchObject({
      action: "add-admin",
      scope: manager,
      manifest,
    });
  });

  it("lists durable intents for Activity in stable newest-first order", async () => {
    const store = await memoryStore();
    const older = store.walletIntents.create(
      intentInput({
        id: "10000000-0000-4000-8000-000000000001",
        createdAt: "2026-07-18T11:00:00.000Z",
        expiresAt: "2026-07-18T11:10:00.000Z",
      }),
    ).intent;
    const newer = store.walletIntents.create(
      intentInput({
        id: "10000000-0000-4000-8000-000000000002",
        scope: "fresh:SP000000000000000000002Q6VF78.other-manager",
      }),
    ).intent;

    expect(store.walletIntents.listForActivity(1).map(({ id }) => id)).toEqual([newer.id]);
    expect(store.walletIntents.listForActivity().map(({ id }) => id)).toEqual([newer.id, older.id]);
  });

  it("loads one Activity intent by txid and only its operation scope", async () => {
    const store = await memoryStore();
    const first = store.walletIntents.create(
      intentInput({ id: "10000000-0000-4000-8000-000000000001" }),
    ).intent;
    const second = store.walletIntents.create(
      intentInput({
        id: "10000000-0000-4000-8000-000000000002",
        factsSha256: "bb".repeat(32),
        createdAt: "2026-07-18T12:01:00.000Z",
        expiresAt: "2026-07-18T12:11:00.000Z",
      }),
    ).intent;
    store.walletIntents.create(
      intentInput({
        id: "10000000-0000-4000-8000-000000000003",
        scope: "other-scope",
      }),
    );
    store.walletIntents.submit({ id: first.id, txid: txidOne, submittedAt: afterSubmission });

    expect(store.walletIntents.getByTxid(txidOne)?.id).toBe(first.id);
    expect(store.walletIntents.getActivityScopeNeighbors(first)).toMatchObject({
      previous: null,
      next: { id: second.id },
    });
    expect(store.walletIntents.getActivityScopeNeighbors(second)).toMatchObject({
      previous: { id: first.id },
      next: null,
    });
    expect(store.walletIntents.getByTxid(txidTwo)).toBeNull();
  });

  it("lists every nonterminal intent for Activity independently of the history window", async () => {
    const store = await memoryStore();
    const terminal = store.walletIntents.create(
      intentInput({
        id: "10000000-0000-4000-8000-000000000001",
        createdAt: "2026-07-18T11:00:00.000Z",
        expiresAt: "2026-07-18T11:10:00.000Z",
      }),
    ).intent;
    store.walletIntents.findActiveScope({
      action: terminal.action,
      scope: terminal.scope,
      now: "2026-07-18T11:10:00.000Z",
    });
    const active = store.walletIntents.create(
      intentInput({
        id: "10000000-0000-4000-8000-000000000002",
        scope: "fresh:SP000000000000000000002Q6VF78.other-manager",
      }),
    ).intent;

    expect(store.walletIntents.get(terminal.id)?.state).toBe("expired");
    expect(store.walletIntents.listActiveForActivity().map(({ id }) => id)).toEqual([active.id]);
  });

  it("migrates, survives restart, and returns observations oldest-to-newest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-wallet-intents-"));
    directories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const initial = await openSidekickStore(path, createdAt);
    stores.push(initial.store);
    expect(initial.store.schemaVersion()).toBe(29);

    const created = initial.store.walletIntents.create(
      intentInput({ id: "10000000-0000-4000-8000-000000000001" }),
    );
    initial.store.walletIntents.appendObservation({
      id: "20000000-0000-4000-8000-000000000002",
      intentId: created.intent.id,
      outcome: "mempool-match",
      canonical: null,
      blockHeight: null,
      indexBlockHash: null,
      evidence: { txidMatched: true, rawTransactionSha256: "44".repeat(32) },
      observedAt: "2026-07-18T12:06:00.000Z",
    });
    initial.store.walletIntents.appendObservation({
      id: "20000000-0000-4000-8000-000000000001",
      intentId: created.intent.id,
      outcome: "canonical-match",
      canonical: true,
      blockHeight: 1_234,
      indexBlockHash,
      evidence: { payloadMatched: true, poststateMatched: true },
      observedAt: "2026-07-18T12:07:00.000Z",
    });
    closeTracked(initial.store);

    const reopened = await openSidekickStore(path, "2026-07-18T12:08:00.000Z");
    stores.push(reopened.store);
    expect(reopened.backupPath).toBeNull();
    expect(reopened.store.walletIntents.get(created.intent.id)).toMatchObject({
      id: created.intent.id,
      action: "deploy-manager",
      manifest: deploymentManifest,
      state: "prepared",
    });
    expect(reopened.store.walletIntents.listObservations(created.intent.id)).toMatchObject([
      { outcome: "mempool-match", canonical: null, observedAt: "2026-07-18T12:06:00.000Z" },
      { outcome: "canonical-match", observedAt: "2026-07-18T12:07:00.000Z" },
    ]);
    expect(reopened.store.walletIntents.listObservations(created.intent.id).at(-1)?.outcome).toBe(
      "canonical-match",
    );
    expect(
      reopened.store.walletIntents.latestObservation(created.intent.id, {
        excludeOutcomes: ["canonical-match"],
      })?.outcome,
    ).toBe("mempool-match");
  });

  it("loads only the latest observation for each Activity intent in one batched read", async () => {
    const store = await memoryStore();
    const observed = store.walletIntents.create(
      intentInput({ id: "10000000-0000-4000-8000-000000000001" }),
    ).intent;
    const unobserved = store.walletIntents.create(
      intentInput({
        id: "10000000-0000-4000-8000-000000000002",
        scope: "fresh:SP000000000000000000002Q6VF78.other-manager",
      }),
    ).intent;
    store.walletIntents.appendObservation({
      id: "20000000-0000-4000-8000-000000000001",
      intentId: observed.id,
      outcome: "mempool-match",
      canonical: null,
      blockHeight: null,
      indexBlockHash: null,
      evidence: { txidMatched: true },
      observedAt: "2026-07-18T12:06:00.000Z",
    });
    const latest = store.walletIntents.appendObservation({
      id: "20000000-0000-4000-8000-000000000002",
      intentId: observed.id,
      outcome: "canonical-match",
      canonical: true,
      blockHeight: 1_234,
      indexBlockHash,
      evidence: { payloadMatched: true },
      observedAt: "2026-07-18T12:07:00.000Z",
    });

    const observations = store.walletIntents.listLatestObservationsForActivity([
      unobserved.id,
      observed.id,
      observed.id,
    ]);

    expect([...observations.keys()]).toEqual([observed.id]);
    expect(observations.get(observed.id)).toEqual(latest);
    expect(observations.has(unobserved.id)).toBe(false);
  });

  it("expires prepared intents at the exact expiry boundary", async () => {
    const store = await memoryStore();
    const created = store.walletIntents.create(intentInput()).intent;
    expect(
      store.walletIntents.findActiveScope({
        action: created.action,
        scope: created.scope,
        now: beforeExpiry,
      })?.id,
    ).toBe(created.id);
    expect(
      store.walletIntents.findActiveScope({
        action: created.action,
        scope: created.scope,
        now: expiresAt,
      }),
    ).toBeNull();
    expect(store.walletIntents.get(created.id)).toMatchObject({
      state: "expired",
      stateVersion: 1,
      updatedAt: expiresAt,
    });
    expect(
      store.walletIntents.submit({ id: created.id, txid: txidOne, submittedAt: expiresAt }),
    ).toMatchObject({ state: "submitted", stateVersion: 2, txid: txidOne });
  });

  it("attaches a wallet txid when the first submission arrives at the expiry boundary", async () => {
    const store = await memoryStore();
    const created = store.walletIntents.create(intentInput()).intent;
    expect(
      store.walletIntents.submit({ id: created.id, txid: txidOne, submittedAt: expiresAt }),
    ).toMatchObject({
      state: "submitted",
      txid: txidOne,
      submittedAt: expiresAt,
      stateVersion: 1,
    });
  });

  it("supersedes an unsigned replacement when an expired intent reports its broadcast", async () => {
    const store = await memoryStore();
    const expired = store.walletIntents.create(
      intentInput({ id: "10000000-0000-4000-8000-000000000001" }),
    ).intent;
    store.walletIntents.findActiveScope({
      action: expired.action,
      scope: expired.scope,
      now: expiresAt,
    });
    const replacement = store.walletIntents.create(
      intentInput({
        id: "10000000-0000-4000-8000-000000000002",
        createdAt: "2026-07-18T12:10:01.000Z",
        expiresAt: "2026-07-18T12:25:01.000Z",
      }),
    ).intent;

    expect(
      store.walletIntents.submit({
        id: expired.id,
        txid: txidOne,
        submittedAt: "2026-07-18T12:11:00.000Z",
      }),
    ).toMatchObject({ state: "submitted", txid: txidOne });
    expect(store.walletIntents.get(replacement.id)).toMatchObject({
      state: "superseded",
      txid: null,
    });
  });

  it("retains a late expired broadcast as superseded when equivalent work is active", async () => {
    const store = await memoryStore();
    const expired = store.walletIntents.create(
      intentInput({ id: "10000000-0000-4000-8000-000000000001" }),
    ).intent;
    store.walletIntents.findActiveScope({
      action: expired.action,
      scope: expired.scope,
      now: expiresAt,
    });
    const replacement = store.walletIntents.create(
      intentInput({
        id: "10000000-0000-4000-8000-000000000002",
        createdAt: "2026-07-18T12:10:01.000Z",
        expiresAt: "2026-07-18T12:25:01.000Z",
      }),
    ).intent;
    store.walletIntents.submit({
      id: replacement.id,
      txid: txidOne,
      submittedAt: "2026-07-18T12:10:30.000Z",
    });

    expect(
      store.walletIntents.submit({
        id: expired.id,
        txid: txidTwo,
        submittedAt: "2026-07-18T12:11:00.000Z",
      }),
    ).toMatchObject({ state: "superseded", txid: txidTwo });
    expect(store.walletIntents.get(replacement.id)).toMatchObject({
      state: "submitted",
      txid: txidOne,
    });
  });

  it("finds submitted equivalents and atomically supersedes an active replacement", async () => {
    const store = await memoryStore();
    const original = store.walletIntents.create(
      intentInput({ id: "10000000-0000-4000-8000-000000000001" }),
    ).intent;
    store.walletIntents.submit({ id: original.id, txid: txidOne, submittedAt: afterSubmission });
    store.walletIntents.transition({
      id: original.id,
      fromStates: ["submitted"],
      toState: "reobserve",
      updatedAt: "2026-07-18T12:06:00.000Z",
    });
    store.walletIntents.transition({
      id: original.id,
      fromStates: ["reobserve"],
      toState: "superseded",
      updatedAt: "2026-07-18T12:07:00.000Z",
    });
    const replacement = store.walletIntents.create(
      intentInput({
        id: "10000000-0000-4000-8000-000000000002",
        createdAt: "2026-07-18T12:10:01.000Z",
        expiresAt: "2026-07-18T12:25:01.000Z",
      }),
    ).intent;

    expect(
      store.walletIntents.listSubmittedEquivalent({
        action: original.action,
        scope: original.scope,
        factsSha256: original.factsSha256,
      }),
    ).toMatchObject([{ id: original.id, state: "superseded", txid: txidOne }]);
    expect(
      store.walletIntents.supersedeActiveEquivalent({
        winnerId: original.id,
        updatedAt: "2026-07-18T12:11:00.000Z",
      }),
    ).toMatchObject([{ id: replacement.id, state: "superseded", txid: null }]);
    expect(store.walletIntents.get(replacement.id)).toMatchObject({
      state: "superseded",
      stateVersion: 1,
    });
  });

  it("deduplicates exact work and gives a late broadcast precedence over unsigned changed facts", async () => {
    const store = await memoryStore();
    const first = store.walletIntents.create(
      intentInput({ id: "10000000-0000-4000-8000-000000000001" }),
    );
    const duplicate = store.walletIntents.create(
      intentInput({ id: "10000000-0000-4000-8000-000000000002" }),
    );
    expect(duplicate).toMatchObject({ created: false, intent: { id: first.intent.id } });

    const changed = store.walletIntents.create(
      intentInput({
        id: "10000000-0000-4000-8000-000000000003",
        factsSha256: "bb".repeat(32),
      }),
    );
    expect(changed.created).toBe(true);
    expect(store.walletIntents.get(first.intent.id)).toMatchObject({
      state: "superseded",
      stateVersion: 1,
    });
    expect(
      store.walletIntents.submit({
        id: first.intent.id,
        txid: txidOne,
        submittedAt: afterSubmission,
      }),
    ).toMatchObject({ state: "submitted", txid: txidOne });
    expect(store.walletIntents.get(changed.intent.id)).toMatchObject({
      state: "superseded",
      txid: null,
    });
  });

  it("rejects changed facts while the same action and scope has an active transaction", async () => {
    const store = await memoryStore();
    const active = store.walletIntents.create(
      intentInput({ id: "10000000-0000-4000-8000-000000000001" }),
    ).intent;
    store.walletIntents.submit({ id: active.id, txid: txidOne, submittedAt: afterSubmission });

    expect(() =>
      store.walletIntents.create(
        intentInput({
          id: "10000000-0000-4000-8000-000000000002",
          factsSha256: "bb".repeat(32),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "active-intent-conflict" }));
    expect(
      store.walletIntents.findActiveScope({
        action: active.action,
        scope: active.scope,
        now: afterSubmission,
      }),
    ).toMatchObject({ id: active.id, state: "submitted", factsSha256: active.factsSha256 });
  });

  it("submits once, retries the same txid idempotently, and rejects conflicts", async () => {
    const store = await memoryStore();
    const first = store.walletIntents.create(intentInput()).intent;
    const submitted = store.walletIntents.submit({
      id: first.id,
      txid: txidOne,
      submittedAt: afterSubmission,
    });
    expect(submitted).toMatchObject({
      state: "submitted",
      stateVersion: 1,
      txid: txidOne,
      submittedAt: afterSubmission,
    });
    expect(
      store.walletIntents.submit({
        id: first.id,
        txid: txidOne,
        submittedAt: "2026-07-18T12:09:00.000Z",
      }),
    ).toEqual(submitted);
    expect(() =>
      store.walletIntents.submit({ id: first.id, txid: txidTwo, submittedAt: afterSubmission }),
    ).toThrowError(expect.objectContaining({ code: "already-submitted" }));

    const second = store.walletIntents.create(
      intentInput({
        scope: "fresh:second-manager",
        factsSha256: "bb".repeat(32),
      }),
    ).intent;
    expect(() =>
      store.walletIntents.submit({ id: second.id, txid: txidOne, submittedAt: afterSubmission }),
    ).toThrowError(expect.objectContaining({ code: "duplicate-txid" }));
  });

  it("uses guarded transitions and append-only bounded evidence", async () => {
    const store = await memoryStore();
    const intent = store.walletIntents.create(intentInput()).intent;
    const submitted = store.walletIntents.submit({
      id: intent.id,
      txid: txidOne,
      submittedAt: afterSubmission,
    });
    const mempool = store.walletIntents.transition({
      id: intent.id,
      fromStates: ["submitted"],
      toState: "mempool",
      updatedAt: "2026-07-18T12:06:00.000Z",
    });
    expect(mempool).toMatchObject({ state: "mempool", stateVersion: 2 });
    expect(
      store.walletIntents.transition({
        id: intent.id,
        fromStates: ["submitted"],
        toState: "mempool",
        updatedAt: "2026-07-18T12:07:00.000Z",
      }),
    ).toEqual(mempool);
    expect(() =>
      store.walletIntents.transition({
        id: intent.id,
        fromStates: ["submitted"],
        toState: "complete",
        updatedAt: "2026-07-18T12:07:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "state-conflict" }));
    expect(submitted.stateVersion).toBe(1);

    const confirmed = store.walletIntents.transition({
      id: intent.id,
      fromStates: ["mempool"],
      toState: "confirmed",
      updatedAt: "2026-07-18T12:07:00.000Z",
    });
    const complete = store.walletIntents.transition({
      id: intent.id,
      fromStates: ["confirmed"],
      toState: "complete",
      updatedAt: "2026-07-18T12:08:00.000Z",
    });
    expect(complete.stateVersion).toBe(confirmed.stateVersion + 1);
    expect(
      store.walletIntents.findActiveScope({
        action: intent.action,
        scope: intent.scope,
        now: expiresAt,
      })?.state,
    ).toBe("complete");
    const reobserve = store.walletIntents.transition({
      id: intent.id,
      fromStates: ["complete"],
      toState: "reobserve",
      updatedAt: "2026-07-18T12:09:00.000Z",
    });
    const superseded = store.walletIntents.transition({
      id: intent.id,
      fromStates: ["reobserve"],
      toState: "superseded",
      updatedAt: "2026-07-18T12:10:00.000Z",
    });
    expect(superseded).toMatchObject({ state: "superseded", txid: txidOne });
    expect(reobserve.stateVersion).toBe(complete.stateVersion + 1);

    expect(() =>
      store.walletIntents.appendObservation({
        intentId: intent.id,
        outcome: "raw-evidence",
        canonical: false,
        blockHeight: null,
        indexBlockHash: null,
        evidence: { rawTransaction: `0x${"ab".repeat(256)}` },
        observedAt: "2026-07-18T12:08:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "observation-evidence-rejected" }));
  });

  it("rejects noncanonical manifests, digest mismatches, and extra input fields", async () => {
    const store = await memoryStore();
    expect(() =>
      store.walletIntents.create(intentInput({ manifestSha256: "ff".repeat(32) })),
    ).toThrowError(expect.objectContaining({ code: "manifest-sha256-mismatch" }));
    expect(() => canonicalJsonSha256({ missing: undefined })).toThrow("cannot contain undefined");
    expect(() =>
      store.walletIntents.create({ ...intentInput(), extra: true } as CreateWalletIntentInput),
    ).toThrow();
    expect(WalletIntentRepositoryError).toBeTypeOf("function");
  });

  it("keeps the browser and backend canonical manifest hash vector aligned", () => {
    const admin = "SP000000000000000000002Q6VF78";
    expect(
      canonicalJsonSha256({
        schemaVersion: 1,
        id: "4e011bf7-f291-42c4-a35b-ab299a87ff8c",
        action: "deploy-manager",
        network: "mainnet",
        chainId: 1,
        requiredSender: admin,
        createdAt: "2026-07-18T18:00:00.000Z",
        expiresAt: "2099-07-18T19:00:00.000Z",
        transaction: {
          method: "stx_deployContract",
          params: {
            name: "signer-manager",
            clarityCode: "(define-public (ping) (ok true))",
            clarityVersion: 6,
            network: "mainnet",
            address: admin,
            sponsored: false,
            postConditionMode: "deny",
            postConditions: [],
          },
        },
        review: {
          title: "Deploy signer manager",
          summary: "Deploy the reviewed manager source.",
          expectedPostState: "The exact manager source is confirmed.",
        },
        seal: { factsSha256: "11".repeat(32) },
      }),
    ).toBe("6bc23d72aa8bdbe4fd9ed92892bc860008536bc987f1dbec43e0f57f60bed1b0");
  });

  it("enforces immutable bindings and append-only observations in SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-wallet-trigger-"));
    directories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const { store } = await openSidekickStore(path, createdAt);
    stores.push(store);
    const intent = store.walletIntents.create(intentInput()).intent;
    const observation = store.walletIntents.appendObservation({
      intentId: intent.id,
      outcome: "prepared",
      canonical: false,
      blockHeight: null,
      indexBlockHash: null,
      evidence: { manifestMatched: true },
      observedAt: createdAt,
    });

    const database = new DatabaseSync(path);
    try {
      expect(
        database.prepare("PRAGMA index_info('browser_wallet_one_active_scope')").all(),
      ).toMatchObject([{ name: "action" }, { name: "scope" }]);
      const activeScopeIndex = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'browser_wallet_one_active_scope'",
        )
        .get() as { sql: string };
      expect(activeScopeIndex.sql).toContain(
        "state IN ('prepared', 'submitted', 'mempool', 'confirmed', 'complete', 'reobserve')",
      );
      expect(activeScopeIndex.sql).not.toContain("facts_sha256");
      expect(() =>
        database
          .prepare("UPDATE browser_wallet_intents SET manifest_json = '{}' WHERE intent_id = ?")
          .run(intent.id),
      ).toThrow("browser wallet intent binding is immutable");
      expect(() =>
        database
          .prepare(
            "UPDATE browser_wallet_intent_observations SET outcome = 'changed' WHERE observation_id = ?",
          )
          .run(observation.id),
      ).toThrow("browser wallet observation is immutable");
      expect(() =>
        database
          .prepare("DELETE FROM browser_wallet_intent_observations WHERE observation_id = ?")
          .run(observation.id),
      ).toThrow("browser wallet observation is immutable");
      expect(() =>
        database.prepare("DELETE FROM browser_wallet_intents WHERE intent_id = ?").run(intent.id),
      ).toThrow("browser wallet intent is durable");
    } finally {
      database.close();
    }
  });
});
