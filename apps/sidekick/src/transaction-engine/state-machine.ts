export const transactionJobStates = [
  "prepared",
  "preflighted",
  "awaiting_approval",
  "nonce_reserved",
  "broadcast",
  "confirmed",
  "reconciled",
  "blocked",
  "superseded",
  "ambiguous",
  "noncanonical_reobserve",
] as const;

export type TransactionJobState = (typeof transactionJobStates)[number];

const transitions = {
  prepared: ["preflighted", "confirmed", "blocked", "superseded", "reconciled"],
  preflighted: ["awaiting_approval", "confirmed", "blocked", "superseded", "reconciled"],
  awaiting_approval: ["nonce_reserved", "confirmed", "blocked", "superseded", "reconciled"],
  nonce_reserved: ["broadcast", "confirmed", "ambiguous", "blocked", "reconciled"],
  broadcast: ["confirmed", "ambiguous", "blocked", "reconciled"],
  confirmed: ["reconciled", "noncanonical_reobserve", "blocked"],
  reconciled: [],
  blocked: ["prepared", "confirmed", "superseded", "reconciled"],
  superseded: [],
  ambiguous: ["broadcast", "confirmed", "blocked", "reconciled"],
  noncanonical_reobserve: ["prepared", "confirmed", "blocked", "superseded", "reconciled"],
} as const satisfies Record<TransactionJobState, readonly TransactionJobState[]>;

export class InvalidTransactionJobTransitionError extends Error {
  constructor(
    readonly from: TransactionJobState,
    readonly to: TransactionJobState,
  ) {
    super(`Transaction job cannot transition from ${from} to ${to}`);
    this.name = "InvalidTransactionJobTransitionError";
  }
}

export function canTransitionTransactionJob(
  from: TransactionJobState,
  to: TransactionJobState,
): boolean {
  return (transitions[from] as readonly TransactionJobState[]).includes(to);
}

export function assertTransactionJobTransition(
  from: TransactionJobState,
  to: TransactionJobState,
): void {
  if (!canTransitionTransactionJob(from, to)) {
    throw new InvalidTransactionJobTransitionError(from, to);
  }
}

export function allowedTransactionJobTransitions(
  from: TransactionJobState,
): readonly TransactionJobState[] {
  return transitions[from];
}
