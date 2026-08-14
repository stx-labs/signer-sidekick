import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { validatePrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";

const walletIntentActions = [
  "deploy-manager",
  "register-self",
  "add-admin",
  "remove-admin",
  "update-fees",
  "withdraw-fees",
  "sweep-fee-refunds",
  "claim-rewards",
  "claim-staker-rewards",
  "calculate-rewards",
] as const;
export type WalletIntentAction = (typeof walletIntentActions)[number];

export const walletIntentStates = [
  "prepared",
  "submitted",
  "mempool",
  "confirmed",
  "complete",
  "expired",
  "superseded",
  "failed",
  "reobserve",
] as const;
export type WalletIntentState = (typeof walletIntentStates)[number];

const uuidSchema = z.string().uuid();
const identifierSchema = z.string().min(1).max(500);
const instantSchema = z.iso.datetime().transform((value) => new Date(value).toISOString());
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const txidSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const sqliteBatchSize = 400;
const networkSchema = z.enum(["mainnet", "testnet", "devnet", "regtest"]);
const principalSchema = z.string().max(500).refine(validatePrincipal, "Invalid Stacks principal");
const outcomeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export type WalletIntentRepositoryErrorCode =
  | "not-found"
  | "expired"
  | "superseded"
  | "already-submitted"
  | "duplicate-txid"
  | "active-intent-conflict"
  | "state-conflict"
  | "manifest-sha256-mismatch"
  | "observation-conflict"
  | "observation-evidence-rejected";

export class WalletIntentRepositoryError extends Error {
  constructor(
    readonly code: WalletIntentRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WalletIntentRepositoryError";
  }
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 50) throw new TypeError("Canonical JSON exceeds the maximum nesting depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts only plain objects and arrays");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`)
      .join(",")}}`;
  }
  throw new TypeError(
    "Canonical JSON cannot contain undefined, bigint, symbol, or function values",
  );
}

function canonicalDocument(value: unknown, field: string, maximumBytes: number): string {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${field} must be a JSON object`);
  }
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) {
    throw new TypeError(`${field} exceeds ${maximumBytes} bytes`);
  }
  return encoded;
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function parseCanonicalObject(value: string, field: string, maximumBytes: number): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Persisted ${field} is not valid JSON`, { cause: error });
  }
  const canonical = canonicalDocument(parsed, field, maximumBytes);
  if (canonical !== value) throw new Error(`Persisted ${field} is not canonical JSON`);
  return parsed;
}

function assertNoRawTransactionEvidence(value: unknown, depth = 0): void {
  if (depth > 50) {
    throw new WalletIntentRepositoryError(
      "observation-evidence-rejected",
      "Wallet intent observation evidence exceeds the maximum nesting depth",
    );
  }
  if (typeof value === "string" && /^(?:0x)?[0-9a-f]{256,}$/i.test(value)) {
    throw new WalletIntentRepositoryError(
      "observation-evidence-rejected",
      "Wallet intent observation evidence must not contain raw transaction bytes",
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoRawTransactionEvidence(item, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:raw(?:transaction|tx)|signed(?:transaction|tx)|(?:transaction|tx)hex)$/i.test(key)) {
        throw new WalletIntentRepositoryError(
          "observation-evidence-rejected",
          `Wallet intent observation evidence field ${key} may contain raw transaction bytes`,
        );
      }
      assertNoRawTransactionEvidence(item, depth + 1);
    }
  }
}

const walletIntentRowSchema = z.object({
  intent_id: uuidSchema,
  action: z.enum(walletIntentActions),
  scope: identifierSchema,
  facts_sha256: sha256Schema,
  manifest_sha256: sha256Schema,
  manifest_json: z.string(),
  required_sender: principalSchema,
  network: networkSchema,
  chain_id: z.number().int().min(0).max(0xffff_ffff),
  state: z.enum(walletIntentStates),
  state_version: z.number().int().nonnegative(),
  txid: txidSchema.nullable(),
  created_at: instantSchema,
  expires_at: instantSchema,
  submitted_at: instantSchema.nullable(),
  updated_at: instantSchema,
});

