import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export interface StoredRuntimeSettings {
  settings: unknown;
  apiKeySecret: string | null;
  revision: number;
  updatedAt: string;
}

export interface SettingsAuditEntry {
  revision: number;
  changedFields: string[];
  changedAt: string;
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

export class RuntimeSettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(): StoredRuntimeSettings | null {
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

  put(input: {
    settings: unknown;
    apiKeySecret: string | null;
    changedFields: string[];
    observedAt: string;
  }): StoredRuntimeSettings {
    const observedAt = z.iso.datetime().parse(input.observedAt);
    const changedFields = z.array(z.string().min(1)).min(1).parse(input.changedFields);
    const settingsJson = serializeJson(input.settings, "runtime settings");
    const changedFieldsJson = serializeJson([...new Set(changedFields)].sort(), "changed fields");
    const revision = (this.get()?.revision ?? 0) + 1;
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

  listAudit(limit = 20): SettingsAuditEntry[] {
    const parsedLimit = z.number().int().min(1).max(10_001).parse(limit);
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

  getAudit(revision: number): SettingsAuditEntry | null {
    const parsedRevision = z.number().int().positive().parse(revision);
    const row = this.db
      .prepare(
        `SELECT revision, changed_fields_json, changed_at
         FROM settings_audit WHERE revision = ?
         ORDER BY changed_at DESC, audit_id DESC LIMIT 1`,
      )
      .get(parsedRevision) as
      | { revision: number; changed_fields_json: string; changed_at: string }
      | undefined;
    return row === undefined
      ? null
      : {
          revision: z.number().int().positive().parse(row.revision),
          changedFields: z.array(z.string()).parse(JSON.parse(row.changed_fields_json)),
          changedAt: z.iso.datetime().parse(row.changed_at),
        };
  }
}
