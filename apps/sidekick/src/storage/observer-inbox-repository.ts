import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const hashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const observerDeliveryInputSchema = z
  .object({
    endpointKind: z.enum(["new-block", "new-burn-block", "attachments"]),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    rawPayloadJson: z.string().min(1),
    payloadBytes: z.number().int().nonnegative(),
    state: z.enum(["observer-claimed", "quarantined", "expired"]),
    stateReason: z.string().min(1).max(500).nullable(),
    claimedBlockHeight: z.number().int().nonnegative().nullable(),
    claimedBlockHash: hashSchema.nullable(),
    claimedIndexBlockHash: hashSchema.nullable(),
    claimedBurnBlockHeight: z.number().int().nonnegative().nullable(),
    claimedBurnBlockHash: hashSchema.nullable(),
    receivedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      JSON.parse(value.rawPayloadJson);
    } catch {
      context.addIssue({
        code: "custom",
        message: "rawPayloadJson must contain valid JSON",
        path: ["rawPayloadJson"],
      });
    }
    if (Buffer.byteLength(value.rawPayloadJson, "utf8") !== value.payloadBytes) {
      context.addIssue({
        code: "custom",
        message: "payloadBytes must match the UTF-8 payload size",
        path: ["payloadBytes"],
      });
    }
  });

const storedObserverDeliveryRowSchema = z.object({
  delivery_id: z.string().uuid(),
  endpoint_kind: z.enum(["new-block", "new-burn-block", "attachments"]),
  raw_payload_json: z.string(),
  claimed_block_height: z.number().int().nonnegative().nullable(),
  claimed_block_hash: hashSchema.nullable(),
  claimed_index_block_hash: hashSchema.nullable(),
  claimed_burn_block_height: z.number().int().nonnegative().nullable(),
  claimed_burn_block_hash: hashSchema.nullable(),
  processing_attempts: z.number().int().positive(),
  first_received_at: z.iso.datetime(),
  last_received_at: z.iso.datetime(),
  last_processing_at: z.iso.datetime(),
});

const acceptedObserverDeliveryRowSchema = z.object({
  delivery_id: z.string().uuid(),
  state: z.enum(["observer-claimed", "processing", "node-verified", "quarantined", "expired"]),
  delivery_attempts: z.number().int().min(1),
});

const OBSERVER_RAW_PAYLOAD_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_RETAINED_OBSERVER_RAW_PAYLOADS = 25_000;
const MAX_RETAINED_OBSERVER_RAW_PAYLOAD_BYTES = 64 * 1_024 * 1_024;
const MAX_PENDING_OBSERVER_DELIVERIES = 2_000;
const MAX_PENDING_OBSERVER_PAYLOAD_BYTES = 64 * 1_024 * 1_024;

export type ObserverDeliveryInput = z.infer<typeof observerDeliveryInputSchema>;

export interface AcceptedObserverDelivery {
  deliveryId: string;
  duplicate: boolean;
  state: "observer-claimed" | "processing" | "node-verified" | "quarantined" | "expired";
  deliveryAttempts: number;
}

export interface ObserverInboxLimits {
  maximumPendingDeliveries: number;
  maximumPendingPayloadBytes: number;
}

export class ObserverInboxCapacityError extends Error {
  constructor() {
    super("Observer inbox capacity is exhausted; retry after Sidekick processes pending callbacks");
    this.name = "ObserverInboxCapacityError";
  }
}

export interface StoredObserverDelivery {
  deliveryId: string;
  endpointKind: "new-block" | "new-burn-block" | "attachments";
  rawPayloadJson: string;
  claimedBlockHeight: number | null;
  claimedBlockHash: string | null;
  claimedIndexBlockHash: string | null;
  claimedBurnBlockHeight: number | null;
  claimedBurnBlockHash: string | null;
  processingAttempts: number;
  firstReceivedAt: string;
  lastReceivedAt: string;
  lastProcessingAt: string;
}

export interface ObserverDeliveryCompletion {
  deliveryId: string;
  state: "node-verified" | "quarantined" | "expired";
  reason: string;
  completedAt: string;
}

export interface ObserverDeliveryRetry {
  deliveryId: string;
  reason: string;
  retriedAt: string;
  nextAttemptAt: string;
}

