import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type HealthSnapshot,
  healthFindingEpisodeSchema,
  healthFindingSchema,
  healthRollupSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { z } from "zod";
import type { HealthObservation } from "../health-monitoring-types.js";

export const HEALTH_RAW_RETENTION_HOURS = 72 as const;
export const HEALTH_ROLLUP_RETENTION_DAYS = 90 as const;
export const HEALTH_ROLLUP_INTERVAL_MINUTES = 5 as const;
export const HEALTH_RESOLVED_EPISODE_RETENTION_DAYS = 90 as const;
export const HEALTH_EPISODE_RECURRENCE_WINDOW_MS = 5 * 60 * 1_000;

export type HealthRollup = HealthSnapshot["history"]["recentRollups"][number];
export type HealthFindingEpisode = HealthSnapshot["history"]["recentEpisodes"][number];

const sourceObservationSchema = z.looseObject({
  reachable: z.boolean(),
  latencyMs: z.number().nonnegative().nullable(),
  errorCode: z.string().nullable(),
  checkedAt: z.iso.datetime(),
});

const optionalCounterSchema = z.number().nonnegative().nullable();
const metricTotalsSchema = z.record(z.string(), z.number().nonnegative());

const nodeInfoSchema = z
  .object({
    server_version: z.string().min(1).optional(),
    network_id: z.number().int(),
    burn_block_height: z.number().int().nonnegative(),
    stacks_tip_height: z.number().int().nonnegative(),
    stacks_tip: z.string().optional(),
    stacks_tip_consensus_hash: z.string().optional(),
    is_fully_synced: z.boolean().optional(),
  })
  .strict();

const nodeHealthSchema = z
  .object({
    difference_from_max_peer: z.number().int().nonnegative(),
    max_stacks_height_of_neighbors: z.number().int().nonnegative(),
    node_stacks_tip_height: z.number().int().nonnegative(),
  })
  .strict();

const nodeMetricValuesSchema = z
  .object({
    stacksTipHeight: optionalCounterSchema,
    burnBlockHeight: optionalCounterSchema,
    inboundPeers: optionalCounterSchema,
    outboundPeers: optionalCounterSchema,
    warningTotal: optionalCounterSchema,
    errorTotal: optionalCounterSchema,
  })
  .strict();

