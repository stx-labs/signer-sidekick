import { z } from "zod";
import { fetchHealthSource, HealthSourceError } from "./health-http.js";

const hashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const durationSchema = z
  .number()
  .int()
  .nonnegative()
  .max(24 * 60 * 60 * 1_000)
  .nullable();
const timestampSchema = z.iso.datetime().nullable();

export const signerBlockTelemetryRecordSchema = z
  .object({
    recordId: z.string().min(1).max(200),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    blockId: hashSchema,
    signerSighash: hashSchema,
    blockHeight: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    blockTimestamp: z.iso.datetime(),
    stage: z.enum([
      "proposal-received",
      "validation-submitted",
      "validation-complete",
      "precommit-sent",
      "precommit-threshold",
      "response-started",
      "response-acknowledged",
      "response-failed",
    ]),
    outcome: z.enum(["pending", "accepted", "rejected", "failed"]),
    rejectReason: z.string().min(1).max(500).nullable(),
    timestamps: z
      .object({
        proposalReceivedAt: z.iso.datetime(),
        validationSubmittedAt: timestampSchema,
        validationResultAt: timestampSchema,
        precommitSentAt: timestampSchema,
        precommitThresholdAt: timestampSchema,
        responseStartedAt: timestampSchema,
        responseAckedAt: timestampSchema,
      })
      .strict(),
    durationsMs: z
      .object({
        proposalToValidationSubmission: durationSchema,
        proposalToValidationResult: durationSchema,
        nodeValidation: durationSchema,
        validationResultToPrecommit: durationSchema,
        precommitWait: durationSchema,
        responsePublication: durationSchema,
        proposalToResponseAck: durationSchema,
        headerToResponseAck: durationSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((record, context) => {
    const finalized = record.stage === "response-acknowledged";
    if (
      finalized &&
      (record.outcome === "pending" ||
        record.timestamps.responseAckedAt === null ||
        record.durationsMs.proposalToResponseAck === null ||
        record.durationsMs.headerToResponseAck === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "An acknowledged response requires a final outcome, timestamp, and durations",
      });
    }
    if (record.outcome === "rejected" && record.rejectReason === null) {
      context.addIssue({
        code: "custom",
        path: ["rejectReason"],
        message: "A rejected response requires a bounded public reason",
      });
    }
    if (record.outcome !== "rejected" && record.rejectReason !== null) {
      context.addIssue({
        code: "custom",
        path: ["rejectReason"],
        message: "Only a rejected response may carry a reject reason",
      });
    }
    const orderedTimestamps = [
      ["proposalReceivedAt", record.timestamps.proposalReceivedAt],
      ["validationSubmittedAt", record.timestamps.validationSubmittedAt],
      ["validationResultAt", record.timestamps.validationResultAt],
      ["precommitSentAt", record.timestamps.precommitSentAt],
      ["precommitThresholdAt", record.timestamps.precommitThresholdAt],
      ["responseStartedAt", record.timestamps.responseStartedAt],
      ["responseAckedAt", record.timestamps.responseAckedAt],
    ] as const;
    let previous: { name: string; value: string } | null = null;
    for (const [name, value] of orderedTimestamps) {
      if (value === null) continue;
      if (previous && Date.parse(value) < Date.parse(previous.value)) {
        context.addIssue({
          code: "custom",
          path: ["timestamps", name],
          message: `${name} precedes ${previous.name}`,
        });
      }
      previous = { name, value };
    }
  });

export const signerBlockTelemetryPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    producer: z
      .object({
        version: z.string().min(1).max(200),
        bootId: z.string().min(1).max(200),
      })
      .strict(),
    records: z.array(signerBlockTelemetryRecordSchema).max(500),
    nextCursor: z.string().min(1).max(500),
    hasMore: z.boolean(),
    cursorReset: z.boolean(),
  })
  .strict();

export type SignerBlockTelemetryRecord = z.infer<typeof signerBlockTelemetryRecordSchema>;
export type SignerBlockTelemetryPage = z.infer<typeof signerBlockTelemetryPageSchema>;

export class SignerBlockTelemetryUnsupportedError extends Error {
  constructor() {
    super("The configured Signer does not expose per-block telemetry");
    this.name = "SignerBlockTelemetryUnsupportedError";
  }
}

export async function fetchSignerBlockTelemetryPage(
  baseUrl: string,
  cursor: string | null,
  limit = 200,
): Promise<{ page: SignerBlockTelemetryPage; latencyMs: number }> {
  const endpoint = new URL("/v1/block-telemetry", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (cursor) endpoint.searchParams.set("cursor", cursor);
  endpoint.searchParams.set("limit", z.number().int().min(1).max(500).parse(limit).toString());
  try {
    const response = await fetchHealthSource(endpoint.toString(), {
      allowQuery: true,
      maxBytes: 1_048_576,
    });
    return {
      page: signerBlockTelemetryPageSchema.parse(JSON.parse(response.body) as unknown),
      latencyMs: response.latencyMs,
    };
  } catch (error) {
    if (error instanceof HealthSourceError && error.status === 404) {
      throw new SignerBlockTelemetryUnsupportedError();
    }
    throw error;
  }
}

export function nearestRankP95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}
