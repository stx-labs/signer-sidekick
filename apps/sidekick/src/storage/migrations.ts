export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
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
  {
    version: 11,
    name: "manager_trust_transitions",
    sql: `
      CREATE TABLE manager_trust_state (
        manager_principal TEXT PRIMARY KEY,
        recognition_tier TEXT NOT NULL CHECK (recognition_tier IN (
          'reference-built-in', 'reference-render', 'custom-observe', 'unrecognized'
        )),
        profile_id TEXT,
        profile_origin TEXT CHECK (
          profile_origin IS NULL OR profile_origin IN ('built-in', 'operator-installed')
        ),
        source_sha256 TEXT,
        canonical_source_sha256 TEXT,
        automation_eligible INTEGER NOT NULL CHECK (automation_eligible IN (0, 1)),
        eligibility_reason TEXT NOT NULL,
        observed_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE manager_trust_audit (
        event_id TEXT PRIMARY KEY,
        manager_principal TEXT NOT NULL,
        transition TEXT NOT NULL CHECK (transition IN ('gained', 'lost')),
        previous_tier TEXT NOT NULL,
        current_tier TEXT NOT NULL,
        previous_profile_id TEXT,
        current_profile_id TEXT,
        previous_source_sha256 TEXT,
        current_source_sha256 TEXT,
        previous_canonical_source_sha256 TEXT,
        current_canonical_source_sha256 TEXT,
        reason TEXT NOT NULL,
        changed_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX manager_trust_audit_recent
        ON manager_trust_audit (manager_principal, changed_at DESC, event_id DESC);
    `,
  },
  {
    version: 12,
    name: "manager_trust_degraded_transitions",
    sql: `
      ALTER TABLE manager_trust_audit RENAME TO manager_trust_audit_v11;
      DROP INDEX manager_trust_audit_recent;

      CREATE TABLE manager_trust_audit (
        event_id TEXT PRIMARY KEY,
        manager_principal TEXT NOT NULL,
        transition TEXT NOT NULL CHECK (transition IN ('gained', 'lost', 'degraded')),
        previous_tier TEXT NOT NULL,
        current_tier TEXT NOT NULL,
        previous_profile_id TEXT,
        current_profile_id TEXT,
        previous_source_sha256 TEXT,
        current_source_sha256 TEXT,
        previous_canonical_source_sha256 TEXT,
        current_canonical_source_sha256 TEXT,
        reason TEXT NOT NULL,
        changed_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO manager_trust_audit (
        event_id,
        manager_principal,
        transition,
        previous_tier,
        current_tier,
        previous_profile_id,
        current_profile_id,
        previous_source_sha256,
        current_source_sha256,
        previous_canonical_source_sha256,
        current_canonical_source_sha256,
        reason,
        changed_at
      )
      SELECT
        event_id,
        manager_principal,
        transition,
        previous_tier,
        current_tier,
        previous_profile_id,
        current_profile_id,
        previous_source_sha256,
        current_source_sha256,
        previous_canonical_source_sha256,
        current_canonical_source_sha256,
        reason,
        changed_at
      FROM manager_trust_audit_v11;

      DROP TABLE manager_trust_audit_v11;

      CREATE INDEX manager_trust_audit_recent
        ON manager_trust_audit (manager_principal, changed_at DESC, event_id DESC);
    `,
  },
  {
    version: 13,
    name: "anchored_signer_staker_reconciliation",
    sql: `
      ALTER TABLE ingestion_runs
        ADD COLUMN authoritative INTEGER NOT NULL DEFAULT 1 CHECK (authoritative IN (0, 1));
      ALTER TABLE ingestion_runs
        ADD COLUMN reconciliation_complete INTEGER NOT NULL DEFAULT 1
        CHECK (reconciliation_complete IN (0, 1));
      ALTER TABLE ingestion_runs ADD COLUMN anchor_stacks_block_height INTEGER;
      ALTER TABLE ingestion_runs ADD COLUMN anchor_index_block_hash TEXT;
      ALTER TABLE ingestion_runs ADD COLUMN anchor_burn_block_height INTEGER;
      ALTER TABLE ingestion_runs ADD COLUMN anchor_reward_cycle INTEGER;
      ALTER TABLE ingestion_runs ADD COLUMN anchor_reward_cycle_length INTEGER;
      ALTER TABLE ingestion_runs ADD COLUMN anchor_prepare_cycle_length INTEGER;
      ALTER TABLE ingestion_runs ADD COLUMN anchor_cycle_position INTEGER;
      ALTER TABLE ingestion_runs ADD COLUMN anchor_phase TEXT;
      ALTER TABLE ingestion_runs ADD COLUMN anchor_checkpoint TEXT;

      UPDATE ingestion_runs SET authoritative = 0 WHERE status = 'running';

      ALTER TABLE stake_positions ADD COLUMN observed_index_block_hash TEXT;
      ALTER TABLE cycle_memberships ADD COLUMN observed_index_block_hash TEXT;
      ALTER TABLE staker_position_observations ADD COLUMN observed_index_block_hash TEXT;
    `,
  },
  {
    version: 14,
    name: "transaction_engine_persistence",
    sql: `
      ALTER TABLE pool_cycle_snapshots
        ADD COLUMN chain_anchor_json TEXT CHECK (
          chain_anchor_json IS NULL OR json_valid(chain_anchor_json)
        );
      ALTER TABLE reward_cycle_snapshots
        ADD COLUMN chain_anchor_json TEXT CHECK (
          chain_anchor_json IS NULL OR json_valid(chain_anchor_json)
        );

      CREATE TABLE transaction_jobs (
        job_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        operation_scope_key TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        adapter_revision INTEGER NOT NULL CHECK (adapter_revision > 0),
        manager_principal TEXT NOT NULL,
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256) = 64),
        policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64),
        intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
        policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
        chain_anchor_json TEXT NOT NULL CHECK (json_valid(chain_anchor_json)),
        attestation_issuer TEXT NOT NULL,
        attestation_revision INTEGER NOT NULL CHECK (attestation_revision > 0),
        attestation_payload_sha256 TEXT NOT NULL CHECK (
          length(attestation_payload_sha256) = 64
        ),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'preflighted', 'awaiting_approval', 'nonce_reserved',
          'broadcast', 'confirmed', 'reconciled', 'blocked', 'superseded',
          'ambiguous', 'noncanonical_reobserve'
        )),
        state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
        block_reason TEXT,
        supersession_reason TEXT,
        superseded_by_job_id TEXT REFERENCES transaction_jobs(job_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((state = 'blocked') = (block_reason IS NOT NULL)),
        CHECK ((state = 'superseded') = (supersession_reason IS NOT NULL)),
        CHECK (superseded_by_job_id IS NULL OR state = 'superseded'),
        CHECK (superseded_by_job_id IS NULL OR superseded_by_job_id <> job_id)
      ) STRICT;

      CREATE UNIQUE INDEX transaction_jobs_one_active_checkpoint
        ON transaction_jobs (idempotency_key)
        WHERE state NOT IN ('reconciled', 'superseded');
      CREATE UNIQUE INDEX transaction_jobs_one_active_scope
        ON transaction_jobs (operation_scope_key)
        WHERE state NOT IN ('reconciled', 'superseded');
      CREATE INDEX transaction_jobs_recent
        ON transaction_jobs (updated_at DESC, job_id DESC);

      CREATE TRIGGER transaction_jobs_immutable_intent
      BEFORE UPDATE ON transaction_jobs
      WHEN NEW.idempotency_key IS NOT OLD.idempotency_key
        OR NEW.operation_scope_key IS NOT OLD.operation_scope_key
        OR NEW.adapter_id IS NOT OLD.adapter_id
        OR NEW.adapter_revision IS NOT OLD.adapter_revision
        OR NEW.manager_principal IS NOT OLD.manager_principal
        OR NEW.intent_sha256 IS NOT OLD.intent_sha256
        OR NEW.policy_sha256 IS NOT OLD.policy_sha256
        OR NEW.intent_json IS NOT OLD.intent_json
        OR NEW.policy_json IS NOT OLD.policy_json
        OR NEW.chain_anchor_json IS NOT OLD.chain_anchor_json
        OR NEW.attestation_issuer IS NOT OLD.attestation_issuer
        OR NEW.attestation_revision IS NOT OLD.attestation_revision
        OR NEW.attestation_payload_sha256 IS NOT OLD.attestation_payload_sha256
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'transaction job intent is immutable');
      END;

      CREATE TABLE gas_payer_nonce_reservations (
        reservation_id TEXT PRIMARY KEY,
        gas_payer_principal TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES transaction_jobs(job_id),
        nonce TEXT NOT NULL CHECK (
          length(nonce) > 0 AND nonce NOT GLOB '*[^0-9]*'
        ),
        observed_account_nonce TEXT NOT NULL CHECK (
          length(observed_account_nonce) > 0 AND observed_account_nonce NOT GLOB '*[^0-9]*'
        ),
        state TEXT NOT NULL CHECK (state IN ('reserved', 'ambiguous', 'resolved')),
        state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
        foreign_activity INTEGER NOT NULL DEFAULT 0 CHECK (foreign_activity IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        CHECK ((state = 'resolved') = (resolved_at IS NOT NULL)),
        UNIQUE (gas_payer_principal, nonce)
      ) STRICT;

      CREATE UNIQUE INDEX gas_payer_nonce_one_unresolved
        ON gas_payer_nonce_reservations (gas_payer_principal)
        WHERE resolved_at IS NULL;
      CREATE INDEX gas_payer_nonce_by_job
        ON gas_payer_nonce_reservations (job_id, created_at DESC);

      CREATE TRIGGER gas_payer_nonce_immutable_binding
      BEFORE UPDATE ON gas_payer_nonce_reservations
      WHEN NEW.gas_payer_principal IS NOT OLD.gas_payer_principal
        OR NEW.job_id IS NOT OLD.job_id
        OR NEW.nonce IS NOT OLD.nonce
        OR NEW.observed_account_nonce IS NOT OLD.observed_account_nonce
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'gas payer nonce binding is immutable');
      END;

      CREATE TABLE transaction_attempts (
        attempt_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES transaction_jobs(job_id),
        attempt_number INTEGER NOT NULL CHECK (attempt_number = 1),
        nonce_reservation_id TEXT NOT NULL REFERENCES gas_payer_nonce_reservations(reservation_id),
        fee_ustx TEXT NOT NULL CHECK (
          length(fee_ustx) > 0 AND fee_ustx NOT GLOB '*[^0-9]*'
        ),
        fee_policy_revision INTEGER NOT NULL CHECK (fee_policy_revision > 0),
        signed_transaction_ref TEXT NOT NULL,
        precomputed_txid TEXT NOT NULL UNIQUE CHECK (length(precomputed_txid) = 66),
        state TEXT NOT NULL CHECK (state IN (
          'signed', 'submitted', 'ambiguous', 'confirmed', 'rejected', 'reconciled'
        )),
        state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
        submission_result_json TEXT CHECK (
          submission_result_json IS NULL OR json_valid(submission_result_json)
        ),
        inclusion_record_json TEXT CHECK (
          inclusion_record_json IS NULL OR json_valid(inclusion_record_json)
        ),
        submitted_at TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (job_id)
      ) STRICT;

      CREATE INDEX transaction_attempts_by_job
        ON transaction_attempts (job_id, attempt_number);
      CREATE INDEX transaction_attempts_by_nonce
        ON transaction_attempts (nonce_reservation_id, attempt_number);

      CREATE TRIGGER transaction_attempts_immutable_binding
      BEFORE UPDATE ON transaction_attempts
      WHEN NEW.job_id IS NOT OLD.job_id
        OR NEW.attempt_number IS NOT OLD.attempt_number
        OR NEW.nonce_reservation_id IS NOT OLD.nonce_reservation_id
        OR NEW.fee_ustx IS NOT OLD.fee_ustx
        OR NEW.fee_policy_revision IS NOT OLD.fee_policy_revision
        OR NEW.signed_transaction_ref IS NOT OLD.signed_transaction_ref
        OR NEW.precomputed_txid IS NOT OLD.precomputed_txid
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'transaction attempt binding is immutable');
      END;

      CREATE TABLE transaction_approvals (
        approval_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES transaction_jobs(job_id),
        intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256) = 64),
        policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64),
        approval_sha256 TEXT NOT NULL CHECK (length(approval_sha256) = 64),
        approval_json TEXT NOT NULL CHECK (json_valid(approval_json)),
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        invalidated_at TEXT,
        invalidation_reason TEXT,
        approval_version INTEGER NOT NULL DEFAULT 0 CHECK (approval_version >= 0),
        CHECK ((invalidated_at IS NULL) = (invalidation_reason IS NULL))
      ) STRICT;

      CREATE UNIQUE INDEX transaction_approvals_one_active
        ON transaction_approvals (job_id)
        WHERE invalidated_at IS NULL;
      CREATE INDEX transaction_approvals_history
        ON transaction_approvals (job_id, created_at DESC);

      CREATE TRIGGER transaction_approvals_immutable_binding
      BEFORE UPDATE ON transaction_approvals
      WHEN NEW.job_id IS NOT OLD.job_id
        OR NEW.intent_sha256 IS NOT OLD.intent_sha256
        OR NEW.policy_sha256 IS NOT OLD.policy_sha256
        OR NEW.approval_sha256 IS NOT OLD.approval_sha256
        OR NEW.approval_json IS NOT OLD.approval_json
        OR NEW.actor IS NOT OLD.actor
        OR NEW.created_at IS NOT OLD.created_at
        OR NEW.expires_at IS NOT OLD.expires_at
      BEGIN
        SELECT RAISE(ABORT, 'transaction approval binding is immutable');
      END;

      CREATE TABLE transaction_reconciliation_observations (
        observation_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES transaction_jobs(job_id),
        predicate_sha256 TEXT NOT NULL CHECK (length(predicate_sha256) = 64),
        predicate_json TEXT NOT NULL CHECK (json_valid(predicate_json)),
        chain_anchor_json TEXT NOT NULL CHECK (json_valid(chain_anchor_json)),
        authoritative INTEGER NOT NULL CHECK (authoritative IN (0, 1)),
        canonical INTEGER NOT NULL CHECK (canonical IN (0, 1)),
        finality_depth INTEGER NOT NULL CHECK (finality_depth >= 0),
        outcome TEXT NOT NULL CHECK (outcome IN (
          'pending', 'satisfied', 'not_satisfied', 'external_success',
          'noncanonical', 'ambiguous', 'blocked'
        )),
        effect_remaining INTEGER NOT NULL CHECK (effect_remaining IN (0, 1)),
        reason TEXT,
        observed_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX transaction_reconciliation_by_job
        ON transaction_reconciliation_observations (job_id, observed_at DESC, observation_id DESC);

      CREATE TRIGGER transaction_reconciliation_immutable_update
      BEFORE UPDATE ON transaction_reconciliation_observations
      BEGIN
        SELECT RAISE(ABORT, 'transaction reconciliation evidence is immutable');
      END;

      CREATE TRIGGER transaction_reconciliation_immutable_delete
      BEFORE DELETE ON transaction_reconciliation_observations
      BEGIN
        SELECT RAISE(ABORT, 'transaction reconciliation evidence is immutable');
      END;

      CREATE TABLE accepted_compatibility_attestations (
        issuer TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
        verified_at TEXT NOT NULL,
        document_json TEXT NOT NULL CHECK (json_valid(document_json)),
        accepted_at TEXT NOT NULL,
        row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0)
      ) STRICT;

      CREATE TRIGGER accepted_attestations_monotonic_revision
      BEFORE UPDATE ON accepted_compatibility_attestations
      WHEN NEW.issuer IS NOT OLD.issuer
        OR NEW.revision < OLD.revision
        OR (NEW.revision = OLD.revision AND NEW.payload_sha256 IS NOT OLD.payload_sha256)
      BEGIN
        SELECT RAISE(ABORT, 'accepted attestation revision/digest is not monotonic');
      END;

      CREATE TABLE engine_force_observe_control (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        forced_at TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER engine_force_observe_immutable_update
      BEFORE UPDATE ON engine_force_observe_control
      BEGIN
        SELECT RAISE(ABORT, 'Force Observe is irreversible');
      END;

      CREATE TRIGGER engine_force_observe_immutable_delete
      BEFORE DELETE ON engine_force_observe_control
      BEGIN
        SELECT RAISE(ABORT, 'Force Observe is irreversible');
      END;

      CREATE TABLE engine_adapter_disable_controls (
        adapter_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        disabled_at TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;

      CREATE TRIGGER engine_adapter_disable_immutable_update
      BEFORE UPDATE ON engine_adapter_disable_controls
      BEGIN
        SELECT RAISE(ABORT, 'adapter disable is irreversible');
      END;

      CREATE TRIGGER engine_adapter_disable_immutable_delete
      BEFORE DELETE ON engine_adapter_disable_controls
      BEGIN
        SELECT RAISE(ABORT, 'adapter disable is irreversible');
      END;
    `,
  },
  {
    version: 15,
    name: "reusable_resolved_gas_payer_nonces",
    sql: `
      CREATE TEMP TABLE migration_15_nonce_reservations AS
        SELECT * FROM gas_payer_nonce_reservations;
      CREATE TEMP TABLE migration_15_transaction_attempts AS
        SELECT * FROM transaction_attempts;

      DROP TABLE transaction_attempts;
      DROP TABLE gas_payer_nonce_reservations;

      CREATE TABLE gas_payer_nonce_reservations (
        reservation_id TEXT PRIMARY KEY,
        gas_payer_principal TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES transaction_jobs(job_id),
        nonce TEXT NOT NULL CHECK (
          length(nonce) > 0 AND nonce NOT GLOB '*[^0-9]*'
        ),
        observed_account_nonce TEXT NOT NULL CHECK (
          length(observed_account_nonce) > 0 AND observed_account_nonce NOT GLOB '*[^0-9]*'
        ),
        state TEXT NOT NULL CHECK (state IN ('reserved', 'ambiguous', 'resolved')),
        state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
        foreign_activity INTEGER NOT NULL DEFAULT 0 CHECK (foreign_activity IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
      ) STRICT;

      INSERT INTO gas_payer_nonce_reservations (
        reservation_id, gas_payer_principal, job_id, nonce, observed_account_nonce,
        state, state_version, foreign_activity, created_at, updated_at, resolved_at
      )
      SELECT
        reservation_id, gas_payer_principal, job_id, nonce, observed_account_nonce,
        state, state_version, foreign_activity, created_at, updated_at, resolved_at
      FROM migration_15_nonce_reservations;

      CREATE UNIQUE INDEX gas_payer_nonce_one_unresolved
        ON gas_payer_nonce_reservations (gas_payer_principal)
        WHERE resolved_at IS NULL;
      CREATE INDEX gas_payer_nonce_by_job
        ON gas_payer_nonce_reservations (job_id, created_at DESC);

      CREATE TRIGGER gas_payer_nonce_immutable_binding
      BEFORE UPDATE ON gas_payer_nonce_reservations
      WHEN NEW.gas_payer_principal IS NOT OLD.gas_payer_principal
        OR NEW.job_id IS NOT OLD.job_id
        OR NEW.nonce IS NOT OLD.nonce
        OR NEW.observed_account_nonce IS NOT OLD.observed_account_nonce
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'gas payer nonce binding is immutable');
      END;

      CREATE TABLE transaction_attempts (
        attempt_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES transaction_jobs(job_id),
        attempt_number INTEGER NOT NULL CHECK (attempt_number = 1),
        nonce_reservation_id TEXT NOT NULL REFERENCES gas_payer_nonce_reservations(reservation_id),
        fee_ustx TEXT NOT NULL CHECK (
          length(fee_ustx) > 0 AND fee_ustx NOT GLOB '*[^0-9]*'
        ),
        fee_policy_revision INTEGER NOT NULL CHECK (fee_policy_revision > 0),
        signed_transaction_ref TEXT NOT NULL,
        precomputed_txid TEXT NOT NULL UNIQUE CHECK (length(precomputed_txid) = 66),
        state TEXT NOT NULL CHECK (state IN (
          'signed', 'submitted', 'ambiguous', 'confirmed', 'rejected', 'reconciled'
        )),
        state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
        submission_result_json TEXT CHECK (
          submission_result_json IS NULL OR json_valid(submission_result_json)
        ),
        inclusion_record_json TEXT CHECK (
          inclusion_record_json IS NULL OR json_valid(inclusion_record_json)
        ),
        submitted_at TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (job_id)
      ) STRICT;

      INSERT INTO transaction_attempts (
        attempt_id, job_id, attempt_number, nonce_reservation_id, fee_ustx,
        fee_policy_revision, signed_transaction_ref, precomputed_txid,
        state, state_version, submission_result_json, inclusion_record_json,
        submitted_at, resolved_at, created_at, updated_at
      )
      SELECT
        attempt_id, job_id, attempt_number, nonce_reservation_id, fee_ustx,
        fee_policy_revision, signed_transaction_ref, precomputed_txid,
        state, state_version, submission_result_json, inclusion_record_json,
        submitted_at, resolved_at, created_at, updated_at
      FROM migration_15_transaction_attempts;

      CREATE INDEX transaction_attempts_by_job
        ON transaction_attempts (job_id, attempt_number);
      CREATE INDEX transaction_attempts_by_nonce
        ON transaction_attempts (nonce_reservation_id, attempt_number);

      CREATE TRIGGER transaction_attempts_immutable_binding
      BEFORE UPDATE ON transaction_attempts
      WHEN NEW.job_id IS NOT OLD.job_id
        OR NEW.attempt_number IS NOT OLD.attempt_number
        OR NEW.nonce_reservation_id IS NOT OLD.nonce_reservation_id
        OR NEW.fee_ustx IS NOT OLD.fee_ustx
        OR NEW.fee_policy_revision IS NOT OLD.fee_policy_revision
        OR NEW.signed_transaction_ref IS NOT OLD.signed_transaction_ref
        OR NEW.precomputed_txid IS NOT OLD.precomputed_txid
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'transaction attempt binding is immutable');
      END;

      DROP TABLE migration_15_transaction_attempts;
      DROP TABLE migration_15_nonce_reservations;
    `,
  },
  {
    version: 16,
    name: "browser_wallet_intents",
    sql: `
      CREATE TABLE browser_wallet_intents (
        intent_id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('deploy-manager', 'register-self')),
        scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 500),
        facts_sha256 TEXT NOT NULL CHECK (
          length(facts_sha256) = 64 AND facts_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        manifest_sha256 TEXT NOT NULL CHECK (
          length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        manifest_json TEXT NOT NULL CHECK (
          json_valid(manifest_json) AND length(manifest_json) BETWEEN 2 AND 262144
        ),
        required_sender TEXT NOT NULL CHECK (length(required_sender) BETWEEN 1 AND 500),
        network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet', 'regtest')),
        chain_id INTEGER NOT NULL CHECK (chain_id BETWEEN 0 AND 4294967295),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'submitted', 'mempool', 'confirmed', 'complete',
          'expired', 'superseded', 'failed', 'reobserve'
        )),
        state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
        txid TEXT UNIQUE CHECK (
          txid IS NULL OR (
            length(txid) = 66
            AND substr(txid, 1, 2) = '0x'
            AND substr(txid, 3) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        submitted_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (expires_at > created_at),
        CHECK ((txid IS NULL) = (submitted_at IS NULL)),
        CHECK (
          state NOT IN ('submitted', 'mempool', 'confirmed', 'complete', 'reobserve')
          OR txid IS NOT NULL
        ),
        CHECK (state NOT IN ('prepared', 'expired') OR txid IS NULL)
      ) STRICT;

      CREATE UNIQUE INDEX browser_wallet_one_active_scope
        ON browser_wallet_intents (action, scope)
        WHERE state IN ('prepared', 'submitted', 'mempool', 'confirmed', 'complete', 'reobserve');
      CREATE INDEX browser_wallet_intents_by_scope
        ON browser_wallet_intents (action, scope, created_at DESC, intent_id DESC);

      CREATE TRIGGER browser_wallet_intent_immutable_binding
      BEFORE UPDATE ON browser_wallet_intents
      WHEN NEW.intent_id IS NOT OLD.intent_id
        OR NEW.action IS NOT OLD.action
        OR NEW.scope IS NOT OLD.scope
        OR NEW.facts_sha256 IS NOT OLD.facts_sha256
        OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
        OR NEW.manifest_json IS NOT OLD.manifest_json
        OR NEW.required_sender IS NOT OLD.required_sender
        OR NEW.network IS NOT OLD.network
        OR NEW.chain_id IS NOT OLD.chain_id
        OR NEW.created_at IS NOT OLD.created_at
        OR NEW.expires_at IS NOT OLD.expires_at
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet intent binding is immutable');
      END;

      CREATE TRIGGER browser_wallet_intent_immutable_submission
      BEFORE UPDATE ON browser_wallet_intents
      WHEN (OLD.txid IS NOT NULL AND NEW.txid IS NOT OLD.txid)
        OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS NOT OLD.submitted_at)
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet intent submission is immutable');
      END;

      CREATE TRIGGER browser_wallet_intent_immutable_delete
      BEFORE DELETE ON browser_wallet_intents
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet intent is durable');
      END;

      CREATE TABLE browser_wallet_intent_observations (
        observation_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL REFERENCES browser_wallet_intents(intent_id),
        outcome TEXT NOT NULL CHECK (
          length(outcome) BETWEEN 1 AND 100
          AND outcome NOT GLOB '*[^a-z0-9-]*'
        ),
        canonical INTEGER CHECK (canonical IS NULL OR canonical IN (0, 1)),
        block_height INTEGER CHECK (block_height IS NULL OR block_height >= 0),
        index_block_hash TEXT CHECK (
          index_block_hash IS NULL OR (
            length(index_block_hash) = 66
            AND substr(index_block_hash, 1, 2) = '0x'
            AND substr(index_block_hash, 3) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        evidence_json TEXT NOT NULL CHECK (
          json_valid(evidence_json) AND length(evidence_json) BETWEEN 2 AND 32768
        ),
        observed_at TEXT NOT NULL,
        CHECK ((block_height IS NULL) = (index_block_hash IS NULL))
      ) STRICT;

      CREATE INDEX browser_wallet_observations_by_intent
        ON browser_wallet_intent_observations (
          intent_id, observed_at DESC, observation_id DESC
        );

      CREATE TRIGGER browser_wallet_observation_immutable_update
      BEFORE UPDATE ON browser_wallet_intent_observations
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet observation is immutable');
      END;

      CREATE TRIGGER browser_wallet_observation_immutable_delete
      BEFORE DELETE ON browser_wallet_intent_observations
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet observation is immutable');
      END;
    `,
  },
  {
    version: 17,
    name: "browser_wallet_manager_actions",
    sql: `
      CREATE TABLE browser_wallet_intents_v17 (
        intent_id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN (
          'deploy-manager', 'register-self', 'add-admin', 'remove-admin',
          'update-fees', 'withdraw-fees', 'sweep-fee-refunds', 'claim-rewards'
        )),
        scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 500),
        facts_sha256 TEXT NOT NULL CHECK (
          length(facts_sha256) = 64 AND facts_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        manifest_sha256 TEXT NOT NULL CHECK (
          length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        manifest_json TEXT NOT NULL CHECK (
          json_valid(manifest_json) AND length(manifest_json) BETWEEN 2 AND 262144
        ),
        required_sender TEXT NOT NULL CHECK (length(required_sender) BETWEEN 1 AND 500),
        network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet', 'regtest')),
        chain_id INTEGER NOT NULL CHECK (chain_id BETWEEN 0 AND 4294967295),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'submitted', 'mempool', 'confirmed', 'complete',
          'expired', 'superseded', 'failed', 'reobserve'
        )),
        state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
        txid TEXT UNIQUE CHECK (
          txid IS NULL OR (
            length(txid) = 66
            AND substr(txid, 1, 2) = '0x'
            AND substr(txid, 3) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        submitted_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (expires_at > created_at),
        CHECK ((txid IS NULL) = (submitted_at IS NULL)),
        CHECK (
          state NOT IN ('submitted', 'mempool', 'confirmed', 'complete', 'reobserve')
          OR txid IS NOT NULL
        ),
        CHECK (state NOT IN ('prepared', 'expired') OR txid IS NULL)
      ) STRICT;

      INSERT INTO browser_wallet_intents_v17 (
        intent_id, action, scope, facts_sha256, manifest_sha256, manifest_json,
        required_sender, network, chain_id, state, state_version, txid,
        created_at, expires_at, submitted_at, updated_at
      )
      SELECT
        intent_id, action, scope, facts_sha256, manifest_sha256, manifest_json,
        required_sender, network, chain_id, state, state_version, txid,
        created_at, expires_at, submitted_at, updated_at
      FROM browser_wallet_intents;

      CREATE TABLE browser_wallet_intent_observations_v17 (
        observation_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL REFERENCES browser_wallet_intents_v17(intent_id),
        outcome TEXT NOT NULL CHECK (
          length(outcome) BETWEEN 1 AND 100
          AND outcome NOT GLOB '*[^a-z0-9-]*'
        ),
        canonical INTEGER CHECK (canonical IS NULL OR canonical IN (0, 1)),
        block_height INTEGER CHECK (block_height IS NULL OR block_height >= 0),
        index_block_hash TEXT CHECK (
          index_block_hash IS NULL OR (
            length(index_block_hash) = 66
            AND substr(index_block_hash, 1, 2) = '0x'
            AND substr(index_block_hash, 3) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        evidence_json TEXT NOT NULL CHECK (
          json_valid(evidence_json) AND length(evidence_json) BETWEEN 2 AND 32768
        ),
        observed_at TEXT NOT NULL,
        CHECK ((block_height IS NULL) = (index_block_hash IS NULL))
      ) STRICT;

      INSERT INTO browser_wallet_intent_observations_v17 (
        observation_id, intent_id, outcome, canonical, block_height,
        index_block_hash, evidence_json, observed_at
      )
      SELECT
        observation_id, intent_id, outcome, canonical, block_height,
        index_block_hash, evidence_json, observed_at
      FROM browser_wallet_intent_observations;

      DROP TABLE browser_wallet_intent_observations;
      DROP TABLE browser_wallet_intents;
      ALTER TABLE browser_wallet_intents_v17 RENAME TO browser_wallet_intents;
      ALTER TABLE browser_wallet_intent_observations_v17
        RENAME TO browser_wallet_intent_observations;

      CREATE UNIQUE INDEX browser_wallet_one_active_scope
        ON browser_wallet_intents (action, scope)
        WHERE state IN ('prepared', 'submitted', 'mempool', 'confirmed', 'complete', 'reobserve');
      CREATE INDEX browser_wallet_intents_by_scope
        ON browser_wallet_intents (action, scope, created_at DESC, intent_id DESC);

      CREATE TRIGGER browser_wallet_intent_immutable_binding
      BEFORE UPDATE ON browser_wallet_intents
      WHEN NEW.intent_id IS NOT OLD.intent_id
        OR NEW.action IS NOT OLD.action
        OR NEW.scope IS NOT OLD.scope
        OR NEW.facts_sha256 IS NOT OLD.facts_sha256
        OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
        OR NEW.manifest_json IS NOT OLD.manifest_json
        OR NEW.required_sender IS NOT OLD.required_sender
        OR NEW.network IS NOT OLD.network
        OR NEW.chain_id IS NOT OLD.chain_id
        OR NEW.created_at IS NOT OLD.created_at
        OR NEW.expires_at IS NOT OLD.expires_at
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet intent binding is immutable');
      END;

      CREATE TRIGGER browser_wallet_intent_immutable_submission
      BEFORE UPDATE ON browser_wallet_intents
      WHEN (OLD.txid IS NOT NULL AND NEW.txid IS NOT OLD.txid)
        OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS NOT OLD.submitted_at)
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet intent submission is immutable');
      END;

      CREATE TRIGGER browser_wallet_intent_immutable_delete
      BEFORE DELETE ON browser_wallet_intents
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet intent is durable');
      END;

      CREATE INDEX browser_wallet_observations_by_intent
        ON browser_wallet_intent_observations (
          intent_id, observed_at DESC, observation_id DESC
        );

      CREATE TRIGGER browser_wallet_observation_immutable_update
      BEFORE UPDATE ON browser_wallet_intent_observations
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet observation is immutable');
      END;

      CREATE TRIGGER browser_wallet_observation_immutable_delete
      BEFORE DELETE ON browser_wallet_intent_observations
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet observation is immutable');
      END;
    `,
  },
  {
    version: 18,
    name: "durable_signer_staker_api_rosters",
    sql: `
      UPDATE ingestion_runs
      SET status = 'completed', authoritative = 0, reconciliation_complete = 0,
        completed_at = COALESCE(completed_at, updated_at)
      WHERE stream = 'signer-stakers' AND status = 'running';

      CREATE TABLE signer_staker_api_scans (
        run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(run_id),
        expected_total INTEGER NOT NULL CHECK (expected_total >= 0),
        sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1)),
        anchor_fenced INTEGER NOT NULL DEFAULT 0 CHECK (anchor_fenced IN (0, 1)),
        CHECK (anchor_fenced = 0 OR sealed = 1)
      ) STRICT;

      CREATE TABLE signer_staker_api_scan_items (
        run_id TEXT NOT NULL REFERENCES signer_staker_api_scans(run_id),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        staker_principal TEXT NOT NULL,
        has_stx INTEGER NOT NULL CHECK (has_stx IN (0, 1)),
        has_btc INTEGER NOT NULL CHECK (has_btc IN (0, 1)),
        PRIMARY KEY (run_id, staker_principal),
        UNIQUE (run_id, ordinal),
        CHECK (has_stx = 1 OR has_btc = 1)
      ) STRICT;
    `,
  },
  {
    version: 19,
    name: "supersede_revision_1_manager_claims",
    sql: `
      -- The manager-claim adapter moved to revision 2, which claims PoX-5 bond buckets explicitly.
      -- Revision 1 sealed a bond-periods argument revision 2 no longer produces, and its
      -- reconciliation predicate carries a no-bond roster digest that nothing computes any more, so
      -- a stored revision 1 job can never be revalidated, approved or reconciled again.
      --
      -- Retire them here rather than leaving them to fail deep in a revalidation path. Terminal
      -- states are left alone: they are history, and nothing reads their sealed plan to act on it.
      UPDATE transaction_jobs
      SET state = 'superseded',
        supersession_reason = COALESCE(
          supersession_reason,
          'manager-claim adapter revision 1 retired; re-plan against revision 2'
        ),
        state_version = state_version + 1,
        updated_at = COALESCE(updated_at, created_at)
      WHERE adapter_id = 'reference-manager-claim-rewards'
        AND adapter_revision < 2
        AND state NOT IN ('confirmed', 'reconciled', 'superseded', 'ambiguous');
    `,
  },
  {
    version: 20,
    name: "node_verified_bond_membership",
    sql: `
      -- Bond membership was previously inferred entirely from the Stacks API's \`types\` field.
      -- These columns hold what \`get-bond-membership\` returned at the reconciliation anchor, so a
      -- bond participant is explained by the node rather than by an indexer label.
      ALTER TABLE stakers ADD COLUMN bond_node_verified INTEGER
        CHECK (bond_node_verified IN (0, 1));
      ALTER TABLE stakers ADD COLUMN bond_index TEXT;
      ALTER TABLE stakers ADD COLUMN bond_amount_ustx TEXT;
      ALTER TABLE stakers ADD COLUMN bond_amount_sats TEXT;
      ALTER TABLE stakers ADD COLUMN bond_is_l1_lock INTEGER
        CHECK (bond_is_l1_lock IN (0, 1));

      -- Every stored row predates the node read, so no row may claim a verified bond yet. The next
      -- anchored reconciliation fills these in.
      UPDATE stakers SET bond_node_verified = NULL;
    `,
  },
  {
    version: 21,
    name: "browser_wallet_staker_claims",
    sql: `
      -- Widens the wallet-intent action check for operator-signed staker payouts. SQLite cannot
      -- alter a table CHECK, so this rebuilds the pair exactly as migration 17 did.
      DROP INDEX browser_wallet_one_active_scope;
      DROP INDEX browser_wallet_intents_by_scope;
      DROP TRIGGER browser_wallet_intent_immutable_binding;
      DROP TRIGGER browser_wallet_intent_immutable_submission;
      DROP TRIGGER browser_wallet_observation_immutable_update;
      DROP TRIGGER browser_wallet_observation_immutable_delete;

      CREATE TABLE browser_wallet_intents_v21 (
        intent_id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN (
          'deploy-manager', 'register-self', 'add-admin', 'remove-admin',
          'update-fees', 'withdraw-fees', 'sweep-fee-refunds', 'claim-rewards',
          'claim-staker-rewards'
        )),
        scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 500),
        facts_sha256 TEXT NOT NULL CHECK (
          length(facts_sha256) = 64 AND facts_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        manifest_sha256 TEXT NOT NULL CHECK (
          length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        manifest_json TEXT NOT NULL CHECK (
          json_valid(manifest_json) AND length(manifest_json) BETWEEN 2 AND 262144
        ),
        required_sender TEXT NOT NULL CHECK (length(required_sender) BETWEEN 1 AND 500),
        network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet', 'regtest')),
        chain_id INTEGER NOT NULL CHECK (chain_id BETWEEN 0 AND 4294967295),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'submitted', 'mempool', 'confirmed', 'complete',
          'expired', 'superseded', 'failed', 'reobserve'
        )),
        state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
        txid TEXT UNIQUE CHECK (
          txid IS NULL OR (
            length(txid) = 66
            AND substr(txid, 1, 2) = '0x'
            AND substr(txid, 3) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        submitted_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (expires_at > created_at),
        CHECK ((txid IS NULL) = (submitted_at IS NULL)),
        CHECK (
          state NOT IN ('submitted', 'mempool', 'confirmed', 'complete', 'reobserve')
          OR txid IS NOT NULL
        ),
        CHECK (state NOT IN ('prepared', 'expired') OR txid IS NULL)
      ) STRICT;

      INSERT INTO browser_wallet_intents_v21 (
        intent_id, action, scope, facts_sha256, manifest_sha256, manifest_json,
        required_sender, network, chain_id, state, state_version, txid,
        created_at, expires_at, submitted_at, updated_at
      )
      SELECT
        intent_id, action, scope, facts_sha256, manifest_sha256, manifest_json,
        required_sender, network, chain_id, state, state_version, txid,
        created_at, expires_at, submitted_at, updated_at
      FROM browser_wallet_intents;

      CREATE TABLE browser_wallet_intent_observations_v21 (
        observation_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL REFERENCES browser_wallet_intents_v21(intent_id),
        outcome TEXT NOT NULL CHECK (
          length(outcome) BETWEEN 1 AND 100
          AND outcome NOT GLOB '*[^a-z0-9-]*'
        ),
        canonical INTEGER CHECK (canonical IS NULL OR canonical IN (0, 1)),
        block_height INTEGER CHECK (block_height IS NULL OR block_height >= 0),
        index_block_hash TEXT CHECK (
          index_block_hash IS NULL OR (
            length(index_block_hash) = 66
            AND substr(index_block_hash, 1, 2) = '0x'
            AND substr(index_block_hash, 3) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        evidence_json TEXT NOT NULL CHECK (
          json_valid(evidence_json) AND length(evidence_json) BETWEEN 2 AND 32768
        ),
        observed_at TEXT NOT NULL,
        CHECK ((block_height IS NULL) = (index_block_hash IS NULL))
      ) STRICT;

      INSERT INTO browser_wallet_intent_observations_v21 (
        observation_id, intent_id, outcome, canonical, block_height,
        index_block_hash, evidence_json, observed_at
      )
      SELECT
        observation_id, intent_id, outcome, canonical, block_height,
        index_block_hash, evidence_json, observed_at
      FROM browser_wallet_intent_observations;

      DROP TABLE browser_wallet_intent_observations;
      DROP TABLE browser_wallet_intents;
      ALTER TABLE browser_wallet_intents_v21 RENAME TO browser_wallet_intents;
      ALTER TABLE browser_wallet_intent_observations_v21
        RENAME TO browser_wallet_intent_observations;

      CREATE UNIQUE INDEX browser_wallet_one_active_scope
        ON browser_wallet_intents (action, scope)
        WHERE state IN ('prepared', 'submitted', 'mempool', 'confirmed', 'complete', 'reobserve');
      CREATE INDEX browser_wallet_intents_by_scope
        ON browser_wallet_intents (action, scope, created_at DESC, intent_id DESC);

      CREATE TRIGGER browser_wallet_intent_immutable_binding
      BEFORE UPDATE ON browser_wallet_intents
      WHEN NEW.intent_id IS NOT OLD.intent_id
        OR NEW.action IS NOT OLD.action
        OR NEW.scope IS NOT OLD.scope
        OR NEW.facts_sha256 IS NOT OLD.facts_sha256
        OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
        OR NEW.manifest_json IS NOT OLD.manifest_json
        OR NEW.required_sender IS NOT OLD.required_sender
        OR NEW.network IS NOT OLD.network
        OR NEW.chain_id IS NOT OLD.chain_id
        OR NEW.created_at IS NOT OLD.created_at
        OR NEW.expires_at IS NOT OLD.expires_at
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet intent binding is immutable');
      END;

      CREATE TRIGGER browser_wallet_intent_immutable_submission
      BEFORE UPDATE ON browser_wallet_intents
      WHEN (OLD.txid IS NOT NULL AND NEW.txid IS NOT OLD.txid)
        OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS NOT OLD.submitted_at)
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet intent submission is immutable');
      END;

      CREATE TRIGGER browser_wallet_intent_immutable_delete
      BEFORE DELETE ON browser_wallet_intents
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet intent is durable');
      END;

      CREATE INDEX browser_wallet_observations_by_intent
        ON browser_wallet_intent_observations (
          intent_id, observed_at DESC, observation_id DESC
        );

      CREATE TRIGGER browser_wallet_observation_immutable_update
      BEFORE UPDATE ON browser_wallet_intent_observations
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet observation is immutable');
      END;

      CREATE TRIGGER browser_wallet_observation_immutable_delete
      BEFORE DELETE ON browser_wallet_intent_observations
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet observation is immutable');
      END;
    `,
  },
  {
    version: 22,
    name: "durable_deployment_identity",
    sql: `
      -- A Sidekick database belongs to exactly one network and signer-manager. The immutable
      -- binding prevents a configuration change from silently merging unrelated operator history.
      CREATE TABLE deployment_identity (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet', 'regtest')),
        network_id INTEGER NOT NULL CHECK (network_id BETWEEN 0 AND 4294967295),
        parent_network_id INTEGER CHECK (
          parent_network_id IS NULL OR parent_network_id BETWEEN 0 AND 4294967295
        ),
        manager_principal TEXT NOT NULL CHECK (length(manager_principal) BETWEEN 3 AND 500),
        binding_source TEXT NOT NULL CHECK (binding_source IN ('new', 'legacy-evidence')),
        bound_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        last_stacks_tip_height INTEGER NOT NULL CHECK (last_stacks_tip_height >= 0),
        last_burn_block_height INTEGER NOT NULL CHECK (last_burn_block_height >= 0),
        last_pox5_contract_id TEXT NOT NULL CHECK (length(last_pox5_contract_id) BETWEEN 3 AND 500)
      ) STRICT;

      CREATE TRIGGER deployment_identity_immutable_binding
      BEFORE UPDATE ON deployment_identity
      WHEN NEW.singleton_id IS NOT OLD.singleton_id
        OR NEW.schema_version IS NOT OLD.schema_version
        OR NEW.network IS NOT OLD.network
        OR NEW.network_id IS NOT OLD.network_id
        OR NEW.parent_network_id IS NOT OLD.parent_network_id
        OR NEW.manager_principal IS NOT OLD.manager_principal
        OR NEW.binding_source IS NOT OLD.binding_source
        OR NEW.bound_at IS NOT OLD.bound_at
      BEGIN
        SELECT RAISE(ABORT, 'deployment identity binding is immutable');
      END;

      CREATE TRIGGER deployment_identity_immutable_delete
      BEFORE DELETE ON deployment_identity
      BEGIN
        SELECT RAISE(ABORT, 'deployment identity is durable');
      END;
    `,
  },
  {
    version: 23,
    name: "observer_delivery_inbox",
    sql: `
      -- Event-dispatcher callbacks are untrusted prompts until Sidekick independently verifies
      -- their chain claims. Persist the exact bounded JSON body before acknowledging delivery so
      -- node retries cannot be lost across process failure.
      CREATE TABLE observer_deliveries (
        delivery_id TEXT PRIMARY KEY,
        endpoint_kind TEXT NOT NULL CHECK (
          endpoint_kind IN ('new-block', 'new-burn-block', 'attachments')
        ),
        content_sha256 TEXT NOT NULL CHECK (
          length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        raw_payload_json TEXT NOT NULL CHECK (json_valid(raw_payload_json)),
        payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
        state TEXT NOT NULL CHECK (
          state IN ('observer-claimed', 'processing', 'node-verified', 'quarantined', 'expired')
        ),
        state_reason TEXT,
        claimed_block_height INTEGER CHECK (
          claimed_block_height IS NULL OR claimed_block_height >= 0
        ),
        claimed_block_hash TEXT,
        claimed_index_block_hash TEXT,
        claimed_burn_block_height INTEGER CHECK (
          claimed_burn_block_height IS NULL OR claimed_burn_block_height >= 0
        ),
        claimed_burn_block_hash TEXT,
        delivery_attempts INTEGER NOT NULL DEFAULT 1 CHECK (delivery_attempts >= 1),
        processing_attempts INTEGER NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
        first_received_at TEXT NOT NULL,
        last_received_at TEXT NOT NULL,
        last_processing_at TEXT,
        next_attempt_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (endpoint_kind, content_sha256)
      ) STRICT;

      CREATE INDEX observer_deliveries_pending
        ON observer_deliveries (state, next_attempt_at, first_received_at, delivery_id);
      CREATE INDEX observer_deliveries_claimed_stacks_block
        ON observer_deliveries (claimed_index_block_hash, claimed_block_height)
        WHERE claimed_index_block_hash IS NOT NULL;
      CREATE UNIQUE INDEX observer_deliveries_unique_stacks_block
        ON observer_deliveries (
          endpoint_kind, claimed_block_height, claimed_block_hash, claimed_index_block_hash
        )
        WHERE endpoint_kind = 'new-block'
          AND claimed_block_height IS NOT NULL
          AND claimed_block_hash IS NOT NULL
          AND claimed_index_block_hash IS NOT NULL;
      CREATE INDEX observer_deliveries_claimed_burn_block
        ON observer_deliveries (claimed_burn_block_hash, claimed_burn_block_height)
        WHERE claimed_burn_block_hash IS NOT NULL;
      CREATE UNIQUE INDEX observer_deliveries_unique_burn_block
        ON observer_deliveries (
          endpoint_kind, claimed_burn_block_height, claimed_burn_block_hash
        )
        WHERE endpoint_kind = 'new-burn-block'
          AND claimed_burn_block_height IS NOT NULL
          AND claimed_burn_block_hash IS NOT NULL;
    `,
  },
  {
    version: 24,
    name: "observer_payload_retention",
    sql: `
      -- Preserve delivery identity and verification evidence after bounded raw callback JSON is
      -- discarded. A pruned row is terminal, so the inbox worker never needs its body again.
      ALTER TABLE observer_deliveries
        ADD COLUMN payload_pruned INTEGER NOT NULL DEFAULT 0
        CHECK (payload_pruned IN (0, 1));
    `,
  },
  {
    version: 25,
    name: "browser_wallet_reward_calculation",
    sql: `
      -- Widens the durable wallet-intent action check for the reviewed permissionless PoX-5
      -- reward-calculation adapter. SQLite cannot alter a table CHECK, so preserve every row and
      -- immutable trigger while rebuilding the parent and observation tables together.
      DROP INDEX browser_wallet_one_active_scope;
      DROP INDEX browser_wallet_intents_by_scope;
      DROP TRIGGER browser_wallet_intent_immutable_binding;
      DROP TRIGGER browser_wallet_intent_immutable_submission;
      DROP TRIGGER browser_wallet_observation_immutable_update;
      DROP TRIGGER browser_wallet_observation_immutable_delete;

      CREATE TABLE browser_wallet_intents_v25 (
        intent_id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN (
          'deploy-manager', 'register-self', 'add-admin', 'remove-admin',
          'update-fees', 'withdraw-fees', 'sweep-fee-refunds', 'claim-rewards',
          'claim-staker-rewards', 'calculate-rewards'
        )),
        scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 500),
        facts_sha256 TEXT NOT NULL CHECK (
          length(facts_sha256) = 64 AND facts_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        manifest_sha256 TEXT NOT NULL CHECK (
          length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        manifest_json TEXT NOT NULL CHECK (
          json_valid(manifest_json) AND length(manifest_json) BETWEEN 2 AND 262144
        ),
        required_sender TEXT NOT NULL CHECK (length(required_sender) BETWEEN 1 AND 500),
        network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet', 'regtest')),
        chain_id INTEGER NOT NULL CHECK (chain_id BETWEEN 0 AND 4294967295),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'submitted', 'mempool', 'confirmed', 'complete',
          'expired', 'superseded', 'failed', 'reobserve'
        )),
        state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
        txid TEXT UNIQUE CHECK (
          txid IS NULL OR (
            length(txid) = 66
            AND substr(txid, 1, 2) = '0x'
            AND substr(txid, 3) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        submitted_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (expires_at > created_at),
        CHECK ((txid IS NULL) = (submitted_at IS NULL)),
        CHECK (
          state NOT IN ('submitted', 'mempool', 'confirmed', 'complete', 'reobserve')
          OR txid IS NOT NULL
        ),
        CHECK (state NOT IN ('prepared', 'expired') OR txid IS NULL)
      ) STRICT;

      INSERT INTO browser_wallet_intents_v25 (
        intent_id, action, scope, facts_sha256, manifest_sha256, manifest_json,
        required_sender, network, chain_id, state, state_version, txid,
        created_at, expires_at, submitted_at, updated_at
      )
      SELECT
        intent_id, action, scope, facts_sha256, manifest_sha256, manifest_json,
        required_sender, network, chain_id, state, state_version, txid,
        created_at, expires_at, submitted_at, updated_at
      FROM browser_wallet_intents;

      CREATE TABLE browser_wallet_intent_observations_v25 (
        observation_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL REFERENCES browser_wallet_intents_v25(intent_id),
        outcome TEXT NOT NULL CHECK (
          length(outcome) BETWEEN 1 AND 100
          AND outcome NOT GLOB '*[^a-z0-9-]*'
        ),
        canonical INTEGER CHECK (canonical IS NULL OR canonical IN (0, 1)),
        block_height INTEGER CHECK (block_height IS NULL OR block_height >= 0),
        index_block_hash TEXT CHECK (
          index_block_hash IS NULL OR (
            length(index_block_hash) = 66
            AND substr(index_block_hash, 1, 2) = '0x'
            AND substr(index_block_hash, 3) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        evidence_json TEXT NOT NULL CHECK (
          json_valid(evidence_json) AND length(evidence_json) BETWEEN 2 AND 32768
        ),
        observed_at TEXT NOT NULL,
        CHECK ((block_height IS NULL) = (index_block_hash IS NULL))
      ) STRICT;

      INSERT INTO browser_wallet_intent_observations_v25 (
        observation_id, intent_id, outcome, canonical, block_height,
        index_block_hash, evidence_json, observed_at
      )
      SELECT
        observation_id, intent_id, outcome, canonical, block_height,
        index_block_hash, evidence_json, observed_at
      FROM browser_wallet_intent_observations;

      DROP TABLE browser_wallet_intent_observations;
      DROP TABLE browser_wallet_intents;
      ALTER TABLE browser_wallet_intents_v25 RENAME TO browser_wallet_intents;
      ALTER TABLE browser_wallet_intent_observations_v25
        RENAME TO browser_wallet_intent_observations;

      CREATE UNIQUE INDEX browser_wallet_one_active_scope
        ON browser_wallet_intents (action, scope)
        WHERE state IN ('prepared', 'submitted', 'mempool', 'confirmed', 'complete', 'reobserve');
      CREATE INDEX browser_wallet_intents_by_scope
        ON browser_wallet_intents (action, scope, created_at DESC, intent_id DESC);

      CREATE TRIGGER browser_wallet_intent_immutable_binding
      BEFORE UPDATE ON browser_wallet_intents
      WHEN NEW.intent_id IS NOT OLD.intent_id
        OR NEW.action IS NOT OLD.action
        OR NEW.scope IS NOT OLD.scope
        OR NEW.facts_sha256 IS NOT OLD.facts_sha256
        OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
        OR NEW.manifest_json IS NOT OLD.manifest_json
        OR NEW.required_sender IS NOT OLD.required_sender
        OR NEW.network IS NOT OLD.network
        OR NEW.chain_id IS NOT OLD.chain_id
        OR NEW.created_at IS NOT OLD.created_at
        OR NEW.expires_at IS NOT OLD.expires_at
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet intent binding is immutable');
      END;

      CREATE TRIGGER browser_wallet_intent_immutable_submission
      BEFORE UPDATE ON browser_wallet_intents
      WHEN (OLD.txid IS NOT NULL AND NEW.txid IS NOT OLD.txid)
        OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS NOT OLD.submitted_at)
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet intent submission is immutable');
      END;

      CREATE TRIGGER browser_wallet_intent_immutable_delete
      BEFORE DELETE ON browser_wallet_intents
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet intent is durable');
      END;

      CREATE INDEX browser_wallet_observations_by_intent
        ON browser_wallet_intent_observations (
          intent_id, observed_at DESC, observation_id DESC
        );

      CREATE TRIGGER browser_wallet_observation_immutable_update
      BEFORE UPDATE ON browser_wallet_intent_observations
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet observation is immutable');
      END;

      CREATE TRIGGER browser_wallet_observation_immutable_delete
      BEFORE DELETE ON browser_wallet_intent_observations
      BEGIN
        SELECT RAISE(ABORT, 'browser wallet observation is immutable');
      END;
    `,
  },
  {
    version: 26,
    name: "reward_outlook_observations",
    sql: `
      -- The cycle ledger remains the latest manager settlement snapshot. Reward outlook needs a
      -- separate burn-block series so projections can be derived from exact anchored PoX-5
      -- accrual observations and later compared with realized calculations.
      CREATE TABLE reward_outlook_observations (
        manager_principal TEXT NOT NULL,
        pox5_contract_id TEXT NOT NULL,
        observed_burn_block_height INTEGER NOT NULL CHECK (observed_burn_block_height >= 0),
        observed_stacks_tip_height INTEGER NOT NULL CHECK (observed_stacks_tip_height >= 0),
        observed_index_block_hash TEXT NOT NULL CHECK (
          length(observed_index_block_hash) = 66
          AND substr(observed_index_block_hash, 1, 2) = '0x'
          AND substr(observed_index_block_hash, 3) NOT GLOB '*[^0-9a-f]*'
        ),
        chain_anchor_json TEXT NOT NULL CHECK (json_valid(chain_anchor_json)),
        global_accrued_rewards_sats TEXT NOT NULL CHECK (
          length(global_accrued_rewards_sats) >= 1
          AND global_accrued_rewards_sats NOT GLOB '*[^0-9]*'
        ),
        calculation_state TEXT NOT NULL CHECK (
          calculation_state IN ('pending', 'completed', 'ahead', 'unknown')
        ),
        last_reward_compute_burn_height TEXT NOT NULL CHECK (
          length(last_reward_compute_burn_height) >= 1
          AND last_reward_compute_burn_height NOT GLOB '*[^0-9]*'
        ),
        next_target_reward_cycle INTEGER CHECK (
          next_target_reward_cycle IS NULL OR next_target_reward_cycle >= 0
        ),
        next_target_checkpoint TEXT CHECK (
          next_target_checkpoint IS NULL OR next_target_checkpoint IN ('first-half', 'second-half')
        ),
        next_calculation_burn_height INTEGER CHECK (
          next_calculation_burn_height IS NULL OR next_calculation_burn_height >= 0
        ),
        next_eligible_burn_height INTEGER CHECK (
          next_eligible_burn_height IS NULL OR next_eligible_burn_height >= 0
        ),
        next_blocks_remaining INTEGER CHECK (
          next_blocks_remaining IS NULL OR next_blocks_remaining >= 0
        ),
        next_state TEXT CHECK (next_state IS NULL OR next_state IN ('due', 'scheduled')),
        observed_at TEXT NOT NULL,
        -- A permissionless calculation can complete in a Stacks block after an earlier sample in
        -- the same Bitcoin block. Keep both sides of that boundary while coalescing ordinary
        -- same-burn refreshes for the same last-compute state.
        PRIMARY KEY (
          manager_principal, pox5_contract_id, observed_burn_block_height,
          last_reward_compute_burn_height
        ),
        CHECK (
          (next_target_reward_cycle IS NULL
            AND next_target_checkpoint IS NULL
            AND next_calculation_burn_height IS NULL
            AND next_eligible_burn_height IS NULL
            AND next_blocks_remaining IS NULL
            AND next_state IS NULL)
          OR
          (next_target_reward_cycle IS NOT NULL
            AND next_target_checkpoint IS NOT NULL
            AND next_calculation_burn_height IS NOT NULL
            AND next_eligible_burn_height IS NOT NULL
            AND next_blocks_remaining IS NOT NULL
            AND next_state IS NOT NULL)
        )
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX reward_outlook_observations_history
        ON reward_outlook_observations (
          manager_principal, pox5_contract_id, observed_burn_block_height DESC,
          last_reward_compute_burn_height DESC
        );
    `,
  },
  {
    version: 27,
    name: "reward_outlook_pool_estimates",
    sql: `
      -- Preserve the contract-exact current-share simulation and its anchored inputs with each
      -- accrual sample so later checkpoint forecasts can be calibrated against realized results.
      ALTER TABLE reward_outlook_observations ADD COLUMN pool_estimate_json TEXT
        CHECK (pool_estimate_json IS NULL OR json_valid(pool_estimate_json));
      ALTER TABLE reward_outlook_observations ADD COLUMN pool_estimate_unavailable_reason TEXT
        CHECK (
          pool_estimate_unavailable_reason IS NULL OR pool_estimate_unavailable_reason IN (
            'chain-anchor-unavailable', 'calculation-target-unavailable',
            'incomplete-active-bond-state', 'anchored-inputs-unavailable',
            'contract-simulation-failed'
          )
        );
    `,
  },
  {
    version: 28,
    name: "reward_outlook_run_rate_forecasts",
    sql: `
      -- Forecasts remain distinct from the exact current-share simulation. Persist the range and
      -- omission reason at each anchor so later realized calculations can calibrate the model.
      ALTER TABLE reward_outlook_observations ADD COLUMN forecast_json TEXT
        CHECK (forecast_json IS NULL OR json_valid(forecast_json));
      ALTER TABLE reward_outlook_observations ADD COLUMN forecast_unavailable_reason TEXT
        CHECK (
          forecast_unavailable_reason IS NULL OR forecast_unavailable_reason IN (
            'chain-anchor-unavailable', 'calculation-target-unavailable',
            'current-pool-estimate-unavailable', 'insufficient-samples',
            'non-monotonic-accrual', 'forecast-inputs-unavailable',
            'contract-simulation-failed'
          )
        );

      CREATE INDEX reward_outlook_forecast_samples
        ON reward_outlook_observations (
          manager_principal, pox5_contract_id, last_reward_compute_burn_height,
          next_target_reward_cycle, next_target_checkpoint, next_calculation_burn_height,
          observed_burn_block_height DESC
        );
    `,
  },
  {
    version: 29,
    name: "reward_calculation_realizations",
    sql: `
      -- Model revisions make calibration windows reproducible. Existing forecasts predate the
      -- first explicit revision and intentionally remain ineligible for calibration.
      ALTER TABLE reward_outlook_observations ADD COLUMN forecast_model_revision INTEGER
        CHECK (forecast_model_revision IS NULL OR forecast_model_revision > 0);

      -- One canonical PoX-5 calculate-rewards print closes a forecast. The event is discovered
      -- through the indexer, its transaction inclusion is independently proven by the local node,
      -- and manager allocation is replayed from node reads at the transaction's parent anchor.
      CREATE TABLE reward_calculation_realizations (
        chain_id INTEGER NOT NULL CHECK (chain_id >= 0),
        tx_id TEXT NOT NULL CHECK (
          length(tx_id) = 66
          AND substr(tx_id, 1, 2) = '0x'
          AND substr(tx_id, 3) NOT GLOB '*[^0-9a-f]*'
        ),
        event_index INTEGER NOT NULL CHECK (event_index >= 0),
        source_id TEXT NOT NULL REFERENCES chain_sources(source_id),
        manager_principal TEXT NOT NULL,
        pox5_contract_id TEXT NOT NULL,
        canonical INTEGER NOT NULL CHECK (canonical IN (0, 1)),
        block_height INTEGER NOT NULL CHECK (block_height >= 0),
        index_block_hash TEXT NOT NULL CHECK (
          length(index_block_hash) = 66
          AND substr(index_block_hash, 1, 2) = '0x'
          AND substr(index_block_hash, 3) NOT GLOB '*[^0-9a-f]*'
        ),
        burn_block_height INTEGER NOT NULL CHECK (burn_block_height >= 0),
        target_reward_cycle INTEGER NOT NULL CHECK (target_reward_cycle >= 0),
        target_checkpoint TEXT NOT NULL CHECK (
          target_checkpoint IN ('first-half', 'second-half')
        ),
        calculation_burn_height INTEGER NOT NULL CHECK (calculation_burn_height >= 0),
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        pool_estimate_json TEXT CHECK (pool_estimate_json IS NULL OR json_valid(pool_estimate_json)),
        pool_estimate_unavailable_reason TEXT CHECK (
          pool_estimate_unavailable_reason IS NULL OR pool_estimate_unavailable_reason IN (
            'historical-anchor-unavailable', 'same-block-state-ambiguous',
            'anchored-inputs-unavailable', 'contract-simulation-failed'
          )
        ),
        model_revision INTEGER NOT NULL CHECK (model_revision > 0),
        evaluation_json TEXT CHECK (evaluation_json IS NULL OR json_valid(evaluation_json)),
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chain_id, tx_id, event_index),
        CHECK (
          (pool_estimate_json IS NULL) <> (pool_estimate_unavailable_reason IS NULL)
        )
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX reward_calculation_realizations_manager_history
        ON reward_calculation_realizations (
          manager_principal, pox5_contract_id, canonical,
          calculation_burn_height DESC, block_height DESC
        );
      CREATE INDEX reward_calculation_realizations_contract_height
        ON reward_calculation_realizations (
          pox5_contract_id, canonical, block_height DESC, event_index DESC
        );
    `,
  },
  {
    version: 30,
    name: "durable_signer_health_evidence",
    sql: `
      -- Five-second local evidence is retained for short-horizon diagnosis. Five-minute rollups
      -- preserve longer trends without allowing raw monitoring samples to grow without bound.
      CREATE TABLE health_observations (
        config_fingerprint TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
        PRIMARY KEY (config_fingerprint, observed_at)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX health_observations_recent
        ON health_observations (config_fingerprint, observed_at DESC);

      CREATE TABLE health_rollups (
        config_fingerprint TEXT NOT NULL,
        window_started_at TEXT NOT NULL,
        window_ended_at TEXT NOT NULL,
        rollup_json TEXT NOT NULL CHECK (json_valid(rollup_json)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (config_fingerprint, window_started_at)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX health_rollups_recent
        ON health_rollups (config_fingerprint, window_started_at DESC);

      -- Findings are episode-oriented: a sustained condition opens one durable record, subsequent
      -- observations update its evidence, and recovery resolves it without deleting the history.
      CREATE TABLE health_finding_episodes (
        episode_id TEXT PRIMARY KEY,
        config_fingerprint TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
        finding_json TEXT NOT NULL CHECK (json_valid(finding_json)),
        opened_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        resolved_at TEXT,
        occurrences INTEGER NOT NULL CHECK (occurrences > 0),
        updated_at TEXT NOT NULL,
        CHECK (
          (status = 'active' AND resolved_at IS NULL)
          OR (status = 'resolved' AND resolved_at IS NOT NULL)
        )
      ) STRICT;

      CREATE UNIQUE INDEX health_finding_one_active_episode
        ON health_finding_episodes (config_fingerprint, finding_id)
        WHERE status = 'active';
      CREATE INDEX health_finding_episode_history
        ON health_finding_episodes (config_fingerprint, opened_at DESC, episode_id DESC);
    `,
  },
  {
    version: 31,
    name: "local_node_authority",
    sql: `
      -- Current-state projections must not silently become authoritative while a fresh or
      -- recovering local node is still catching up. Keep the last proven-current height so a
      -- transient or restarted process cannot erase that safety boundary.
      CREATE TABLE local_node_authority (
        manager_principal TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        status TEXT NOT NULL CHECK (status IN ('current', 'catching-up', 'unknown')),
        observed_at TEXT NOT NULL,
        stacks_tip_height INTEGER NOT NULL CHECK (stacks_tip_height >= 0),
        highest_proven_current_stacks_tip_height INTEGER CHECK (
          highest_proven_current_stacks_tip_height IS NULL
          OR highest_proven_current_stacks_tip_height >= 0
        ),
        consecutive_current_observations INTEGER NOT NULL CHECK (
          consecutive_current_observations >= 0
        ),
        reason TEXT NOT NULL CHECK (length(reason) > 0)
      ) STRICT, WITHOUT ROWID;
    `,
  },
  {
    version: 32,
    name: "current_member_history_recovery",
    sql: `
      -- Evidence strength is part of each imported event rather than an inference from whichever
      -- source happens to be configured later.
      ALTER TABLE chain_events ADD COLUMN evidence_level TEXT NOT NULL
        DEFAULT 'indexer-reported'
        CHECK (evidence_level IN (
          'node-index-verified', 'canonical-block-correlated', 'indexer-reported'
        ));

      ALTER TABLE reward_calculation_realizations ADD COLUMN evidence_level TEXT NOT NULL
        DEFAULT 'indexer-reported'
        CHECK (evidence_level IN (
          'node-index-verified', 'canonical-block-correlated', 'indexer-reported'
        ));

      -- Fresh installs backfill only principals in the authoritative current roster. Progress is
      -- per member so work remains restart-safe, bounded, and fair across long-lived wallets.
      CREATE TABLE current_member_history_recovery (
        source_id TEXT NOT NULL REFERENCES chain_sources(source_id),
        manager_principal TEXT NOT NULL,
        pox5_contract_id TEXT NOT NULL,
        staker_principal TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
        cursor TEXT,
        pages_processed INTEGER NOT NULL DEFAULT 0 CHECK (pages_processed >= 0),
        transactions_inspected INTEGER NOT NULL DEFAULT 0 CHECK (transactions_inspected >= 0),
        relevant_events INTEGER NOT NULL DEFAULT 0 CHECK (relevant_events >= 0),
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (source_id, manager_principal, pox5_contract_id, staker_principal),
        CHECK (
          (status = 'pending' AND completed_at IS NULL)
          OR (status = 'complete' AND cursor IS NULL AND completed_at IS NOT NULL)
        )
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX current_member_history_recovery_fair_queue
        ON current_member_history_recovery (
          source_id, manager_principal, pox5_contract_id, status, updated_at, staker_principal
        );
    `,
  },
  {
    version: 33,
    name: "chain_event_occurrence_time",
    sql: `
      -- Discovery time answers when Sidekick learned about an event; occurrence time answers when
      -- the event actually happened. Keep both so a fresh install does not make historical pool
      -- activity look new merely because it was just backfilled.
      ALTER TABLE chain_events ADD COLUMN occurred_at TEXT;

      -- Migration 32 already bounds historical recovery to current pool members. Requeue only
      -- completed members whose imported events predate occurrence-time capture, allowing the
      -- ordinary fair anti-entropy loop to enrich them without a global contract-history scan.
      UPDATE current_member_history_recovery
      SET status = 'pending', cursor = NULL, pages_processed = 0,
          transactions_inspected = 0, relevant_events = 0,
          updated_at = discovered_at, completed_at = NULL
      WHERE status = 'complete'
        AND EXISTS (
          SELECT 1
          FROM chain_events
          WHERE chain_events.contract_id = current_member_history_recovery.pox5_contract_id
            AND chain_events.occurred_at IS NULL
            AND chain_events.decoded_payload_json IS NOT NULL
            AND json_extract(
              chain_events.decoded_payload_json,
              '$.event.stakerPrincipal'
            ) = current_member_history_recovery.staker_principal
        );
    `,
  },
  {
    version: 34,
    name: "source_scoped_api_credentials",
    sql: `
      -- API credentials belong to a specific outbound source. Keeping them outside the public
      -- settings document prevents accidental disclosure and lets future sources add credentials
      -- without adding another secret column to the singleton settings row.
      CREATE TABLE runtime_api_credentials (
        source TEXT PRIMARY KEY CHECK (source IN ('indexed-api', 'reference-api')),
        secret TEXT NOT NULL CHECK (length(secret) BETWEEN 1 AND 2000),
        bound_url TEXT NOT NULL CHECK (length(bound_url) BETWEEN 1 AND 500),
        updated_at TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;

      -- Preserve the pre-v34 indexed API credential. The legacy column remains only because
      -- SQLite cannot drop it without rebuilding the settings table; new writes clear it.
      INSERT INTO runtime_api_credentials (source, secret, bound_url, updated_at)
      SELECT 'indexed-api', api_key_secret,
        json_extract(settings_json, '$.dataSources.apiUrl'), updated_at
      FROM runtime_settings
      WHERE singleton_id = 1 AND api_key_secret IS NOT NULL;

      UPDATE runtime_settings SET api_key_secret = NULL WHERE singleton_id = 1;
    `,
  },
  {
    version: 35,
    name: "gas_wallet",
    sql: `
      -- The operator-run gas wallet (ADR 0010): one dedicated STX key per deployment, generated by
      -- Sidekick or pointed at an operator-provided secret file. Only the public identity and the
      -- secret *path* are stored; key material never enters the database.
      CREATE TABLE gas_wallet (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
        public_key TEXT NOT NULL CHECK (length(public_key) = 66),
        secret_file_path TEXT NOT NULL CHECK (length(secret_file_path) BETWEEN 1 AND 4096),
        source TEXT NOT NULL CHECK (source IN ('generated', 'configured')),
        created_at TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        enabled_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE gas_wallet_banners (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        setup_dismissed_at TEXT,
        low_balance_dismissed_until TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 36,
    name: "gas_wallet_sweeps",
    sql: `
      -- Sealed gas-wallet sweeps (plan §7.6): one STX transfer of balance - fee to an operator-entered
      -- address, approved per run. The sealed plan JSON is the exact material the signer revalidates.
      CREATE TABLE gas_wallet_sweeps (
        sweep_id TEXT PRIMARY KEY CHECK (length(sweep_id) = 36),
        status TEXT NOT NULL CHECK (status IN ('planned', 'broadcast', 'confirmed', 'failed', 'cancelled', 'expired')),
        wallet_principal TEXT NOT NULL,
        recipient TEXT NOT NULL,
        amount_ustx TEXT NOT NULL,
        fee_ustx TEXT NOT NULL,
        nonce TEXT NOT NULL,
        balance_ustx TEXT NOT NULL,
        plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
        plan_json TEXT NOT NULL,
        txid TEXT CHECK (txid IS NULL OR length(txid) = 66),
        broadcast_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (broadcast_ambiguous IN (0, 1)),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        broadcast_at TEXT,
        resolved_at TEXT,
        block_height INTEGER,
        failure_reason TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX gas_wallet_sweeps_created_idx ON gas_wallet_sweeps (created_at DESC);
    `,
  },
  {
    version: 37,
    name: "operator_reward_runs",
    sql: `
      -- A single durable lease enforces the one-active-authorization invariant across both reward
      -- runs and gas-wallet sweeps. The row is acquired and released in the same SQLite
      -- transaction as the owning record's state transition.
      CREATE TABLE gas_wallet_authorizations (
        wallet_principal TEXT PRIMARY KEY,
        authorization_kind TEXT NOT NULL CHECK (authorization_kind IN ('reward-run', 'sweep')),
        authorization_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;

      CREATE UNIQUE INDEX gas_wallet_authorization_owner
        ON gas_wallet_authorizations (authorization_kind, authorization_id);

      CREATE TABLE transaction_runs (
        run_id TEXT PRIMARY KEY CHECK (length(run_id) = 36),
        status TEXT NOT NULL CHECK (status IN (
          'awaiting-approval', 'approved', 'running', 'paused',
          'completed', 'halted', 'cancelled', 'expired'
        )),
        authorization_schema_version INTEGER NOT NULL CHECK (authorization_schema_version = 2),
        wallet_principal TEXT NOT NULL,
        manager_principal TEXT NOT NULL,
        network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet')),
        reward_cycle INTEGER NOT NULL CHECK (reward_cycle >= 0),
        distribution INTEGER NOT NULL CHECK (distribution IN (1, 2)),
        recipe_sha256 TEXT NOT NULL CHECK (length(recipe_sha256) = 64),
        recipe_json TEXT NOT NULL CHECK (json_valid(recipe_json)),
        cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
        gas_spent_ustx TEXT NOT NULL DEFAULT '0',
        approval_expires_at TEXT NOT NULL,
        runtime_expires_at TEXT,
        approved_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (status IN ('approved', 'running', 'paused', 'completed', 'halted') AND approved_at IS NOT NULL)
          OR (status NOT IN ('approved', 'running', 'paused', 'completed', 'halted'))
        ),
        CHECK (
          (status IN ('running', 'paused', 'completed', 'halted') AND started_at IS NOT NULL AND runtime_expires_at IS NOT NULL)
          OR (status NOT IN ('running', 'paused', 'completed', 'halted'))
        )
      ) STRICT;

      CREATE INDEX transaction_runs_created ON transaction_runs (created_at DESC, run_id DESC);
      CREATE INDEX transaction_runs_active ON transaction_runs (wallet_principal, status);

      CREATE TABLE transaction_run_children (
        run_id TEXT NOT NULL REFERENCES transaction_runs(run_id) ON DELETE CASCADE,
        child_index INTEGER NOT NULL CHECK (child_index >= 0),
        operation_kind TEXT NOT NULL CHECK (operation_kind IN (
          'calculate-rewards', 'claim-rewards', 'claim-staker-rewards',
          'settle-accepted-withdrawal', 'reclaim-failed-withdrawal'
        )),
        adapter_id TEXT NOT NULL,
        adapter_revision INTEGER NOT NULL CHECK (adapter_revision > 0),
        account_key TEXT,
        maximum_amount_sats TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'materialized', 'broadcast', 'confirmed',
          'externally-completed', 'skipped', 'halted'
        )),
        materialized_amount_sats TEXT,
        plan_sha256 TEXT,
        plan_json TEXT CHECK (plan_json IS NULL OR json_valid(plan_json)),
        txid TEXT CHECK (txid IS NULL OR length(txid) = 66),
        provenance TEXT CHECK (
          provenance IS NULL OR provenance IN ('you', 'another-caller', 'policy-exception')
        ),
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, child_index),
        CHECK ((plan_json IS NULL) = (plan_sha256 IS NULL)),
        CHECK (
          (operation_kind = 'claim-staker-rewards'
            AND account_key IS NOT NULL AND maximum_amount_sats IS NOT NULL)
          OR (operation_kind <> 'claim-staker-rewards' AND account_key IS NULL)
        ),
        CHECK (
          (operation_kind IN ('claim-rewards', 'claim-staker-rewards', 'reclaim-failed-withdrawal')
            AND maximum_amount_sats IS NOT NULL)
          OR (operation_kind IN ('calculate-rewards', 'settle-accepted-withdrawal')
            AND maximum_amount_sats IS NULL)
        )
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX transaction_run_children_state
        ON transaction_run_children (run_id, status, child_index);

      CREATE TABLE transaction_run_attempts (
        run_id TEXT NOT NULL,
        child_index INTEGER NOT NULL,
        attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
        precomputed_txid TEXT NOT NULL CHECK (length(precomputed_txid) = 66),
        nonce TEXT NOT NULL,
        fee_ustx TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('signed', 'accepted', 'ambiguous', 'rejected', 'confirmed')),
        broadcast_result_json TEXT CHECK (
          broadcast_result_json IS NULL OR json_valid(broadcast_result_json)
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, child_index, attempt_index),
        FOREIGN KEY (run_id, child_index)
          REFERENCES transaction_run_children(run_id, child_index) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;

      CREATE UNIQUE INDEX transaction_run_attempt_txid
        ON transaction_run_attempts (precomputed_txid);

      -- Existing nonterminal sweeps predate the shared lease. Preserve the newest one as the
      -- exclusive owner; S2 already treats older concurrent rows as an invariant violation.
      INSERT INTO gas_wallet_authorizations (
        wallet_principal, authorization_kind, authorization_id, acquired_at, updated_at
      )
      SELECT wallet_principal, 'sweep', sweep_id, created_at, updated_at
      FROM gas_wallet_sweeps
      WHERE status IN ('planned', 'broadcast')
      ORDER BY created_at DESC
      LIMIT 1;
    `,
  },
  {
    version: 38,
    name: "durable_reward_run_preparations",
    sql: `
      -- Recipe discovery can require hundreds of anchored read-only calls for a large pool. Keep it
      -- outside the HTTP request lifetime and recover interrupted work after a Sidekick restart.
      CREATE TABLE reward_run_preparations (
        preparation_id TEXT PRIMARY KEY CHECK (length(preparation_id) = 36),
        status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'ready', 'failed')),
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        run_id TEXT REFERENCES transaction_runs(run_id),
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK ((status = 'ready') = (run_id IS NOT NULL)),
        CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
        CHECK ((status IN ('ready', 'failed')) = (completed_at IS NOT NULL))
      ) STRICT;

      CREATE UNIQUE INDEX reward_run_preparations_active_request
        ON reward_run_preparations (request_sha256)
        WHERE status IN ('queued', 'preparing');
      CREATE INDEX reward_run_preparations_created
        ON reward_run_preparations (created_at DESC, preparation_id DESC);
    `,
  },
  {
    version: 39,
    name: "sbtc_withdrawal_completion_evidence",
    sql: `
      -- The manager payout transaction proves an L1 withdrawal request, not the later Bitcoin
      -- payment. Persist the registry's node-readable completion proof separately.
      CREATE TABLE sbtc_withdrawal_completions (
        chain_id INTEGER NOT NULL CHECK (chain_id >= 0),
        registry_contract TEXT NOT NULL,
        request_id TEXT NOT NULL,
        sweep_txid TEXT NOT NULL CHECK (length(sweep_txid) = 66),
        bitcoin_block_height INTEGER NOT NULL CHECK (bitcoin_block_height >= 0),
        bitcoin_block_hash TEXT NOT NULL CHECK (length(bitcoin_block_hash) = 66),
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chain_id, registry_contract, request_id)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX sbtc_withdrawal_completions_sweep_tx
        ON sbtc_withdrawal_completions (sweep_txid);
    `,
  },
];