type WalletIntentRow = z.infer<typeof walletIntentRowSchema>;

export interface StoredWalletIntent {
  id: string;
  action: WalletIntentAction;
  scope: string;
  factsSha256: string;
  manifestSha256: string;
  manifest: unknown;
  requiredSender: string;
  network: z.infer<typeof networkSchema>;
  chainId: number;
  state: WalletIntentState;
  stateVersion: number;
  txid: string | null;
  createdAt: string;
  expiresAt: string;
  submittedAt: string | null;
  updatedAt: string;
}

function mapIntent(input: unknown): StoredWalletIntent {
  const row = walletIntentRowSchema.parse(input);
  const manifest = parseCanonicalObject(row.manifest_json, "wallet intent manifest", 262_144);
  if (canonicalJsonSha256(manifest) !== row.manifest_sha256) {
    throw new Error(`Persisted wallet intent ${row.intent_id} manifest digest does not match`);
  }
  return {
    id: row.intent_id,
    action: row.action,
    scope: row.scope,
    factsSha256: row.facts_sha256,
    manifestSha256: row.manifest_sha256,
    manifest,
    requiredSender: row.required_sender,
    network: row.network,
    chainId: row.chain_id,
    state: row.state,
    stateVersion: row.state_version,
    txid: row.txid,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

const observationRowSchema = z.object({
  observation_id: uuidSchema,
  intent_id: uuidSchema,
  outcome: outcomeSchema,
  canonical: z.union([z.literal(0), z.literal(1)]).nullable(),
  block_height: z.number().int().nonnegative().nullable(),
  index_block_hash: txidSchema.nullable(),
  evidence_json: z.string(),
  observed_at: instantSchema,
});

export interface WalletIntentObservation {
  id: string;
  intentId: string;
  outcome: string;
  canonical: boolean | null;
  blockHeight: number | null;
  indexBlockHash: string | null;
  evidence: unknown;
  observedAt: string;
}

function mapObservation(input: unknown): WalletIntentObservation {
  const row = observationRowSchema.parse(input);
  const evidence = parseCanonicalObject(
    row.evidence_json,
    "wallet intent observation evidence",
    32_768,
  );
  assertNoRawTransactionEvidence(evidence);
  return {
    id: row.observation_id,
    intentId: row.intent_id,
    outcome: row.outcome,
    canonical: row.canonical === null ? null : row.canonical === 1,
    blockHeight: row.block_height,
    indexBlockHash: row.index_block_hash,
    evidence,
    observedAt: row.observed_at,
  };
}

const equivalentFactsInputSchema = z
  .object({
    action: z.enum(walletIntentActions),
    scope: identifierSchema,
    factsSha256: sha256Schema,
  })
  .strict();

const actionScopeInputSchema = z
  .object({
    action: z.enum(walletIntentActions),
    scope: identifierSchema,
  })
  .strict();

const createInputSchema = z
  .object({
    id: uuidSchema.optional(),
    action: z.enum(walletIntentActions),
    scope: identifierSchema,
    factsSha256: sha256Schema,
    manifestSha256: sha256Schema,
    manifest: z.unknown(),
    requiredSender: principalSchema,
    network: networkSchema,
    chainId: z.number().int().min(0).max(0xffff_ffff),
    createdAt: instantSchema,
    expiresAt: instantSchema,
  })
  .strict()
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.createdAt), {
    message: "Wallet intent expiresAt must be after createdAt",
    path: ["expiresAt"],
  });

export interface CreateWalletIntentInput {
  id?: string;
  action: WalletIntentAction;
  scope: string;
  factsSha256: string;
  manifestSha256: string;
  manifest: unknown;
  requiredSender: string;
  network: z.infer<typeof networkSchema>;
  chainId: number;
  createdAt: string;
  expiresAt: string;
}

