import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { validatePrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import type { SidekickNetwork } from "../config.js";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "chain_evidence_foundation",
    sql: `
      CREATE TABLE chain_sources (
        source_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('api', 'node')),
        network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet', 'regtest')),
        base_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE chain_cursors (
        source_id TEXT NOT NULL REFERENCES chain_sources(source_id),
        stream TEXT NOT NULL,
        cursor TEXT,
        last_block_height INTEGER,
        last_index_block_hash TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, stream),
        CHECK (last_block_height IS NULL OR last_block_height >= 0)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE chain_events (
        chain_id INTEGER NOT NULL,
        tx_id TEXT NOT NULL,
        event_index INTEGER NOT NULL CHECK (event_index >= 0),
        block_height INTEGER NOT NULL CHECK (block_height >= 0),
        block_hash TEXT NOT NULL,
        index_block_hash TEXT NOT NULL,
        microblock_hash TEXT,
        microblock_sequence INTEGER CHECK (microblock_sequence IS NULL OR microblock_sequence >= 0),
        canonical INTEGER NOT NULL CHECK (canonical IN (0, 1)),
        microblock_canonical INTEGER NOT NULL CHECK (microblock_canonical IN (0, 1)),
        contract_id TEXT,
        topic TEXT,
        raw_payload_json TEXT NOT NULL CHECK (json_valid(raw_payload_json)),
        decoded_schema_version INTEGER CHECK (
          decoded_schema_version IS NULL OR decoded_schema_version > 0
        ),
        decoded_payload_json TEXT CHECK (
          decoded_payload_json IS NULL OR json_valid(decoded_payload_json)
        ),
        source_id TEXT NOT NULL REFERENCES chain_sources(source_id),
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chain_id, tx_id, event_index)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX chain_events_canonical_height
        ON chain_events (chain_id, canonical, block_height, event_index);
      CREATE INDEX chain_events_contract_topic
        ON chain_events (contract_id, topic, block_height);
      CREATE INDEX chain_events_index_block
        ON chain_events (chain_id, index_block_hash);
    `,
  },
  {
    version: 2,
    name: "signer_staker_projections",
    sql: `
      CREATE TABLE ingestion_runs (
        run_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES chain_sources(source_id),
        stream TEXT NOT NULL,
        manager_principal TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
        cursor_next TEXT,
        pages_processed INTEGER NOT NULL DEFAULT 0 CHECK (pages_processed >= 0),
        items_processed INTEGER NOT NULL DEFAULT 0 CHECK (items_processed >= 0),
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;

      CREATE UNIQUE INDEX ingestion_runs_one_active_scan
        ON ingestion_runs (source_id, stream, manager_principal)
        WHERE status = 'running';

      CREATE TABLE stakers (
        manager_principal TEXT NOT NULL,
        staker_principal TEXT NOT NULL,
        has_stx INTEGER NOT NULL CHECK (has_stx IN (0, 1)),
        has_btc INTEGER NOT NULL CHECK (has_btc IN (0, 1)),
        stx_node_verified INTEGER CHECK (stx_node_verified IN (0, 1)),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        source_id TEXT NOT NULL REFERENCES chain_sources(source_id),
        verification_source_id TEXT REFERENCES chain_sources(source_id),
        last_seen_run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (manager_principal, staker_principal)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX stakers_active_by_manager
        ON stakers (manager_principal, active, staker_principal);

      CREATE TABLE stake_positions (
        manager_principal TEXT NOT NULL,
        staker_principal TEXT NOT NULL,
        signer_principal TEXT NOT NULL,
        amount_ustx TEXT NOT NULL,
        first_reward_cycle TEXT NOT NULL,
        num_cycles TEXT NOT NULL,
        unlock_cycle TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        discovery_source_id TEXT NOT NULL REFERENCES chain_sources(source_id),
        verification_source_id TEXT NOT NULL REFERENCES chain_sources(source_id),
        last_seen_run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
        observed_burn_block_height INTEGER NOT NULL CHECK (observed_burn_block_height >= 0),
        observed_stacks_tip_height INTEGER NOT NULL CHECK (observed_stacks_tip_height >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (manager_principal, staker_principal),
        FOREIGN KEY (manager_principal, staker_principal)
          REFERENCES stakers(manager_principal, staker_principal)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE cycle_memberships (
        manager_principal TEXT NOT NULL,
        staker_principal TEXT NOT NULL,
        reward_cycle TEXT NOT NULL,
        signer_principal TEXT NOT NULL,
        amount_ustx TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        discovery_source_id TEXT NOT NULL REFERENCES chain_sources(source_id),
        verification_source_id TEXT NOT NULL REFERENCES chain_sources(source_id),
        last_seen_run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
        observed_burn_block_height INTEGER NOT NULL CHECK (observed_burn_block_height >= 0),
        observed_stacks_tip_height INTEGER NOT NULL CHECK (observed_stacks_tip_height >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (manager_principal, staker_principal, reward_cycle),
        FOREIGN KEY (manager_principal, staker_principal)
          REFERENCES stakers(manager_principal, staker_principal)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX cycle_memberships_active_by_cycle
        ON cycle_memberships (manager_principal, reward_cycle, active, staker_principal);
    `,
  },
  {
    version: 3,
    name: "deferred_stx_unlock_height",
    sql: `
      ALTER TABLE stake_positions ADD COLUMN unlock_burn_height TEXT;
    `,
  },
  {
    version: 4,
    name: "normalized_manager_activity",
    sql: `
      CREATE TABLE manager_activity_events (
        chain_id INTEGER NOT NULL,
        tx_id TEXT NOT NULL,
        event_index INTEGER NOT NULL CHECK (event_index >= 0),
        manager_principal TEXT NOT NULL,
        block_height INTEGER NOT NULL CHECK (block_height >= 0),
        canonical INTEGER NOT NULL CHECK (canonical IN (0, 1)),
        kind TEXT NOT NULL CHECK (kind IN (
          'claim-staker-rewards',
          'reclaim-failed-withdrawal',
          'settle-accepted-withdrawal'
        )),
        staker_principal TEXT NOT NULL,
        reward_cycle TEXT,
        bond_index TEXT,
        amount_sats TEXT NOT NULL,
        request_id TEXT,
        withdrawal_amount_sats TEXT,
        max_fee_sats TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chain_id, tx_id, event_index),
        FOREIGN KEY (chain_id, tx_id, event_index)
          REFERENCES chain_events(chain_id, tx_id, event_index)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX manager_activity_by_kind_height
        ON manager_activity_events (
          chain_id, manager_principal, canonical, kind, block_height DESC, event_index DESC
        );
      CREATE INDEX manager_activity_by_request
        ON manager_activity_events (
          chain_id, manager_principal, request_id, canonical, block_height
        );

      INSERT INTO manager_activity_events (
        chain_id, tx_id, event_index, manager_principal, block_height, canonical, kind,
        staker_principal, reward_cycle, bond_index, amount_sats, request_id,
        withdrawal_amount_sats, max_fee_sats, updated_at
      )
      SELECT
        chain_id,
        tx_id,
        event_index,
        contract_id,
        block_height,
        canonical,
        json_extract(decoded_payload_json, '$.event.kind'),
        json_extract(decoded_payload_json, '$.event.stakerPrincipal'),
        json_extract(decoded_payload_json, '$.event.rewardCycle'),
        json_extract(decoded_payload_json, '$.event.bondIndex'),
        COALESCE(
          json_extract(decoded_payload_json, '$.event.amountSats'),
          json_extract(decoded_payload_json, '$.event.liabilityReleasedSats')
        ),
        COALESCE(
          json_extract(decoded_payload_json, '$.event.l1Withdrawal.requestId'),
          json_extract(decoded_payload_json, '$.event.requestId')
        ),
        json_extract(decoded_payload_json, '$.event.l1Withdrawal.amountSats'),
        json_extract(decoded_payload_json, '$.event.l1Withdrawal.maxFeeSats'),
        updated_at
      FROM chain_events
      WHERE contract_id IS NOT NULL
        AND decoded_payload_json IS NOT NULL
        AND json_extract(decoded_payload_json, '$.transactionStatus') = 'success'
        AND json_extract(decoded_payload_json, '$.event.kind') IN (
          'claim-staker-rewards',
          'reclaim-failed-withdrawal',
          'settle-accepted-withdrawal'
        );
    `,
  },
  {
    version: 5,
    name: "longitudinal_pool_evidence",
    sql: `
      CREATE TABLE staker_position_observations (
        manager_principal TEXT NOT NULL,
        staker_principal TEXT NOT NULL,
        observed_burn_block_height INTEGER NOT NULL CHECK (observed_burn_block_height >= 0),
        observed_stacks_tip_height INTEGER NOT NULL CHECK (observed_stacks_tip_height >= 0),
        has_stx INTEGER NOT NULL CHECK (has_stx IN (0, 1)),
        has_btc INTEGER NOT NULL CHECK (has_btc IN (0, 1)),
        stx_node_verified INTEGER CHECK (stx_node_verified IN (0, 1)),
        position_present INTEGER NOT NULL CHECK (position_present IN (0, 1)),
        signer_principal TEXT,
        amount_ustx TEXT,
        first_reward_cycle TEXT,
        num_cycles TEXT,
        unlock_cycle TEXT,
        unlock_burn_height TEXT,
        source_id TEXT NOT NULL REFERENCES chain_sources(source_id),
        verification_source_id TEXT REFERENCES chain_sources(source_id),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (
          manager_principal,
          staker_principal,
          observed_burn_block_height,
          observed_stacks_tip_height
        ),
        CHECK (
          (position_present = 0 AND signer_principal IS NULL AND amount_ustx IS NULL
            AND first_reward_cycle IS NULL AND num_cycles IS NULL AND unlock_cycle IS NULL)
          OR
          (position_present = 1 AND signer_principal IS NOT NULL AND amount_ustx IS NOT NULL
            AND first_reward_cycle IS NOT NULL AND num_cycles IS NOT NULL
            AND unlock_cycle IS NOT NULL)
        )
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX staker_position_observations_history
        ON staker_position_observations (
          manager_principal, staker_principal,
          observed_burn_block_height DESC, observed_stacks_tip_height DESC
        );

      CREATE TABLE pool_cycle_snapshots (
        manager_principal TEXT NOT NULL,
        reward_cycle INTEGER NOT NULL CHECK (reward_cycle >= 0),
        observed_burn_block_height INTEGER NOT NULL CHECK (observed_burn_block_height >= 0),
        observed_stacks_tip_height INTEGER NOT NULL CHECK (observed_stacks_tip_height >= 0),
        status TEXT NOT NULL CHECK (status IN ('ready', 'attention')),
        roster_available INTEGER NOT NULL CHECK (roster_available IN (0, 1)),
        staker_count INTEGER CHECK (staker_count IS NULL OR staker_count >= 0),
        enumerated_stx_ustx TEXT,
        enumeration_delta_ustx TEXT,
        pending_stx_ustx TEXT NOT NULL,
        eligible_stx_shares_ustx TEXT NOT NULL,
        total_delegated_ustx TEXT NOT NULL,
        non_stx_delegated_ustx TEXT,
        in_signer_set INTEGER NOT NULL CHECK (in_signer_set IN (0, 1)),
        threshold_ustx TEXT NOT NULL,
        threshold_margin_ustx TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (
          manager_principal,
          reward_cycle,
          observed_burn_block_height,
          observed_stacks_tip_height
        )
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX pool_cycle_snapshots_history
        ON pool_cycle_snapshots (
          manager_principal, reward_cycle DESC,
          observed_burn_block_height DESC, observed_stacks_tip_height DESC
        );
    `,
  },
  {
    version: 6,
    name: "reward_cycle_ledger",
    sql: `
      CREATE TABLE reward_cycle_snapshots (
        manager_principal TEXT NOT NULL,
        reward_cycle INTEGER NOT NULL CHECK (reward_cycle >= 0),
        status TEXT NOT NULL CHECK (status IN ('ready', 'attention')),
        observed_burn_block_height INTEGER NOT NULL CHECK (observed_burn_block_height >= 0),
        observed_stacks_tip_height INTEGER NOT NULL CHECK (observed_stacks_tip_height >= 0),
        last_reward_compute_burn_height TEXT NOT NULL,
        last_computed_reward_cycle TEXT,
        rewards_per_token TEXT NOT NULL,
        signer_earned_before_manager_claim_sats TEXT NOT NULL,
        fee_snapshot_bips TEXT NOT NULL,
        earned_fees_sats TEXT NOT NULL,
        withdrawal_liability_sats TEXT NOT NULL,
        unclaimed_staker_rewards_sats TEXT NOT NULL,
        staker_count INTEGER NOT NULL CHECK (staker_count >= 0),
        gross_sats TEXT NOT NULL,
        earned_sats TEXT NOT NULL,
        fee_sats TEXT NOT NULL,
        actionable_claims INTEGER NOT NULL CHECK (actionable_claims >= 0),
        l1_claims_waiting_for_fee_threshold INTEGER NOT NULL
          CHECK (l1_claims_waiting_for_fee_threshold >= 0),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (manager_principal, reward_cycle)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE staker_reward_cycle_snapshots (
        manager_principal TEXT NOT NULL,
        reward_cycle INTEGER NOT NULL CHECK (reward_cycle >= 0),
        staker_principal TEXT NOT NULL,
        payout_kind TEXT NOT NULL CHECK (payout_kind IN ('direct-sbtc', 'bitcoin-l1')),
        pox_address_version_hex TEXT,
        pox_address_hashbytes_hex TEXT,
        max_fee_sats TEXT,
        earned_sats TEXT NOT NULL,
        fee_sats TEXT NOT NULL,
        gross_sats TEXT NOT NULL,
        claimable_by_policy INTEGER NOT NULL CHECK (claimable_by_policy IN (0, 1)),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (manager_principal, reward_cycle, staker_principal),
        FOREIGN KEY (manager_principal, reward_cycle)
          REFERENCES reward_cycle_snapshots(manager_principal, reward_cycle)
          ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX reward_cycle_snapshots_history
        ON reward_cycle_snapshots (manager_principal, reward_cycle DESC);
      CREATE INDEX staker_reward_cycle_snapshots_page
        ON staker_reward_cycle_snapshots (
          manager_principal, reward_cycle, staker_principal
        );
    `,
  },
  {
    version: 7,
    name: "phase2_value_provenance",
    sql: `
      ALTER TABLE pool_cycle_snapshots
        ADD COLUMN value_classification TEXT NOT NULL DEFAULT 'projected'
        CHECK (value_classification IN ('authoritative', 'projected'));
      ALTER TABLE pool_cycle_snapshots
        ADD COLUMN contract_source TEXT NOT NULL DEFAULT 'pox5-read-only';
      ALTER TABLE pool_cycle_snapshots
        ADD COLUMN local_roster_source TEXT NOT NULL DEFAULT 'unavailable'
        CHECK (local_roster_source IN ('api-indexed-node-verified', 'unavailable'));

      ALTER TABLE reward_cycle_snapshots
        ADD COLUMN fee_snapshot_present INTEGER NOT NULL DEFAULT 0
        CHECK (fee_snapshot_present IN (0, 1));
      ALTER TABLE reward_cycle_snapshots ADD COLUMN configured_fee_bips TEXT;

      CREATE INDEX manager_activity_stable_order
        ON manager_activity_events (
          chain_id, manager_principal, canonical, kind,
          block_height DESC, tx_id DESC, event_index DESC
        );
    `,
  },
  {
    version: 8,
    name: "phase3_onboarding_and_settings",
    sql: `
      CREATE TABLE runtime_settings (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
        api_key_secret TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE settings_audit (
        audit_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        changed_fields_json TEXT NOT NULL CHECK (json_valid(changed_fields_json)),
        changed_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX settings_audit_recent
        ON settings_audit (changed_at DESC, audit_id DESC);

      CREATE TABLE onboarding_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        path TEXT NOT NULL CHECK (path IN ('attach', 'fresh')),
        current_step TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('in-progress', 'blocked', 'complete')),
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 9,
    name: "onboarding_audit",
    sql: `
      CREATE TABLE onboarding_audit (
        event_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        path TEXT NOT NULL CHECK (path IN ('attach', 'fresh')),
        current_step TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('in-progress', 'blocked', 'complete')),
        changed_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX onboarding_audit_recent
        ON onboarding_audit (changed_at DESC, event_id DESC);
    `,
  },
  {
    version: 10,
    name: "onboarding_wizard_preference",
    sql: `
      CREATE TABLE onboarding_wizard_preference (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        dismissed_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE onboarding_wizard_audit (
        event_id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('dismissed', 'resumed')),
        changed_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX onboarding_wizard_audit_recent
        ON onboarding_wizard_audit (changed_at DESC, event_id DESC);
    `,
  },
];

const sourceInputSchema = z
  .object({
    sourceId: z.string().min(1),
    kind: z.enum(["api", "node"]),
    network: z.enum(["mainnet", "testnet", "devnet", "regtest"]),
    baseUrl: z.url(),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const url = new URL(value.baseUrl);
    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({
        code: "custom",
        message: "Chain source URL must not contain credentials, query parameters, or a fragment",
        path: ["baseUrl"],
      });
    }
  });

const cursorInputSchema = z
  .object({
    sourceId: z.string().min(1),
    stream: z.string().min(1),
    cursor: z.string().nullable(),
    lastBlockHeight: z.number().int().nonnegative().nullable(),
    lastIndexBlockHash: z.string().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const hashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const eventInputSchema = z
  .object({
    chainId: z.number().int().nonnegative(),
    txId: hashSchema,
    eventIndex: z.number().int().nonnegative(),
    blockHeight: z.number().int().nonnegative(),
    blockHash: hashSchema,
    indexBlockHash: hashSchema,
    microblockHash: hashSchema.nullable(),
    microblockSequence: z.number().int().nonnegative().nullable(),
    canonical: z.boolean(),
    microblockCanonical: z.boolean(),
    contractId: z.string().nullable(),
    topic: z.string().nullable(),
    rawPayload: z.unknown(),
    decodedSchemaVersion: z.number().int().positive().nullable(),
    decodedPayload: z.unknown().nullable(),
    sourceId: z.string().min(1),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (value) => (value.decodedSchemaVersion === null) === (value.decodedPayload === null),
    "decodedSchemaVersion and decodedPayload must either both be present or both be null",
  );

const cursorRowSchema = z.object({
  source_id: z.string(),
  stream: z.string(),
  cursor: z.string().nullable(),
  last_block_height: z.number().int().nonnegative().nullable(),
  last_index_block_hash: z.string().nullable(),
  updated_at: z.string(),
});

const eventRowSchema = z.object({
  chain_id: z.number().int().nonnegative(),
  tx_id: z.string(),
  event_index: z.number().int().nonnegative(),
  block_height: z.number().int().nonnegative(),
  block_hash: z.string(),
  index_block_hash: z.string(),
  microblock_hash: z.string().nullable(),
  microblock_sequence: z.number().int().nonnegative().nullable(),
  canonical: z.union([z.literal(0), z.literal(1)]),
  microblock_canonical: z.union([z.literal(0), z.literal(1)]),
  contract_id: z.string().nullable(),
  topic: z.string().nullable(),
  raw_payload_json: z.string(),
  decoded_schema_version: z.number().int().positive().nullable(),
  decoded_payload_json: z.string().nullable(),
  source_id: z.string(),
  first_seen_at: z.string(),
  updated_at: z.string(),
});

const unsignedIntegerTextSchema = z.string().regex(/^\d+$/);
const managerActivityEnvelopeSchema = z.object({
  transactionStatus: z.literal("success"),
  event: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("claim-staker-rewards"),
      stakerPrincipal: z.string(),
      rewardCycle: unsignedIntegerTextSchema,
      bondIndex: unsignedIntegerTextSchema.nullable(),
      amountSats: unsignedIntegerTextSchema,
      l1Withdrawal: z
        .object({
          requestId: unsignedIntegerTextSchema,
          amountSats: unsignedIntegerTextSchema,
          maxFeeSats: unsignedIntegerTextSchema,
        })
        .nullable(),
    }),
    z.object({
      kind: z.literal("reclaim-failed-withdrawal"),
      requestId: unsignedIntegerTextSchema,
      stakerPrincipal: z.string(),
      amountSats: unsignedIntegerTextSchema,
    }),
    z.object({
      kind: z.literal("settle-accepted-withdrawal"),
      requestId: unsignedIntegerTextSchema,
      stakerPrincipal: z.string(),
      liabilityReleasedSats: unsignedIntegerTextSchema,
    }),
  ]),
});

const managerClaimRowSchema = z.object({
  tx_id: z.string(),
  event_index: z.number().int().nonnegative(),
  block_height: z.number().int().nonnegative(),
  staker_principal: z.string(),
  reward_cycle: z.string(),
  bond_index: z.string().nullable(),
  amount_sats: z.string(),
  request_id: z.string().nullable(),
});

const managerWithdrawalRowSchema = z.object({
  request_id: z.string(),
  staker_principal: z.string(),
  amount_sats: z.string(),
  max_fee_sats: z.string(),
  initiated_tx_id: z.string(),
  initiated_block_height: z.number().int().nonnegative(),
  resolution_kind: z.enum(["reclaim-failed-withdrawal", "settle-accepted-withdrawal"]).nullable(),
  resolved_tx_id: z.string().nullable(),
  resolved_block_height: z.number().int().nonnegative().nullable(),
});

const principalSchema = z.string().refine(validatePrincipal, "Invalid Stacks principal");
const signerCycleMembershipInputSchema = z
  .object({
    rewardCycle: z.bigint().nonnegative(),
    signerPrincipal: principalSchema,
    amountUstx: z.bigint().nonnegative(),
  })
  .strict();
const signerStakerPositionInputSchema = z
  .object({
    signerPrincipal: principalSchema,
    amountUstx: z.bigint().nonnegative(),
    firstRewardCycle: z.bigint().nonnegative(),
    numCycles: z.bigint().min(1n).max(96n),
    unlockBurnHeight: z.bigint().nonnegative().optional(),
    cycleMemberships: z.array(signerCycleMembershipInputSchema).max(96),
  })
  .strict();
const signerStakerPageItemSchema = z
  .object({
    stakerPrincipal: principalSchema,
    hasStx: z.boolean(),
    hasBtc: z.boolean(),
    stxNodeVerified: z.boolean().nullable(),
    position: signerStakerPositionInputSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.hasStx && !value.hasBtc) {
      context.addIssue({
        code: "custom",
        message: "A discovery must include at least one staking type",
        path: ["hasStx"],
      });
    }
    if (value.hasStx && value.stxNodeVerified === null) {
      context.addIssue({
        code: "custom",
        message: "STX discoveries require a node verification result",
        path: ["stxNodeVerified"],
      });
    }
    if (!value.hasStx && value.stxNodeVerified !== null) {
      context.addIssue({
        code: "custom",
        message: "BTC-only discoveries cannot have an STX node verification result",
        path: ["stxNodeVerified"],
      });
    }
    if ((value.position !== null) !== (value.stxNodeVerified === true)) {
      context.addIssue({
        code: "custom",
        message: "A trusted position requires successful STX node verification",
        path: ["position"],
      });
    }
  });
const signerStakerPageInputSchema = z
  .object({
    runId: z.string().uuid(),
    sourceId: z.string().min(1),
    nodeSourceId: z.string().min(1),
    managerPrincipal: principalSchema,
    nextCursor: principalSchema.nullable(),
    items: z.array(signerStakerPageItemSchema),
    observedAt: z.iso.datetime(),
    burnBlockHeight: z.number().int().nonnegative(),
    stacksTipHeight: z.number().int().nonnegative(),
  })
  .strict();

const ingestionRunRowSchema = z.object({
  run_id: z.string().uuid(),
  source_id: z.string(),
  stream: z.string(),
  manager_principal: z.string(),
  status: z.enum(["running", "completed"]),
  cursor_next: z.string().nullable(),
  pages_processed: z.number().int().nonnegative(),
  items_processed: z.number().int().nonnegative(),
  started_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});

const storedSignerStakerRowSchema = z.object({
  manager_principal: z.string(),
  staker_principal: z.string(),
  has_stx: z.union([z.literal(0), z.literal(1)]),
  has_btc: z.union([z.literal(0), z.literal(1)]),
  stx_node_verified: z.union([z.literal(0), z.literal(1)]).nullable(),
  active: z.union([z.literal(0), z.literal(1)]),
  source_id: z.string(),
  verification_source_id: z.string().nullable(),
  last_seen_run_id: z.string(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  signer_principal: z.string().nullable(),
  amount_ustx: z.string().nullable(),
  first_reward_cycle: z.string().nullable(),
  num_cycles: z.string().nullable(),
  unlock_cycle: z.string().nullable(),
  unlock_burn_height: z.string().nullable(),
  position_active: z.union([z.literal(0), z.literal(1)]).nullable(),
});

const cycleMembershipRowSchema = z.object({
  staker_principal: z.string(),
  reward_cycle: z.string(),
  signer_principal: z.string(),
  amount_ustx: z.string(),
  active: z.union([z.literal(0), z.literal(1)]),
});

const stakerPositionObservationRowSchema = z.object({
  manager_principal: z.string(),
  staker_principal: z.string(),
  observed_burn_block_height: z.number().int().nonnegative(),
  observed_stacks_tip_height: z.number().int().nonnegative(),
  has_stx: z.union([z.literal(0), z.literal(1)]),
  has_btc: z.union([z.literal(0), z.literal(1)]),
  stx_node_verified: z.union([z.literal(0), z.literal(1)]).nullable(),
  position_present: z.union([z.literal(0), z.literal(1)]),
  signer_principal: z.string().nullable(),
  amount_ustx: z.string().nullable(),
  first_reward_cycle: z.string().nullable(),
  num_cycles: z.string().nullable(),
  unlock_cycle: z.string().nullable(),
  unlock_burn_height: z.string().nullable(),
  observed_at: z.string(),
});

const poolCycleSnapshotInputSchema = z
  .object({
    managerPrincipal: principalSchema,
    observedAt: z.iso.datetime(),
    burnBlockHeight: z.number().int().nonnegative(),
    stacksTipHeight: z.number().int().nonnegative(),
    cycles: z.array(
      z
        .object({
          cycleId: z.number().int().nonnegative(),
          status: z.enum(["ready", "attention"]),
          rosterAvailable: z.boolean(),
          stakerCount: z.number().int().nonnegative().nullable(),
          enumeratedStxUstx: z.string().nullable(),
          enumerationDeltaUstx: z.string().nullable(),
          pendingStxUstx: unsignedIntegerTextSchema,
          eligibleStxSharesUstx: unsignedIntegerTextSchema,
          totalDelegatedUstx: unsignedIntegerTextSchema,
          nonStxDelegatedUstx: unsignedIntegerTextSchema.nullable(),
          inSignerSet: z.boolean(),
          thresholdUstx: unsignedIntegerTextSchema,
          thresholdMarginUstx: z.string().regex(/^-?\d+$/),
          provenance: z
            .object({
              classification: z.enum(["authoritative", "projected"]),
              contractSource: z.literal("pox5-read-only"),
              localRosterSource: z.enum(["api-indexed-node-verified", "unavailable"]),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

const poolCycleSnapshotRowSchema = z.object({
  manager_principal: z.string(),
  reward_cycle: z.number().int().nonnegative(),
  observed_burn_block_height: z.number().int().nonnegative(),
  observed_stacks_tip_height: z.number().int().nonnegative(),
  status: z.enum(["ready", "attention"]),
  roster_available: z.union([z.literal(0), z.literal(1)]),
  staker_count: z.number().int().nonnegative().nullable(),
  enumerated_stx_ustx: z.string().nullable(),
  enumeration_delta_ustx: z.string().nullable(),
  pending_stx_ustx: z.string(),
  eligible_stx_shares_ustx: z.string(),
  total_delegated_ustx: z.string(),
  non_stx_delegated_ustx: z.string().nullable(),
  in_signer_set: z.union([z.literal(0), z.literal(1)]),
  threshold_ustx: z.string(),
  threshold_margin_ustx: z.string(),
  value_classification: z.enum(["authoritative", "projected"]),
  contract_source: z.literal("pox5-read-only"),
  local_roster_source: z.enum(["api-indexed-node-verified", "unavailable"]),
  observed_at: z.string(),
});

const rewardCycleSnapshotInputSchema = z
  .object({
    managerPrincipal: principalSchema,
    rewardCycle: z.number().int().nonnegative(),
    status: z.enum(["ready", "attention"]),
    observedAt: z.iso.datetime(),
    burnBlockHeight: z.number().int().nonnegative(),
    stacksTipHeight: z.number().int().nonnegative(),
    global: z
      .object({
        lastRewardComputeBurnHeight: unsignedIntegerTextSchema,
        lastComputedRewardCycle: unsignedIntegerTextSchema.nullable(),
        rewardsPerToken: unsignedIntegerTextSchema,
        signerEarnedBeforeManagerClaimSats: unsignedIntegerTextSchema,
      })
      .strict(),
    manager: z
      .object({
        configuredFeeBips: unsignedIntegerTextSchema,
        feeSnapshotBips: unsignedIntegerTextSchema.nullable(),
        earnedFeesSats: unsignedIntegerTextSchema,
        withdrawalLiabilitySats: unsignedIntegerTextSchema,
        unclaimedStakerRewardsSats: unsignedIntegerTextSchema,
      })
      .strict(),
    totals: z
      .object({
        stakers: z.number().int().nonnegative(),
        grossSats: unsignedIntegerTextSchema,
        earnedSats: unsignedIntegerTextSchema,
        feeSats: unsignedIntegerTextSchema,
        actionableClaims: z.number().int().nonnegative(),
        l1ClaimsWaitingForFeeThreshold: z.number().int().nonnegative(),
      })
      .strict(),
    stakers: z.array(
      z
        .object({
          stakerPrincipal: principalSchema,
          payout: z.discriminatedUnion("kind", [
            z.object({
              kind: z.literal("direct-sbtc"),
              poxAddress: z.null(),
              maxFeeSats: z.null(),
            }),
            z.object({
              kind: z.literal("bitcoin-l1"),
              poxAddress: z.object({ versionHex: z.string(), hashbytesHex: z.string() }),
              maxFeeSats: unsignedIntegerTextSchema,
            }),
          ]),
          rewards: z
            .object({
              earnedSats: unsignedIntegerTextSchema,
              feeSats: unsignedIntegerTextSchema,
              grossSats: unsignedIntegerTextSchema,
            })
            .strict(),
          claimableByPolicy: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

const rewardCycleSummaryRowSchema = z.object({
  manager_principal: z.string(),
  reward_cycle: z.number().int().nonnegative(),
  status: z.enum(["ready", "attention"]),
  observed_burn_block_height: z.number().int().nonnegative(),
  observed_stacks_tip_height: z.number().int().nonnegative(),
  staker_count: z.number().int().nonnegative(),
  gross_sats: z.string(),
  earned_sats: z.string(),
  fee_sats: z.string(),
  fee_snapshot_bips: z.string(),
  fee_snapshot_present: z.union([z.literal(0), z.literal(1)]),
  configured_fee_bips: z.string().nullable(),
  actionable_claims: z.number().int().nonnegative(),
  l1_claims_waiting_for_fee_threshold: z.number().int().nonnegative(),
  observed_at: z.string(),
});

export type ChainSourceInput = z.infer<typeof sourceInputSchema>;
export type ChainCursorInput = z.infer<typeof cursorInputSchema>;
export type ChainEventInput = z.infer<typeof eventInputSchema>;

export interface ChainCursor {
  sourceId: string;
  stream: string;
  cursor: string | null;
  lastBlockHeight: number | null;
  lastIndexBlockHash: string | null;
  updatedAt: string;
}

export interface StoredChainEvent extends Omit<ChainEventInput, "observedAt"> {
  firstSeenAt: string;
  updatedAt: string;
}

export type SignerStakerPositionInput = z.infer<typeof signerStakerPositionInputSchema>;
export type SignerStakerPageItem = z.infer<typeof signerStakerPageItemSchema>;
export type SignerStakerPageInput = z.infer<typeof signerStakerPageInputSchema>;
export type PoolCycleSnapshotInput = z.infer<typeof poolCycleSnapshotInputSchema>;
export type RewardCycleSnapshotInput = z.infer<typeof rewardCycleSnapshotInputSchema>;

export interface SignerStakerRun {
  runId: string;
  sourceId: string;
  managerPrincipal: string;
  status: "running" | "completed";
  cursor: string | null;
  pagesProcessed: number;
  itemsProcessed: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface StoredSignerStaker {
  managerPrincipal: string;
  stakerPrincipal: string;
  hasStx: boolean;
  hasBtc: boolean;
  stxNodeVerified: boolean | null;
  active: boolean;
  sourceId: string;
  verificationSourceId: string | null;
  lastSeenRunId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  position: null | {
    signerPrincipal: string;
    amountUstx: bigint;
    firstRewardCycle: bigint;
    numCycles: bigint;
    unlockCycle: bigint;
    unlockBurnHeight: bigint | null;
    active: boolean;
  };
}

export interface StoredCycleMembership {
  stakerPrincipal: string;
  rewardCycle: bigint;
  signerPrincipal: string;
  amountUstx: bigint;
  active: boolean;
}

export interface StoredStakerPositionObservation {
  managerPrincipal: string;
  stakerPrincipal: string;
  observedBurnBlockHeight: number;
  observedStacksTipHeight: number;
  hasStx: boolean;
  hasBtc: boolean;
  stxNodeVerified: boolean | null;
  position: null | {
    signerPrincipal: string;
    amountUstx: string;
    firstRewardCycle: string;
    numCycles: string;
    unlockCycle: string;
    unlockBurnHeight: string | null;
  };
  observedAt: string;
}

export interface StoredPoolCycleSnapshot {
  managerPrincipal: string;
  cycleId: number;
  observedBurnBlockHeight: number;
  observedStacksTipHeight: number;
  status: "ready" | "attention";
  rosterAvailable: boolean;
  stakerCount: number | null;
  enumeratedStxUstx: string | null;
  enumerationDeltaUstx: string | null;
  pendingStxUstx: string;
  eligibleStxSharesUstx: string;
  totalDelegatedUstx: string;
  nonStxDelegatedUstx: string | null;
  inSignerSet: boolean;
  thresholdUstx: string;
  thresholdMarginUstx: string;
  provenance: {
    classification: "authoritative" | "projected";
    contractSource: "pox5-read-only";
    localRosterSource: "api-indexed-node-verified" | "unavailable";
  };
  observedAt: string;
}

export interface StoredRewardCycleSummary {
  managerPrincipal: string;
  rewardCycle: number;
  status: "ready" | "attention";
  observedBurnBlockHeight: number;
  observedStacksTipHeight: number;
  stakerCount: number;
  grossSats: string;
  earnedSats: string;
  feeSats: string;
  configuredFeeBips: string | null;
  feeSnapshotBips: string | null;
  actionableClaims: number;
  l1ClaimsWaitingForFeeThreshold: number;
  observedAt: string;
}

export interface StoredRuntimeSettings {
  settings: unknown;
  apiKeySecret: string | null;
  revision: number;
  updatedAt: string;
}

export interface StoredOnboardingState {
  path: "attach" | "fresh";
  currentStep: string;
  status: "in-progress" | "blocked" | "complete";
  state: unknown;
  updatedAt: string;
}

export interface StoredManagerClaim {
  txId: string;
  eventIndex: number;
  blockHeight: number;
  stakerPrincipal: string;
  rewardCycle: string;
  bondIndex: string | null;
  amountSats: string;
  destination: "direct-sbtc" | "bitcoin-l1";
  withdrawalRequestId: string | null;
}

export interface StoredManagerWithdrawal {
  requestId: string;
  stakerPrincipal: string;
  amountSats: string;
  maxFeeSats: string;
  initiatedTxId: string;
  initiatedBlockHeight: number;
  state: "pending" | "settled" | "reclaimed";
  resolvedTxId: string | null;
  resolvedBlockHeight: number | null;
}

export interface ManagerActivityPage<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

function toStoredChainEvent(row: unknown): StoredChainEvent {
  const value = eventRowSchema.parse(row);
  return {
    chainId: value.chain_id,
    txId: value.tx_id,
    eventIndex: value.event_index,
    blockHeight: value.block_height,
    blockHash: value.block_hash,
    indexBlockHash: value.index_block_hash,
    microblockHash: value.microblock_hash,
    microblockSequence: value.microblock_sequence,
    canonical: value.canonical === 1,
    microblockCanonical: value.microblock_canonical === 1,
    contractId: value.contract_id,
    topic: value.topic,
    rawPayload: JSON.parse(value.raw_payload_json) as unknown,
    decodedSchemaVersion: value.decoded_schema_version,
    decodedPayload: value.decoded_payload_json
      ? (JSON.parse(value.decoded_payload_json) as unknown)
      : null,
    sourceId: value.source_id,
    firstSeenAt: value.first_seen_at,
    updatedAt: value.updated_at,
  };
}

function migrationChecksum(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest("hex");
}

function serializeJson(value: unknown, field: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${field} must be JSON-serializable: ${String(error)}`);
  }
  if (serialized === undefined) throw new Error(`${field} must be JSON-serializable`);
  return serialized;
}

