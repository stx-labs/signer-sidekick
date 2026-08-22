import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/** Public identity of the operator-run gas wallet. Never holds key material. */
export interface StoredGasWallet {
  schemaVersion: 1;
  principal: string;
  publicKey: string;
  secretFilePath: string;
  source: "generated" | "configured";
  createdAt: string;
  enabled: boolean;
  enabledAt: string | null;
  updatedAt: string;
}

export interface StoredGasWalletBanners {
  setupDismissedAt: string | null;
  lowBalanceDismissedUntil: string | null;
}

const rowSchema = z
  .object({
    schema_version: z.literal(1),
    principal: z.string().min(1),
    public_key: z.string().regex(/^(02|03)[0-9a-f]{64}$/),
    secret_file_path: z.string().min(1),
    source: z.enum(["generated", "configured"]),
    created_at: z.string().min(1),
    enabled: z.union([z.literal(0), z.literal(1)]),
    enabled_at: z.string().nullable(),
    updated_at: z.string().min(1),
  })
  .strict();

export class GasWalletRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(): StoredGasWallet | null {
    const row = this.db
      .prepare(
        `SELECT schema_version, principal, public_key, secret_file_path, source, created_at,
                enabled, enabled_at, updated_at
         FROM gas_wallet WHERE singleton_id = 1`,
      )
      .get();
    if (row === undefined) return null;
    const value = rowSchema.parse(row);
    return {
      schemaVersion: 1,
      principal: value.principal,
      publicKey: value.public_key,
      secretFilePath: value.secret_file_path,
      source: value.source,
      createdAt: value.created_at,
      enabled: value.enabled === 1,
      enabledAt: value.enabled_at,
      updatedAt: value.updated_at,
    };
  }

  /** Records a wallet identity. Refuses to overwrite a different existing identity. */
  put(input: {
    principal: string;
    publicKey: string;
    secretFilePath: string;
    source: "generated" | "configured";
    createdAt: string;
  }): StoredGasWallet {
    const existing = this.get();
    if (existing && existing.principal !== input.principal) {
      throw new Error(
        "A different gas wallet is already recorded; remove it before creating another",
      );
    }
    this.db
      .prepare(
        `INSERT INTO gas_wallet (
           singleton_id, schema_version, principal, public_key, secret_file_path, source,
           created_at, enabled, enabled_at, updated_at
         ) VALUES (1, 1, ?, ?, ?, ?, ?, 0, NULL, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           public_key = excluded.public_key,
           secret_file_path = excluded.secret_file_path,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.principal,
        input.publicKey.toLowerCase(),
        input.secretFilePath,
        input.source,
        input.createdAt,
        input.createdAt,
      );
    const stored = this.get();
    if (!stored) throw new Error("Gas wallet identity did not persist");
    return stored;
  }

  setEnabled(enabled: boolean, at: string): StoredGasWallet {
    this.db
      .prepare(
        `UPDATE gas_wallet SET enabled = ?, enabled_at = ?, updated_at = ? WHERE singleton_id = 1`,
      )
      .run(enabled ? 1 : 0, enabled ? at : null, at);
    const stored = this.get();
    if (!stored) throw new Error("No gas wallet is recorded");
    return stored;
  }

  remove(): void {
    this.db.prepare("DELETE FROM gas_wallet WHERE singleton_id = 1").run();
  }

  banners(): StoredGasWalletBanners {
    const row = this.db
      .prepare(
        "SELECT setup_dismissed_at, low_balance_dismissed_until FROM gas_wallet_banners WHERE singleton_id = 1",
      )
      .get() as
      | { setup_dismissed_at: string | null; low_balance_dismissed_until: string | null }
      | undefined;
    return {
      setupDismissedAt: row?.setup_dismissed_at ?? null,
      lowBalanceDismissedUntil: row?.low_balance_dismissed_until ?? null,
    };
  }

  dismissSetupBanner(at: string | null, updatedAt: string): StoredGasWalletBanners {
    this.db
      .prepare(
        `INSERT INTO gas_wallet_banners (singleton_id, setup_dismissed_at, low_balance_dismissed_until, updated_at)
         VALUES (1, ?, NULL, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET setup_dismissed_at = excluded.setup_dismissed_at, updated_at = excluded.updated_at`,
      )
      .run(at, updatedAt);
    return this.banners();
  }

  dismissLowBalance(until: string | null, updatedAt: string): StoredGasWalletBanners {
    this.db
      .prepare(
        `INSERT INTO gas_wallet_banners (singleton_id, setup_dismissed_at, low_balance_dismissed_until, updated_at)
         VALUES (1, NULL, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET low_balance_dismissed_until = excluded.low_balance_dismissed_until, updated_at = excluded.updated_at`,
      )
      .run(until, updatedAt);
    return this.banners();
  }
}
