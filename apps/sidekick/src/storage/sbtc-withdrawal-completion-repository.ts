import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const hashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const unsignedIntegerTextSchema = z.string().regex(/^\d+$/);
const contractPrincipalSchema = z.string().min(1);

const completionInputSchema = z
  .object({
    chainId: z.number().int().nonnegative(),
    registryContract: contractPrincipalSchema,
    requestId: unsignedIntegerTextSchema,
    sweepTxId: hashSchema,
    bitcoinBlockHeight: z.number().int().nonnegative(),
    bitcoinBlockHash: hashSchema,
    observedAt: z.iso.datetime(),
  })
  .strict();

export type SbtcWithdrawalCompletionInput = z.infer<typeof completionInputSchema>;
export interface StoredSbtcWithdrawalCompletion extends SbtcWithdrawalCompletionInput {
  updatedAt: string;
}

const completionRowSchema = z.object({
  chain_id: z.number().int().nonnegative(),
  registry_contract: contractPrincipalSchema,
  request_id: unsignedIntegerTextSchema,
  sweep_txid: hashSchema,
  bitcoin_block_height: z.number().int().nonnegative(),
  bitcoin_block_hash: hashSchema,
  observed_at: z.string(),
  updated_at: z.string(),
});

const columns = `chain_id, registry_contract, request_id, sweep_txid, bitcoin_block_height,
  bitcoin_block_hash, observed_at, updated_at`;

/** Durable node-first proof for an accepted sBTC withdrawal, enriched by its canonical print event. */
export class SbtcWithdrawalCompletionRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(
    chainId: number,
    registryContract: string,
    requestId: string,
  ): StoredSbtcWithdrawalCompletion | null {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM sbtc_withdrawal_completions
         WHERE chain_id = ? AND registry_contract = ? AND request_id = ?`,
      )
      .get(
        z.number().int().nonnegative().parse(chainId),
        contractPrincipalSchema.parse(registryContract),
        unsignedIntegerTextSchema.parse(requestId),
      );
    if (row === undefined) return null;
    const value = completionRowSchema.parse(row);
    return {
      chainId: value.chain_id,
      registryContract: value.registry_contract,
      requestId: value.request_id,
      sweepTxId: value.sweep_txid,
      bitcoinBlockHeight: value.bitcoin_block_height,
      bitcoinBlockHash: value.bitcoin_block_hash,
      observedAt: value.observed_at,
      updatedAt: value.updated_at,
    };
  }

  upsert(input: SbtcWithdrawalCompletionInput): StoredSbtcWithdrawalCompletion {
    const value = completionInputSchema.parse(input);
    const existing = this.get(value.chainId, value.registryContract, value.requestId);
    if (
      existing &&
      (existing.sweepTxId !== value.sweepTxId ||
        existing.bitcoinBlockHeight !== value.bitcoinBlockHeight ||
        existing.bitcoinBlockHash !== value.bitcoinBlockHash)
    ) {
      throw new Error(`sBTC withdrawal ${value.requestId} completion evidence changed`);
    }
    this.db
      .prepare(
        `INSERT INTO sbtc_withdrawal_completions (${columns})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (chain_id, registry_contract, request_id) DO UPDATE SET
           observed_at = excluded.observed_at,
           updated_at = excluded.observed_at`,
      )
      .run(
        value.chainId,
        value.registryContract,
        value.requestId,
        value.sweepTxId,
        value.bitcoinBlockHeight,
        value.bitcoinBlockHash,
        value.observedAt,
        value.observedAt,
      );
    return this.get(
      value.chainId,
      value.registryContract,
      value.requestId,
    ) as StoredSbtcWithdrawalCompletion;
  }
}