const apiStatusSchema = z
  .object({
    server_version: z.string().optional(),
    status: z.string(),
    chain_tip: z
      .object({
        block_height: z.number().int().nonnegative(),
        burn_block_height: z.number().int().nonnegative(),
        index_block_hash: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const signerInfoSchema = z
  .object({
    signerPublicKey: z.string().min(1),
    network: z.string().min(1),
    stxAddress: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();

const signerMetricValuesSchema = z
  .object({
    nodeHeight: optionalCounterSchema,
    rewardCycle: optionalCounterSchema,
    stxBalanceUstx: optionalCounterSchema,
    proposalsTotal: optionalCounterSchema,
    validationAcceptedTotal: optionalCounterSchema,
    validationRejectedTotal: optionalCounterSchema,
    acceptedTotal: optionalCounterSchema,
    rejectedTotal: optionalCounterSchema,
    preCommitsTotal: optionalCounterSchema,
    conflictTotal: optionalCounterSchema,
    nodeRpcLatencyBuckets: metricTotalsSchema,
    validationLatencyBuckets: metricTotalsSchema,
    responseLatencyBuckets: metricTotalsSchema,
    capitulationLatencyBuckets: metricTotalsSchema,
  })
  // Strip retired metric vectors when reading rows written by older Sidekick builds.
  .strip();

const healthObservationSchema = z.looseObject({
  observedAt: z.iso.datetime(),
  nodeRpc: sourceObservationSchema,
  nodeInfo: nodeInfoSchema.nullable(),
  nodeHealth: nodeHealthSchema.nullable(),
  nodeHealthSource: sourceObservationSchema.nullable().optional(),
  nodeMetricsSource: sourceObservationSchema.nullable(),
  nodeMetrics: nodeMetricValuesSchema.nullable(),
  hiroSource: sourceObservationSchema.nullable(),
  hiro: apiStatusSchema.nullable(),
  configuredApiSource: sourceObservationSchema.nullable(),
  configuredApi: apiStatusSchema.nullable(),
  signerInfoSource: sourceObservationSchema.nullable(),
  signerInfo: signerInfoSchema.nullable(),
  signerHeartbeat: sourceObservationSchema.nullable(),
  signerMetricsSource: sourceObservationSchema.nullable(),
  signerMetrics: signerMetricValuesSchema.nullable(),
});

const observationRowSchema = z.object({
  observation_json: z.string(),
});

const observationSummaryRowSchema = z.object({
  observation_count: z.number().int().nonnegative(),
  observed_since: z.string().nullable(),
});

const rollupRowSchema = z.object({ rollup_json: z.string() });

const episodeRowSchema = z.object({
  episode_id: z.string().uuid(),
  status: z.enum(["active", "resolved"]),
  finding_json: z.string(),
  opened_at: z.string(),
  last_observed_at: z.string(),
  resolved_at: z.string().nullable(),
  occurrences: z.number().int().positive(),
});

function parseObservation(value: string): HealthObservation {
  const parsed = healthObservationSchema.parse(JSON.parse(value));
  return { ...parsed, nodeHealthSource: parsed.nodeHealthSource ?? null } as HealthObservation;
}

function parseEpisode(row: unknown): HealthFindingEpisode {
  const value = episodeRowSchema.parse(row);
  const finding = healthFindingSchema.parse(JSON.parse(value.finding_json));
  return healthFindingEpisodeSchema.parse({
    ...finding,
    episodeId: value.episode_id,
    status: value.status,
    firstObservedAt: value.opened_at,
    lastObservedAt: value.last_observed_at,
    resolvedAt: value.resolved_at,
    occurrences: value.occurrences,
  });
}

export class HealthMonitoringRepository {
  private skippedObservationRows = 0;
  private skippedRollupRows = 0;
  private skippedEpisodeRows = 0;

  constructor(private readonly db: DatabaseSync) {}

  recordObservation(configFingerprint: string, observation: HealthObservation): void {
    const fingerprint = z.string().min(1).parse(configFingerprint);
    const value = healthObservationSchema.parse(observation);
    this.db
      .prepare(
        `INSERT INTO health_observations (
           config_fingerprint, observed_at, observation_json
         ) VALUES (?, ?, ?)
         ON CONFLICT (config_fingerprint, observed_at) DO NOTHING`,
      )
      .run(fingerprint, value.observedAt, JSON.stringify(value));
  }

  listObservations(
    configFingerprint: string,
    options: { since?: string; limit?: number } = {},
  ): HealthObservation[] {
    const fingerprint = z.string().min(1).parse(configFingerprint);
    const since = options.since
      ? z.iso.datetime().parse(options.since)
      : "0000-01-01T00:00:00.000Z";
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .parse(options.limit ?? 10_000);
    const rows = this.db
      .prepare(
        `SELECT observation_json
         FROM (
           SELECT observation_json, observed_at
           FROM health_observations
           WHERE config_fingerprint = ? AND observed_at >= ?
           ORDER BY observed_at DESC
           LIMIT ?
         )
         ORDER BY observed_at ASC`,
      )
      .all(fingerprint, since, limit);
    this.skippedObservationRows = 0;
    const observations: HealthObservation[] = [];
    for (const row of rows) {
      try {
        observations.push(parseObservation(observationRowSchema.parse(row).observation_json));
      } catch {
        this.skippedObservationRows += 1;
      }
    }
    return observations;
  }

  observationSummary(configFingerprint: string): {
    observationCount: number;
    observedSince: string | null;
  } {
    const row = observationSummaryRowSchema.parse(
      this.db
        .prepare(
          `SELECT COUNT(*) AS observation_count, MIN(observed_at) AS observed_since
           FROM health_observations
           WHERE config_fingerprint = ?`,
        )
        .get(z.string().min(1).parse(configFingerprint)),
    );
    return {
      observationCount: row.observation_count,
      observedSince: row.observed_since,
    };
  }

  upsertRollup(configFingerprint: string, rollup: HealthRollup, updatedAt: string): void {
    const fingerprint = z.string().min(1).parse(configFingerprint);
    const value = healthRollupSchema.parse(rollup);
    const parsedUpdatedAt = z.iso.datetime().parse(updatedAt);
    this.db
      .prepare(
        `INSERT INTO health_rollups (
           config_fingerprint, window_started_at, window_ended_at, rollup_json, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (config_fingerprint, window_started_at) DO UPDATE SET
           window_ended_at = excluded.window_ended_at,
           rollup_json = excluded.rollup_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        fingerprint,
        value.windowStartedAt,
        value.windowEndedAt,
        JSON.stringify(value),
        parsedUpdatedAt,
      );
  }

  listRecentRollups(configFingerprint: string, limit = 288): HealthRollup[] {
    const rows = this.db
      .prepare(
        `SELECT rollup_json
         FROM health_rollups
         WHERE config_fingerprint = ?
         ORDER BY window_started_at DESC
         LIMIT ?`,
      )
      .all(
        z.string().min(1).parse(configFingerprint),
        z.number().int().min(1).max(10_000).parse(limit),
      );
    this.skippedRollupRows = 0;
    const rollups: HealthRollup[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(rollupRowSchema.parse(row).rollup_json) as unknown;
        const normalized =
          parsed &&
          typeof parsed === "object" &&
          "signerAvailabilityPercent" in parsed &&
          !("signerInfoAvailabilityPercent" in parsed)
            ? (() => {
                const { signerAvailabilityPercent, ...rest } = parsed as Record<string, unknown> & {
                  signerAvailabilityPercent: unknown;
                };
                return { ...rest, signerInfoAvailabilityPercent: signerAvailabilityPercent };
              })()
            : parsed;
        rollups.push(healthRollupSchema.parse(normalized));
      } catch {
        this.skippedRollupRows += 1;
      }
    }
    return rollups;
  }

  reconcileFindingEpisodes(
    configFingerprint: string,
    findings: HealthSnapshot["findings"],
    observedAt: string,
  ): HealthFindingEpisode[] {
    const fingerprint = z.string().min(1).parse(configFingerprint);
    const at = z.iso.datetime().parse(observedAt);
    const activeIds = new Set(findings.map(({ id }) => id));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const findingInput of findings) {
        const existing = episodeRowSchema.nullable().parse(
          this.db
            .prepare(
              `SELECT episode_id, status, finding_json, opened_at, last_observed_at,
                   resolved_at, occurrences
                 FROM health_finding_episodes
                 WHERE config_fingerprint = ? AND finding_id = ?
                 ORDER BY (status = 'active') DESC, last_observed_at DESC
                 LIMIT 1`,
            )
            .get(fingerprint, findingInput.id) ?? null,
        );
        const reopenRecent = Boolean(
          existing?.status === "resolved" &&
            existing.resolved_at !== null &&
            Date.parse(at) - Date.parse(existing.resolved_at) <=
              HEALTH_EPISODE_RECURRENCE_WINDOW_MS,
        );
        const retainedWithoutNewEvidence =
          existing?.status === "active" && findingInput.lastObservedAt !== at;
        if (retainedWithoutNewEvidence) continue;
        const episodeId =
          existing && (existing.status === "active" || reopenRecent)
            ? existing.episode_id
            : randomUUID();
        const continuingEpisode = existing?.status === "active" || reopenRecent;
        const finding = healthFindingSchema.parse({
          ...findingInput,
          episodeId,
          firstObservedAt: continuingEpisode ? existing?.opened_at : findingInput.firstObservedAt,
          lastObservedAt: at,
        });
        if (existing?.status === "active" || reopenRecent) {
          this.db
            .prepare(
              `UPDATE health_finding_episodes
               SET status = 'active', finding_json = ?, last_observed_at = ?, resolved_at = NULL,
                   occurrences = occurrences + 1, updated_at = ?
               WHERE episode_id = ?`,
            )
            .run(JSON.stringify(finding), at, at, episodeId);
        } else {
          this.db
            .prepare(
              `INSERT INTO health_finding_episodes (
                 episode_id, config_fingerprint, finding_id, status, finding_json,
                 opened_at, last_observed_at, resolved_at, occurrences, updated_at
               ) VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, 1, ?)`,
            )
            .run(
              episodeId,
              fingerprint,
              finding.id,
              JSON.stringify(finding),
              finding.firstObservedAt,
              at,
              at,
            );
        }
      }
      const activeRows = this.db
        .prepare(
          `SELECT finding_id
           FROM health_finding_episodes
           WHERE config_fingerprint = ? AND status = 'active'`,
        )
        .all(fingerprint) as Array<{ finding_id: string }>;
      for (const row of activeRows) {
        if (activeIds.has(row.finding_id)) continue;
        this.db
          .prepare(
            `UPDATE health_finding_episodes
             SET status = 'resolved', resolved_at = ?, updated_at = ?
             WHERE config_fingerprint = ? AND finding_id = ? AND status = 'active'`,
          )
          .run(at, at, fingerprint, row.finding_id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const recent = this.listFindingEpisodes(fingerprint, 50);
    const active = this.listActiveFindingEpisodes(fingerprint);
    const activeEpisodeIds = new Set(active.map(({ episodeId }) => episodeId));
    return [
      ...active.sort((left, right) => right.firstObservedAt.localeCompare(left.firstObservedAt)),
      ...recent.filter(({ episodeId }) => !activeEpisodeIds.has(episodeId)),
    ].slice(0, 50);
  }

  resolveActiveFindingEpisodes(configFingerprint: string, resolvedAt: string): number {
    const result = this.db
      .prepare(
        `UPDATE health_finding_episodes
         SET status = 'resolved', resolved_at = ?, updated_at = ?
         WHERE config_fingerprint = ? AND status = 'active'`,
      )
      .run(
        z.iso.datetime().parse(resolvedAt),
        z.iso.datetime().parse(resolvedAt),
        z.string().min(1).parse(configFingerprint),
      );
    return Number(result.changes);
  }

  listFindingEpisodes(configFingerprint: string, limit = 50): HealthFindingEpisode[] {
    const rows = this.db
      .prepare(
        `SELECT episode_id, status, finding_json, opened_at, last_observed_at,
           resolved_at, occurrences
         FROM health_finding_episodes
         WHERE config_fingerprint = ?
         ORDER BY opened_at DESC, episode_id DESC
         LIMIT ?`,
      )
      .all(
        z.string().min(1).parse(configFingerprint),
        z.number().int().min(1).max(1_000).parse(limit),
      );
    this.skippedEpisodeRows = 0;
    const episodes: HealthFindingEpisode[] = [];
    for (const row of rows) {
      try {
        episodes.push(parseEpisode(row));
      } catch {
        this.skippedEpisodeRows += 1;
      }
    }
    return episodes;
  }

  listActiveFindingEpisodes(configFingerprint: string): HealthFindingEpisode[] {
    const rows = this.db
      .prepare(
        `SELECT episode_id, status, finding_json, opened_at, last_observed_at,
           resolved_at, occurrences
         FROM health_finding_episodes
         WHERE config_fingerprint = ? AND status = 'active'
         ORDER BY opened_at DESC, episode_id DESC`,
      )
      .all(z.string().min(1).parse(configFingerprint));
    const episodes: HealthFindingEpisode[] = [];
    for (const row of rows) {
      try {
        episodes.push(parseEpisode(row));
      } catch {
        this.skippedEpisodeRows += 1;
      }
    }
    return episodes;
  }

  dataQualitySummary(): {
    skippedObservationRows: number;
    skippedRollupRows: number;
    skippedEpisodeRows: number;
  } {
    return {
      skippedObservationRows: this.skippedObservationRows,
      skippedRollupRows: this.skippedRollupRows,
      skippedEpisodeRows: this.skippedEpisodeRows,
    };
  }

  prune(observedAt: string): { observations: number; rollups: number; episodes: number } {
    const at = Date.parse(z.iso.datetime().parse(observedAt));
    const rawCutoff = new Date(at - HEALTH_RAW_RETENTION_HOURS * 60 * 60 * 1_000).toISOString();
    const rollupCutoff = new Date(
      at - HEALTH_ROLLUP_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const episodeCutoff = new Date(
      at - HEALTH_RESOLVED_EPISODE_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const observations = this.db
      .prepare("DELETE FROM health_observations WHERE observed_at < ?")
      .run(rawCutoff);
    const rollups = this.db
      .prepare("DELETE FROM health_rollups WHERE window_started_at < ?")
      .run(rollupCutoff);
    const episodes = this.db
      .prepare("DELETE FROM health_finding_episodes WHERE status = 'resolved' AND resolved_at < ?")
      .run(episodeCutoff);
    return {
      observations: Number(observations.changes),
      rollups: Number(rollups.changes),
      episodes: Number(episodes.changes),
    };
  }
}
