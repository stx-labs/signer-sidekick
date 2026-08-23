import { Cl, cvToHex, Pc, postConditionToHex } from "@stacks/transactions";
import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
  MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
  MANAGER_CLAIM_REWARDS_SBTC_ASSET_NAME,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import {
  deriveRewardCalculationTarget,
  type RewardCalculationCheckpoint,
} from "../chain-anchor.js";
import type { OperatorAnchorSnapshot } from "../operator-anchor-snapshot.js";
import type { StxRewardStatus } from "../reward-status.js";

export interface ManagerClaimBondBucket {
  bondIndex: bigint;
  managerSharesSats: bigint;
  earnedSats: bigint;
  feeSnapshot: { state: "absent" | "present"; effectiveFeeBips: bigint };
}

export interface ManagerClaimCheckpoint {
  rewardCycle: bigint;
  calculationCheckpoint: RewardCalculationCheckpoint;
  lastRewardComputeBurnHeight: number;
  rewardsPerToken: bigint;
  observedSignerEarnedSats: bigint;
  expectedSignerOutflowSats: bigint;
  feeSnapshot: { state: "absent" | "present"; effectiveFeeBips: bigint };
  stxEarnedSats: bigint;
  bondBuckets: ManagerClaimBondBucket[];
  effect: "remaining" | "completed" | "none" | "buckets-idle";
}

export interface ManagerClaimProposal {
  schemaVersion: 1;
  kind: "reference-manager-claim-rewards-proposal";
  adapter: {
    id: typeof MANAGER_CLAIM_REWARDS_ADAPTER_ID;
    revision: typeof MANAGER_CLAIM_REWARDS_ADAPTER_REVISION;
  };
  network: { kind: "mainnet" | "testnet"; chainId: number };
  manager: { contract: string; profileId: string; sourceSha256: string };
  contracts: { pox5: string; sbtcToken: string };
  chainAnchor: OperatorAnchorSnapshot["chainAnchor"];
  rewardCheckpoint: {
    rewardCycle: string;
    calculationCheckpoint: RewardCalculationCheckpoint;
    lastRewardComputeBurnHeight: number;
    rewardsPerToken: string;
  };
  buckets: {
    stxEarnedSats: string;
    stxFeeSnapshot: { state: "absent" | "present"; effectiveFeeBips: string };
    bond: Array<{
      bondIndex: string;
      managerSharesSats: string;
      earnedSats: string;
      feeSnapshot: { state: "absent" | "present"; effectiveFeeBips: string };
    }>;
  };
  call: {
    contract: string;
    functionName: typeof MANAGER_CLAIM_REWARDS_FUNCTION_NAME;
    functionArgs: [string, string];
  };
  expectedEffect: {
    asset: string;
    sender: string;
    recipient: string;
    amountSats: string;
    postCondition: string;
  };
}

