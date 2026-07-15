import { cvToHex, noneCV, tupleCV, uintCV } from "@stacks/transactions";
import {
  type ClarityValue,
  decodeEarnedStakerRewards,
  decodeOptionalUInt,
  decodePoxAddressPreference,
  decodeUInt,
  encodeOptionalUIntHex,
  encodePrincipalHex,
  encodeUIntHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import type {
  RewardCycleSnapshotInput,
  SignerStakerRun,
  StoredCycleMembership,
} from "./storage/store.js";

export interface RewardStatusNode {
  callReadOnly(
    principal: string,
    functionName: string,
    sender: string,
    args: readonly string[],
  ): Promise<ClarityValue>;
  getDataVar(principal: string, variableName: string): Promise<ClarityValue>;
  getMapEntry(principal: string, mapName: string, key: string): Promise<ClarityValue>;
}

export interface RewardStatusStore {
  getLatestCompletedSignerStakerRun(
    sourceId: string,
    managerPrincipal: string,
  ): SignerStakerRun | null;
  listCycleMembershipsForCycle(
    managerPrincipal: string,
    rewardCycle: number,
    sourceId?: string | null,
  ): StoredCycleMembership[];
  putRewardCycleSnapshot?(input: RewardCycleSnapshotInput): void;
}

export interface RewardStatusOptions {
  store: RewardStatusStore;
  node: RewardStatusNode;
  sourceId: string;
  managerPrincipal: string;
  pox5ContractId: string;
  rewardCycle: number;
  observedAt: string;
  burnBlockHeight: number;
  stacksTipHeight: number;
}

export interface StakerRewardStatus {
  stakerPrincipal: string;
  rewardCycle: number;
  payout:
    | {
        kind: "direct-sbtc";
        poxAddress: null;
        maxFeeSats: null;
      }
    | {
        kind: "bitcoin-l1";
        poxAddress: {
          versionHex: string;
          hashbytesHex: string;
        };
        maxFeeSats: string;
      };
  rewards: {
    earnedSats: string;
    feeSats: string;
    grossSats: string;
  };
  claimableByPolicy: boolean;
}

export interface StxRewardStatus {
  status: "ready" | "attention";
  managerPrincipal: string;
  pox5ContractId: string;
  rewardCycle: number;
  observedAt: {
    timestamp: string;
    burnBlockHeight: number;
    stacksTipHeight: number;
  };
  ingestion: null | {
    runId: string;
    completedAt: string;
  };
  global: {
    lastRewardComputeBurnHeight: string;
    lastComputedRewardCycle: string | null;
    rewardsPerToken: string;
    signerEarnedBeforeManagerClaimSats: string;
  };
  manager: {
    configuredFeeBips: string;
    feeSnapshotBips: string | null;
    earnedFeesSats: string;
    withdrawalLiabilitySats: string;
    unclaimedStakerRewardsSats: string;
  };
  totals: {
    stakers: number;
    grossSats: string;
    earnedSats: string;
    feeSats: string;
    actionableClaims: number;
    l1ClaimsWaitingForFeeThreshold: number;
  };
  stakers: StakerRewardStatus[];
}

async function readStakerReward(
  node: RewardStatusNode,
  managerPrincipal: string,
  stakerPrincipal: string,
  rewardCycle: number,
): Promise<StakerRewardStatus> {
  const [rewardsValue, payoutValue] = await Promise.all([
    node.callReadOnly(managerPrincipal, "get-earned-staker-rewards", managerPrincipal, [
      encodePrincipalHex(stakerPrincipal),
      encodeUIntHex(BigInt(rewardCycle)),
      encodeOptionalUIntHex(null),
    ]),
    node.callReadOnly(managerPrincipal, "get-pox-addr", managerPrincipal, [
      encodePrincipalHex(stakerPrincipal),
    ]),
  ]);
  const rewards = decodeEarnedStakerRewards(rewardsValue);
  const payout = decodePoxAddressPreference(payoutValue);
  const gross = rewards.earned + rewards.fees;
  return {
    stakerPrincipal,
    rewardCycle,
    payout: payout
      ? {
          kind: "bitcoin-l1",
          poxAddress: {
            versionHex: payout.versionHex,
            hashbytesHex: payout.hashbytesHex,
          },
          maxFeeSats: payout.maxFee.toString(),
        }
      : { kind: "direct-sbtc", poxAddress: null, maxFeeSats: null },
    rewards: {
      earnedSats: rewards.earned.toString(),
      feeSats: rewards.fees.toString(),
      grossSats: gross.toString(),
    },
    claimableByPolicy: rewards.earned > 0n && (payout === null || rewards.earned >= payout.maxFee),
  };
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

export async function readStxRewardStatus(options: RewardStatusOptions): Promise<StxRewardStatus> {
  if (!Number.isSafeInteger(options.rewardCycle) || options.rewardCycle < 0) {
    throw new Error("rewardCycle must be a non-negative safe integer");
  }
  const run = options.store.getLatestCompletedSignerStakerRun(
    options.sourceId,
    options.managerPrincipal,
  );
  const cycleMemberships = run
    ? options.store
        .listCycleMembershipsForCycle(
          options.managerPrincipal,
          options.rewardCycle,
          options.sourceId,
        )
        .filter(({ signerPrincipal }) => signerPrincipal === options.managerPrincipal)
    : [];
  const stakerPrincipals = [
    ...new Set(cycleMemberships.map(({ stakerPrincipal }) => stakerPrincipal)),
  ];
  const cycleArgs = [encodeUIntHex(BigInt(options.rewardCycle)), encodeOptionalUIntHex(null)];
  const signerCycleArgs = [encodePrincipalHex(options.managerPrincipal), ...cycleArgs];
  const [
    lastRewardComputeHeightValue,
    configuredFeeValue,
    feeSnapshotValue,
    earnedFeesValue,
    withdrawalLiabilityValue,
    unclaimedStakerRewardsValue,
    rewardsPerTokenValue,
    signerEarnedValue,
  ] = await Promise.all([
    options.node.callReadOnly(
      options.pox5ContractId,
      "get-last-reward-compute-height",
      options.managerPrincipal,
      [],
    ),
    options.node.getDataVar(options.managerPrincipal, "fees-bips"),
    options.node.getMapEntry(
      options.managerPrincipal,
      "fee-bips-for-cycle",
      cvToHex(
        tupleCV({
          "reward-cycle": uintCV(BigInt(options.rewardCycle)),
          "bond-index": noneCV(),
        }),
      ),
    ),
    options.node.callReadOnly(
      options.managerPrincipal,
      "get-earned-fees",
      options.managerPrincipal,
      [],
    ),
    options.node.callReadOnly(
      options.managerPrincipal,
      "get-withdrawal-liability",
      options.managerPrincipal,
      [],
    ),
    options.node.callReadOnly(
      options.managerPrincipal,
      "get-unclaimed-staker-rewards",
      options.managerPrincipal,
      [],
    ),
    options.node.callReadOnly(
      options.pox5ContractId,
      "get-rewards-per-token-for-cycle",
      options.managerPrincipal,
      cycleArgs,
    ),
    options.node.callReadOnly(
      options.pox5ContractId,
      "get-earned",
      options.managerPrincipal,
      signerCycleArgs,
    ),
  ]);
  const lastRewardComputeHeight = decodeUInt(
    lastRewardComputeHeightValue,
    "get-last-reward-compute-height",
  );
  const lastComputedRewardCycle =
    lastRewardComputeHeight === 0n
      ? null
      : decodeUInt(
          await options.node.callReadOnly(
            options.pox5ContractId,
            "burn-height-to-reward-cycle",
            options.managerPrincipal,
            [encodeUIntHex(lastRewardComputeHeight)],
          ),
          "burn-height-to-reward-cycle",
        );

  const rewardStatuses: StakerRewardStatus[] = [];
  for (let index = 0; index < stakerPrincipals.length; index += 8) {
    rewardStatuses.push(
      ...(await Promise.all(
        stakerPrincipals
          .slice(index, index + 8)
          .map((stakerPrincipal) =>
            readStakerReward(
              options.node,
              options.managerPrincipal,
              stakerPrincipal,
              options.rewardCycle,
            ),
          ),
      )),
    );
  }

  const earned = rewardStatuses.map(({ rewards }) => BigInt(rewards.earnedSats));
  const fees = rewardStatuses.map(({ rewards }) => BigInt(rewards.feeSats));
  const status: StxRewardStatus = {
    status: run ? "ready" : "attention",
    managerPrincipal: options.managerPrincipal,
    pox5ContractId: options.pox5ContractId,
    rewardCycle: options.rewardCycle,
    observedAt: {
      timestamp: options.observedAt,
      burnBlockHeight: options.burnBlockHeight,
      stacksTipHeight: options.stacksTipHeight,
    },
    ingestion: run ? { runId: run.runId, completedAt: run.completedAt ?? run.updatedAt } : null,
    global: {
      lastRewardComputeBurnHeight: lastRewardComputeHeight.toString(),
      lastComputedRewardCycle: lastComputedRewardCycle?.toString() ?? null,
      rewardsPerToken: decodeUInt(
        rewardsPerTokenValue,
        "get-rewards-per-token-for-cycle",
      ).toString(),
      signerEarnedBeforeManagerClaimSats: decodeUInt(signerEarnedValue, "get-earned").toString(),
    },
    manager: {
      configuredFeeBips: decodeUInt(configuredFeeValue, "fees-bips").toString(),
      feeSnapshotBips:
        decodeOptionalUInt(feeSnapshotValue, "fee-bips-for-cycle")?.toString() ?? null,
      earnedFeesSats: decodeUInt(earnedFeesValue, "get-earned-fees").toString(),
      withdrawalLiabilitySats: decodeUInt(
        withdrawalLiabilityValue,
        "get-withdrawal-liability",
      ).toString(),
      unclaimedStakerRewardsSats: decodeUInt(
        unclaimedStakerRewardsValue,
        "get-unclaimed-staker-rewards",
      ).toString(),
    },
    totals: {
      stakers: rewardStatuses.length,
      grossSats: (sum(earned) + sum(fees)).toString(),
      earnedSats: sum(earned).toString(),
      feeSats: sum(fees).toString(),
      actionableClaims: rewardStatuses.filter(({ claimableByPolicy }) => claimableByPolicy).length,
      l1ClaimsWaitingForFeeThreshold: rewardStatuses.filter(
        ({ payout, rewards, claimableByPolicy }) =>
          payout.kind === "bitcoin-l1" && BigInt(rewards.earnedSats) > 0n && !claimableByPolicy,
      ).length,
    },
    stakers: rewardStatuses,
  };
  options.store.putRewardCycleSnapshot?.({
    managerPrincipal: status.managerPrincipal,
    rewardCycle: status.rewardCycle,
    status: status.status,
    observedAt: status.observedAt.timestamp,
    burnBlockHeight: status.observedAt.burnBlockHeight,
    stacksTipHeight: status.observedAt.stacksTipHeight,
    global: status.global,
    manager: status.manager,
    totals: status.totals,
    stakers: status.stakers.map(({ rewardCycle: _rewardCycle, ...staker }) => staker),
  });
  return status;
}