export interface AppendWalletIntentObservationInput {
  id?: string;
  intentId: string;
  outcome: string;
  canonical: boolean | null;
  blockHeight: number | null;
  indexBlockHash: string | null;
  evidence: unknown;
  observedAt: string;
}

const appendObservationInputSchema = z
  .object({
    id: uuidSchema.optional(),
    intentId: uuidSchema,
    outcome: outcomeSchema,
    canonical: z.boolean().nullable(),
    blockHeight: z.number().int().nonnegative().nullable(),
    indexBlockHash: txidSchema.nullable(),
    evidence: z.unknown(),
    observedAt: instantSchema,
  })
  .strict()
  .refine((value) => (value.blockHeight === null) === (value.indexBlockHash === null), {
    message: "blockHeight and indexBlockHash must both be present or both be null",
  });

const transitionInputSchema = z
  .object({
    id: uuidSchema,
    fromStates: z.array(z.enum(walletIntentStates)).min(1),
    toState: z.enum(walletIntentStates),
    updatedAt: instantSchema,
  })
  .strict();

const transitions = {
  prepared: ["expired", "superseded", "failed"],
  submitted: ["mempool", "confirmed", "failed", "reobserve", "superseded"],
  mempool: ["confirmed", "failed", "reobserve", "superseded"],
  confirmed: ["complete", "failed", "reobserve", "superseded"],
  complete: ["reobserve", "superseded"],
  expired: [],
  superseded: [],
  failed: ["reobserve", "superseded"],
  reobserve: ["submitted", "mempool", "confirmed", "complete", "failed", "superseded"],
} as const satisfies Record<WalletIntentState, readonly WalletIntentState[]>;

function intentMatchesCreate(
  row: WalletIntentRow,
  input: z.infer<typeof createInputSchema>,
): boolean {
  return (
    row.action === input.action &&
    row.scope === input.scope &&
    row.facts_sha256 === input.factsSha256 &&
    row.manifest_sha256 === input.manifestSha256 &&
    row.required_sender === input.requiredSender &&
    row.network === input.network &&
    row.chain_id === input.chainId
  );
}

export class WalletIntentRepository {
  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private row(id: string): WalletIntentRow | null {
    const row = this.db
      .prepare("SELECT * FROM browser_wallet_intents WHERE intent_id = ?")
      .get(uuidSchema.parse(id));
    return row === undefined ? null : walletIntentRowSchema.parse(row);
  }

  findActiveScope(input: {
    action: WalletIntentAction;
    scope: string;
    now: string;
  }): StoredWalletIntent | null {
    const value = actionScopeInputSchema.extend({ now: instantSchema }).strict().parse(input);
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE browser_wallet_intents SET
             state = 'expired', state_version = state_version + 1, updated_at = ?
           WHERE action = ? AND scope = ?
             AND state = 'prepared' AND expires_at <= ?`,
        )
        .run(value.now, value.action, value.scope, value.now);
      const row = this.db
        .prepare(
          `SELECT * FROM browser_wallet_intents
           WHERE action = ? AND scope = ?
             AND state IN ('prepared', 'submitted', 'mempool', 'confirmed', 'complete', 'reobserve')
           ORDER BY created_at DESC, intent_id DESC LIMIT 1`,
        )
        .get(value.action, value.scope);
      return row === undefined ? null : mapIntent(row);
    });
  }

  create(input: CreateWalletIntentInput): { intent: StoredWalletIntent; created: boolean } {
    const value = createInputSchema.parse(input);
    const id = value.id ?? randomUUID();
    const manifestJson = canonicalDocument(value.manifest, "wallet intent manifest", 262_144);
    const computedManifestSha256 = canonicalJsonSha256(value.manifest);
    if (computedManifestSha256 !== value.manifestSha256) {
      throw new WalletIntentRepositoryError(
        "manifest-sha256-mismatch",
        "Wallet intent manifest digest does not match its canonical JSON",
      );
    }
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE browser_wallet_intents SET
             state = 'expired', state_version = state_version + 1, updated_at = ?
           WHERE action = ? AND scope = ?
             AND state = 'prepared' AND expires_at <= ?`,
        )
        .run(value.createdAt, value.action, value.scope, value.createdAt);

