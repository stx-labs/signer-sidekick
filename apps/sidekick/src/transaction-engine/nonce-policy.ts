export type LocalNonceAttemptState = "signed" | "submitted" | "ambiguous";

export interface LocalNonceAttempt {
  attemptId: string;
  precomputedTxid: `0x${string}`;
  feeUstx: bigint;
  state: LocalNonceAttemptState;
}

export interface UnresolvedNonceReservation {
  reservationId: string;
  nonce: bigint;
  intentHash: string;
  attempts: readonly LocalNonceAttempt[];
}

export interface ObservedGasPayerTransaction {
  nonce: bigint;
  txid: `0x${string}`;
  state: "mempool" | "confirmed";
}

export interface NonceProposal {
  nonce: bigint;
  intentHash: string;
  feeUstx: bigint;
  maximumFeeUstx: bigint;
}

export interface NonceOwnershipInput {
  /** The account nonce Sidekick last established while it had exclusive ownership. */
  expectedAccountNonce: bigint;
  /** The current canonical account nonce from the authoritative node. */
  observedAccountNonce: bigint;
  unresolved: readonly UnresolvedNonceReservation[];
  /** Mempool/confirmed activity observed since the ownership checkpoint. */
  observedTransactions: readonly ObservedGasPayerTransaction[];
  proposal: NonceProposal;
}

export type NoncePolicyBlockCode =
  | "invalid-input"
  | "multiple-unresolved-nonces"
  | "unresolved-nonce"
  | "fee-cap-exceeded"
  | "foreign-activity"
  | "observation-inconsistent";

export type NonceOwnershipDecision =
  | {
      allowed: true;
      action: "reserve-initial";
      nonce: bigint;
    }
  | {
      allowed: false;
      action: "block";
      code: NoncePolicyBlockCode;
      message: string;
    }
  | {
      allowed: false;
      action: "reconcile-local-attempt";
      landedAttemptId: string;
      landedTxid: `0x${string}`;
    };

const txidPattern = /^0x[0-9a-f]{64}$/;
const intentHashPattern = /^[0-9a-f]{64}$/;

function block(code: NoncePolicyBlockCode, message: string): NonceOwnershipDecision {
  return { allowed: false, action: "block", code, message };
}

function nonnegative(value: bigint): boolean {
  return value >= 0n;
}

function validateLocalState(input: NonceOwnershipInput): NonceOwnershipDecision | null {
  if (
    !nonnegative(input.expectedAccountNonce) ||
    !nonnegative(input.observedAccountNonce) ||
    !nonnegative(input.proposal.nonce) ||
    input.proposal.feeUstx <= 0n ||
    input.proposal.maximumFeeUstx <= 0n ||
    !intentHashPattern.test(input.proposal.intentHash)
  ) {
    return block("invalid-input", "Nonce policy input contains an invalid value");
  }
  if (input.unresolved.length > 1) {
    return block("multiple-unresolved-nonces", "V1 permits only one unresolved gas-payer nonce");
  }

  const reservation = input.unresolved[0];
  if (!reservation) return null;
  if (
    !reservation.reservationId ||
    !nonnegative(reservation.nonce) ||
    !intentHashPattern.test(reservation.intentHash) ||
    reservation.attempts.length !== 1 ||
    reservation.nonce !== input.expectedAccountNonce
  ) {
    return block("invalid-input", "Unresolved nonce state is internally inconsistent");
  }
  const attempt = reservation.attempts[0];
  if (
    attempt === undefined ||
    !attempt.attemptId ||
    !txidPattern.test(attempt.precomputedTxid) ||
    attempt.feeUstx <= 0n
  ) {
    return block("invalid-input", "Local nonce attempt is internally inconsistent");
  }
  return null;
}

function evaluateObservedActivity(input: NonceOwnershipInput): NonceOwnershipDecision | null {
  const reservation = input.unresolved[0];
  const attempt = reservation?.attempts[0];
  let confirmed: ObservedGasPayerTransaction | undefined;

  for (const transaction of input.observedTransactions) {
    if (!nonnegative(transaction.nonce) || !txidPattern.test(transaction.txid)) {
      return block("invalid-input", "Observed gas-payer activity is invalid");
    }
    if (
      !reservation ||
      !attempt ||
      transaction.nonce !== reservation.nonce ||
      transaction.txid !== attempt.precomputedTxid
    ) {
      return block(
        "foreign-activity",
        "Unexplained gas-payer transaction activity requires an ownership stop",
      );
    }
    if (transaction.state === "confirmed") confirmed = transaction;
  }

  if (confirmed && attempt) {
    if (input.observedAccountNonce !== input.expectedAccountNonce + 1n) {
      return block(
        "observation-inconsistent",
        "Confirmed local attempt does not match the observed account nonce",
      );
    }
    return {
      allowed: false,
      action: "reconcile-local-attempt",
      landedAttemptId: attempt.attemptId,
      landedTxid: confirmed.txid,
    };
  }

  if (input.observedAccountNonce !== input.expectedAccountNonce) {
    return block(
      "foreign-activity",
      "Gas-payer account nonce moved without a recognized local confirmation",
    );
  }
  return null;
}

/**
 * Pure V1 nonce-ownership policy. V1 can reserve one initial nonce and one signed attempt only;
 * ambiguous or pending attempts remain unresolved for observation and explicit operator recovery.
 */
export function evaluateNonceOwnership(input: NonceOwnershipInput): NonceOwnershipDecision {
  const invalid = validateLocalState(input);
  if (invalid) return invalid;
  const observed = evaluateObservedActivity(input);
  if (observed) return observed;

  if (input.proposal.feeUstx > input.proposal.maximumFeeUstx) {
    return block("fee-cap-exceeded", "Proposed transaction fee exceeds the approved maximum");
  }
  if (input.unresolved[0]) {
    return block("unresolved-nonce", "An earlier gas-payer nonce remains unresolved");
  }
  if (
    input.proposal.nonce !== input.observedAccountNonce ||
    input.expectedAccountNonce !== input.observedAccountNonce
  ) {
    return block("invalid-input", "Nonce proposal does not match current ownership state");
  }
  return { allowed: true, action: "reserve-initial", nonce: input.proposal.nonce };
}
