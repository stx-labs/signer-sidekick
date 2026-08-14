import { ClarityType, type ClarityValue } from "@stacks/transactions";
import { ClarityCodecError, decodeUInt } from "./clarity-codecs.js";

export interface Pox5CalculateRewardsEvent {
  kind: "calculate-rewards";
  topic: "calculate-rewards";
  bondPeriods: string[];
  calculationBurnHeight: string;
  grossAccruedRewardsSats: string;
  totalBondRewardsSats: string;
  reserveDepositSats: string;
  reserveBalanceSats: string;
  rewardCycle: string;
  totalStxStakerRewardsSats: string;
  cycleStakedUstx: string;
  accruedRewardsPerUstx: string;
  cumulativeRewardsPerUstx: string;
}

function tuple(value: ClarityValue, path: string): Record<string, ClarityValue> {
  if (value.type !== ClarityType.Tuple) {
    throw new ClarityCodecError(`expected tuple, received ${value.type}`, path);
  }
  return value.value;
}

function field(value: Record<string, ClarityValue>, name: string, path: string): ClarityValue {
  const child = value[name];
  if (!child) throw new ClarityCodecError(`missing tuple field ${name}`, path);
  return child;
}

function uintText(value: Record<string, ClarityValue>, name: string, path: string): string {
  return decodeUInt(field(value, name, path), `${path}.${name}`).toString();
}

function topic(value: ClarityValue, path: string): string {
  if (value.type !== ClarityType.StringASCII && value.type !== ClarityType.StringUTF8) {
    throw new ClarityCodecError(`expected string, received ${value.type}`, path);
  }
  return value.value;
}

/** Decode only the protocol-owned PoX-5 reward calculation print. */
export function decodePox5CalculateRewardsEvent(
  value: ClarityValue,
  path = "pox5-calculate-rewards-event",
): Pox5CalculateRewardsEvent | null {
  const event = tuple(value, path);
  if (topic(field(event, "topic", path), `${path}.topic`) !== "calculate-rewards") return null;
  const bondPeriods = field(event, "bond-periods", path);
  if (bondPeriods.type !== ClarityType.List) {
    throw new ClarityCodecError(
      `expected list, received ${bondPeriods.type}`,
      `${path}.bond-periods`,
    );
  }
  return {
    kind: "calculate-rewards",
    topic: "calculate-rewards",
    bondPeriods: bondPeriods.value.map((entry, index) =>
      decodeUInt(entry, `${path}.bond-periods[${index}]`).toString(),
    ),
    calculationBurnHeight: uintText(event, "calculation-height", path),
    grossAccruedRewardsSats: uintText(event, "gross-accrued-rewards", path),
    totalBondRewardsSats: uintText(event, "total-bond-rewards", path),
    reserveDepositSats: uintText(event, "reserve-deposit", path),
    reserveBalanceSats: uintText(event, "reserve-balance", path),
    rewardCycle: uintText(event, "stx-cycle", path),
    totalStxStakerRewardsSats: uintText(event, "total-stx-staker-rewards", path),
    cycleStakedUstx: uintText(event, "cycle-staked-ustx", path),
    accruedRewardsPerUstx: uintText(event, "accrued-rewards-per-ustx", path),
    cumulativeRewardsPerUstx: uintText(event, "cumulative-rewards-per-ustx", path),
  };
}
