import { z } from "zod";
import type { ChainAnchor } from "../chain-anchor.js";
import type { ApiStatus, StacksBlockSummary } from "../chain-clients.js";

export interface CanonicalAnchorProofApi {
  getStatus(): Promise<ApiStatus>;
  getBlock(height: number): Promise<StacksBlockSummary>;
}

export interface CanonicalStacksBlockReference {
  stacksBlockHeight: number;
  indexBlockHash: string;
  burnBlockHeight?: number;
}

export type CanonicalAnchorProofInvalidReason =
  | "planned-anchor-after-live-anchor"
  | "planned-anchor-noncanonical"
  | "planned-anchor-mismatch";

export type CanonicalAnchorProofUnavailableReason =
  | "api-unavailable"
  | "api-tip-behind-live-anchor"
  | "api-tip-unstable"
  | "live-anchor-stale";

export type CanonicalAnchorProof =
  | {
      status: "proven";
      plannedAnchor: ChainAnchor;
      liveAnchor: ChainAnchor;
      apiTipHeight: number;
      apiTipIndexBlockHash: string;
    }
  | {
      status: "invalid";
      reason: CanonicalAnchorProofInvalidReason;
    }
  | {
      status: "unavailable";
      reason: CanonicalAnchorProofUnavailableReason;
    };

function sameTip(left: ApiStatus, right: ApiStatus): boolean {
  return (
    left.chain_tip.block_height === right.chain_tip.block_height &&
    left.chain_tip.block_hash === right.chain_tip.block_hash &&
    left.chain_tip.index_block_hash === right.chain_tip.index_block_hash &&
    left.chain_tip.burn_block_height === right.chain_tip.burn_block_height
  );
}

function blockMatchesReference(
  block: StacksBlockSummary,
  reference: CanonicalStacksBlockReference,
): boolean {
  return (
    block.canonical &&
    block.height === reference.stacksBlockHeight &&
    block.index_block_hash === reference.indexBlockHash &&
    (reference.burnBlockHeight === undefined ||
      block.burn_block_height === reference.burnBlockHeight)
  );
}

type CanonicalReferenceProof =
  | Exclude<CanonicalAnchorProof, { status: "proven" }>
  | {
      status: "proven";
      apiTipHeight: number;
      apiTipIndexBlockHash: string;
    };

async function proveCanonicalReferenceRelationship(
  api: CanonicalAnchorProofApi,
  planned: CanonicalStacksBlockReference,
  live: CanonicalStacksBlockReference,
  maximumAttempts: number,
): Promise<CanonicalReferenceProof> {
  if (planned.stacksBlockHeight > live.stacksBlockHeight) {
    return { status: "invalid", reason: "planned-anchor-after-live-anchor" };
  }
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const before = await api.getStatus();
      if (before.chain_tip.block_height < live.stacksBlockHeight) {
        return { status: "unavailable", reason: "api-tip-behind-live-anchor" };
      }
      const plannedBlock = await api.getBlock(planned.stacksBlockHeight);
      const liveBlock =
        planned.stacksBlockHeight === live.stacksBlockHeight
          ? plannedBlock
          : await api.getBlock(live.stacksBlockHeight);
      const after = await api.getStatus();
      if (!sameTip(before, after)) {
        if (attempt < maximumAttempts) continue;
        return { status: "unavailable", reason: "api-tip-unstable" };
      }
      if (!plannedBlock.canonical) {
        return { status: "invalid", reason: "planned-anchor-noncanonical" };
      }
      if (!blockMatchesReference(plannedBlock, planned)) {
        return { status: "invalid", reason: "planned-anchor-mismatch" };
      }
      if (!blockMatchesReference(liveBlock, live)) {
        return { status: "unavailable", reason: "live-anchor-stale" };
      }
      return {
        status: "proven",
        apiTipHeight: after.chain_tip.block_height,
        apiTipIndexBlockHash: after.chain_tip.index_block_hash,
      };
    } catch {
      return { status: "unavailable", reason: "api-unavailable" };
    }
  }
  return { status: "unavailable", reason: "api-tip-unstable" };
}

/**
 * Proves that two stored anchors are members of one current canonical Stacks chain.
 *
 * A block-by-hash lookup is intentionally insufficient: an orphan remains retrievable by hash.
 * Reading the canonical block at both heights inside an unchanged API-tip fence establishes the
 * ancestry relation. Tip movement is retried only within the small bound and otherwise fails
 * closed without declaring the planned anchor noncanonical.
 */
export async function proveCanonicalAnchorRelationship(
  api: CanonicalAnchorProofApi,
  plannedAnchor: ChainAnchor,
  liveAnchor: ChainAnchor,
  options: { maximumAttempts?: number } = {},
): Promise<CanonicalAnchorProof> {
  const maximumAttempts = z
    .number()
    .int()
    .min(1)
    .max(3)
    .parse(options.maximumAttempts ?? 2);
  if (plannedAnchor.burnBlockHeight > liveAnchor.burnBlockHeight) {
    return { status: "invalid", reason: "planned-anchor-after-live-anchor" };
  }
  const proof = await proveCanonicalReferenceRelationship(
    api,
    plannedAnchor,
    liveAnchor,
    maximumAttempts,
  );
  return proof.status === "proven" ? { ...proof, plannedAnchor, liveAnchor } : proof;
}

/** Proves a stored local inclusion is on the current live anchor's canonical ancestry. */
export async function proveCanonicalInclusionRelationship(
  api: CanonicalAnchorProofApi,
  inclusion: Pick<CanonicalStacksBlockReference, "stacksBlockHeight" | "indexBlockHash">,
  liveAnchor: ChainAnchor,
  options: { maximumAttempts?: number } = {},
): Promise<CanonicalReferenceProof> {
  const maximumAttempts = z
    .number()
    .int()
    .min(1)
    .max(3)
    .parse(options.maximumAttempts ?? 2);
  return await proveCanonicalReferenceRelationship(api, inclusion, liveAnchor, maximumAttempts);
}