function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  return z.number().int().nonnegative().parse(row?.user_version);
}

function applyMigrations(db: DatabaseSync, now: string): void {
  const current = currentSchemaVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(`Database schema version ${current} is newer than supported version ${latest}`);
  }
  const migrationTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (current > 0 && !migrationTable) {
    throw new Error(`Database user_version is ${current}, but the migration ledger does not exist`);
  }
  if (!migrationTable) {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  const appliedRows = db
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number; name: string; checksum: string }>;
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row] as const));
  for (const migration of migrations) {
    if (migration.version <= current && !appliedByVersion.has(migration.version)) {
      throw new Error(
        `Database user_version is ${current}, but migration ${migration.version} is not recorded`,
      );
    }
  }
  for (const row of appliedRows) {
    if (row.version > current) {
      throw new Error(
        `Migration ${row.version} is recorded beyond database user_version ${current}`,
      );
    }
    const migration = migrations.find(({ version }) => version === row.version);
    if (
      !migration ||
      migration.name !== row.name ||
      migrationChecksum(migration) !== row.checksum
    ) {
      throw new Error(`Applied migration ${row.version} does not match this Sidekick build`);
    }
  }

  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, migrationChecksum(migration), now);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`Failed to apply migration ${migration.version} (${migration.name})`, {
        cause: error,
      });
    }
  }
}

