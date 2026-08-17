import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const recognitionTierSchema = z.enum([
  "reference-built-in",
  "reference-render",
  "custom-observe",
  "unrecognized",
]);
const transitionSchema = z.enum(["gained", "lost", "degraded"]);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export interface ManagerTrustObservation {
  managerPrincipal: string;
  recognitionTier: z.infer<typeof recognitionTierSchema>;
  profileId: string | null;
  profileOrigin: "built-in" | "operator-installed" | null;
  sourceSha256: string | null;
  canonicalSourceSha256: string | null;
  automationEligible: boolean;
  eligibilityReason: string;
  observedAt: string;
}

export interface ManagerTrustTransition {
  transition: z.infer<typeof transitionSchema>;
  previousTier: string;
  currentTier: string;
  reason: string;
  changedAt: string;
}

export interface ManagerTrustAuditEntry extends ManagerTrustTransition {
  previousProfileId: string | null;
  currentProfileId: string | null;
  previousSourceSha256: string | null;
  currentSourceSha256: string | null;
  previousCanonicalSourceSha256: string | null;
  currentCanonicalSourceSha256: string | null;
}

export class ManagerTrustRepository {
  constructor(private readonly db: DatabaseSync) {}

  record(input: ManagerTrustObservation): ManagerTrustTransition | null {
    const managerPrincipal = z.string().min(1).parse(input.managerPrincipal);
    const recognitionTier = recognitionTierSchema.parse(input.recognitionTier);
    const profileId = z.string().min(1).nullable().parse(input.profileId);
    const profileOrigin = z
      .enum(["built-in", "operator-installed"])
      .nullable()
      .parse(input.profileOrigin);
    const sourceSha256 = sha256Schema.nullable().parse(input.sourceSha256);
    const canonicalSourceSha256 = sha256Schema.nullable().parse(input.canonicalSourceSha256);
    const automationEligible = z.boolean().parse(input.automationEligible);
    const eligibilityReason = z.string().min(1).parse(input.eligibilityReason);
    const observedAt = z.iso.datetime().parse(input.observedAt);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare(
          `SELECT recognition_tier, profile_id, source_sha256, canonical_source_sha256,
                automation_eligible
           FROM manager_trust_state WHERE manager_principal = ?`,
        )
        .get(managerPrincipal) as
        | {
            recognition_tier: string;
            profile_id: string | null;
            source_sha256: string | null;
            canonical_source_sha256: string | null;
            automation_eligible: number;
          }
        | undefined;
      const tierRank = {
        "reference-built-in": 3,
        "reference-render": 3,
        "custom-observe": 1,
        unrecognized: 0,
      } as const;
      const previousTier = previous ? recognitionTierSchema.parse(previous.recognition_tier) : null;
      const transition = !previous
        ? automationEligible
          ? "gained"
          : null
        : Boolean(previous.automation_eligible) !== automationEligible
          ? automationEligible
            ? "gained"
            : "lost"
          : previousTier && tierRank[recognitionTier] < tierRank[previousTier]
            ? "degraded"
            : null;
      this.db
        .prepare(
          `INSERT INTO manager_trust_state (
            manager_principal, recognition_tier, profile_id, profile_origin,
            source_sha256, canonical_source_sha256, automation_eligible,
            eligibility_reason, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (manager_principal) DO UPDATE SET
            recognition_tier = excluded.recognition_tier,
            profile_id = excluded.profile_id,
            profile_origin = excluded.profile_origin,
            source_sha256 = excluded.source_sha256,
            canonical_source_sha256 = excluded.canonical_source_sha256,
            automation_eligible = excluded.automation_eligible,
            eligibility_reason = excluded.eligibility_reason,
            observed_at = excluded.observed_at`,
        )
        .run(
          managerPrincipal,
          recognitionTier,
          profileId,
          profileOrigin,
          sourceSha256,
          canonicalSourceSha256,
          automationEligible ? 1 : 0,
          eligibilityReason,
          observedAt,
        );
      if (transition) {
        this.db
          .prepare(
            `INSERT INTO manager_trust_audit (
              event_id, manager_principal, transition, previous_tier, current_tier,
              previous_profile_id, current_profile_id,
              previous_source_sha256, current_source_sha256,
              previous_canonical_source_sha256, current_canonical_source_sha256,
              reason, changed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            managerPrincipal,
            transition,
            previous?.recognition_tier ?? "unobserved",
            recognitionTier,
            previous?.profile_id ?? null,
            profileId,
            previous?.source_sha256 ?? null,
            sourceSha256,
            previous?.canonical_source_sha256 ?? null,
            canonicalSourceSha256,
            eligibilityReason,
            observedAt,
          );
      }
      this.db.exec("COMMIT");
      return transition
        ? {
            transition,
            previousTier: previous?.recognition_tier ?? "unobserved",
            currentTier: recognitionTier,
            reason: eligibilityReason,
            changedAt: observedAt,
          }
        : null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listAudit(managerPrincipal: string, limit = 20): ManagerTrustAuditEntry[] {
    const principal = z.string().min(1).parse(managerPrincipal);
    const parsedLimit = z.number().int().min(1).max(100).parse(limit);
    const rows = this.db
      .prepare(
        `SELECT transition, previous_tier, current_tier, previous_profile_id,
                current_profile_id, previous_source_sha256, current_source_sha256,
                previous_canonical_source_sha256, current_canonical_source_sha256,
                reason, changed_at
         FROM manager_trust_audit
         WHERE manager_principal = ?
         ORDER BY changed_at DESC, event_id DESC LIMIT ?`,
      )
      .all(principal, parsedLimit) as Array<{
      transition: "gained" | "lost" | "degraded";
      previous_tier: string;
      current_tier: string;
      previous_profile_id: string | null;
      current_profile_id: string | null;
      previous_source_sha256: string | null;
      current_source_sha256: string | null;
      previous_canonical_source_sha256: string | null;
      current_canonical_source_sha256: string | null;
      reason: string;
      changed_at: string;
    }>;
    return rows.map((row) => ({
      transition: transitionSchema.parse(row.transition),
      previousTier: z.string().parse(row.previous_tier),
      currentTier: z.string().parse(row.current_tier),
      previousProfileId: z.string().nullable().parse(row.previous_profile_id),
      currentProfileId: z.string().nullable().parse(row.current_profile_id),
      previousSourceSha256: z.string().nullable().parse(row.previous_source_sha256),
      currentSourceSha256: z.string().nullable().parse(row.current_source_sha256),
      previousCanonicalSourceSha256: z
        .string()
        .nullable()
        .parse(row.previous_canonical_source_sha256),
      currentCanonicalSourceSha256: z
        .string()
        .nullable()
        .parse(row.current_canonical_source_sha256),
      reason: z.string().min(1).parse(row.reason),
      changedAt: z.iso.datetime().parse(row.changed_at),
    }));
  }
}