function parsedUnsigned(value: string, label: string): bigint | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${label} is not an unsigned integer`);
  }
}

export function managerClaimNetworkKind(
  setup: OperatorAnchorSnapshot,
): "mainnet" | "testnet" | null {
  if (setup.preflight.network === "mainnet") return "mainnet";
  if (["testnet", "devnet", "regtest"].includes(setup.preflight.network)) return "testnet";
  return null;
}

/**
 * Derive the execution-neutral claim checkpoint from one anchored reward observation.
 *
 * It deliberately contains no attestation, fee payer, nonce, fee estimate, approval, signature,
 * or broadcast authority. Observe wallets and operator runs consume the same exact bucket set
 * and expected sBTC effect from here.
 */
export function managerClaimCheckpoint(
  setup: OperatorAnchorSnapshot,
  rewards: StxRewardStatus | null,
): ManagerClaimCheckpoint | null {
  if (!rewards) return null;
  const target = deriveRewardCalculationTarget(
    setup.chainAnchor,
    setup.preflight.pox.firstRewardCycleId,
  );
  if (target.status === "invalid") return null;
  const lastHeight = parsedUnsigned(
    rewards.global.lastRewardComputeBurnHeight,
    "last reward compute height",
  );
  const rewardsPerToken = parsedUnsigned(rewards.global.rewardsPerToken, "rewards per token");
  const signerEarned = parsedUnsigned(
    rewards.global.signerEarnedBeforeManagerClaimSats,
    "signer earned rewards",
  );
  const configuredFee = parsedUnsigned(rewards.manager.configuredFeeBips, "configured fee");
  const snapshottedFee =
    rewards.manager.feeSnapshotBips === null
      ? null
      : parsedUnsigned(rewards.manager.feeSnapshotBips, "snapshotted fee");
  if (
    lastHeight === null ||
    lastHeight < 1n ||
    lastHeight > BigInt(Number.MAX_SAFE_INTEGER) ||
    rewardsPerToken === null ||
    signerEarned === null ||
    configuredFee === null ||
    configuredFee > 9_999n ||
    (snapshottedFee !== null && snapshottedFee > 9_999n) ||
    rewards.status !== "ready" ||
    rewards.managerPrincipal !== setup.manager.managerPrincipal ||
    rewards.pox5ContractId !== setup.preflight.pox.pox5ContractId ||
    rewards.ingestion === null ||
    rewards.rewardCycle !== target.rewardCycle ||
    rewards.global.lastComputedRewardCycle !== String(target.rewardCycle) ||
    rewards.observedAt.burnBlockHeight !== setup.chainAnchor.burnBlockHeight ||
    rewards.observedAt.stacksTipHeight !== setup.chainAnchor.stacksBlockHeight ||
    lastHeight !== BigInt(target.expectedLastRewardComputeBurnHeight)
  ) {
    return null;
  }
  const stxBucket = rewards.buckets.find(({ bondIndex }) => bondIndex === null);
  if (
    !stxBucket ||
    parsedUnsigned(stxBucket.signerEarnedBeforeManagerClaimSats, "stx bucket") !== signerEarned
  ) {
    return null;
  }
  const bondBuckets: ManagerClaimBondBucket[] = [];
  for (const bucket of rewards.buckets) {
    if (bucket.bondIndex === null || !bucket.participating) continue;
    const bondIndex = parsedUnsigned(bucket.bondIndex, "bond index");
    const managerSharesSats = parsedUnsigned(bucket.managerSharesSats, "bond bucket shares");
    const earnedSats = parsedUnsigned(
      bucket.signerEarnedBeforeManagerClaimSats,
      "bond bucket earnings",
    );
    const bucketFee =
      bucket.feeSnapshotBips === null
        ? null
        : parsedUnsigned(bucket.feeSnapshotBips, "bond bucket fee snapshot");
    if (
      bondIndex === null ||
      managerSharesSats === null ||
      earnedSats === null ||
      (bucketFee !== null && bucketFee > 9_999n)
    ) {
      return null;
    }
    bondBuckets.push({
      bondIndex,
      managerSharesSats,
      earnedSats,
      feeSnapshot: {
        state: bucketFee === null ? "absent" : "present",
        effectiveFeeBips: bucketFee ?? configuredFee,
      },
    });
  }
  bondBuckets.sort((left, right) =>
    left.bondIndex < right.bondIndex ? -1 : left.bondIndex > right.bondIndex ? 1 : 0,
  );
  if (
    new Set(bondBuckets.map(({ bondIndex }) => bondIndex.toString())).size !== bondBuckets.length
  ) {
    return null;
  }
  const totalEarned =
    signerEarned + bondBuckets.reduce((total, bucket) => total + bucket.earnedSats, 0n);
  const anyFeePinned =
    snapshottedFee !== null ||
    bondBuckets.some(({ feeSnapshot }) => feeSnapshot.state === "present");
  return {
    rewardCycle: BigInt(rewards.rewardCycle),
    calculationCheckpoint: target.calculationCheckpoint,
    lastRewardComputeBurnHeight: Number(lastHeight),
    rewardsPerToken,
    observedSignerEarnedSats: totalEarned,
    expectedSignerOutflowSats: totalEarned,
    feeSnapshot: {
      state: snapshottedFee === null ? "absent" : "present",
      effectiveFeeBips: snapshottedFee ?? configuredFee,
    },
    stxEarnedSats: signerEarned,
    bondBuckets,
    effect:
      totalEarned > 0n
        ? "remaining"
        : anyFeePinned
          ? "completed"
          : bondBuckets.length > 0 || stxBucket.participating
            ? "buckets-idle"
            : "none",
  };
}

export function buildManagerClaimProposal(input: {
  setup: OperatorAnchorSnapshot;
  rewards: StxRewardStatus | null;
}): ManagerClaimProposal | null {
  const checkpoint = managerClaimCheckpoint(input.setup, input.rewards);
  const kind = managerClaimNetworkKind(input.setup);
  const pox5 = input.setup.preflight.pox.pox5ContractId;
  const sbtcToken = input.setup.preflight.pox.sbtcTokenContract;
  const sourceSha256 = input.setup.manager.source.sha256;
  const profileId = input.setup.manager.source.profileId;
  if (
    checkpoint?.effect !== "remaining" ||
    !kind ||
    !pox5 ||
    !sbtcToken ||
    !sourceSha256 ||
    !profileId
  ) {
    return null;
  }
  const postCondition = postConditionToHex(
    Pc.principal(pox5)
      .willSendEq(checkpoint.expectedSignerOutflowSats)
      .ft(sbtcToken as `${string}.${string}`, MANAGER_CLAIM_REWARDS_SBTC_ASSET_NAME),
  );
  return {
    schemaVersion: 1,
    kind: "reference-manager-claim-rewards-proposal",
    adapter: {
      id: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
      revision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
    },
    network: { kind, chainId: input.setup.preflight.node.networkId },
    manager: {
      contract: input.setup.manager.managerPrincipal,
      profileId,
      sourceSha256,
    },
    contracts: { pox5, sbtcToken },
    chainAnchor: input.setup.chainAnchor,
    rewardCheckpoint: {
      rewardCycle: checkpoint.rewardCycle.toString(),
      calculationCheckpoint: checkpoint.calculationCheckpoint,
      lastRewardComputeBurnHeight: checkpoint.lastRewardComputeBurnHeight,
      rewardsPerToken: checkpoint.rewardsPerToken.toString(),
    },
    buckets: {
      stxEarnedSats: checkpoint.stxEarnedSats.toString(),
      stxFeeSnapshot: {
        state: checkpoint.feeSnapshot.state,
        effectiveFeeBips: checkpoint.feeSnapshot.effectiveFeeBips.toString(),
      },
      bond: checkpoint.bondBuckets.map((bucket) => ({
        bondIndex: bucket.bondIndex.toString(),
        managerSharesSats: bucket.managerSharesSats.toString(),
        earnedSats: bucket.earnedSats.toString(),
        feeSnapshot: {
          state: bucket.feeSnapshot.state,
          effectiveFeeBips: bucket.feeSnapshot.effectiveFeeBips.toString(),
        },
      })),
    },
    call: {
      contract: input.setup.manager.managerPrincipal,
      functionName: MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
      functionArgs: [
        cvToHex(Cl.list(checkpoint.bondBuckets.map(({ bondIndex }) => Cl.uint(bondIndex)))),
        cvToHex(Cl.uint(checkpoint.rewardCycle)),
      ],
    },
    expectedEffect: {
      asset: `${sbtcToken}::${MANAGER_CLAIM_REWARDS_SBTC_ASSET_NAME}`,
      sender: pox5,
      recipient: input.setup.manager.managerPrincipal,
      amountSats: checkpoint.expectedSignerOutflowSats.toString(),
      postCondition,
    },
  };
}
