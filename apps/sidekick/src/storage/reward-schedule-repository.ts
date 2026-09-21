import type { DatabaseSync } from "node:sqlite";
import {
  rewardRunPrepareRequestSchema,
  rewardScheduleStatusSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { z } from "zod";

const stateSchema = rewardScheduleStatusSchema.extend({
  identity: z.string().nullable(),
  request: rewardRunPrepareRequestSchema.nullable(),
  beforeCycle: z.number().int().nonnegative().nullable(),
  stopped: z.boolean(),
});
export type RewardScheduleState = z.infer<typeof stateSchema>;

export class RewardScheduleRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(): RewardScheduleState {
    const row = this.db
      .prepare("SELECT state_json FROM reward_schedule WHERE singleton_id = 1")
      .get() as { state_json: string } | undefined;
    return row
      ? stateSchema.parse(JSON.parse(row.state_json))
      : {
          enabled: false,
          intervalMinutes: 15,
          revision: 0,
          identity: null,
          request: null,
          state: "off",
          detail: "Automatic reward runs are off.",
          nextCheckAt: null,
          lastCheckAt: null,
          runId: null,
          preparationId: null,
          beforeCycle: null,
          stopped: false,
        };
  }

  update(patch: Partial<RewardScheduleState>): RewardScheduleState {
    const state = stateSchema.parse({ ...this.get(), ...patch });
    this.db
      .prepare(`INSERT INTO reward_schedule (singleton_id, state_json) VALUES (1, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET state_json = excluded.state_json`)
      .run(JSON.stringify(state));
    return state;
  }

  track(requestId: string, now: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO reward_schedule_requests (request_id, created_at) VALUES (?, ?)",
      )
      .run(requestId, now);
  }

  isScheduled(runId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM reward_schedule_requests WHERE request_id = ?").get(runId) !==
      undefined
    );
  }

  /** An expired manual run can release its lease while an attempt is still unresolved. */
  unresolvedExpiredRun(walletPrincipal: string): string | null {
    const row = this.db
      .prepare(`SELECT run_id FROM transaction_runs r
      WHERE wallet_principal = ? AND status = 'expired' AND EXISTS (
        SELECT 1 FROM transaction_run_children c WHERE c.run_id = r.run_id
          AND c.status IN ('materialized', 'broadcast', 'halted')
      ) LIMIT 1`)
      .get(walletPrincipal) as { run_id: string } | undefined;
    return row?.run_id ?? null;
  }
}
