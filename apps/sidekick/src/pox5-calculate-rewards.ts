import {
  decodeBoolean,
  decodePox5ProtocolBond,
  decodeUInt,
  encodeOptionalUIntHex,
  encodePrincipalHex,
  encodeUIntHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import { bondPeriodsForRewardCycle } from "@stx-labs/signer-sidekick-protocol/pox5-bonds";
import {
  encodePox5CalculateRewardsArguments,
  orderPox5CalculationBonds,
  POX5_CALCULATE_REWARDS_ADAPTER_ID,
  POX5_CALCULATE_REWARDS_ADAPTER_REVISION,
  type Pox5CalculationBond,
  Pox5RewardSimulationError,
  type Pox5RewardSimulationInput,
  simulatePox5CalculateRewards,
} from "@stx-labs/signer-sidekick-protocol/pox5-calculate-rewards";
import { type ChainAnchor, deriveRewardCalculationTarget } from "./chain-anchor.js";
import type { ChainReadOptions } from "./chain-clients.js";
import type { RewardStatusNode } from "./reward-status.js";

export interface Pox5CalculateRewardsObservation {
  adapter: {
    id: typeof POX5_CALCULATE_REWARDS_ADAPTER_ID;
    revision: typeof POX5_CALCULATE_REWARDS_ADAPTER_REVISION;
  };
  targetRewardCycle: number;
  targetCheckpoint: "first-half" | "second-half";
  expectedLastRewardComputeBurnHeight: number;
  observedLastRewardComputeBurnHeight: string;
  grossAccruedRewardsSats: string;
  activeBonds: Array<{
    bondIndex: string;
    targetRateBips: string;
    stxValueRatio: string;
    minUstxRatioBips: string;
  }>;
  functionArgs: [string];
}

export interface Pox5CurrentPoolEstimate {
  kind: "if-calculated-now";
  targetRewardCycle: number;
  targetCheckpoint: "first-half" | "second-half";
  calculationBurnHeight: number;
  grossSats: string;
  stxSats: string;
  bondSats: string;
  inputs: {
    globalStxSharesUstx: string;
    managerStxSharesUstx: string;
    activeBonds: Array<{
      bondIndex: string;
      targetRateBips: string;
      globalSharesSats: string;
      managerSharesSats: string;
    }>;
  };
  assumptions: Array<
    | "current-global-accrual"
    | "current-cycle-shares"
    | "current-active-bond-set"
    | "contract-integer-rounding"
  >;
}

export interface Pox5PoolSimulationSnapshot {
  currentEstimate: Pox5CurrentPoolEstimate;
  simulationInput: Pox5RewardSimulationInput;
}

export class Pox5CalculateRewardsError extends Error {
  constructor(
    readonly code: "invalid-target" | "already-computed" | "incomplete-bond-state",
    message: string,
  ) {
    super(message);
    this.name = "Pox5CalculateRewardsError";
  }
}

function readOptions(chainAnchor: ChainAnchor): ChainReadOptions {
  return { tip: chainAnchor.indexBlockHash };
}

async function readActiveCalculationBonds(input: {
  node: Pick<RewardStatusNode, "callReadOnly">;
  pox5ContractId: string;
  sender: string;
  rewardCycle: number;
  calculationBurnHeight: number;
  firstBondPeriodCycle: bigint;
  options: ChainReadOptions;
}): Promise<Pox5CalculationBond[]> {
  const candidatePeriods = bondPeriodsForRewardCycle(
    BigInt(input.rewardCycle),
    input.firstBondPeriodCycle,
  );
  const candidates = await Promise.all(
    candidatePeriods.map(async (bondIndex): Promise<Pox5CalculationBond | null> => {
      const [bondValue, activeValue] = await Promise.all([
        input.node.callReadOnly(
          input.pox5ContractId,
          "get-protocol-bond",
          input.sender,
          [encodeUIntHex(bondIndex)],
          input.options,
        ),
        input.node.callReadOnly(
          input.pox5ContractId,
          "is-bond-active-at-height",
          input.sender,
          [encodeUIntHex(bondIndex), encodeUIntHex(BigInt(input.calculationBurnHeight))],
          input.options,
        ),
      ]);
      const bond = decodePox5ProtocolBond(bondValue, `get-protocol-bond(${bondIndex})`);
      const active = decodeBoolean(activeValue, `is-bond-active-at-height(${bondIndex})`);
      if (!bond) {
        if (active) {
          throw new Pox5CalculateRewardsError(
            "incomplete-bond-state",
            `PoX-5 reported bond period ${bondIndex} active without returning its definition`,
          );
        }
        return null;
      }
      if (!active) return null;
      return {
        bondIndex,
        targetRateBips: bond.targetRate,
        stxValueRatio: bond.stxValueRatio,
        minUstxRatioBips: bond.minUstxRatio,
      };
    }),
  );
  return orderPox5CalculationBonds(
    candidates.filter((bond): bond is Pox5CalculationBond => bond !== null),
  );
}

function simulateManagerPoolEstimate(input: {
  simulationInput: Pox5RewardSimulationInput;
  grossAccruedRewardsSats: bigint;
  targetRewardCycle: number;
  targetCheckpoint: "first-half" | "second-half";
  calculationBurnHeight: number;
}): Pox5CurrentPoolEstimate {
  const simulation = simulatePox5CalculateRewards({
    ...input.simulationInput,
    grossAccruedRewardsSats: input.grossAccruedRewardsSats,
  });
  if (!simulation.manager) {
    throw new Pox5RewardSimulationError("manager shares are incomplete at the selected anchor");
  }
  const managerStxSharesUstx = input.simulationInput.managerStxSharesUstx;
  if (managerStxSharesUstx === undefined) {
    throw new Pox5RewardSimulationError("manager STX shares are missing at the selected anchor");
  }
  return {
    kind: "if-calculated-now",
    targetRewardCycle: input.targetRewardCycle,
    targetCheckpoint: input.targetCheckpoint,
    calculationBurnHeight: input.calculationBurnHeight,
    grossSats: simulation.manager.grossRewardSats.toString(),
    stxSats: simulation.manager.stxRewardSats.toString(),
    bondSats: simulation.manager.bondRewardSats.toString(),
    inputs: {
      globalStxSharesUstx: simulation.cycleStakedUstx.toString(),
      managerStxSharesUstx: managerStxSharesUstx.toString(),
      activeBonds: input.simulationInput.bonds.map((bond) => {
        if (bond.managerSharesSats === undefined) {
          throw new Pox5RewardSimulationError(
            `manager shares are missing for bond ${bond.bondIndex}`,
          );
        }
        return {
          bondIndex: bond.bondIndex.toString(),
          targetRateBips: bond.targetRateBips.toString(),
          globalSharesSats: bond.totalSharesSats.toString(),
          managerSharesSats: bond.managerSharesSats.toString(),
        };
      }),
    },
    assumptions: [
      "current-global-accrual",
      "current-cycle-shares",
      "current-active-bond-set",
      "contract-integer-rounding",
    ],
  };
}

export async function readPox5PoolSimulationSnapshot(input: {
  node: Pick<RewardStatusNode, "callReadOnly">;
  pox5ContractId: string;
  managerPrincipal: string;
  chainAnchor: ChainAnchor;
  targetRewardCycle: number;
  targetCheckpoint: "first-half" | "second-half";
  calculationBurnHeight: number;
  grossAccruedRewardsSats: bigint;
}): Promise<Pox5PoolSimulationSnapshot> {
  const options = readOptions(input.chainAnchor);
  const rewardCycle = BigInt(input.targetRewardCycle);
  const stxBucket = encodeOptionalUIntHex(null);
  const cycleArg = encodeUIntHex(rewardCycle);
  const [firstBondCycleValue, reserveValue, totalStxValue, currentStxRptValue, managerStxValue] =
    await Promise.all([
      input.node.callReadOnly(
        input.pox5ContractId,
        "bond-period-to-reward-cycle",
        input.managerPrincipal,
        [encodeUIntHex(0n)],
        options,
      ),
      input.node.callReadOnly(
        input.pox5ContractId,
        "get-reserve-balance",
        input.managerPrincipal,
        [],
        options,
      ),
      input.node.callReadOnly(
        input.pox5ContractId,
        "get-total-shares-staked-for-cycle",
        input.managerPrincipal,
        [cycleArg, stxBucket],
        options,
      ),
      input.node.callReadOnly(
        input.pox5ContractId,
        "get-rewards-per-token-for-cycle",
        input.managerPrincipal,
        [cycleArg, stxBucket],
        options,
      ),
      input.node.callReadOnly(
        input.pox5ContractId,
        "get-signer-shares-staked-for-cycle",
        input.managerPrincipal,
        [encodePrincipalHex(input.managerPrincipal), cycleArg, stxBucket],
        options,
      ),
    ]);
  const activeBonds = await readActiveCalculationBonds({
    node: input.node,
    pox5ContractId: input.pox5ContractId,
    sender: input.managerPrincipal,
    rewardCycle: input.targetRewardCycle,
    calculationBurnHeight: input.calculationBurnHeight,
    firstBondPeriodCycle: decodeUInt(firstBondCycleValue, "bond-period-to-reward-cycle"),
    options,
  });
  const simulationBonds = await Promise.all(
    activeBonds.map(async (bond) => {
      const bondArg = encodeOptionalUIntHex(bond.bondIndex);
      const [totalSharesValue, currentRptValue, managerSharesValue] = await Promise.all([
        input.node.callReadOnly(
          input.pox5ContractId,
          "get-total-shares-staked-for-cycle",
          input.managerPrincipal,
          [cycleArg, bondArg],
          options,
        ),
        input.node.callReadOnly(
          input.pox5ContractId,
          "get-rewards-per-token-for-cycle",
          input.managerPrincipal,
          [cycleArg, bondArg],
          options,
        ),
        input.node.callReadOnly(
          input.pox5ContractId,
          "get-signer-shares-staked-for-cycle",
          input.managerPrincipal,
          [encodePrincipalHex(input.managerPrincipal), cycleArg, bondArg],
          options,
        ),
      ]);
      return {
        bondIndex: bond.bondIndex,
        targetRateBips: bond.targetRateBips,
        stxValueRatio: bond.stxValueRatio,
        totalSharesSats: decodeUInt(
          totalSharesValue,
          `get-total-shares-staked-for-cycle(${bond.bondIndex})`,
        ),
        currentRewardsPerSat: decodeUInt(
          currentRptValue,
          `get-rewards-per-token-for-cycle(${bond.bondIndex})`,
        ),
        managerSharesSats: decodeUInt(
          managerSharesValue,
          `get-signer-shares-staked-for-cycle(${bond.bondIndex})`,
        ),
      };
    }),
  );
  const simulationInput: Pox5RewardSimulationInput = {
    grossAccruedRewardsSats: input.grossAccruedRewardsSats,
    currentReserveBalanceSats: decodeUInt(reserveValue, "get-reserve-balance"),
    cycleStakedUstx: decodeUInt(totalStxValue, "get-total-shares-staked-for-cycle(stx)"),
    currentRewardsPerUstx: decodeUInt(currentStxRptValue, "get-rewards-per-token-for-cycle(stx)"),
    managerStxSharesUstx: decodeUInt(managerStxValue, "get-signer-shares-staked-for-cycle(stx)"),
    bonds: simulationBonds,
  };
  return {
    simulationInput,
    currentEstimate: simulateManagerPoolEstimate({
      simulationInput,
      grossAccruedRewardsSats: input.grossAccruedRewardsSats,
      targetRewardCycle: input.targetRewardCycle,
      targetCheckpoint: input.targetCheckpoint,
      calculationBurnHeight: input.calculationBurnHeight,
    }),
  };
}

export function simulatePox5PoolEstimateAtGross(input: {
  snapshot: Pox5PoolSimulationSnapshot;
  grossAccruedRewardsSats: bigint;
}): Pox5CurrentPoolEstimate {
  const current = input.snapshot.currentEstimate;
  return simulateManagerPoolEstimate({
    simulationInput: input.snapshot.simulationInput,
    grossAccruedRewardsSats: input.grossAccruedRewardsSats,
    targetRewardCycle: current.targetRewardCycle,
    targetCheckpoint: current.targetCheckpoint,
    calculationBurnHeight: current.calculationBurnHeight,
  });
}

/**
 * Reads and seals every protocol-global input to `pox-5::calculate-rewards` at one node anchor.
 *
 * PoX-5 has no iterable map API. Its own validation examines at most the six periods overlapping
 * the calculation cycle, so Sidekick derives that same bounded candidate window, reads each map
 * entry and active predicate from the node, and orders the complete active set with the reviewed
 * adapter before it ever opens a wallet.
 */
export async function readPox5CalculateRewardsObservation(input: {
  node: RewardStatusNode;
  pox5ContractId: string;
  sender: string;
  chainAnchor: ChainAnchor;
  firstRewardCycleId?: number | null;
}): Promise<Pox5CalculateRewardsObservation> {
  const target = deriveRewardCalculationTarget(input.chainAnchor, input.firstRewardCycleId);
  if (target.status === "invalid") {
    throw new Pox5CalculateRewardsError(
      "invalid-target",
      `The current chain anchor has no valid PoX-5 reward-calculation target (${target.reason})`,
    );
  }
  const options = readOptions(input.chainAnchor);
  const [lastComputeValue, accruedValue, firstBondCycleValue] = await Promise.all([
    input.node.callReadOnly(
      input.pox5ContractId,
      "get-last-reward-compute-height",
      input.sender,
      [],
      options,
    ),
    input.node.callReadOnly(input.pox5ContractId, "get-new-rewards", input.sender, [], options),
    input.node.callReadOnly(
      input.pox5ContractId,
      "bond-period-to-reward-cycle",
      input.sender,
      [encodeUIntHex(0n)],
      options,
    ),
  ]);
  const observedLastRewardComputeBurnHeight = decodeUInt(
    lastComputeValue,
    "get-last-reward-compute-height",
  );
  if (observedLastRewardComputeBurnHeight >= BigInt(target.expectedLastRewardComputeBurnHeight)) {
    throw new Pox5CalculateRewardsError(
      "already-computed",
      `PoX-5 reward calculation already reached Bitcoin block ${observedLastRewardComputeBurnHeight}`,
    );
  }

  const activeBonds = await readActiveCalculationBonds({
    node: input.node,
    pox5ContractId: input.pox5ContractId,
    sender: input.sender,
    rewardCycle: target.rewardCycle,
    calculationBurnHeight: target.expectedLastRewardComputeBurnHeight,
    firstBondPeriodCycle: decodeUInt(firstBondCycleValue, "bond-period-to-reward-cycle"),
    options,
  });
  return {
    adapter: {
      id: POX5_CALCULATE_REWARDS_ADAPTER_ID,
      revision: POX5_CALCULATE_REWARDS_ADAPTER_REVISION,
    },
    targetRewardCycle: target.rewardCycle,
    targetCheckpoint: target.calculationCheckpoint,
    expectedLastRewardComputeBurnHeight: target.expectedLastRewardComputeBurnHeight,
    observedLastRewardComputeBurnHeight: observedLastRewardComputeBurnHeight.toString(),
    grossAccruedRewardsSats: decodeUInt(accruedValue, "get-new-rewards").toString(),
    activeBonds: activeBonds.map((bond) => ({
      bondIndex: bond.bondIndex.toString(),
      targetRateBips: bond.targetRateBips.toString(),
      stxValueRatio: bond.stxValueRatio.toString(),
      minUstxRatioBips: bond.minUstxRatioBips.toString(),
    })),
    functionArgs: encodePox5CalculateRewardsArguments(activeBonds),
  };
}
