import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SidekickNetwork } from "../config.js";

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

export const chainCursorInputSchema = z
  .object({
    sourceId: z.string().min(1),
    stream: z.string().min(1),
    cursor: z.string().nullable(),
    lastBlockHeight: z.number().int().nonnegative().nullable(),
    lastIndexBlockHash: z.string().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const cursorRowSchema = z.object({
  source_id: z.string(),
  stream: z.string(),
  cursor: z.string().nullable(),
  last_block_height: z.number().int().nonnegative().nullable(),
  last_index_block_hash: z.string().nullable(),
  updated_at: z.string(),
});

export type ChainSourceInput = z.infer<typeof sourceInputSchema>;
export type ChainCursorInput = z.infer<typeof chainCursorInputSchema>;

export interface ChainCursor {
  sourceId: string;
  stream: string;
  cursor: string | null;
  lastBlockHeight: number | null;
  lastIndexBlockHash: string | null;
  updatedAt: string;
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

/** Persistence boundary for immutable chain-source identities and stream cursors. */
export class ChainStateRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsertSource(input: ChainSourceInput): void {
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
    const value = chainCursorInputSchema.parse(input);
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
}