export interface OpenSidekickStoreResult {
  store: SidekickStore;
  backupPath: string | null;
}

export interface DatabaseBackupResult {
  sourcePath: string;
  destinationPath: string;
  sizeBytes: number;
  quickCheck: "ok";
}

export async function backupSidekickDatabase(
  sourcePath: string,
  destinationPath: string,
): Promise<DatabaseBackupResult> {
  if (sourcePath === ":memory:") throw new Error("An in-memory database cannot be backed up");
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (source === destination) throw new Error("Backup destination must differ from the database");
  const sourceStat = await stat(source).catch(() => null);
  if (!sourceStat?.isFile() || sourceStat.size === 0) {
    throw new Error(`Sidekick database does not exist or is empty: ${source}`);
  }
  const destinationExists = await access(destination)
    .then(() => true)
    .catch(() => false);
  if (destinationExists) throw new Error(`Backup destination already exists: ${destination}`);

  await mkdir(dirname(destination), { recursive: true });
  const db = new DatabaseSync(source, { allowExtension: false, readOnly: true, timeout: 5_000 });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    await backup(db, destination);
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  } finally {
    db.close();
  }

  const verification = new DatabaseSync(destination, {
    allowExtension: false,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    const quickCheck = verification.prepare("PRAGMA quick_check").get() as
      | { quick_check?: unknown }
      | undefined;
    if (quickCheck?.quick_check !== "ok") {
      throw new Error(`Backup integrity check failed: ${String(quickCheck?.quick_check)}`);
    }
    return {
      sourcePath: source,
      destinationPath: destination,
      sizeBytes: (await stat(destination)).size,
      quickCheck: "ok",
    };
  } finally {
    verification.close();
  }
}

