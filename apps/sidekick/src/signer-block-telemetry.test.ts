import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchSignerBlockTelemetryPage,
  nearestRankP95,
  SignerBlockTelemetryUnsupportedError,
  signerBlockTelemetryPageSchema,
} from "./signer-block-telemetry.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function page() {
  return {
    schemaVersion: 1 as const,
    producer: { version: "stacks-signer 4.1.0", bootId: "boot-1" },
    records: [
      {
        recordId: "proposal-1",
        sequence: 7,
        blockId: `0x${"11".repeat(32)}`,
        signerSighash: `0x${"22".repeat(32)}`,
        blockHeight: 123,
        blockTimestamp: "2026-08-15T12:00:00.000Z",
        stage: "response-acknowledged" as const,
        outcome: "accepted" as const,
        rejectReason: null,
        timestamps: {
          proposalReceivedAt: "2026-08-15T12:00:01.000Z",
          validationSubmittedAt: "2026-08-15T12:00:01.100Z",
          validationResultAt: "2026-08-15T12:00:01.500Z",
          precommitSentAt: "2026-08-15T12:00:01.600Z",
          precommitThresholdAt: "2026-08-15T12:00:02.000Z",
          responseStartedAt: "2026-08-15T12:00:02.100Z",
          responseAckedAt: "2026-08-15T12:00:02.200Z",
        },
        durationsMs: {
          proposalToValidationSubmission: 100,
          proposalToValidationResult: 500,
          nodeValidation: 350,
          validationResultToPrecommit: 100,
          precommitWait: 400,
          responsePublication: 100,
          proposalToResponseAck: 1_200,
          headerToResponseAck: 2_200,
        },
      },
    ],
    nextCursor: "boot-1:7",
    hasMore: false,
    cursorReset: false,
  };
}

describe("per-block signer telemetry", () => {
  it("parses the bounded versioned producer contract", () => {
    expect(signerBlockTelemetryPageSchema.parse(page())).toEqual(page());
    expect(() =>
      signerBlockTelemetryPageSchema.parse({
        ...page(),
        records: [
          {
            ...page().records[0],
            outcome: "rejected",
            rejectReason: null,
          },
        ],
      }),
    ).toThrow("rejected response requires");
    expect(() =>
      signerBlockTelemetryPageSchema.parse({
        ...page(),
        records: [
          {
            ...page().records[0],
            timestamps: {
              ...page().records[0]?.timestamps,
              responseAckedAt: "2026-08-15T12:00:01.000Z",
            },
          },
        ],
      }),
    ).toThrow("precedes responseStartedAt");
  });

  it("uses an opaque cursor and recognizes a legacy 404 as unsupported", async () => {
    let requestedUrl = "";
    let unsupported = false;
    const server = createServer((request, response) => {
      requestedUrl = request.url ?? "";
      if (!unsupported && request.url?.startsWith("/v1/block-telemetry?")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(page()));
        return;
      }
      response.statusCode = 404;
      response.end("Not Found");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await expect(fetchSignerBlockTelemetryPage(baseUrl, "boot 0:6", 200)).resolves.toMatchObject({
      page: { nextCursor: "boot-1:7" },
    });
    expect(requestedUrl).toContain("cursor=boot+0%3A6");
    expect(requestedUrl).toContain("limit=200");

    unsupported = true;
    await expect(fetchSignerBlockTelemetryPage(baseUrl, null)).rejects.toBeInstanceOf(
      SignerBlockTelemetryUnsupportedError,
    );
  });

  it("calculates an auditable nearest-rank p95 from raw values", () => {
    expect(nearestRankP95(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(19);
    expect(nearestRankP95([9_900, 5_100, 5_200, 5_300])).toBe(9_900);
    expect(nearestRankP95([])).toBeNull();
  });
});
