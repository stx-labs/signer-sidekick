import type { ChainAnchor } from "../chain-anchor.js";

export type EngineMode = "observe" | "assist";

export type AdmissionBlockCode =
  | "attestation-missing"
  | "attestation-not-current"
  | "attestation-mismatch"
  | "live-fingerprint-mismatch"
  | "adapter-unavailable"
  | "adapter-revision-mismatch"
  | "anchor-noncanonical"
  | "anchor-mismatch"
  | "prerequisites-incomplete"
  | "fee-state-mismatch"
  | "fee-cap-exceeded"
  | "observe-mode"
  | "approval-missing"
  | "approval-invalid"
  | "approval-expired"
  | "signer-unavailable"
  | "signer-identity-mismatch"
  | "nonce-unresolved"
  | "nonce-not-owned"
  | "foreign-nonce-activity"
  | "authoritative-blocker";

export interface AdmissionBlock {
  code: AdmissionBlockCode;
  message: string;
}

export interface AuthoritativeBroadcastBlocker {
  code: string;
  message: string;
}

export interface TransactionAdmissionInput {
  mode: EngineMode;
  intentHash: string;
  policyHash: string;
  attestation: null | {
    current: boolean;
    payloadSha256: string;
  };
  expectedAttestationSha256: string;
  liveFingerprintMatches: boolean;
  adapter: null | {
    id: string;
    revision: number;
  };
  expectedAdapter: {
    id: string;
    revision: number;
  };
  plannedAnchor: ChainAnchor;
  liveAnchor: ChainAnchor;
  anchorCanonical: boolean;
  /** Proven canonical ancestry from the immutable planned anchor to the live revalidation anchor. */
  anchorDescendant: boolean;
  prerequisitesComplete: boolean;
  fee: {
    stateMatches: boolean;
    transactionFeeUstx: bigint;
    maximumFeeUstx: bigint;
  };
  approval: null | {
    intentHash: string;
    policyHash: string;
    expiresAt: string;
    invalidatedAt: string | null;
  };
  signer: null | {
    available: boolean;
    principal: string;
    expectedPrincipal: string;
  };
  nonce: null | {
    owned: boolean;
    unresolvedAttempt: boolean;
    foreignActivity: boolean;
  };
  authoritativeBlockers: readonly AuthoritativeBroadcastBlocker[];
  now: Date;
}

export interface TransactionAdmissionResult {
  admitted: boolean;
  blocks: readonly AdmissionBlock[];
}

function block(blocks: AdmissionBlock[], code: AdmissionBlockCode, message: string): void {
  blocks.push({ code, message });
}

function evaluateCommonAdmission(input: TransactionAdmissionInput, blocks: AdmissionBlock[]): void {
  if (!input.attestation) {
    block(blocks, "attestation-missing", "No authenticated compatibility attestation is loaded");
  } else {
    if (!input.attestation.current) {
      block(blocks, "attestation-not-current", "The compatibility attestation is not current");
    }
    if (input.attestation.payloadSha256 !== input.expectedAttestationSha256) {
      block(blocks, "attestation-mismatch", "The attestation does not match the planned intent");
    }
  }
  if (!input.liveFingerprintMatches) {
    block(
      blocks,
      "live-fingerprint-mismatch",
      "The live network or contract fingerprint does not match the attestation",
    );
  }
  if (!input.adapter) {
    block(blocks, "adapter-unavailable", "The code-backed adapter is unavailable");
  } else if (
    input.adapter.id !== input.expectedAdapter.id ||
    input.adapter.revision !== input.expectedAdapter.revision
  ) {
    block(blocks, "adapter-revision-mismatch", "The installed adapter differs from the intent");
  }
  if (!input.anchorCanonical) {
    block(blocks, "anchor-noncanonical", "The planned chain anchor is no longer canonical");
  }
  if (!input.anchorDescendant) {
    block(blocks, "anchor-mismatch", "The live anchor is not a proven canonical descendant");
  }
  if (!input.prerequisitesComplete) {
    block(blocks, "prerequisites-incomplete", "Authoritative adapter prerequisites are incomplete");
  }
  if (!input.fee.stateMatches) {
    block(blocks, "fee-state-mismatch", "The authoritative fee state changed after planning");
  }
  if (input.fee.transactionFeeUstx > input.fee.maximumFeeUstx) {
    block(blocks, "fee-cap-exceeded", "The transaction fee exceeds the approved cap");
  }
  if (input.authoritativeBlockers.length > 0) {
    block(
      blocks,
      "authoritative-blocker",
      input.authoritativeBlockers.map(({ code }) => code).join(", "),
    );
  }
}

function evaluateBroadcastAdmission(
  input: TransactionAdmissionInput,
  blocks: AdmissionBlock[],
): void {
  if (input.mode === "observe") {
    block(blocks, "observe-mode", "Observe mode cannot sign or broadcast");
  } else if (input.mode === "assist") {
    if (!input.approval) {
      block(blocks, "approval-missing", "Assist mode requires an exact durable approval");
    } else {
      if (
        input.approval.intentHash !== input.intentHash ||
        input.approval.policyHash !== input.policyHash ||
        input.approval.invalidatedAt !== null
      ) {
        block(blocks, "approval-invalid", "The approval is stale or does not bind this intent");
      }
      if (
        !Number.isFinite(input.now.getTime()) ||
        !Number.isFinite(Date.parse(input.approval.expiresAt)) ||
        input.now.getTime() >= Date.parse(input.approval.expiresAt)
      ) {
        block(blocks, "approval-expired", "The approval has expired");
      }
    }
  }

  if (!input.signer?.available) {
    block(blocks, "signer-unavailable", "The isolated gas-payer signer is unavailable");
  } else if (input.signer.principal !== input.signer.expectedPrincipal) {
    block(blocks, "signer-identity-mismatch", "The gas-payer identity differs from configuration");
  }
  if (!input.nonce) {
    block(blocks, "nonce-not-owned", "Gas-payer nonce ownership has not been established");
  } else {
    if (input.nonce.unresolvedAttempt) {
      block(blocks, "nonce-unresolved", "A previous gas-payer nonce remains unresolved");
    }
    if (!input.nonce.owned) {
      block(blocks, "nonce-not-owned", "The next gas-payer nonce is not locally owned");
    }
    if (input.nonce.foreignActivity) {
      block(
        blocks,
        "foreign-nonce-activity",
        "Unexplained foreign gas-payer activity was observed",
      );
    }
  }
}

export function evaluateTransactionAdmission(
  input: TransactionAdmissionInput,
): TransactionAdmissionResult {
  const blocks: AdmissionBlock[] = [];
  evaluateCommonAdmission(input, blocks);
  evaluateBroadcastAdmission(input, blocks);
  return { admitted: blocks.length === 0, blocks };
}