export interface ObserverInboxStatus {
  schemaVersion: 1;
  uniqueDeliveries: number;
  deliveryAttempts: number;
  processingAttempts: number;
  duplicates: number;
  queueDepth: number;
  processing: number;
  nodeVerified: number;
  quarantined: number;
  expired: number;
  retainedPayloadBytes: number;
  prunedPayloads: number;
  lastReceivedAt: string | null;
  lastProcessedAt: string | null;
  oldestPendingAt: string | null;
  lastClaimedStacksBlock: null | {
    height: number;
    blockHash: string;
    indexBlockHash: string;
  };
  lastVerifiedStacksBlock: null | {
    height: number;
    indexBlockHash: string;
    receivedAt: string;
    verifiedAt: string;
  };
  lastClaimedBurnBlock: null | {
    height: number;
    blockHash: string;
  };
  lastQuarantine: null | {
    endpointKind: "new-block" | "new-burn-block" | "attachments";
    reason: string;
    receivedAt: string;
  };
}

export class ObserverInboxRepository {
  constructor(private readonly db: DatabaseSync) {}

  acceptDelivery(
    input: ObserverDeliveryInput,
    limits: ObserverInboxLimits = {
      maximumPendingDeliveries: MAX_PENDING_OBSERVER_DELIVERIES,
      maximumPendingPayloadBytes: MAX_PENDING_OBSERVER_PAYLOAD_BYTES,
    },
  ): AcceptedObserverDelivery {
    const value = observerDeliveryInputSchema.parse(input);
    const parsedLimits = z
      .object({
        maximumPendingDeliveries: z.number().int().positive(),
        maximumPendingPayloadBytes: z.number().int().positive(),
      })
      .strict()
      .parse(limits);
    const proposedDeliveryId = randomUUID();
    let accepted: z.infer<typeof acceptedObserverDeliveryRowSchema>;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const conflictingChainClaim =
        value.endpointKind === "new-block" &&
        value.claimedBlockHeight !== null &&
        value.claimedIndexBlockHash !== null
          ? this.db
              .prepare(
                `SELECT 1
                 FROM observer_deliveries
                 WHERE endpoint_kind = 'new-block'
                   AND claimed_block_height = ?
                   AND claimed_index_block_hash = ?
                   AND content_sha256 <> ?
                 LIMIT 1`,
              )
              .get(value.claimedBlockHeight, value.claimedIndexBlockHash, value.contentSha256) !==
            undefined
          : value.endpointKind === "new-burn-block" &&
              value.claimedBurnBlockHeight !== null &&
              value.claimedBurnBlockHash !== null
            ? this.db
                .prepare(
                  `SELECT 1
                   FROM observer_deliveries
                   WHERE endpoint_kind = 'new-burn-block'
                     AND claimed_burn_block_height = ?
                     AND claimed_burn_block_hash = ?
                     AND content_sha256 <> ?
                   LIMIT 1`,
                )
                .get(
                  value.claimedBurnBlockHeight,
                  value.claimedBurnBlockHash,
                  value.contentSha256,
                ) !== undefined
            : false;
      const acceptedState = conflictingChainClaim ? "quarantined" : value.state;
      const acceptedReason = conflictingChainClaim
        ? "conflicting-callback-bodies-for-chain-position"
        : value.stateReason;
      const completedAt = acceptedState === "observer-claimed" ? null : value.receivedAt;
      if (conflictingChainClaim) {
        const where =
          value.endpointKind === "new-block"
            ? `endpoint_kind = 'new-block'
               AND claimed_block_height = ? AND claimed_index_block_hash = ?`
            : `endpoint_kind = 'new-burn-block'
               AND claimed_burn_block_height = ? AND claimed_burn_block_hash = ?`;
        const identity =
          value.endpointKind === "new-block"
            ? [value.claimedBlockHeight, value.claimedIndexBlockHash]
            : [value.claimedBurnBlockHeight, value.claimedBurnBlockHash];
        this.db
          .prepare(
            `UPDATE observer_deliveries
             SET state = 'quarantined',
                 state_reason = 'conflicting-callback-bodies-for-chain-position',
                 completed_at = COALESCE(completed_at, ?), updated_at = ?
             WHERE ${where}`,
          )
          .run(value.receivedAt, value.receivedAt, ...identity);
      }
      const row = this.db
        .prepare(
          `INSERT INTO observer_deliveries (
            delivery_id, endpoint_kind, content_sha256, raw_payload_json, payload_bytes,
            state, state_reason, claimed_block_height, claimed_block_hash,
            claimed_index_block_hash, claimed_burn_block_height, claimed_burn_block_hash,
            delivery_attempts, first_received_at, last_received_at, next_attempt_at, completed_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
          ON CONFLICT DO UPDATE SET
            delivery_attempts = observer_deliveries.delivery_attempts + 1,
            state = CASE
              WHEN excluded.state = 'quarantined' THEN 'quarantined'
              ELSE observer_deliveries.state
            END,
            state_reason = CASE
              WHEN excluded.state = 'quarantined' THEN excluded.state_reason
              ELSE observer_deliveries.state_reason
            END,
            completed_at = CASE
              WHEN excluded.state = 'quarantined'
                THEN COALESCE(observer_deliveries.completed_at, excluded.completed_at)
              ELSE observer_deliveries.completed_at
            END,
            last_received_at = excluded.last_received_at,
            updated_at = excluded.updated_at
          RETURNING delivery_id, state, delivery_attempts`,
        )
        .get(
          proposedDeliveryId,
          value.endpointKind,
          value.contentSha256,
          value.rawPayloadJson,
          value.payloadBytes,
          acceptedState,
          acceptedReason,
          value.claimedBlockHeight,
          value.claimedBlockHash,
          value.claimedIndexBlockHash,
          value.claimedBurnBlockHeight,
          value.claimedBurnBlockHash,
          value.receivedAt,
          value.receivedAt,
          value.receivedAt,
          completedAt,
          value.receivedAt,
        );
      accepted = acceptedObserverDeliveryRowSchema.parse(row);
      if (accepted.delivery_id === proposedDeliveryId && accepted.state === "observer-claimed") {
        const pending = z
          .object({
            deliveries: z.number().int().nonnegative(),
            payload_bytes: z.number().int().nonnegative(),
          })
          .parse(
            this.db
              .prepare(
                `SELECT COUNT(*) AS deliveries, COALESCE(SUM(payload_bytes), 0) AS payload_bytes
                 FROM observer_deliveries
                 WHERE state IN ('observer-claimed', 'processing')`,
              )
              .get(),
          );
        if (
          pending.deliveries > parsedLimits.maximumPendingDeliveries ||
          pending.payload_bytes > parsedLimits.maximumPendingPayloadBytes
        ) {
          throw new ObserverInboxCapacityError();
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.prunePayloads(value.receivedAt);
    return {
      deliveryId: accepted.delivery_id,
      duplicate: accepted.delivery_id !== proposedDeliveryId,
      state: accepted.state,
      deliveryAttempts: accepted.delivery_attempts,
    };
  }

  prunePayloads(observedAt: string): number {
    const parsedObservedAt = z.iso.datetime().parse(observedAt);
    const cutoff = new Date(
      Date.parse(parsedObservedAt) - OBSERVER_RAW_PAYLOAD_RETENTION_MS,
    ).toISOString();
    const result = this.db
      .prepare(
        `WITH retained AS (
           SELECT delivery_id,
             ROW_NUMBER() OVER (
               ORDER BY COALESCE(completed_at, updated_at) DESC, delivery_id DESC
             ) AS retained_rank,
             SUM(payload_bytes) OVER (
               ORDER BY COALESCE(completed_at, updated_at) DESC, delivery_id DESC
             ) AS retained_bytes,
             COALESCE(completed_at, updated_at) AS terminal_at
           FROM observer_deliveries
           WHERE state IN ('node-verified', 'quarantined', 'expired')
             AND payload_pruned = 0
         )
         UPDATE observer_deliveries
         SET raw_payload_json = '{}', payload_bytes = 0, payload_pruned = 1, updated_at = ?
         WHERE delivery_id IN (
           SELECT delivery_id
           FROM retained
           WHERE terminal_at < ? OR retained_rank > ? OR retained_bytes > ?
         )`,
      )
      .run(
        parsedObservedAt,
        cutoff,
        MAX_RETAINED_OBSERVER_RAW_PAYLOADS,
        MAX_RETAINED_OBSERVER_RAW_PAYLOAD_BYTES,
      );
    return Number(result.changes);
  }

  recoverDeliveries(recoveredAt: string): number {
    const parsedRecoveredAt = z.iso.datetime().parse(recoveredAt);
    const result = this.db
      .prepare(
        `UPDATE observer_deliveries
         SET state = 'observer-claimed', state_reason = 'recovered-after-restart',
             next_attempt_at = ?, updated_at = ?
         WHERE state = 'processing'`,
      )
      .run(parsedRecoveredAt, parsedRecoveredAt);
    return Number(result.changes);
  }

  claimNextDelivery(claimedAt: string): StoredObserverDelivery | null {
    const parsedClaimedAt = z.iso.datetime().parse(claimedAt);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `UPDATE observer_deliveries
           SET state = 'processing', state_reason = NULL,
               processing_attempts = processing_attempts + 1,
               last_processing_at = ?, updated_at = ?
           WHERE delivery_id = (
             SELECT delivery_id
             FROM observer_deliveries
             WHERE state = 'observer-claimed' AND next_attempt_at <= ?
             ORDER BY next_attempt_at ASC, first_received_at ASC, delivery_id ASC
             LIMIT 1
           )
           RETURNING delivery_id, endpoint_kind, raw_payload_json,
             claimed_block_height, claimed_block_hash, claimed_index_block_hash,
             claimed_burn_block_height, claimed_burn_block_hash, processing_attempts,
             first_received_at, last_received_at, last_processing_at`,
        )
        .get(parsedClaimedAt, parsedClaimedAt, parsedClaimedAt);
      const delivery = row ? storedObserverDeliveryRowSchema.parse(row) : null;
      this.db.exec("COMMIT");
      if (!delivery) return null;
      return {
        deliveryId: delivery.delivery_id,
        endpointKind: delivery.endpoint_kind,
        rawPayloadJson: delivery.raw_payload_json,
        claimedBlockHeight: delivery.claimed_block_height,
        claimedBlockHash: delivery.claimed_block_hash,
        claimedIndexBlockHash: delivery.claimed_index_block_hash,
        claimedBurnBlockHeight: delivery.claimed_burn_block_height,
        claimedBurnBlockHash: delivery.claimed_burn_block_hash,
        processingAttempts: delivery.processing_attempts,
        firstReceivedAt: delivery.first_received_at,
        lastReceivedAt: delivery.last_received_at,
        lastProcessingAt: delivery.last_processing_at,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishDelivery(input: ObserverDeliveryCompletion): void {
    const deliveryId = z.string().uuid().parse(input.deliveryId);
    const state = z.enum(["node-verified", "quarantined", "expired"]).parse(input.state);
    const reason = z.string().min(1).max(500).parse(input.reason);
    const completedAt = z.iso.datetime().parse(input.completedAt);
    const result = this.db
      .prepare(
        `UPDATE observer_deliveries
         SET state = ?, state_reason = ?, completed_at = ?, updated_at = ?
         WHERE delivery_id = ? AND state = 'processing'`,
      )
      .run(state, reason, completedAt, completedAt, deliveryId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Observer delivery ${deliveryId} is not being processed`);
    }
    this.prunePayloads(completedAt);
  }

  retryDelivery(input: ObserverDeliveryRetry): void {
    const deliveryId = z.string().uuid().parse(input.deliveryId);
    const reason = z.string().min(1).max(500).parse(input.reason);
    const retriedAt = z.iso.datetime().parse(input.retriedAt);
    const nextAttemptAt = z.iso.datetime().parse(input.nextAttemptAt);
    if (Date.parse(nextAttemptAt) <= Date.parse(retriedAt)) {
      throw new Error("Observer delivery next attempt must be after the retry time");
    }
    const result = this.db
      .prepare(
        `UPDATE observer_deliveries
         SET state = 'observer-claimed', state_reason = ?, next_attempt_at = ?, updated_at = ?
         WHERE delivery_id = ? AND state = 'processing'`,
      )
      .run(reason, nextAttemptAt, retriedAt, deliveryId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Observer delivery ${deliveryId} is not being processed`);
    }
  }

  status(): ObserverInboxStatus {
    const totals = z
      .object({
        unique_deliveries: z.number().int().nonnegative(),
        delivery_attempts: z.number().int().nonnegative(),
        processing_attempts: z.number().int().nonnegative(),
        duplicates: z.number().int().nonnegative(),
        queue_depth: z.number().int().nonnegative(),
        processing: z.number().int().nonnegative(),
        node_verified: z.number().int().nonnegative(),
        quarantined: z.number().int().nonnegative(),
        expired: z.number().int().nonnegative(),
        retained_payload_bytes: z.number().int().nonnegative(),
        pruned_payloads: z.number().int().nonnegative(),
        last_received_at: z.string().nullable(),
        last_processed_at: z.string().nullable(),
        oldest_pending_at: z.string().nullable(),
      })
      .parse(
        this.db
          .prepare(
            `SELECT
              COUNT(*) AS unique_deliveries,
              COALESCE(SUM(delivery_attempts), 0) AS delivery_attempts,
              COALESCE(SUM(processing_attempts), 0) AS processing_attempts,
              COALESCE(SUM(delivery_attempts - 1), 0) AS duplicates,
              COALESCE(SUM(state = 'observer-claimed'), 0) AS queue_depth,
              COALESCE(SUM(state = 'processing'), 0) AS processing,
              COALESCE(SUM(state = 'node-verified'), 0) AS node_verified,
              COALESCE(SUM(state = 'quarantined'), 0) AS quarantined,
              COALESCE(SUM(state = 'expired'), 0) AS expired,
              COALESCE(SUM(CASE WHEN payload_pruned = 0 THEN payload_bytes ELSE 0 END), 0)
                AS retained_payload_bytes,
              COALESCE(SUM(payload_pruned), 0) AS pruned_payloads,
              MAX(last_received_at) AS last_received_at,
              MAX(last_processing_at) AS last_processed_at,
              MIN(CASE WHEN state = 'observer-claimed' THEN first_received_at END)
                AS oldest_pending_at
             FROM observer_deliveries`,
          )
          .get(),
      );
    const stacks = z
      .object({
        claimed_block_height: z.number().int().nonnegative(),
        claimed_block_hash: hashSchema,
        claimed_index_block_hash: hashSchema,
      })
      .nullable()
      .parse(
        this.db
          .prepare(
            `SELECT claimed_block_height, claimed_block_hash, claimed_index_block_hash
             FROM observer_deliveries
             WHERE claimed_block_height IS NOT NULL
               AND claimed_block_hash IS NOT NULL
               AND claimed_index_block_hash IS NOT NULL
             ORDER BY claimed_block_height DESC, last_received_at DESC
             LIMIT 1`,
          )
          .get() ?? null,
      );
    const burn = z
      .object({
        claimed_burn_block_height: z.number().int().nonnegative(),
        claimed_burn_block_hash: hashSchema,
      })
      .nullable()
      .parse(
        this.db
          .prepare(
            `SELECT claimed_burn_block_height, claimed_burn_block_hash
             FROM observer_deliveries
             WHERE claimed_burn_block_height IS NOT NULL
               AND claimed_burn_block_hash IS NOT NULL
             ORDER BY claimed_burn_block_height DESC, last_received_at DESC
             LIMIT 1`,
          )
          .get() ?? null,
      );
    const verifiedStacks = z
      .object({
        claimed_block_height: z.number().int().nonnegative(),
        claimed_index_block_hash: hashSchema,
        first_received_at: z.iso.datetime(),
        completed_at: z.iso.datetime(),
      })
      .nullable()
      .parse(
        this.db
          .prepare(
            `SELECT claimed_block_height, claimed_index_block_hash,
                    first_received_at, completed_at
             FROM observer_deliveries
             WHERE state = 'node-verified'
               AND claimed_block_height IS NOT NULL
               AND claimed_index_block_hash IS NOT NULL
               AND completed_at IS NOT NULL
             ORDER BY claimed_block_height DESC, completed_at DESC
             LIMIT 1`,
          )
          .get() ?? null,
      );
    const quarantine = z
      .object({
        endpoint_kind: z.enum(["new-block", "new-burn-block", "attachments"]),
        state_reason: z.string().min(1),
        last_received_at: z.string(),
      })
      .nullable()
      .parse(
        this.db
          .prepare(
            `SELECT endpoint_kind, state_reason, last_received_at
             FROM observer_deliveries
             WHERE state = 'quarantined' AND state_reason IS NOT NULL
             ORDER BY last_received_at DESC, delivery_id DESC
             LIMIT 1`,
          )
          .get() ?? null,
      );
    return {
      schemaVersion: 1,
      uniqueDeliveries: totals.unique_deliveries,
      deliveryAttempts: totals.delivery_attempts,
      processingAttempts: totals.processing_attempts,
      duplicates: totals.duplicates,
      queueDepth: totals.queue_depth,
      processing: totals.processing,
      nodeVerified: totals.node_verified,
      quarantined: totals.quarantined,
      expired: totals.expired,
      retainedPayloadBytes: totals.retained_payload_bytes,
      prunedPayloads: totals.pruned_payloads,
      lastReceivedAt: totals.last_received_at,
      lastProcessedAt: totals.last_processed_at,
      oldestPendingAt: totals.oldest_pending_at,
      lastClaimedStacksBlock: stacks
        ? {
            height: stacks.claimed_block_height,
            blockHash: stacks.claimed_block_hash,
            indexBlockHash: stacks.claimed_index_block_hash,
          }
        : null,
      lastVerifiedStacksBlock: verifiedStacks
        ? {
            height: verifiedStacks.claimed_block_height,
            indexBlockHash: verifiedStacks.claimed_index_block_hash,
            receivedAt: verifiedStacks.first_received_at,
            verifiedAt: verifiedStacks.completed_at,
          }
        : null,
      lastClaimedBurnBlock: burn
        ? { height: burn.claimed_burn_block_height, blockHash: burn.claimed_burn_block_hash }
        : null,
      lastQuarantine: quarantine
        ? {
            endpointKind: quarantine.endpoint_kind,
            reason: quarantine.state_reason,
            receivedAt: quarantine.last_received_at,
          }
        : null,
    };
  }
}
