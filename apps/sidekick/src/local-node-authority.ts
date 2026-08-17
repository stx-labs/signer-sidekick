import type { LocalNodeAuthority } from "@stx-labs/signer-sidekick-api-contracts";

const REQUIRED_CURRENT_OBSERVATIONS = 2;

export interface LocalNodeAuthorityObservation {
  observedAt: string;
  stacksTipHeight: number;
  isFullySynced: boolean | null;
  peerHeightDifference: number | null;
}

function highestProvenHeight(
  previous: LocalNodeAuthority | null,
  observedHeight: number,
  provenCurrent: boolean,
): number | null {
  const prior = previous?.highestProvenCurrentStacksTipHeight ?? null;
  if (!provenCurrent) return prior;
  return prior === null ? observedHeight : Math.max(prior, observedHeight);
}

/**
 * Turn the node's point-in-time sync signals into a durable authority boundary.
 *
 * Falling behind demotes immediately. Recovery requires two consecutive current observations at
 * or above the last proven-current height, so a restarted or flapping peer assessment cannot make
 * stale state authoritative for money-moving decisions.
 */
export function advanceLocalNodeAuthority(
  previous: LocalNodeAuthority | null,
  observation: LocalNodeAuthorityObservation,
): LocalNodeAuthority {
  const { observedAt, stacksTipHeight, isFullySynced, peerHeightDifference } = observation;
  const priorHighWatermark = previous?.highestProvenCurrentStacksTipHeight ?? null;
  const belowHighWatermark = priorHighWatermark !== null && stacksTipHeight < priorHighWatermark;
  const explicitlyBehind =
    isFullySynced === false ||
    (peerHeightDifference !== null && peerHeightDifference > 0) ||
    belowHighWatermark;

  if (explicitlyBehind) {
    const reason = belowHighWatermark
      ? `The local node Stacks tip ${stacksTipHeight} is below its last proven-current height ${priorHighWatermark}.`
      : peerHeightDifference !== null && peerHeightDifference > 0
        ? `The local node reports a peer height gap of ${peerHeightDifference} Stacks blocks.`
        : "The local node reports that it is not fully synchronized.";
    return {
      schemaVersion: 1,
      status: "catching-up",
      observedAt,
      stacksTipHeight,
      highestProvenCurrentStacksTipHeight: priorHighWatermark,
      consecutiveCurrentObservations: 0,
      reason,
    };
  }

  const explicitlyCurrent =
    isFullySynced === true || (peerHeightDifference !== null && peerHeightDifference === 0);
  if (!explicitlyCurrent) {
    return {
      schemaVersion: 1,
      status: "unknown",
      observedAt,
      stacksTipHeight,
      highestProvenCurrentStacksTipHeight: priorHighWatermark,
      consecutiveCurrentObservations: 0,
      reason:
        "The local node did not expose enough sync evidence to prove that its tip is current.",
    };
  }

  if (previous?.status === "current") {
    return {
      schemaVersion: 1,
      status: "current",
      observedAt,
      stacksTipHeight,
      highestProvenCurrentStacksTipHeight: highestProvenHeight(previous, stacksTipHeight, true),
      consecutiveCurrentObservations: Math.max(
        REQUIRED_CURRENT_OBSERVATIONS,
        previous.consecutiveCurrentObservations + 1,
      ),
      reason: "The local node continues to report a current Stacks tip.",
    };
  }

  const consecutiveCurrentObservations = (previous?.consecutiveCurrentObservations ?? 0) + 1;
  const recovered = consecutiveCurrentObservations >= REQUIRED_CURRENT_OBSERVATIONS;
  return {
    schemaVersion: 1,
    status: recovered ? "current" : "catching-up",
    observedAt,
    stacksTipHeight,
    highestProvenCurrentStacksTipHeight: highestProvenHeight(previous, stacksTipHeight, recovered),
    consecutiveCurrentObservations,
    reason: recovered
      ? "The local node reported a current Stacks tip in two consecutive observations."
      : "The local node appears current; one more consecutive observation is required before current-state authority is restored.",
  };
}