      const sameId = this.row(id);
      if (sameId !== null) {
        if (intentMatchesCreate(sameId, value) && sameId.manifest_json === manifestJson) {
          return { intent: mapIntent(sameId), created: false };
        }
        throw new WalletIntentRepositoryError(
          "active-intent-conflict",
          `Wallet intent id ${id} already binds different facts`,
        );
      }

      const active = this.db
        .prepare(
          `SELECT * FROM browser_wallet_intents
           WHERE action = ? AND scope = ?
             AND state IN ('prepared', 'submitted', 'mempool', 'confirmed', 'complete', 'reobserve')
           ORDER BY created_at DESC, intent_id DESC LIMIT 1`,
        )
        .get(value.action, value.scope);
      if (active !== undefined) {
        const row = walletIntentRowSchema.parse(active);
        if (intentMatchesCreate(row, value) && row.manifest_json === manifestJson) {
          return { intent: mapIntent(row), created: false };
        }
        if (row.state !== "prepared") {
          throw new WalletIntentRepositoryError(
            "active-intent-conflict",
            "An unresolved wallet transaction already binds this action and scope",
          );
        }
        const superseded = this.db
          .prepare(
            `UPDATE browser_wallet_intents SET
               state = 'superseded', state_version = state_version + 1, updated_at = ?
             WHERE intent_id = ? AND state = 'prepared' AND state_version = ?`,
          )
          .run(value.createdAt, row.intent_id, row.state_version);
        if (superseded.changes !== 1 && superseded.changes !== 1n) {
          throw new WalletIntentRepositoryError(
            "state-conflict",
            `Wallet intent ${row.intent_id} changed while preparing its replacement`,
          );
        }
      }

