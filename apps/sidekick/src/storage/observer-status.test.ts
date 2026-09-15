import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { observerRuntimeStatus } from "../observer-server.js";
import { createServer } from "../server.js";
import {
  type ObserverDeliveryInput,
  ObserverInboxCapacityError,
  ObserverInboxRepository,
} from "./observer-inbox-repository.js";
import { openSidekickStore } from "./store.js";

const now = "2026-09-15T12:00:00.000Z";
const later = "2026-09-15T12:00:01.000Z";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
function input(n: number, overrides: Partial<ObserverDeliveryInput> = {}): ObserverDeliveryInput {
  return {
    endpointKind: "new-block",
    contentSha256: hash(n).slice(2),
    rawPayloadJson: "{}",
    payloadBytes: 2,
    state: "observer-claimed",
    stateReason: null,
    claimedBlockHeight: n,
    claimedBlockHash: hash(n),
    claimedIndexBlockHash: hash(n),
    claimedBurnBlockHeight: null,
    claimedBurnBlockHash: null,
    receivedAt: now,
    ...overrides,
  };
}

async function fixture(run: (inbox: ObserverInboxRepository, db: DatabaseSync) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "sidekick-observer-status-test-"));
  const path = join(directory, "fixture.sqlite");
  const { store } = await openSidekickStore(path, now);
  const db = new DatabaseSync(path);
  try {
    await run(store.observerInbox, db);
  } finally {
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// A fresh repository always recomputes the full SQL aggregate, independent of the cached deltas.
function assertExact(inbox: ObserverInboxRepository, db: DatabaseSync) {
  expect(inbox.status()).toEqual(new ObserverInboxRepository(db).status());
}

function fullScans(inbox: ObserverInboxRepository) {
  const read = vi.spyOn(inbox as unknown as { readTotals(where?: string): unknown }, "readTotals");
  return () => read.mock.calls.filter(([where]) => where === undefined).length;
}

describe("observer status derived counters", () => {
  it("keeps exact counters through count- and byte-limited pruning of a large retained set", async () => {
    await fixture(async (inbox, db) => {
      db.exec(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 25002)
        INSERT INTO observer_deliveries(delivery_id, endpoint_kind, content_sha256,
          raw_payload_json, payload_bytes, state, first_received_at, last_received_at,
          next_attempt_at, completed_at, updated_at)
        SELECT printf('00000000-0000-4000-8000-%012d', n), 'attachments', printf('%064x', n),
          '{}', 2, 'expired', '${now}', '${now}', '${now}', '${now}', '${now}' FROM numbers`);
      const scans = fullScans(inbox);
      assertExact(inbox, db);
      expect(inbox.prunePayloads(now)).toBe(2);
      assertExact(inbox, db);
      expect(inbox.status()).toMatchObject({
        uniqueDeliveries: 25002,
        prunedPayloads: 2,
        retainedPayloadBytes: 50000,
      });
      expect(scans()).toBe(1);
      // Synthetic byte accounting exercises the cap without allocating 96 MiB of JSON.
      db.exec(`UPDATE observer_deliveries SET payload_bytes = 33554432
        WHERE delivery_id IN (SELECT delivery_id FROM observer_deliveries WHERE payload_pruned = 0
          ORDER BY delivery_id DESC LIMIT 3)`);
      assertExact(inbox, db);
      expect(inbox.prunePayloads(now)).toBeGreaterThan(0);
      assertExact(inbox, db);
      expect(inbox.status().retainedPayloadBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(scans()).toBe(2);
    });
  });
  it("matches a full aggregate throughout delivery, retry, recovery, finish and pruning without rescans", async () => {
    await fixture(async (inbox, db) => {
      const scans = fullScans(inbox);
      assertExact(inbox, db);
      for (let n = 1; n <= 12; n++) {
        const accepted = inbox.acceptDelivery(input(n));
        assertExact(inbox, db);
        inbox.acceptDelivery(input(n, { receivedAt: later }));
        assertExact(inbox, db);
        inbox.claimNextDelivery(later);
        assertExact(inbox, db);
        inbox.retryDelivery({
          deliveryId: accepted.deliveryId,
          reason: "retry",
          retriedAt: now,
          nextAttemptAt: later,
        });
        assertExact(inbox, db);
        inbox.claimNextDelivery(later);
        inbox.recoverDeliveries(later);
        assertExact(inbox, db);
        inbox.claimNextDelivery(later);
        inbox.finishDelivery({
          deliveryId: accepted.deliveryId,
          state: n % 3 === 0 ? "expired" : n % 3 === 1 ? "node-verified" : "quarantined",
          reason: "fixture",
          completedAt: later,
        });
        assertExact(inbox, db);
      }
      inbox.prunePayloads("2026-09-17T12:00:00.000Z");
      assertExact(inbox, db);
      expect(inbox.status()).toMatchObject({
        uniqueDeliveries: 12,
        deliveryAttempts: 24,
        duplicates: 12,
        processingAttempts: 36,
        nodeVerified: 4,
        quarantined: 4,
        expired: 4,
        queueDepth: 0,
        processing: 0,
        retainedPayloadBytes: 0,
        prunedPayloads: 12,
      });
      inbox.acceptDelivery(input(1, { receivedAt: "2026-09-17T12:00:01.000Z" }));
      assertExact(inbox, db);
      expect(inbox.status().prunedPayloads).toBe(12);
      expect(scans()).toBe(1);
    });
  });

  it.each([
    "new-block",
    "new-burn-block",
  ] as const)("accounts for %s conflict upserts and removal of the verified tip", async (endpointKind) => {
    await fixture(async (inbox, db) => {
      const scans = fullScans(inbox);
      inbox.status();
      const original = input(
        1,
        endpointKind === "new-burn-block"
          ? {
              endpointKind,
              claimedBlockHeight: null,
              claimedBlockHash: null,
              claimedIndexBlockHash: null,
              claimedBurnBlockHeight: 1,
              claimedBurnBlockHash: hash(1),
            }
          : {},
      );
      const accepted = inbox.acceptDelivery(original);
      inbox.claimNextDelivery(later);
      inbox.finishDelivery({
        deliveryId: accepted.deliveryId,
        state: "node-verified",
        reason: "fixture",
        completedAt: later,
      });
      inbox.acceptDelivery({ ...original, contentSha256: hash(2).slice(2), receivedAt: later });
      assertExact(inbox, db);
      expect(inbox.status()).toMatchObject({
        uniqueDeliveries: 1,
        duplicates: 1,
        quarantined: 1,
        nodeVerified: 0,
        lastVerifiedStacksBlock: null,
      });
      if (endpointKind === "new-block") {
        // Same claimed position with a different block hash inserts a second quarantined row.
        inbox.acceptDelivery({
          ...original,
          contentSha256: hash(3).slice(2),
          claimedBlockHash: hash(3),
          receivedAt: later,
        });
        assertExact(inbox, db);
        expect(inbox.status().quarantined).toBe(2);
      }
      expect(scans()).toBe(1);
    });
  });

  it("never publishes rolled-back acceptance, conflict changes or failed completion", async () => {
    await fixture(async (inbox, db) => {
      const accepted = inbox.acceptDelivery(input(1));
      const before = inbox.status();
      expect(() =>
        inbox.acceptDelivery(input(2), {
          maximumPendingDeliveries: 1,
          maximumPendingPayloadBytes: 10,
        }),
      ).toThrow(ObserverInboxCapacityError);
      expect(inbox.status()).toEqual(before);
      expect(() =>
        inbox.finishDelivery({
          deliveryId: accepted.deliveryId,
          state: "node-verified",
          reason: "not claimed",
          completedAt: later,
        }),
      ).toThrow("not being processed");
      db.exec(`CREATE TRIGGER reject_observer_insert BEFORE INSERT ON observer_deliveries
        BEGIN SELECT RAISE(ABORT, 'fixture rejects insert'); END`);
      inbox.status(); // acknowledge the schema change before exercising rollback
      expect(() => inbox.acceptDelivery(input(1, { contentSha256: hash(3).slice(2) }))).toThrow(
        "fixture rejects insert",
      );
      expect(inbox.status()).toEqual(before);
      assertExact(inbox, db);
    });
  });

  it("rebuilds after external commits, including a commit before a local mutation, but not external rollbacks", async () => {
    await fixture(async (inbox, db) => {
      const scans = fullScans(inbox);
      inbox.acceptDelivery(input(1));
      assertExact(inbox, db);
      db.exec("BEGIN; UPDATE observer_deliveries SET delivery_attempts = 10; ROLLBACK;");
      assertExact(inbox, db);
      expect(scans()).toBe(1);
      db.exec("UPDATE observer_deliveries SET delivery_attempts = 10");
      inbox.acceptDelivery(input(2));
      assertExact(inbox, db);
      expect(scans()).toBe(2);
      expect(inbox.status().deliveryAttempts).toBe(11);
      db.exec("DELETE FROM observer_deliveries");
      assertExact(inbox, db);
      expect(inbox.status().uniqueDeliveries).toBe(0);
      expect(scans()).toBe(3);
    });
  });

  it("rebuilds maxima after backdated updates and starts fresh after reopening", async () => {
    await fixture(async (inbox, db) => {
      inbox.acceptDelivery(input(1, { receivedAt: later }));
      inbox.acceptDelivery(input(2));
      inbox.status();
      inbox.acceptDelivery(input(1, { receivedAt: "2026-09-14T12:00:00.000Z" }));
      assertExact(inbox, db);
      expect(inbox.status().lastReceivedAt).toBe(now);
      inbox.claimNextDelivery(later);
      inbox.recoverDeliveries(now);
      inbox.status();
      inbox.claimNextDelivery(now);
      assertExact(inbox, db);
      expect(inbox.status().lastProcessedAt).toBe(now);
      const restarted = new ObserverInboxRepository(db);
      expect(restarted.status()).toEqual(inbox.status());
      restarted.recoverDeliveries(later);
      assertExact(inbox, db);
    });
  });

  it("keeps operational reads independent of totals and uses existing indexes without planner statistics", async () => {
    await fixture(async (inbox, db) => {
      const scans = fullScans(inbox);
      const originalPrepare = DatabaseSync.prototype.prepare;
      const queries: string[] = [];
      const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        queries.push(sql);
        return originalPrepare.call(this, sql);
      });
      try {
        const accepted = inbox.acceptDelivery(input(1));
        expect(inbox.operationalStatus().queueDepth).toBe(1);
        inbox.claimNextDelivery(later);
        inbox.finishDelivery({
          deliveryId: accepted.deliveryId,
          state: "node-verified",
          reason: "fixture",
          completedAt: later,
        });
        expect(inbox.operationalStatus()).toMatchObject({
          queueDepth: 0,
          lastVerifiedStacksBlock: { height: 1 },
        });
      } finally {
        spy.mockRestore();
      }
      expect(scans()).toBe(0);
      const tipSql = queries.find((sql) => sql.includes("INDEXED BY observer_latest_verified"));
      expect(tipSql).toBeDefined();
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${tipSql}`)
        .all()
        .map((row) => row.detail)
        .join(" ");
      expect(plan).toContain("observer_latest_verified");
      expect(plan).not.toContain("TEMP B-TREE");
      const pruningSql = queries.find((sql) => sql.includes("MIN(COALESCE(completed_at"));
      expect(pruningSql).toBeDefined();
      expect(
        db
          .prepare(`EXPLAIN QUERY PLAN ${pruningSql}`)
          .all()
          .map((row) => row.detail)
          .join(" "),
      ).toContain("observer_terminal_payloads");
      const queueSql = queries.find((sql) =>
        sql.includes("INDEXED BY observer_deliveries_pending"),
      );
      expect(queueSql).toBeDefined();
      expect(
        db
          .prepare(`EXPLAIN QUERY PLAN ${queueSql}`)
          .all()
          .map((row) => row.detail)
          .join(" "),
      ).toContain("SEARCH observer_deliveries USING COVERING INDEX observer_deliveries_pending");
    });
  });

  it("serves fresh metrics after callbacks without rebuilding lifetime totals", async () => {
    await fixture(async (inbox) => {
      const scans = fullScans(inbox);
      const server = createServer({
        logger: false,
        observerStatus: () => observerRuntimeStatus({ enabled: false }, inbox.status()),
      });
      try {
        expect((await server.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
        for (let n = 1; n <= 5; n++) {
          inbox.acceptDelivery(input(n));
          const response = await server.inject({ method: "GET", url: "/metrics" });
          expect(response.statusCode).toBe(200);
          expect(response.body).toContain(`sidekick_observer_deliveries_total ${n}\n`);
          expect(response.body).toContain(`sidekick_observer_queue_depth ${n}\n`);
          expect(inbox.status().queueDepth).toBe(n);
        }
        expect(scans()).toBe(1);
      } finally {
        await server.close();
      }
    });
  });
});
