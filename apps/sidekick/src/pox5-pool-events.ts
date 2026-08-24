import { ClarityType, type ClarityValue } from "@stacks/transactions";
import { ClarityCodecError } from "@stx-labs/signer-sidekick-protocol/clarity-codecs";

export const pox5PoolActivityTopics = [
  "stake",
  "stake-update",
  "unstake",
  "register-for-bond",
  "update-bond-registration",
  "unstake-sbtc",
  "announce-l1-early-exit",
  "claim-staker-rewards-for-signer",
  "claim-rewards",
] as const;

export type Pox5PoolActivityTopic = (typeof pox5PoolActivityTopics)[number];
export type Pox5PoolRelationship =
  | "joined"
  | "updated"
  | "leaving"
  | "left"
  | "rewarded"
  | "collected";

export interface Pox5PoolActivityEvent {
  kind: Pox5PoolActivityTopic;
  topic: Pox5PoolActivityTopic;
  relationship: Pox5PoolRelationship;
  /** Null only for the manager-level `claim-rewards` collect print. */
  stakerPrincipal: string | null;
  signer: string | null;
  oldSigner: string | null;
  signerManager: string | null;
  amountUstx: string | null;
  amountIncreaseUstx: string | null;
  amountSats: string | null;
  amountWithdrawnSats: string | null;
  amountSatsReleased: string | null;
  rewardsClaimedSats: string | null;
  /** `reward-cycle` on reward prints (`claim-rewards`, `claim-staker-rewards-for-signer`). */
  rewardCycle: string | null;
  /** `claim-rewards` collect print: the manager's total pulled from PoX-5 for the cycle. */
  totalRewardsSats: string | null;
  stxRewardsSats: string | null;
  firstRewardCycle: string | null;
  unlockCycle: string | null;
  bondIndex: string | null;
}

function text(value: ClarityValue | undefined): string | null {
  if (value?.type !== ClarityType.StringASCII && value?.type !== ClarityType.StringUTF8)
    return null;
  return value.value;
}

function principal(value: ClarityValue | undefined): string | null {
  if (
    value?.type !== ClarityType.PrincipalStandard &&
    value?.type !== ClarityType.PrincipalContract
  ) {
    return null;
  }
  return value.value;
}

function uintText(value: ClarityValue | undefined): string | null {
  return value?.type === ClarityType.UInt ? BigInt(value.value).toString() : null;
}

/** PoX-5 prints `stx-rewards` as the claimable-rewards tuple (`{ earned, ... }`), not a bare uint. */
function nestedUintText(value: ClarityValue | undefined, key: string): string | null {
  if (value?.type !== ClarityType.Tuple) return null;
  return uintText(value.value[key]);
}

function isPoolTopic(value: string): value is Pox5PoolActivityTopic {
  return (pox5PoolActivityTopics as readonly string[]).includes(value);
}

function relationship(
  topic: Pox5PoolActivityTopic,
  managerPrincipal: string,
  signer: string | null,
  oldSigner: string | null,
): Pox5PoolRelationship {
  if (topic === "claim-rewards") return "collected";
  if (topic === "claim-staker-rewards-for-signer") return "rewarded";
  if (oldSigner === managerPrincipal && signer !== managerPrincipal) return "left";
  if (signer === managerPrincipal && oldSigner !== null && oldSigner !== managerPrincipal) {
    return "joined";
  }
  if (topic === "stake" || topic === "register-for-bond") return "joined";
  if (topic === "unstake") return "leaving";
  return "updated";
}

/**
 * Decode the universal PoX-5 prints that affect this manager's pool. Prints for other managers and
 * protocol activity outside the operator-facing roster are intentionally ignored.
 */
export function decodePox5PoolActivityEvent(
  value: ClarityValue,
  managerPrincipal: string,
  path = "pox5-pool-activity-event",
): Pox5PoolActivityEvent | null {
  if (value.type !== ClarityType.Tuple) return null;
  const tuple = value.value;
  const topic = text(tuple.topic);
  if (!topic || !isPoolTopic(topic)) return null;

  const signer = principal(tuple.signer);
  const oldSigner = principal(tuple["old-signer"]);
  const signerManager = principal(tuple["signer-manager"]);
  if (![signer, oldSigner, signerManager].includes(managerPrincipal)) return null;

  const stakerPrincipal = principal(tuple.staker);
  if (!stakerPrincipal && topic !== "claim-rewards") {
    throw new ClarityCodecError("expected staker principal", `${path}.staker`);
  }

  return {
    kind: topic,
    topic,
    relationship: relationship(topic, managerPrincipal, signer, oldSigner),
    stakerPrincipal,
    signer,
    oldSigner,
    signerManager,
    amountUstx: uintText(tuple["amount-ustx"]),
    amountIncreaseUstx: uintText(tuple["amount-increase"]),
    amountSats: uintText(tuple["amount-sats"] ?? tuple["new-amount-sats"]),
    amountWithdrawnSats: uintText(tuple["amount-withdrawn-sats"]),
    amountSatsReleased: uintText(tuple["amount-sats-released"]),
    rewardsClaimedSats: uintText(tuple["rewards-claimed"]),
    rewardCycle: uintText(tuple["reward-cycle"]),
    totalRewardsSats: uintText(tuple["total-rewards"]),
    stxRewardsSats:
      uintText(tuple["stx-rewards"]) ?? nestedUintText(tuple["stx-rewards"], "earned"),
    firstRewardCycle: uintText(tuple["first-reward-cycle"]),
    unlockCycle: uintText(tuple["unlock-cycle"]),
    bondIndex: uintText(tuple["bond-index"]),
  };
}
