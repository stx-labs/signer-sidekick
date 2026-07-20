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
    block(blocks, "attestation-missing", "Assist requires a current compatibility attestation");
  } else {
    if (!input.attestation.current) {
      block(
        blocks,
        "attestation-not-current",
        "The compatibility attestation expired. Install a current attestation",
      );
    }
    if (input.attestation.payloadSha256 !== input.expectedAttestationSha256) {
      block(
        blocks,
        "attestation-mismatch",
        "The compatibility attestation does not match this transaction. Sync chain data to prepare a new current job, then review and approve it",
      );
    }
  }
  if (!input.liveFingerprintMatches) {
    block(
      blocks,
      "live-fingerprint-mismatch",
      "The manager or network identity changed. Sync chain data to prepare a new current job, then review and approve it",
    );
  }
  if (!input.adapter) {
    block(blocks, "adapter-unavailable", "The transaction adapter is unavailable");
  } else if (
    input.adapter.id !== input.expectedAdapter.id ||
    input.adapter.revision !== input.expectedAdapter.revision
  ) {
    block(
      blocks,
      "adapter-revision-mismatch",
      "The transaction adapter changed. Prepare a new job",
    );
  }
  if (!input.anchorCanonical) {
    block(
      blocks,
      "anchor-noncanonical",
      "The planned chain anchor is no longer canonical. Sync chain data to prepare a new current job, then review and approve it",
    );
  }
  if (!input.anchorDescendant) {
    block(
      blocks,
      "anchor-mismatch",
      "The live chain cannot yet be proven from the planned anchor. Wait for the Reference API to catch up",
    );
  }
  if (!input.prerequisitesComplete) {
    block(blocks, "prerequisites-incomplete", "Transaction prerequisites are incomplete");
  }
  if (!input.fee.stateMatches) {
    block(
      blocks,
      "fee-state-mismatch",
      "Manager fee state changed. Sync chain data to prepare a new current job, then review and approve it",
    );
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
      block(blocks, "approval-missing", "Review and approve this transaction job");
    } else {
      if (
        input.approval.intentHash !== input.intentHash ||
        input.approval.policyHash !== input.policyHash ||
        input.approval.invalidatedAt !== null
      ) {
        block(
          blocks,
          "approval-invalid",
          "The approval no longer matches this transaction. Sync chain data to prepare a new current job, then review and approve it",
        );
      }
      if (
        !Number.isFinite(input.now.getTime()) ||
        !Number.isFinite(Date.parse(input.approval.expiresAt)) ||
        input.now.getTime() >= Date.parse(input.approval.expiresAt)
      ) {
        block(
          blocks,
          "approval-expired",
          "The approval expired. Sync chain data to prepare a new current job, then review and approve it",
        );
      }
    }
  }

  if (!input.signer?.available) {
    block(
      blocks,
      "signer-unavailable",
      "The Assist gas-payer signer is unavailable. Check its configuration",
    );
  } else if (input.signer.principal !== input.signer.expectedPrincipal) {
    block(
      blocks,
      "signer-identity-mismatch",
      "The Assist gas-payer identity does not match its configuration",
    );
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