export async function openSidekickStore(
  path: string,
  now = new Date().toISOString(),
): Promise<OpenSidekickStoreResult> {
  const isMemory = path === ":memory:";
  const databasePath = isMemory ? path : resolve(path);
  let existingSize = 0;
  if (!isMemory) {
    await mkdir(dirname(databasePath), { recursive: true });
    existingSize = await stat(databasePath)
      .then((value) => value.size)
      .catch(() => 0);
  }
  const db = new DatabaseSync(databasePath, { allowExtension: false, timeout: 5_000 });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA synchronous = NORMAL");
    if (!isMemory) db.exec("PRAGMA journal_mode = WAL");

    const before = currentSchemaVersion(db);
    const latest = migrations.at(-1)?.version ?? 0;
    let backupPath: string | null = null;
    if (!isMemory && existingSize > 0 && before < latest) {
      const timestamp = now.replaceAll(":", "-");
      backupPath = `${databasePath}.v${before}.backup-${timestamp}`;
      await backup(db, backupPath);
    }
    applyMigrations(db, now);
    return { store: new SidekickStore(db), backupPath };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function createChainSourceId(network: SidekickNetwork, baseUrl: string): string {
  const normalized = new URL(baseUrl).toString().replace(/\/$/, "");
  const digest = createHash("sha256").update(`${network}\n${normalized}`).digest("hex");
  return `api:${network}:${digest}`;
}

export function createNodeSourceId(network: SidekickNetwork, baseUrl: string): string {
  const normalized = new URL(baseUrl).toString().replace(/\/$/, "");
  const digest = createHash("sha256").update(`${network}\n${normalized}`).digest("hex");
  return `node:${network}:${digest}`;
}

const signerStakersStream = "signer-stakers";

function toSignerStakerRun(row: unknown): SignerStakerRun {
  const value = ingestionRunRowSchema.parse(row);
  return {
    runId: value.run_id,
    sourceId: value.source_id,
    managerPrincipal: value.manager_principal,
    status: value.status,
    cursor: value.cursor_next,
    pagesProcessed: value.pages_processed,
    itemsProcessed: value.items_processed,
    startedAt: value.started_at,
    updatedAt: value.updated_at,
    completedAt: value.completed_at,
  };
}

export class SidekickStore {
  constructor(private readonly db: DatabaseSync) {}

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return currentSchemaVersion(this.db);
  }

  databaseStatus(): { schemaVersion: number; journalMode: string; foreignKeys: boolean } {
    const journal = this.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: unknown }
      | undefined;
    const foreignKeys = this.db.prepare("PRAGMA foreign_keys").get() as
      | { foreign_keys?: unknown }
      | undefined;
    return {
      schemaVersion: this.schemaVersion(),
      journalMode: z.string().parse(journal?.journal_mode),
      foreignKeys: z.union([z.literal(0), z.literal(1)]).parse(foreignKeys?.foreign_keys) === 1,
    };
  }

  getRuntimeSettings(): StoredRuntimeSettings | null {
    const row = this.db
      .prepare(
        `SELECT settings_json, api_key_secret, revision, updated_at
         FROM runtime_settings WHERE singleton_id = 1`,
      )
      .get() as
      | {
          settings_json: string;
          api_key_secret: string | null;
          revision: number;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      settings: JSON.parse(row.settings_json) as unknown,
      apiKeySecret: row.api_key_secret,
      revision: z.number().int().positive().parse(row.revision),
      updatedAt: z.iso.datetime().parse(row.updated_at),
    };
  }

  putRuntimeSettings(input: {
    settings: unknown;
    apiKeySecret: string | null;
    changedFields: string[];
    observedAt: string;
  }): StoredRuntimeSettings {
    const observedAt = z.iso.datetime().parse(input.observedAt);
    const changedFields = z.array(z.string().min(1)).min(1).parse(input.changedFields);
    const settingsJson = serializeJson(input.settings, "runtime settings");
    const changedFieldsJson = serializeJson([...new Set(changedFields)].sort(), "changed fields");
    const existing = this.getRuntimeSettings();
    const revision = (existing?.revision ?? 0) + 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO runtime_settings (
            singleton_id, settings_json, api_key_secret, revision, updated_at
          ) VALUES (1, ?, ?, ?, ?)
          ON CONFLICT (singleton_id) DO UPDATE SET
            settings_json = excluded.settings_json,
            api_key_secret = excluded.api_key_secret,
            revision = excluded.revision,
            updated_at = excluded.updated_at`,
        )
        .run(settingsJson, input.apiKeySecret, revision, observedAt);
      this.db
        .prepare(
          `INSERT INTO settings_audit (
            audit_id, revision, changed_fields_json, changed_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(randomUUID(), revision, changedFieldsJson, observedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      settings: JSON.parse(settingsJson) as unknown,
      apiKeySecret: input.apiKeySecret,
      revision,
      updatedAt: observedAt,
    };
  }

  listSettingsAudit(limit = 20): Array<{
    revision: number;
    changedFields: string[];
    changedAt: string;
  }> {
    const parsedLimit = z.number().int().min(1).max(100).parse(limit);
    const rows = this.db
      .prepare(
        `SELECT revision, changed_fields_json, changed_at
         FROM settings_audit ORDER BY changed_at DESC, audit_id DESC LIMIT ?`,
      )
      .all(parsedLimit) as Array<{
      revision: number;
      changed_fields_json: string;
      changed_at: string;
    }>;
    return rows.map((row) => ({
      revision: z.number().int().positive().parse(row.revision),
      changedFields: z.array(z.string()).parse(JSON.parse(row.changed_fields_json)),
      changedAt: z.iso.datetime().parse(row.changed_at),
    }));
  }

  getOnboardingState(): StoredOnboardingState | null {
    const row = this.db
      .prepare(
        `SELECT path, current_step, status, state_json, updated_at
         FROM onboarding_state WHERE singleton_id = 1`,
      )
      .get() as
      | {
          path: "attach" | "fresh";
          current_step: string;
          status: "in-progress" | "blocked" | "complete";
          state_json: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      path: z.enum(["attach", "fresh"]).parse(row.path),
      currentStep: z.string().min(1).parse(row.current_step),
      status: z.enum(["in-progress", "blocked", "complete"]).parse(row.status),
      state: JSON.parse(row.state_json) as unknown,
      updatedAt: z.iso.datetime().parse(row.updated_at),
    };
  }

  putOnboardingState(
    input: Omit<StoredOnboardingState, "updatedAt"> & {
      updatedAt: string;
      auditAction?: string;
    },
  ): void {
    const path = z.enum(["attach", "fresh"]).parse(input.path);
    const currentStep = z.string().min(1).parse(input.currentStep);
    const status = z.enum(["in-progress", "blocked", "complete"]).parse(input.status);
    const updatedAt = z.iso.datetime().parse(input.updatedAt);
    const auditAction = input.auditAction
      ? z.string().trim().min(1).max(100).parse(input.auditAction)
      : null;
    const stateJson = serializeJson(input.state, "onboarding state");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO onboarding_state (
            singleton_id, path, current_step, status, state_json, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT (singleton_id) DO UPDATE SET
            path = excluded.path,
            current_step = excluded.current_step,
            status = excluded.status,
            state_json = excluded.state_json,
            updated_at = excluded.updated_at`,
        )
        .run(path, currentStep, status, stateJson, updatedAt);
      if (auditAction) {
        this.db
          .prepare(
            `INSERT INTO onboarding_audit (
              event_id, action, path, current_step, status, changed_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), auditAction, path, currentStep, status, updatedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listOnboardingAudit(limit = 20): Array<{
    action: string;
    path: "attach" | "fresh";
    currentStep: string;
    status: "in-progress" | "blocked" | "complete";
    changedAt: string;
  }> {
    const parsedLimit = z.number().int().min(1).max(100).parse(limit);
    const rows = this.db
      .prepare(
        `SELECT action, path, current_step, status, changed_at
         FROM onboarding_audit ORDER BY changed_at DESC, event_id DESC LIMIT ?`,
      )
      .all(parsedLimit) as Array<{
      action: string;
      path: "attach" | "fresh";
      current_step: string;
      status: "in-progress" | "blocked" | "complete";
      changed_at: string;
    }>;
    return rows.map((row) => ({
      action: z.string().min(1).parse(row.action),
      path: z.enum(["attach", "fresh"]).parse(row.path),
      currentStep: z.string().min(1).parse(row.current_step),
      status: z.enum(["in-progress", "blocked", "complete"]).parse(row.status),
      changedAt: z.iso.datetime().parse(row.changed_at),
    }));
  }

  getOnboardingWizardPreference(): {
    dismissedAt: string | null;
    updatedAt: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT dismissed_at, updated_at
         FROM onboarding_wizard_preference WHERE singleton_id = 1`,
      )
      .get() as { dismissed_at: string | null; updated_at: string } | undefined;
    if (!row) return null;
    return {
      dismissedAt: z.iso.datetime().nullable().parse(row.dismissed_at),
      updatedAt: z.iso.datetime().parse(row.updated_at),
    };
  }

  setOnboardingWizardDismissed(dismissed: boolean, changedAt: string): void {
    const parsedDismissed = z.boolean().parse(dismissed);
    const parsedChangedAt = z.iso.datetime().parse(changedAt);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO onboarding_wizard_preference (singleton_id, dismissed_at, updated_at)
           VALUES (1, ?, ?)
           ON CONFLICT (singleton_id) DO UPDATE SET
             dismissed_at = excluded.dismissed_at,
             updated_at = excluded.updated_at`,
        )
        .run(parsedDismissed ? parsedChangedAt : null, parsedChangedAt);
      this.db
        .prepare(
          `INSERT INTO onboarding_wizard_audit (event_id, action, changed_at)
           VALUES (?, ?, ?)`,
        )
        .run(randomUUID(), parsedDismissed ? "dismissed" : "resumed", parsedChangedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listOnboardingWizardAudit(limit = 20): Array<{
    action: "dismissed" | "resumed";
    changedAt: string;
  }> {
    const parsedLimit = z.number().int().min(1).max(100).parse(limit);
    const rows = this.db
      .prepare(
        `SELECT action, changed_at
         FROM onboarding_wizard_audit ORDER BY changed_at DESC, event_id DESC LIMIT ?`,
      )
      .all(parsedLimit) as Array<{
      action: "dismissed" | "resumed";
      changed_at: string;
    }>;
    return rows.map((row) => ({
      action: z.enum(["dismissed", "resumed"]).parse(row.action),
      changedAt: z.iso.datetime().parse(row.changed_at),
    }));
  }

  upsertChainSource(input: ChainSourceInput): void {
    const value = sourceInputSchema.parse(input);
    const result = this.db
      .prepare(
        `INSERT INTO chain_sources (
          source_id, kind, network, base_url, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at
        WHERE chain_sources.kind = excluded.kind
          AND chain_sources.network = excluded.network
          AND chain_sources.base_url = excluded.base_url`,
      )
      .run(
        value.sourceId,
        value.kind,
        value.network,
        value.baseUrl,
        value.observedAt,
        value.observedAt,
      );
    if (Number(result.changes) !== 1) {
      throw new Error(`Chain source ${value.sourceId} is already bound to different metadata`);
    }
  }

  putCursor(input: ChainCursorInput): void {
    const value = cursorInputSchema.parse(input);
    this.db
      .prepare(
        `INSERT INTO chain_cursors (
          source_id, stream, cursor, last_block_height, last_index_block_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_id, stream) DO UPDATE SET
          cursor = excluded.cursor,
          last_block_height = excluded.last_block_height,
          last_index_block_hash = excluded.last_index_block_hash,
          updated_at = excluded.updated_at`,
      )
      .run(
        value.sourceId,
        value.stream,
        value.cursor,
        value.lastBlockHeight,
        value.lastIndexBlockHash,
        value.updatedAt,
      );
  }

  getCursor(sourceId: string, stream: string): ChainCursor | null {
    const row = this.db
      .prepare(
        `SELECT source_id, stream, cursor, last_block_height, last_index_block_hash, updated_at
         FROM chain_cursors WHERE source_id = ? AND stream = ?`,
      )
      .get(sourceId, stream);
    if (!row) return null;
    const value = cursorRowSchema.parse(row);
    return {
      sourceId: value.source_id,
      stream: value.stream,
      cursor: value.cursor,
      lastBlockHeight: value.last_block_height,
      lastIndexBlockHash: value.last_index_block_hash,
      updatedAt: value.updated_at,
    };
  }

  putChainEvent(input: ChainEventInput): void {
    const value = eventInputSchema.parse(input);
    const rawPayloadJson = serializeJson(value.rawPayload, "rawPayload");
    const decodedPayloadJson =
      value.decodedPayload === null ? null : serializeJson(value.decodedPayload, "decodedPayload");
    this.db.exec("SAVEPOINT put_chain_event");
    try {
      this.db
        .prepare(
          `INSERT INTO chain_events (
          chain_id, tx_id, event_index, block_height, block_hash, index_block_hash,
          microblock_hash, microblock_sequence, canonical, microblock_canonical,
          contract_id, topic, raw_payload_json, decoded_schema_version,
          decoded_payload_json, source_id, first_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (chain_id, tx_id, event_index) DO UPDATE SET
          block_height = excluded.block_height,
          block_hash = excluded.block_hash,
          index_block_hash = excluded.index_block_hash,
          microblock_hash = excluded.microblock_hash,
          microblock_sequence = excluded.microblock_sequence,
          canonical = excluded.canonical,
          microblock_canonical = excluded.microblock_canonical,
          contract_id = excluded.contract_id,
          topic = excluded.topic,
          raw_payload_json = excluded.raw_payload_json,
          decoded_schema_version = excluded.decoded_schema_version,
          decoded_payload_json = excluded.decoded_payload_json,
          source_id = excluded.source_id,
          updated_at = excluded.updated_at`,
        )
        .run(
          value.chainId,
          value.txId,
          value.eventIndex,
          value.blockHeight,
          value.blockHash,
          value.indexBlockHash,
          value.microblockHash,
          value.microblockSequence,
          value.canonical ? 1 : 0,
          value.microblockCanonical ? 1 : 0,
          value.contractId,
          value.topic,
          rawPayloadJson,
          value.decodedSchemaVersion,
          decodedPayloadJson,
          value.sourceId,
          value.observedAt,
          value.observedAt,
        );
      this.putManagerActivityProjection(value);
      this.db.exec("RELEASE SAVEPOINT put_chain_event");
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT put_chain_event");
      this.db.exec("RELEASE SAVEPOINT put_chain_event");
      throw error;
    }
  }

  private putManagerActivityProjection(value: ChainEventInput): void {
    if (!value.contractId) return;
    const parsed = managerActivityEnvelopeSchema.safeParse(value.decodedPayload);
    if (!parsed.success) return;
    const event = parsed.data.event;
    const isClaim = event.kind === "claim-staker-rewards";
    const amountSats =
      event.kind === "settle-accepted-withdrawal" ? event.liabilityReleasedSats : event.amountSats;
    const requestId = isClaim ? event.l1Withdrawal?.requestId : event.requestId;
    this.db
      .prepare(
        `INSERT INTO manager_activity_events (
          chain_id, tx_id, event_index, manager_principal, block_height, canonical, kind,
          staker_principal, reward_cycle, bond_index, amount_sats, request_id,
          withdrawal_amount_sats, max_fee_sats, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (chain_id, tx_id, event_index) DO UPDATE SET
          manager_principal = excluded.manager_principal,
          block_height = excluded.block_height,
          canonical = excluded.canonical,
          kind = excluded.kind,
          staker_principal = excluded.staker_principal,
          reward_cycle = excluded.reward_cycle,
          bond_index = excluded.bond_index,
          amount_sats = excluded.amount_sats,
          request_id = excluded.request_id,
          withdrawal_amount_sats = excluded.withdrawal_amount_sats,
          max_fee_sats = excluded.max_fee_sats,
          updated_at = excluded.updated_at`,
      )
      .run(
        value.chainId,
        value.txId,
        value.eventIndex,
        value.contractId,
        value.blockHeight,
        value.canonical ? 1 : 0,
        event.kind,
        event.stakerPrincipal,
        isClaim ? event.rewardCycle : null,
        isClaim ? event.bondIndex : null,
        amountSats,
        requestId ?? null,
        isClaim ? (event.l1Withdrawal?.amountSats ?? null) : null,
        isClaim ? (event.l1Withdrawal?.maxFeeSats ?? null) : null,
        value.observedAt,
      );
  }

  putChainEventPage(events: readonly ChainEventInput[], cursor: ChainCursorInput): void {
    eventInputSchema.array().parse(events);
    cursorInputSchema.parse(cursor);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) this.putChainEvent(event);
      this.putCursor(cursor);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  hasChainEventsForContract(chainId: number, contractId: string): boolean {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const parsedContractId = principalSchema.parse(contractId);
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM chain_events
           WHERE chain_id = ? AND contract_id = ? AND canonical = 1
           LIMIT 1`,
        )
        .get(parsedChainId, parsedContractId),
    );
  }

  getChainEvent(chainId: number, txId: string, eventIndex: number): StoredChainEvent | null {
    const row = this.db
      .prepare(
        `SELECT chain_id, tx_id, event_index, block_height, block_hash, index_block_hash,
          microblock_hash, microblock_sequence, canonical, microblock_canonical,
          contract_id, topic, raw_payload_json, decoded_schema_version,
          decoded_payload_json, source_id, first_seen_at, updated_at
         FROM chain_events WHERE chain_id = ? AND tx_id = ? AND event_index = ?`,
      )
      .get(chainId, txId, eventIndex);
    if (!row) return null;
    return toStoredChainEvent(row);
  }

  listChainEventsForContract(
    chainId: number,
    contractId: string,
    limit = 500,
    canonicalOnly = true,
  ): StoredChainEvent[] {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const parsedContractId = principalSchema.parse(contractId);
    const parsedLimit = z.number().int().min(1).max(10_000).parse(limit);
    const rows = this.db
      .prepare(
        `SELECT chain_id, tx_id, event_index, block_height, block_hash, index_block_hash,
          microblock_hash, microblock_sequence, canonical, microblock_canonical,
          contract_id, topic, raw_payload_json, decoded_schema_version,
          decoded_payload_json, source_id, first_seen_at, updated_at
         FROM chain_events
         WHERE chain_id = ? AND contract_id = ? AND (? = 0 OR canonical = 1)
         ORDER BY block_height DESC, tx_id DESC, event_index DESC
         LIMIT ?`,
      )
      .all(parsedChainId, parsedContractId, canonicalOnly ? 1 : 0, parsedLimit);
    return rows.map(toStoredChainEvent);
  }

  listManagerClaims(
    chainId: number,
    managerPrincipal: string,
    options: { limit?: number; offset?: number; rewardCycle?: string | null } = {},
  ): ManagerActivityPage<StoredManagerClaim> {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const manager = principalSchema.parse(managerPrincipal);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.limit ?? 50);
    const offset = z
      .number()
      .int()
      .nonnegative()
      .parse(options.offset ?? 0);
    const rewardCycle =
      options.rewardCycle === undefined || options.rewardCycle === null
        ? null
        : unsignedIntegerTextSchema.parse(options.rewardCycle);
    const where = `chain_id = ? AND manager_principal = ? AND canonical = 1
      AND kind = 'claim-staker-rewards' AND (? IS NULL OR reward_cycle = ?)`;
    const totalRow = this.db
      .prepare(`SELECT count(*) AS count FROM manager_activity_events WHERE ${where}`)
      .get(parsedChainId, manager, rewardCycle, rewardCycle) as { count: number };
    const rows = this.db
      .prepare(
        `SELECT tx_id, event_index, block_height, staker_principal, reward_cycle,
          bond_index, amount_sats, request_id
         FROM manager_activity_events
         WHERE ${where}
         ORDER BY block_height DESC, tx_id DESC, event_index DESC
         LIMIT ? OFFSET ?`,
      )
      .all(parsedChainId, manager, rewardCycle, rewardCycle, limit, offset);
    return {
      items: rows.map((row) => {
        const value = managerClaimRowSchema.parse(row);
        return {
          txId: value.tx_id,
          eventIndex: value.event_index,
          blockHeight: value.block_height,
          stakerPrincipal: value.staker_principal,
          rewardCycle: value.reward_cycle,
          bondIndex: value.bond_index,
          amountSats: value.amount_sats,
          destination: value.request_id === null ? "direct-sbtc" : "bitcoin-l1",
          withdrawalRequestId: value.request_id,
        };
      }),
      total: z.number().int().nonnegative().parse(totalRow.count),
      offset,
      limit,
    };
  }

  listManagerWithdrawals(
    chainId: number,
    managerPrincipal: string,
    options: {
      limit?: number;
      offset?: number;
      state?: "pending" | "settled" | "reclaimed" | null;
    } = {},
  ): ManagerActivityPage<StoredManagerWithdrawal> {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const manager = principalSchema.parse(managerPrincipal);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.limit ?? 50);
    const offset = z
      .number()
      .int()
      .nonnegative()
      .parse(options.offset ?? 0);
    const state = z
      .enum(["pending", "settled", "reclaimed"])
      .nullable()
      .parse(options.state ?? null);
    const cte = `WITH withdrawal_state AS (
      SELECT
        initiation.request_id,
        initiation.staker_principal,
        initiation.withdrawal_amount_sats AS amount_sats,
        initiation.max_fee_sats,
        initiation.tx_id AS initiated_tx_id,
        initiation.block_height AS initiated_block_height,
        resolution.kind AS resolution_kind,
        resolution.tx_id AS resolved_tx_id,
        resolution.block_height AS resolved_block_height,
        CASE resolution.kind
          WHEN 'settle-accepted-withdrawal' THEN 'settled'
          WHEN 'reclaim-failed-withdrawal' THEN 'reclaimed'
          ELSE 'pending'
        END AS state
      FROM manager_activity_events AS initiation
      LEFT JOIN manager_activity_events AS resolution
        ON resolution.chain_id = initiation.chain_id
        AND resolution.manager_principal = initiation.manager_principal
        AND resolution.request_id = initiation.request_id
        AND resolution.canonical = 1
        AND resolution.kind IN ('settle-accepted-withdrawal', 'reclaim-failed-withdrawal')
        AND NOT EXISTS (
          SELECT 1 FROM manager_activity_events AS later
          WHERE later.chain_id = resolution.chain_id
            AND later.manager_principal = resolution.manager_principal
            AND later.request_id = resolution.request_id
            AND later.canonical = 1
            AND later.kind IN ('settle-accepted-withdrawal', 'reclaim-failed-withdrawal')
            AND (
              later.block_height > resolution.block_height
              OR (
                later.block_height = resolution.block_height
                AND (
                  later.tx_id > resolution.tx_id
                  OR (
                    later.tx_id = resolution.tx_id
                    AND later.event_index > resolution.event_index
                  )
                )
              )
            )
        )
      WHERE initiation.chain_id = ?
        AND initiation.manager_principal = ?
        AND initiation.canonical = 1
        AND initiation.kind = 'claim-staker-rewards'
        AND initiation.request_id IS NOT NULL
    )`;
    const totalRow = this.db
      .prepare(
        `${cte} SELECT count(*) AS count FROM withdrawal_state WHERE (? IS NULL OR state = ?)`,
      )
      .get(parsedChainId, manager, state, state) as { count: number };
    const rows = this.db
      .prepare(
        `${cte}
         SELECT request_id, staker_principal, amount_sats, max_fee_sats,
           initiated_tx_id, initiated_block_height, resolution_kind,
           resolved_tx_id, resolved_block_height
         FROM withdrawal_state
         WHERE (? IS NULL OR state = ?)
         ORDER BY initiated_block_height DESC, length(request_id) DESC, request_id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(parsedChainId, manager, state, state, limit, offset);
    return {
      items: rows.map((row) => {
        const value = managerWithdrawalRowSchema.parse(row);
        return {
          requestId: value.request_id,
          stakerPrincipal: value.staker_principal,
          amountSats: value.amount_sats,
          maxFeeSats: value.max_fee_sats,
          initiatedTxId: value.initiated_tx_id,
          initiatedBlockHeight: value.initiated_block_height,
          state:
            value.resolution_kind === "settle-accepted-withdrawal"
              ? "settled"
              : value.resolution_kind === "reclaim-failed-withdrawal"
                ? "reclaimed"
                : "pending",
          resolvedTxId: value.resolved_tx_id,
          resolvedBlockHeight: value.resolved_block_height,
        };
      }),
      total: z.number().int().nonnegative().parse(totalRow.count),
      offset,
      limit,
    };
  }

  getManagerActivityMetadata(
    chainId: number,
    managerPrincipal: string,
  ): { eventCount: number; latestBlockHeight: number | null } {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const manager = principalSchema.parse(managerPrincipal);
    const row = this.db
      .prepare(
        `SELECT count(*) AS count, max(block_height) AS latest_block_height
         FROM manager_activity_events
         WHERE chain_id = ? AND manager_principal = ? AND canonical = 1`,
      )
      .get(parsedChainId, manager) as { count: number; latest_block_height: number | null };
    return {
      eventCount: z.number().int().nonnegative().parse(row.count),
      latestBlockHeight: z.number().int().nonnegative().nullable().parse(row.latest_block_height),
    };
  }

  markIndexBlockNonCanonical(chainId: number, indexBlockHash: string, updatedAt: string): number {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const parsedIndexBlockHash = hashSchema.parse(indexBlockHash);
    const parsedUpdatedAt = z.iso.datetime().parse(updatedAt);
    this.db.exec("SAVEPOINT mark_index_block_noncanonical");
    try {
      const result = this.db
        .prepare(
          `UPDATE chain_events SET canonical = 0, updated_at = ?
         WHERE chain_id = ? AND index_block_hash = ? AND canonical = 1`,
        )
        .run(parsedUpdatedAt, parsedChainId, parsedIndexBlockHash);
      this.db
        .prepare(
          `UPDATE manager_activity_events AS activity
         SET canonical = 0, updated_at = ?
         WHERE activity.chain_id = ? AND activity.canonical = 1
           AND EXISTS (
             SELECT 1 FROM chain_events AS event
             WHERE event.chain_id = activity.chain_id
               AND event.tx_id = activity.tx_id
               AND event.event_index = activity.event_index
               AND event.index_block_hash = ?
               AND event.canonical = 0
           )`,
        )
        .run(parsedUpdatedAt, parsedChainId, parsedIndexBlockHash);
      this.db.exec("RELEASE SAVEPOINT mark_index_block_noncanonical");
      return Number(result.changes);
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT mark_index_block_noncanonical");
      this.db.exec("RELEASE SAVEPOINT mark_index_block_noncanonical");
      throw error;
    }
  }

  markMissingCanonicalContractEvents(
    chainId: number,
    contractId: string,
    boundaryBlockHeight: number,
    includeBoundary: boolean,
    presentEventIds: ReadonlySet<string>,
    updatedAt: string,
  ): number {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const parsedContractId = principalSchema.parse(contractId);
    const parsedBoundary = z.number().int().nonnegative().parse(boundaryBlockHeight);
    const parsedUpdatedAt = z.iso.datetime().parse(updatedAt);
    const rows = this.db
      .prepare(
        `SELECT tx_id, event_index FROM chain_events
         WHERE chain_id = ? AND contract_id = ? AND canonical = 1
           AND block_height ${includeBoundary ? ">=" : ">"} ?`,
      )
      .all(parsedChainId, parsedContractId, parsedBoundary) as Array<{
      tx_id: string;
      event_index: number;
    }>;
    const update = this.db.prepare(
      `UPDATE chain_events SET canonical = 0, updated_at = ?
       WHERE chain_id = ? AND tx_id = ? AND event_index = ? AND canonical = 1`,
    );
    const updateProjection = this.db.prepare(
      `UPDATE manager_activity_events SET canonical = 0, updated_at = ?
       WHERE chain_id = ? AND tx_id = ? AND event_index = ? AND canonical = 1`,
    );
    let changed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (presentEventIds.has(`${row.tx_id}:${row.event_index}`)) continue;
        changed += Number(
          update.run(parsedUpdatedAt, parsedChainId, row.tx_id, row.event_index).changes,
        );
        updateProjection.run(parsedUpdatedAt, parsedChainId, row.tx_id, row.event_index);
      }
      this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  startOrResumeSignerStakerRun(
    sourceId: string,
    managerPrincipal: string,
    now: string,
  ): SignerStakerRun {
    const parsedSourceId = z.string().min(1).parse(sourceId);
    const parsedManager = principalSchema.parse(managerPrincipal);
    const parsedNow = z.iso.datetime().parse(now);
    const selectRun = this.db.prepare(
      `SELECT run_id, source_id, stream, manager_principal, status, cursor_next,
        pages_processed, items_processed, started_at, updated_at, completed_at
       FROM ingestion_runs
       WHERE source_id = ? AND stream = ? AND manager_principal = ? AND status = 'running'`,
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = selectRun.get(parsedSourceId, signerStakersStream, parsedManager);
      if (existing) {
        const result = toSignerStakerRun(existing);
        this.db.exec("COMMIT");
        return result;
      }

      const runId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ingestion_runs (
            run_id, source_id, stream, manager_principal, status, cursor_next,
            pages_processed, items_processed, started_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, 'running', NULL, 0, 0, ?, ?, NULL)`,
        )
        .run(runId, parsedSourceId, signerStakersStream, parsedManager, parsedNow, parsedNow);
      const created = selectRun.get(parsedSourceId, signerStakersStream, parsedManager);
      if (!created) throw new Error("Created signer-staker run could not be read back");
      const result = toSignerStakerRun(created);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  commitSignerStakerPage(input: SignerStakerPageInput): SignerStakerRun {
    const value = signerStakerPageInputSchema.parse(input);
    const uniqueStakers = new Set(value.items.map((item) => item.stakerPrincipal));
    if (uniqueStakers.size !== value.items.length) {
      throw new Error("Signer-staker API page contains duplicate staker principals");
    }
    for (const item of value.items) {
      const position = item.position;
      if (position && position.signerPrincipal !== value.managerPrincipal) {
        throw new Error(
          `Trusted position for ${item.stakerPrincipal} is assigned to a different signer`,
        );
      }
      if (position) {
        const cycles = position.cycleMemberships.map(({ rewardCycle }) => rewardCycle);
        if (new Set(cycles.map(String)).size !== cycles.length) {
          throw new Error(`Trusted position for ${item.stakerPrincipal} has duplicate cycles`);
        }
        if (
          position.cycleMemberships.some(
            ({ signerPrincipal }) => signerPrincipal !== value.managerPrincipal,
          )
        ) {
          throw new Error(
            `Trusted position for ${item.stakerPrincipal} has a cycle assigned to another signer`,
          );
        }
        const unlockCycle = position.firstRewardCycle + position.numCycles;
        if (
          position.cycleMemberships.some(
            ({ rewardCycle }) =>
              rewardCycle < position.firstRewardCycle || rewardCycle >= unlockCycle,
          )
        ) {
          throw new Error(`Trusted position for ${item.stakerPrincipal} has an out-of-range cycle`);
        }
      }
    }

    const selectRun = this.db.prepare(
      `SELECT run_id, source_id, stream, manager_principal, status, cursor_next,
        pages_processed, items_processed, started_at, updated_at, completed_at
       FROM ingestion_runs WHERE run_id = ?`,
    );
    const upsertStaker = this.db.prepare(
      `INSERT INTO stakers (
        manager_principal, staker_principal, has_stx, has_btc, stx_node_verified,
        active, source_id, verification_source_id, last_seen_run_id, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT (manager_principal, staker_principal) DO UPDATE SET
        has_stx = excluded.has_stx,
        has_btc = excluded.has_btc,
        stx_node_verified = excluded.stx_node_verified,
        active = 1,
        source_id = excluded.source_id,
        verification_source_id = excluded.verification_source_id,
        last_seen_run_id = excluded.last_seen_run_id,
        last_seen_at = excluded.last_seen_at`,
    );
    const deactivatePosition = this.db.prepare(
      `UPDATE stake_positions SET active = 0, updated_at = ?
       WHERE manager_principal = ? AND staker_principal = ? AND active = 1`,
    );
    const deactivateMemberships = this.db.prepare(
      `UPDATE cycle_memberships SET active = 0, updated_at = ?
       WHERE manager_principal = ? AND staker_principal = ? AND active = 1`,
    );
    const upsertPosition = this.db.prepare(
      `INSERT INTO stake_positions (
        manager_principal, staker_principal, signer_principal, amount_ustx,
        first_reward_cycle, num_cycles, unlock_cycle, unlock_burn_height, active, discovery_source_id,
        verification_source_id, last_seen_run_id, observed_burn_block_height,
        observed_stacks_tip_height, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (manager_principal, staker_principal) DO UPDATE SET
        signer_principal = excluded.signer_principal,
        amount_ustx = excluded.amount_ustx,
        first_reward_cycle = excluded.first_reward_cycle,
        num_cycles = excluded.num_cycles,
        unlock_cycle = excluded.unlock_cycle,
        unlock_burn_height = excluded.unlock_burn_height,
        active = 1,
        discovery_source_id = excluded.discovery_source_id,
        verification_source_id = excluded.verification_source_id,
        last_seen_run_id = excluded.last_seen_run_id,
        observed_burn_block_height = excluded.observed_burn_block_height,
        observed_stacks_tip_height = excluded.observed_stacks_tip_height,
        updated_at = excluded.updated_at`,
    );
    const upsertMembership = this.db.prepare(
      `INSERT INTO cycle_memberships (
        manager_principal, staker_principal, reward_cycle, signer_principal, amount_ustx, active,
        discovery_source_id, verification_source_id, last_seen_run_id, observed_burn_block_height,
        observed_stacks_tip_height, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (manager_principal, staker_principal, reward_cycle) DO UPDATE SET
        amount_ustx = excluded.amount_ustx,
        signer_principal = excluded.signer_principal,
        active = 1,
        discovery_source_id = excluded.discovery_source_id,
        verification_source_id = excluded.verification_source_id,
        last_seen_run_id = excluded.last_seen_run_id,
        observed_burn_block_height = excluded.observed_burn_block_height,
        observed_stacks_tip_height = excluded.observed_stacks_tip_height,
        updated_at = excluded.updated_at`,
    );
    const putPositionObservation = this.db.prepare(
      `INSERT INTO staker_position_observations (
        manager_principal, staker_principal, observed_burn_block_height,
        observed_stacks_tip_height, has_stx, has_btc, stx_node_verified,
        position_present, signer_principal, amount_ustx, first_reward_cycle,
        num_cycles, unlock_cycle, unlock_burn_height, source_id,
        verification_source_id, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (
        manager_principal, staker_principal,
        observed_burn_block_height, observed_stacks_tip_height
      ) DO UPDATE SET
        has_stx = excluded.has_stx,
        has_btc = excluded.has_btc,
        stx_node_verified = excluded.stx_node_verified,
        position_present = excluded.position_present,
        signer_principal = excluded.signer_principal,
        amount_ustx = excluded.amount_ustx,
        first_reward_cycle = excluded.first_reward_cycle,
        num_cycles = excluded.num_cycles,
        unlock_cycle = excluded.unlock_cycle,
        unlock_burn_height = excluded.unlock_burn_height,
        source_id = excluded.source_id,
        verification_source_id = excluded.verification_source_id,
        observed_at = excluded.observed_at`,
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = toSignerStakerRun(selectRun.get(value.runId));
      if (
        current.status !== "running" ||
        current.sourceId !== value.sourceId ||
        current.managerPrincipal !== value.managerPrincipal
      ) {
        throw new Error(
          `Signer-staker run ${value.runId} is not active for this source and manager`,
        );
      }

      for (const item of value.items) {
        upsertStaker.run(
          value.managerPrincipal,
          item.stakerPrincipal,
          item.hasStx ? 1 : 0,
          item.hasBtc ? 1 : 0,
          item.stxNodeVerified === null ? null : item.stxNodeVerified ? 1 : 0,
          value.sourceId,
          item.hasStx ? value.nodeSourceId : null,
          value.runId,
          value.observedAt,
          value.observedAt,
        );
        deactivatePosition.run(value.observedAt, value.managerPrincipal, item.stakerPrincipal);
        deactivateMemberships.run(value.observedAt, value.managerPrincipal, item.stakerPrincipal);

        const observedPosition = item.position;
        putPositionObservation.run(
          value.managerPrincipal,
          item.stakerPrincipal,
          value.burnBlockHeight,
          value.stacksTipHeight,
          item.hasStx ? 1 : 0,
          item.hasBtc ? 1 : 0,
          item.stxNodeVerified === null ? null : item.stxNodeVerified ? 1 : 0,
          observedPosition ? 1 : 0,
          observedPosition?.signerPrincipal ?? null,
          observedPosition?.amountUstx.toString() ?? null,
          observedPosition?.firstRewardCycle.toString() ?? null,
          observedPosition?.numCycles.toString() ?? null,
          observedPosition
            ? (observedPosition.firstRewardCycle + observedPosition.numCycles).toString()
            : null,
          observedPosition?.unlockBurnHeight?.toString() ?? null,
          value.sourceId,
          item.hasStx ? value.nodeSourceId : null,
          value.observedAt,
        );

        if (!observedPosition) continue;
        const position = observedPosition;
        const unlockCycle = position.firstRewardCycle + position.numCycles;
        upsertPosition.run(
          value.managerPrincipal,
          item.stakerPrincipal,
          position.signerPrincipal,
          position.amountUstx.toString(),
          position.firstRewardCycle.toString(),
          position.numCycles.toString(),
          unlockCycle.toString(),
          position.unlockBurnHeight?.toString() ?? null,
          value.sourceId,
          value.nodeSourceId,
          value.runId,
          value.burnBlockHeight,
          value.stacksTipHeight,
          value.observedAt,
        );
        for (const membership of position.cycleMemberships) {
          upsertMembership.run(
            value.managerPrincipal,
            item.stakerPrincipal,
            membership.rewardCycle.toString(),
            membership.signerPrincipal,
            membership.amountUstx.toString(),
            value.sourceId,
            value.nodeSourceId,
            value.runId,
            value.burnBlockHeight,
            value.stacksTipHeight,
            value.observedAt,
          );
        }
      }

      const completed = value.nextCursor === null;
      if (completed) {
        this.db
          .prepare(
            `UPDATE stakers SET active = 0
             WHERE manager_principal = ? AND active = 1 AND last_seen_run_id <> ?`,
          )
          .run(value.managerPrincipal, value.runId);
        this.db
          .prepare(
            `UPDATE stake_positions SET active = 0, updated_at = ?
             WHERE manager_principal = ? AND active = 1 AND last_seen_run_id <> ?`,
          )
          .run(value.observedAt, value.managerPrincipal, value.runId);
        this.db
          .prepare(
            `UPDATE cycle_memberships SET active = 0, updated_at = ?
             WHERE manager_principal = ? AND active = 1 AND last_seen_run_id <> ?`,
          )
          .run(value.observedAt, value.managerPrincipal, value.runId);
      }
      this.db
        .prepare(
          `UPDATE ingestion_runs SET
            status = ?, cursor_next = ?, pages_processed = pages_processed + 1,
            items_processed = items_processed + ?, updated_at = ?, completed_at = ?
           WHERE run_id = ?`,
        )
        .run(
          completed ? "completed" : "running",
          value.nextCursor,
          value.items.length,
          value.observedAt,
          completed ? value.observedAt : null,
          value.runId,
        );
      const updated = selectRun.get(value.runId);
      const result = toSignerStakerRun(updated);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listSignerStakers(
    managerPrincipal: string,
    activeOnly = true,
    sourceId: string | null = null,
  ): StoredSignerStaker[] {
    const manager = principalSchema.parse(managerPrincipal);
    const parsedSourceId = sourceId === null ? null : z.string().min(1).parse(sourceId);
    const rows = this.db
      .prepare(
        `SELECT s.manager_principal, s.staker_principal, s.has_stx, s.has_btc,
          s.stx_node_verified, s.active, s.source_id, s.last_seen_run_id,
          s.verification_source_id, s.first_seen_at, s.last_seen_at,
          p.signer_principal, p.amount_ustx,
          p.first_reward_cycle, p.num_cycles, p.unlock_cycle, p.unlock_burn_height,
          p.active AS position_active
         FROM stakers s
         LEFT JOIN stake_positions p
           ON p.manager_principal = s.manager_principal
          AND p.staker_principal = s.staker_principal
         WHERE s.manager_principal = ?
           AND (? = 0 OR s.active = 1)
           AND (? IS NULL OR s.source_id = ?)
         ORDER BY s.staker_principal`,
      )
      .all(manager, activeOnly ? 1 : 0, parsedSourceId, parsedSourceId);
    return rows.map((row) => {
      const value = storedSignerStakerRowSchema.parse(row);
      return {
        managerPrincipal: value.manager_principal,
        stakerPrincipal: value.staker_principal,
        hasStx: value.has_stx === 1,
        hasBtc: value.has_btc === 1,
        stxNodeVerified: value.stx_node_verified === null ? null : value.stx_node_verified === 1,
        active: value.active === 1,
        sourceId: value.source_id,
        verificationSourceId: value.verification_source_id,
        lastSeenRunId: value.last_seen_run_id,
        firstSeenAt: value.first_seen_at,
        lastSeenAt: value.last_seen_at,
        position:
          value.signer_principal === null ||
          value.amount_ustx === null ||
          value.first_reward_cycle === null ||
          value.num_cycles === null ||
          value.unlock_cycle === null ||
          value.position_active === null
            ? null
            : {
                signerPrincipal: value.signer_principal,
                amountUstx: BigInt(value.amount_ustx),
                firstRewardCycle: BigInt(value.first_reward_cycle),
                numCycles: BigInt(value.num_cycles),
                unlockCycle: BigInt(value.unlock_cycle),
                unlockBurnHeight:
                  value.unlock_burn_height === null ? null : BigInt(value.unlock_burn_height),
                active: value.position_active === 1,
              },
      };
    });
  }

  listCycleMemberships(
    managerPrincipal: string,
    activeOnly = true,
    sourceId: string | null = null,
  ): StoredCycleMembership[] {
    const manager = principalSchema.parse(managerPrincipal);
    const parsedSourceId = sourceId === null ? null : z.string().min(1).parse(sourceId);
    const rows = this.db
      .prepare(
        `SELECT staker_principal, reward_cycle, signer_principal, amount_ustx, active
         FROM cycle_memberships
         WHERE manager_principal = ?
           AND (? = 0 OR active = 1)
           AND (? IS NULL OR discovery_source_id = ?)
         ORDER BY length(reward_cycle), reward_cycle, staker_principal`,
      )
      .all(manager, activeOnly ? 1 : 0, parsedSourceId, parsedSourceId);
    return rows.map((row) => {
      const value = cycleMembershipRowSchema.parse(row);
      return {
        stakerPrincipal: value.staker_principal,
        rewardCycle: BigInt(value.reward_cycle),
        signerPrincipal: value.signer_principal,
        amountUstx: BigInt(value.amount_ustx),
        active: value.active === 1,
      };
    });
  }

  listCycleMembershipsForCycle(
    managerPrincipal: string,
    rewardCycle: number,
    sourceId: string | null = null,
  ): StoredCycleMembership[] {
    const manager = principalSchema.parse(managerPrincipal);
    const cycle = z.number().int().nonnegative().parse(rewardCycle).toString();
    const parsedSourceId = sourceId === null ? null : z.string().min(1).parse(sourceId);
    const rows = this.db
      .prepare(
        `SELECT staker_principal, reward_cycle, signer_principal, amount_ustx, active
         FROM cycle_memberships
         WHERE manager_principal = ?
           AND reward_cycle = ?
           AND (? IS NULL OR discovery_source_id = ?)
         ORDER BY staker_principal`,
      )
      .all(manager, cycle, parsedSourceId, parsedSourceId);
    return rows.map((row) => {
      const value = cycleMembershipRowSchema.parse(row);
      return {
        stakerPrincipal: value.staker_principal,
        rewardCycle: BigInt(value.reward_cycle),
        signerPrincipal: value.signer_principal,
        amountUstx: BigInt(value.amount_ustx),
        active: value.active === 1,
      };
    });
  }

  listStakerPositionObservations(
    managerPrincipal: string,
    stakerPrincipal: string,
    limit = 100,
  ): StoredStakerPositionObservation[] {
    const manager = principalSchema.parse(managerPrincipal);
    const staker = principalSchema.parse(stakerPrincipal);
    const parsedLimit = z.number().int().min(1).max(500).parse(limit);
    const rows = this.db
      .prepare(
        `SELECT manager_principal, staker_principal, observed_burn_block_height,
          observed_stacks_tip_height, has_stx, has_btc, stx_node_verified,
          position_present, signer_principal, amount_ustx, first_reward_cycle,
          num_cycles, unlock_cycle, unlock_burn_height, observed_at
         FROM staker_position_observations
         WHERE manager_principal = ? AND staker_principal = ?
         ORDER BY observed_burn_block_height DESC, observed_stacks_tip_height DESC
         LIMIT ?`,
      )
      .all(manager, staker, parsedLimit);
    return rows.map((row) => {
      const value = stakerPositionObservationRowSchema.parse(row);
      const position =
        value.position_present === 1 &&
        value.signer_principal !== null &&
        value.amount_ustx !== null &&
        value.first_reward_cycle !== null &&
        value.num_cycles !== null &&
        value.unlock_cycle !== null
          ? {
              signerPrincipal: value.signer_principal,
              amountUstx: value.amount_ustx,
              firstRewardCycle: value.first_reward_cycle,
              numCycles: value.num_cycles,
              unlockCycle: value.unlock_cycle,
              unlockBurnHeight: value.unlock_burn_height,
            }
          : null;
      return {
        managerPrincipal: value.manager_principal,
        stakerPrincipal: value.staker_principal,
        observedBurnBlockHeight: value.observed_burn_block_height,
        observedStacksTipHeight: value.observed_stacks_tip_height,
        hasStx: value.has_stx === 1,
        hasBtc: value.has_btc === 1,
        stxNodeVerified: value.stx_node_verified === null ? null : value.stx_node_verified === 1,
        position,
        observedAt: value.observed_at,
      };
    });
  }

  putPoolCycleSnapshots(input: PoolCycleSnapshotInput): void {
    const value = poolCycleSnapshotInputSchema.parse(input);
    const upsert = this.db.prepare(
      `INSERT INTO pool_cycle_snapshots (
        manager_principal, reward_cycle, observed_burn_block_height,
        observed_stacks_tip_height, status, roster_available, staker_count,
        enumerated_stx_ustx, enumeration_delta_ustx, pending_stx_ustx,
        eligible_stx_shares_ustx, total_delegated_ustx, non_stx_delegated_ustx,
        in_signer_set, threshold_ustx, threshold_margin_ustx, value_classification,
        contract_source, local_roster_source, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (
        manager_principal, reward_cycle,
        observed_burn_block_height, observed_stacks_tip_height
      ) DO UPDATE SET
        status = excluded.status,
        roster_available = excluded.roster_available,
        staker_count = excluded.staker_count,
        enumerated_stx_ustx = excluded.enumerated_stx_ustx,
        enumeration_delta_ustx = excluded.enumeration_delta_ustx,
        pending_stx_ustx = excluded.pending_stx_ustx,
        eligible_stx_shares_ustx = excluded.eligible_stx_shares_ustx,
        total_delegated_ustx = excluded.total_delegated_ustx,
        non_stx_delegated_ustx = excluded.non_stx_delegated_ustx,
        in_signer_set = excluded.in_signer_set,
        threshold_ustx = excluded.threshold_ustx,
        threshold_margin_ustx = excluded.threshold_margin_ustx,
        value_classification = excluded.value_classification,
        contract_source = excluded.contract_source,
        local_roster_source = excluded.local_roster_source,
        observed_at = excluded.observed_at`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const cycle of value.cycles) {
        upsert.run(
          value.managerPrincipal,
          cycle.cycleId,
          value.burnBlockHeight,
          value.stacksTipHeight,
          cycle.status,
          cycle.rosterAvailable ? 1 : 0,
          cycle.stakerCount,
          cycle.enumeratedStxUstx,
          cycle.enumerationDeltaUstx,
          cycle.pendingStxUstx,
          cycle.eligibleStxSharesUstx,
          cycle.totalDelegatedUstx,
          cycle.nonStxDelegatedUstx,
          cycle.inSignerSet ? 1 : 0,
          cycle.thresholdUstx,
          cycle.thresholdMarginUstx,
          cycle.provenance.classification,
          cycle.provenance.contractSource,
          cycle.provenance.localRosterSource,
          value.observedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listLatestPoolCycleSnapshots(
    managerPrincipal: string,
    options: { limit?: number; offset?: number } = {},
  ): ManagerActivityPage<StoredPoolCycleSnapshot> {
    const manager = principalSchema.parse(managerPrincipal);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.limit ?? 50);
    const offset = z
      .number()
      .int()
      .nonnegative()
      .parse(options.offset ?? 0);
    const totalRow = this.db
      .prepare(
        `SELECT count(DISTINCT reward_cycle) AS count
         FROM pool_cycle_snapshots WHERE manager_principal = ?`,
      )
      .get(manager) as { count: number };
    const rows = this.db
      .prepare(
        `WITH ranked AS (
          SELECT *, row_number() OVER (
            PARTITION BY reward_cycle
            ORDER BY observed_burn_block_height DESC, observed_stacks_tip_height DESC
          ) AS observation_rank
          FROM pool_cycle_snapshots
          WHERE manager_principal = ?
        )
        SELECT manager_principal, reward_cycle, observed_burn_block_height,
          observed_stacks_tip_height, status, roster_available, staker_count,
          enumerated_stx_ustx, enumeration_delta_ustx, pending_stx_ustx,
          eligible_stx_shares_ustx, total_delegated_ustx, non_stx_delegated_ustx,
          in_signer_set, threshold_ustx, threshold_margin_ustx, value_classification,
          contract_source, local_roster_source, observed_at
        FROM ranked WHERE observation_rank = 1
        ORDER BY reward_cycle DESC LIMIT ? OFFSET ?`,
      )
      .all(manager, limit, offset);
    return {
      items: rows.map((row) => {
        const value = poolCycleSnapshotRowSchema.parse(row);
        return {
          managerPrincipal: value.manager_principal,
          cycleId: value.reward_cycle,
          observedBurnBlockHeight: value.observed_burn_block_height,
          observedStacksTipHeight: value.observed_stacks_tip_height,
          status: value.status,
          rosterAvailable: value.roster_available === 1,
          stakerCount: value.staker_count,
          enumeratedStxUstx: value.enumerated_stx_ustx,
          enumerationDeltaUstx: value.enumeration_delta_ustx,
          pendingStxUstx: value.pending_stx_ustx,
          eligibleStxSharesUstx: value.eligible_stx_shares_ustx,
          totalDelegatedUstx: value.total_delegated_ustx,
          nonStxDelegatedUstx: value.non_stx_delegated_ustx,
          inSignerSet: value.in_signer_set === 1,
          thresholdUstx: value.threshold_ustx,
          thresholdMarginUstx: value.threshold_margin_ustx,
          provenance: {
            classification: value.value_classification,
            contractSource: value.contract_source,
            localRosterSource: value.local_roster_source,
          },
          observedAt: value.observed_at,
        };
      }),
      total: z.number().int().nonnegative().parse(totalRow.count),
      offset,
      limit,
    };
  }

  putRewardCycleSnapshot(input: RewardCycleSnapshotInput): void {
    const value = rewardCycleSnapshotInputSchema.parse(input);
    const upsertCycle = this.db.prepare(
      `INSERT INTO reward_cycle_snapshots (
        manager_principal, reward_cycle, status, observed_burn_block_height,
        observed_stacks_tip_height, last_reward_compute_burn_height,
        last_computed_reward_cycle, rewards_per_token,
        signer_earned_before_manager_claim_sats, fee_snapshot_bips, fee_snapshot_present,
        configured_fee_bips,
        earned_fees_sats, withdrawal_liability_sats, unclaimed_staker_rewards_sats,
        staker_count, gross_sats, earned_sats, fee_sats, actionable_claims,
        l1_claims_waiting_for_fee_threshold, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (manager_principal, reward_cycle) DO UPDATE SET
        status = excluded.status,
        observed_burn_block_height = excluded.observed_burn_block_height,
        observed_stacks_tip_height = excluded.observed_stacks_tip_height,
        last_reward_compute_burn_height = excluded.last_reward_compute_burn_height,
        last_computed_reward_cycle = excluded.last_computed_reward_cycle,
        rewards_per_token = excluded.rewards_per_token,
        signer_earned_before_manager_claim_sats = excluded.signer_earned_before_manager_claim_sats,
        fee_snapshot_bips = excluded.fee_snapshot_bips,
        fee_snapshot_present = excluded.fee_snapshot_present,
        configured_fee_bips = excluded.configured_fee_bips,
        earned_fees_sats = excluded.earned_fees_sats,
        withdrawal_liability_sats = excluded.withdrawal_liability_sats,
        unclaimed_staker_rewards_sats = excluded.unclaimed_staker_rewards_sats,
        staker_count = excluded.staker_count,
        gross_sats = excluded.gross_sats,
        earned_sats = excluded.earned_sats,
        fee_sats = excluded.fee_sats,
        actionable_claims = excluded.actionable_claims,
        l1_claims_waiting_for_fee_threshold = excluded.l1_claims_waiting_for_fee_threshold,
        observed_at = excluded.observed_at`,
    );
    const insertStaker = this.db.prepare(
      `INSERT INTO staker_reward_cycle_snapshots (
        manager_principal, reward_cycle, staker_principal, payout_kind,
        pox_address_version_hex, pox_address_hashbytes_hex, max_fee_sats,
        earned_sats, fee_sats, gross_sats, claimable_by_policy, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      upsertCycle.run(
        value.managerPrincipal,
        value.rewardCycle,
        value.status,
        value.burnBlockHeight,
        value.stacksTipHeight,
        value.global.lastRewardComputeBurnHeight,
        value.global.lastComputedRewardCycle,
        value.global.rewardsPerToken,
        value.global.signerEarnedBeforeManagerClaimSats,
        value.manager.feeSnapshotBips ?? "0",
        value.manager.feeSnapshotBips === null ? 0 : 1,
        value.manager.configuredFeeBips,
        value.manager.earnedFeesSats,
        value.manager.withdrawalLiabilitySats,
        value.manager.unclaimedStakerRewardsSats,
        value.totals.stakers,
        value.totals.grossSats,
        value.totals.earnedSats,
        value.totals.feeSats,
        value.totals.actionableClaims,
        value.totals.l1ClaimsWaitingForFeeThreshold,
        value.observedAt,
      );
      this.db
        .prepare(
          `DELETE FROM staker_reward_cycle_snapshots
           WHERE manager_principal = ? AND reward_cycle = ?`,
        )
        .run(value.managerPrincipal, value.rewardCycle);
      for (const staker of value.stakers) {
        insertStaker.run(
          value.managerPrincipal,
          value.rewardCycle,
          staker.stakerPrincipal,
          staker.payout.kind,
          staker.payout.poxAddress?.versionHex ?? null,
          staker.payout.poxAddress?.hashbytesHex ?? null,
          staker.payout.maxFeeSats,
          staker.rewards.earnedSats,
          staker.rewards.feeSats,
          staker.rewards.grossSats,
          staker.claimableByPolicy ? 1 : 0,
          value.observedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listRewardCycleSummaries(
    managerPrincipal: string,
    options: { limit?: number; offset?: number } = {},
  ): ManagerActivityPage<StoredRewardCycleSummary> {
    const manager = principalSchema.parse(managerPrincipal);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.limit ?? 50);
    const offset = z
      .number()
      .int()
      .nonnegative()
      .parse(options.offset ?? 0);
    const totalRow = this.db
      .prepare(`SELECT count(*) AS count FROM reward_cycle_snapshots WHERE manager_principal = ?`)
      .get(manager) as { count: number };
    const rows = this.db
      .prepare(
        `SELECT manager_principal, reward_cycle, status, observed_burn_block_height,
          observed_stacks_tip_height, staker_count, gross_sats, earned_sats,
          fee_sats, fee_snapshot_bips, fee_snapshot_present, configured_fee_bips,
          actionable_claims, l1_claims_waiting_for_fee_threshold, observed_at
         FROM reward_cycle_snapshots WHERE manager_principal = ?
         ORDER BY reward_cycle DESC LIMIT ? OFFSET ?`,
      )
      .all(manager, limit, offset);
    return {
      items: rows.map((row) => {
        const value = rewardCycleSummaryRowSchema.parse(row);
        return {
          managerPrincipal: value.manager_principal,
          rewardCycle: value.reward_cycle,
          status: value.status,
          observedBurnBlockHeight: value.observed_burn_block_height,
          observedStacksTipHeight: value.observed_stacks_tip_height,
          stakerCount: value.staker_count,
          grossSats: value.gross_sats,
          earnedSats: value.earned_sats,
          feeSats: value.fee_sats,
          configuredFeeBips: value.configured_fee_bips,
          feeSnapshotBips: value.fee_snapshot_present === 1 ? value.fee_snapshot_bips : null,
          actionableClaims: value.actionable_claims,
          l1ClaimsWaitingForFeeThreshold: value.l1_claims_waiting_for_fee_threshold,
          observedAt: value.observed_at,
        };
      }),
      total: z.number().int().nonnegative().parse(totalRow.count),
      offset,
      limit,
    };
  }

  getLatestCompletedSignerStakerRun(
    sourceId: string,
    managerPrincipal: string,
  ): SignerStakerRun | null {
    const parsedSourceId = z.string().min(1).parse(sourceId);
    const manager = principalSchema.parse(managerPrincipal);
    const row = this.db
      .prepare(
        `SELECT run_id, source_id, stream, manager_principal, status, cursor_next,
          pages_processed, items_processed, started_at, updated_at, completed_at
         FROM ingestion_runs
         WHERE source_id = ? AND stream = ? AND manager_principal = ? AND status = 'completed'
         ORDER BY completed_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(parsedSourceId, signerStakersStream, manager);
    return row ? toSignerStakerRun(row) : null;
  }
}
