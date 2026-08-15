import { describe, expect, it } from "vitest";
import { advanceLocalNodeAuthority } from "./local-node-authority.js";

const observedAt = "2026-08-15T12:00:00.000Z";

describe("advanceLocalNodeAuthority", () => {
  it("requires two consecutive current observations on a fresh install", () => {
    const first = advanceLocalNodeAuthority(null, {
      observedAt,
      stacksTipHeight: 100,
      isFullySynced: true,
      peerHeightDifference: 0,
    });
    expect(first).toMatchObject({
      status: "catching-up",
      consecutiveCurrentObservations: 1,
      highestProvenCurrentStacksTipHeight: null,
    });

    const second = advanceLocalNodeAuthority(first, {
      observedAt: "2026-08-15T12:00:15.000Z",
      stacksTipHeight: 101,
      isFullySynced: true,
      peerHeightDifference: 0,
    });
    expect(second).toMatchObject({
      status: "current",
      consecutiveCurrentObservations: 2,
      highestProvenCurrentStacksTipHeight: 101,
    });
  });

  it("demotes immediately when the node reports a peer gap", () => {
    const result = advanceLocalNodeAuthority(
      {
        schemaVersion: 1,
        status: "current",
        observedAt,
        stacksTipHeight: 200,
        highestProvenCurrentStacksTipHeight: 200,
        consecutiveCurrentObservations: 8,
        reason: "current",
      },
      {
        observedAt: "2026-08-15T12:00:15.000Z",
        stacksTipHeight: 201,
        isFullySynced: true,
        peerHeightDifference: 2,
      },
    );
    expect(result).toMatchObject({
      status: "catching-up",
      consecutiveCurrentObservations: 0,
      highestProvenCurrentStacksTipHeight: 200,
    });
  });

  it("does not restore authority below the durable high-water mark", () => {
    const result = advanceLocalNodeAuthority(
      {
        schemaVersion: 1,
        status: "catching-up",
        observedAt,
        stacksTipHeight: 150,
        highestProvenCurrentStacksTipHeight: 200,
        consecutiveCurrentObservations: 0,
        reason: "behind",
      },
      {
        observedAt: "2026-08-15T12:00:15.000Z",
        stacksTipHeight: 199,
        isFullySynced: true,
        peerHeightDifference: 0,
      },
    );
    expect(result.status).toBe("catching-up");
    expect(result.consecutiveCurrentObservations).toBe(0);
    expect(result.reason).toContain("below its last proven-current height");
  });

  it("reports unknown when the node exposes no explicit sync evidence", () => {
    const result = advanceLocalNodeAuthority(null, {
      observedAt,
      stacksTipHeight: 100,
      isFullySynced: null,
      peerHeightDifference: null,
    });
    expect(result).toMatchObject({
      status: "unknown",
      consecutiveCurrentObservations: 0,
      highestProvenCurrentStacksTipHeight: null,
    });
  });
});