      this.db
        .prepare(
          `INSERT INTO browser_wallet_intents (
             intent_id, action, scope, facts_sha256, manifest_sha256, manifest_json,
             required_sender, network, chain_id, state, state_version, txid,
             created_at, expires_at, submitted_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, NULL, ?, ?, NULL, ?)`,
        )
        .run(
          id,
          value.action,
          value.scope,
          value.factsSha256,
          value.manifestSha256,
          manifestJson,
          value.requiredSender,
          value.network,
          value.chainId,
          value.createdAt,
          value.expiresAt,
          value.createdAt,
        );
      const created = this.row(id);
      if (created === null) throw new Error("Wallet intent insert did not persist");
      return { intent: mapIntent(created), created: true };
    });
  }

  get(id: string): StoredWalletIntent | null {
    const row = this.row(id);
    return row === null ? null : mapIntent(row);
  }

  listForActivity(limit = 10_001): StoredWalletIntent[] {
    const parsedLimit = z.number().int().min(1).max(10_001).parse(limit);
    return this.db
      .prepare(
        `SELECT * FROM browser_wallet_intents
         ORDER BY updated_at DESC, intent_id ASC LIMIT ?`,
      )
      .all(parsedLimit)
      .map(mapIntent);
  }

  listActiveForActivity(limit = 10_001): StoredWalletIntent[] {
    const parsedLimit = z.number().int().min(1).max(10_001).parse(limit);
    return this.db
      .prepare(
        `SELECT * FROM browser_wallet_intents
         WHERE state IN ('prepared', 'submitted', 'mempool', 'confirmed', 'failed', 'reobserve')
         ORDER BY updated_at DESC, intent_id ASC LIMIT ?`,
      )
      .all(parsedLimit)
      .map(mapIntent);
  }

  listSubmittedEquivalent(input: {
    action: WalletIntentAction;
    scope: string;
    factsSha256: string;
  }): StoredWalletIntent[] {
    const value = equivalentFactsInputSchema.parse(input);
    return this.db
      .prepare(
        `SELECT * FROM browser_wallet_intents
         WHERE action = ? AND scope = ? AND facts_sha256 = ? AND txid IS NOT NULL
         ORDER BY created_at ASC, intent_id ASC`,
      )
      .all(value.action, value.scope, value.factsSha256)
      .map(mapIntent);
  }

  listSubmittedScope(input: { action: WalletIntentAction; scope: string }): StoredWalletIntent[] {
    const value = actionScopeInputSchema.parse(input);
    return this.db
      .prepare(
        `SELECT * FROM browser_wallet_intents
         WHERE action = ? AND scope = ? AND txid IS NOT NULL
         ORDER BY created_at ASC, intent_id ASC`,
      )
      .all(value.action, value.scope)
      .map(mapIntent);
  }

  supersedeActiveEquivalent(input: { winnerId: string; updatedAt: string }): StoredWalletIntent[] {
    const value = z
      .object({ winnerId: uuidSchema, updatedAt: instantSchema })
      .strict()
      .parse(input);
    return this.transaction(() => {
      const winner = this.row(value.winnerId);
      if (winner === null) {
        throw new WalletIntentRepositoryError(
          "not-found",
          `Wallet intent ${value.winnerId} does not exist`,
        );
      }
      if (winner.txid === null) {
        throw new WalletIntentRepositoryError(
          "state-conflict",
          `Wallet intent ${value.winnerId} does not bind a transaction`,
        );
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM browser_wallet_intents
           WHERE intent_id <> ? AND action = ? AND scope = ? AND facts_sha256 = ?
             AND state IN ('prepared', 'submitted', 'mempool', 'confirmed', 'reobserve')
           ORDER BY created_at ASC, intent_id ASC`,
        )
        .all(winner.intent_id, winner.action, winner.scope, winner.facts_sha256) as unknown[];
      for (const inputRow of rows) {
        const row = walletIntentRowSchema.parse(inputRow);
        const update = this.db
          .prepare(
            `UPDATE browser_wallet_intents SET
               state = 'superseded', state_version = state_version + 1, updated_at = ?
             WHERE intent_id = ? AND state = ? AND state_version = ?`,
          )
          .run(value.updatedAt, row.intent_id, row.state, row.state_version);
        if (update.changes !== 1 && update.changes !== 1n) {
          throw new WalletIntentRepositoryError(
            "state-conflict",
            `Wallet intent ${row.intent_id} changed during equivalent reconciliation`,
          );
        }
      }
      return rows.map((row) => {
        const id = walletIntentRowSchema.parse(row).intent_id;
        const superseded = this.row(id);
        if (superseded === null) throw new Error(`Wallet intent ${id} disappeared`);
        return mapIntent(superseded);
      });
    });
  }

  submit(input: { id: string; txid: string; submittedAt: string }): StoredWalletIntent {
    const value = z
      .object({ id: uuidSchema, txid: txidSchema, submittedAt: instantSchema })
      .strict()
      .parse(input);
    const result = this.transaction<
      | { intent: StoredWalletIntent; error: null }
      | { intent: null; error: WalletIntentRepositoryError }
    >(() => {
      const row = this.row(value.id);
      if (row === null) {
        return {
          intent: null,
          error: new WalletIntentRepositoryError(
            "not-found",
            `Wallet intent ${value.id} does not exist`,
          ),
        };
      }
      if (row.txid !== null) {
        if (row.txid === value.txid) return { intent: mapIntent(row), error: null };
        return {
          intent: null,
          error: new WalletIntentRepositoryError(
            "already-submitted",
            `Wallet intent ${value.id} already binds another txid`,
          ),
        };
      }
      if (row.state !== "prepared" && row.state !== "expired" && row.state !== "superseded") {
        return {
          intent: null,
          error: new WalletIntentRepositoryError(
            "state-conflict",
            `Wallet intent ${value.id} cannot be submitted from ${row.state}`,
          ),
        };
      }
      const duplicate = this.db
        .prepare("SELECT intent_id FROM browser_wallet_intents WHERE txid = ?")
        .get(value.txid) as { intent_id: string } | undefined;
      if (duplicate !== undefined) {
        return {
          intent: null,
          error: new WalletIntentRepositoryError(
            "duplicate-txid",
            `Txid ${value.txid} already belongs to wallet intent ${duplicate.intent_id}`,
          ),
        };
      }
      let submissionState: "submitted" | "superseded" = "submitted";
      if (row.state === "expired" || row.state === "superseded") {
        const competing = this.db
          .prepare(
            `SELECT intent_id, state FROM browser_wallet_intents
             WHERE intent_id <> ? AND action = ? AND scope = ?
               AND state IN ('prepared', 'submitted', 'mempool', 'confirmed', 'complete', 'reobserve')`,
          )
          .all(value.id, row.action, row.scope) as Array<{
          intent_id: string;
          state: WalletIntentState;
        }>;
        const broadcast = competing.find(({ state }) => state !== "prepared");
        if (broadcast) {
          submissionState = "superseded";
        } else {
          this.db
            .prepare(
              `UPDATE browser_wallet_intents SET
                 state = 'superseded', state_version = state_version + 1, updated_at = ?
               WHERE intent_id <> ? AND action = ? AND scope = ?
                 AND state = 'prepared'`,
            )
            .run(value.submittedAt, value.id, row.action, row.scope);
        }
      }
      const update = this.db
        .prepare(
          `UPDATE browser_wallet_intents SET
             state = ?, state_version = state_version + 1,
             txid = ?, submitted_at = ?, updated_at = ?
           WHERE intent_id = ? AND state IN ('prepared', 'expired', 'superseded')
             AND state_version = ? AND txid IS NULL`,
        )
        .run(
          submissionState,
          value.txid,
          value.submittedAt,
          value.submittedAt,
          value.id,
          row.state_version,
        );
      if (update.changes !== 1 && update.changes !== 1n) {
        return {
          intent: null,
          error: new WalletIntentRepositoryError(
            "state-conflict",
            `Wallet intent ${value.id} changed during submission`,
          ),
        };
      }
      const submitted = this.row(value.id);
      if (submitted === null) throw new Error("Wallet intent disappeared after submission");
      return { intent: mapIntent(submitted), error: null };
    });
    if (result.error !== null) throw result.error;
    return result.intent;
  }

  transition(input: {
    id: string;
    fromStates: readonly WalletIntentState[];
    toState: WalletIntentState;
    updatedAt: string;
  }): StoredWalletIntent {
    const value = transitionInputSchema.parse({ ...input, fromStates: [...input.fromStates] });
    const fromStates = [...new Set(value.fromStates)];
    return this.transaction(() => {
      const row = this.row(value.id);
      if (row === null) {
        throw new WalletIntentRepositoryError(
          "not-found",
          `Wallet intent ${value.id} does not exist`,
        );
      }
      if (row.state === value.toState) return mapIntent(row);
      if (!fromStates.includes(row.state)) {
        throw new WalletIntentRepositoryError(
          "state-conflict",
          `Wallet intent ${value.id} is ${row.state}, expected ${fromStates.join(" or ")}`,
        );
      }
      if (!(transitions[row.state] as readonly WalletIntentState[]).includes(value.toState)) {
        throw new WalletIntentRepositoryError(
          "state-conflict",
          `Wallet intent cannot transition from ${row.state} to ${value.toState}`,
        );
      }
      const placeholders = fromStates.map(() => "?").join(", ");
      const update = this.db
        .prepare(
          `UPDATE browser_wallet_intents SET
             state = ?, state_version = state_version + 1, updated_at = ?
           WHERE intent_id = ? AND state_version = ? AND state IN (${placeholders})`,
        )
        .run(value.toState, value.updatedAt, value.id, row.state_version, ...fromStates);
      if (update.changes !== 1 && update.changes !== 1n) {
        throw new WalletIntentRepositoryError(
          "state-conflict",
          `Wallet intent ${value.id} changed during transition`,
        );
      }
      const transitioned = this.row(value.id);
      if (transitioned === null) throw new Error("Wallet intent disappeared after transition");
      return mapIntent(transitioned);
    });
  }

  appendObservation(input: AppendWalletIntentObservationInput): WalletIntentObservation {
    const value = appendObservationInputSchema.parse(input);
    const id = value.id ?? randomUUID();
    assertNoRawTransactionEvidence(value.evidence);
    const evidenceJson = canonicalDocument(
      value.evidence,
      "wallet intent observation evidence",
      32_768,
    );
    return this.transaction(() => {
      if (this.row(value.intentId) === null) {
        throw new WalletIntentRepositoryError(
          "not-found",
          `Wallet intent ${value.intentId} does not exist`,
        );
      }
      const existing = this.db
        .prepare("SELECT * FROM browser_wallet_intent_observations WHERE observation_id = ?")
        .get(id);
      if (existing !== undefined) {
        throw new WalletIntentRepositoryError(
          "observation-conflict",
          `Wallet intent observation ${id} already exists`,
        );
      }
      this.db
        .prepare(
          `INSERT INTO browser_wallet_intent_observations (
             observation_id, intent_id, outcome, canonical, block_height,
             index_block_hash, evidence_json, observed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          value.intentId,
          value.outcome,
          value.canonical === null ? null : value.canonical ? 1 : 0,
          value.blockHeight,
          value.indexBlockHash,
          evidenceJson,
          value.observedAt,
        );
      const created = this.db
        .prepare("SELECT * FROM browser_wallet_intent_observations WHERE observation_id = ?")
        .get(id);
      if (created === undefined)
        throw new Error("Wallet intent observation insert did not persist");
      return mapObservation(created);
    });
  }

  /** Returns observations in chronological order; `.at(-1)` is the latest observation. */
  listObservations(id: string): WalletIntentObservation[] {
    return this.db
      .prepare(
        `SELECT * FROM browser_wallet_intent_observations WHERE intent_id = ?
         ORDER BY observed_at ASC, rowid ASC`,
      )
      .all(uuidSchema.parse(id))
      .map(mapObservation);
  }

  /** Returns at most the latest observation for each requested intent without per-intent reads. */
  listLatestObservationsForActivity(
    intentIds: readonly string[],
  ): Map<string, WalletIntentObservation> {
    const ids = [...new Set(intentIds.map((id) => uuidSchema.parse(id)))];
    const observations = new Map<string, WalletIntentObservation>();
    for (let offset = 0; offset < ids.length; offset += sqliteBatchSize) {
      const batch = ids.slice(offset, offset + sqliteBatchSize);
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT observation_id, intent_id, outcome, canonical, block_height,
                  index_block_hash, evidence_json, observed_at
           FROM (
             SELECT *, ROW_NUMBER() OVER (
               PARTITION BY intent_id ORDER BY observed_at DESC, rowid DESC
             ) AS activity_rank
             FROM browser_wallet_intent_observations
             WHERE intent_id IN (${placeholders})
           )
           WHERE activity_rank = 1`,
        )
        .all(...batch);
      for (const row of rows) {
        const observation = mapObservation(row);
        observations.set(observation.intentId, observation);
      }
    }
    return observations;
  }

  latestObservation(
    id: string,
    options: { excludeOutcomes?: readonly string[] } = {},
  ): WalletIntentObservation | null {
    const excludedOutcomes = [
      ...new Set((options.excludeOutcomes ?? []).map((outcome) => outcomeSchema.parse(outcome))),
    ];
    const exclusion =
      excludedOutcomes.length === 0
        ? ""
        : ` AND outcome NOT IN (${excludedOutcomes.map(() => "?").join(", ")})`;
    const row = this.db
      .prepare(
        `SELECT * FROM browser_wallet_intent_observations WHERE intent_id = ?
         ${exclusion}
         ORDER BY observed_at DESC, rowid DESC LIMIT 1`,
      )
      .get(uuidSchema.parse(id), ...excludedOutcomes);
    return row === undefined ? null : mapObservation(row);
  }
}
