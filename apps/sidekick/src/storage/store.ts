import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
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
  position_active: z.union([z.literal(0), z.literal(1)]).nullable(),
});

const cycleMembershipRowSchema = z.object({
  staker_principal: z.string(),
  reward_cycle: z.string(),
  signer_principal: z.string(),
  amount_ustx: z.string(),
  active: z.union([z.literal(0), z.literal(1)]),
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

  markIndexBlockNonCanonical(chainId: number, indexBlockHash: string, updatedAt: string): number {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const parsedIndexBlockHash = hashSchema.parse(indexBlockHash);
    const parsedUpdatedAt = z.iso.datetime().parse(updatedAt);
    const result = this.db
      .prepare(
        `UPDATE chain_events SET canonical = 0, updated_at = ?
         WHERE chain_id = ? AND index_block_hash = ? AND canonical = 1`,
      )
      .run(parsedUpdatedAt, parsedChainId, parsedIndexBlockHash);
    return Number(result.changes);
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
        first_reward_cycle, num_cycles, unlock_cycle, active, discovery_source_id,
        verification_source_id, last_seen_run_id, observed_burn_block_height,
        observed_stacks_tip_height, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (manager_principal, staker_principal) DO UPDATE SET
        signer_principal = excluded.signer_principal,
        amount_ustx = excluded.amount_ustx,
        first_reward_cycle = excluded.first_reward_cycle,
        num_cycles = excluded.num_cycles,
        unlock_cycle = excluded.unlock_cycle,
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

        if (!item.position) continue;
        const position = item.position;
        const unlockCycle = position.firstRewardCycle + position.numCycles;
        upsertPosition.run(
          value.managerPrincipal,
          item.stakerPrincipal,
          position.signerPrincipal,
          position.amountUstx.toString(),
          position.firstRewardCycle.toString(),
          position.numCycles.toString(),
          unlockCycle.toString(),
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

  listSignerStakers(managerPrincipal: string, activeOnly = true): StoredSignerStaker[] {
    const manager = principalSchema.parse(managerPrincipal);
    const rows = this.db
      .prepare(
        `SELECT s.manager_principal, s.staker_principal, s.has_stx, s.has_btc,
          s.stx_node_verified, s.active, s.source_id, s.last_seen_run_id,
          s.verification_source_id, s.first_seen_at, s.last_seen_at,
          p.signer_principal, p.amount_ustx,
          p.first_reward_cycle, p.num_cycles, p.unlock_cycle, p.active AS position_active
         FROM stakers s
         LEFT JOIN stake_positions p
           ON p.manager_principal = s.manager_principal
          AND p.staker_principal = s.staker_principal
         WHERE s.manager_principal = ? AND (? = 0 OR s.active = 1)
         ORDER BY s.staker_principal`,
      )
      .all(manager, activeOnly ? 1 : 0);
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
                active: value.position_active === 1,
              },
      };
    });
  }

  listCycleMemberships(managerPrincipal: string, activeOnly = true): StoredCycleMembership[] {
    const manager = principalSchema.parse(managerPrincipal);
    const rows = this.db
      .prepare(
        `SELECT staker_principal, reward_cycle, signer_principal, amount_ustx, active
         FROM cycle_memberships
         WHERE manager_principal = ? AND (? = 0 OR active = 1)
         ORDER BY length(reward_cycle), reward_cycle, staker_principal`,
      )
      .all(manager, activeOnly ? 1 : 0);
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
}
