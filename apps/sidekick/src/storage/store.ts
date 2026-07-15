import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
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
}
