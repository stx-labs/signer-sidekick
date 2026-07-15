import { ClarityType, type ClarityValue } from "@stacks/transactions";
import { ClarityCodecError, decodeUInt } from "./clarity-codecs.js";

export type ManagerPrintEvent =
  | {
      kind: "claim-staker-rewards";
      topic: "claim-staker-rewards";
      stakerPrincipal: string;
      rewardCycle: string;
      bondIndex: string | null;
      amountSats: string;
      l1Withdrawal: null | {
        requestId: string;
        amountSats: string;
        maxFeeSats: string;
      };
    }
  | {
      kind: "reclaim-failed-withdrawal";
      topic: "reclaim-failed-withdrawal";
      requestId: string;
      stakerPrincipal: string;
      amountSats: string;
    }
  | {
      kind: "settle-accepted-withdrawal";
      topic: "settle-accepted-withdrawal";
      requestId: string;
      stakerPrincipal: string;
      liabilityReleasedSats: string;
    }
  | {
      kind: "other";
      topic: string;
    };

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

function principal(value: ClarityValue, path: string): string {
  if (
    value.type !== ClarityType.PrincipalStandard &&
    value.type !== ClarityType.PrincipalContract
  ) {
    throw new ClarityCodecError(`expected principal, received ${value.type}`, path);
  }
  return value.value;
}

function optionalUInt(value: ClarityValue, path: string): string | null {
  if (value.type === ClarityType.OptionalNone) return null;
  if (value.type !== ClarityType.OptionalSome) {
    throw new ClarityCodecError(`expected optional, received ${value.type}`, path);
  }
  return decodeUInt(value.value, path).toString();
}

function topic(value: ClarityValue, path: string): string {
  if (value.type !== ClarityType.StringASCII && value.type !== ClarityType.StringUTF8) {
    throw new ClarityCodecError(`expected string, received ${value.type}`, path);
  }
  return value.value;
}

export function decodeManagerPrintEvent(
  value: ClarityValue,
  path = "manager-print-event",
): ManagerPrintEvent {
  const event = tuple(value, path);
  const eventTopic = topic(field(event, "topic", path), `${path}.topic`);
  if (eventTopic === "claim-staker-rewards") {
    const l1Value = field(event, "l1-withdrawal", path);
    let l1Withdrawal: Extract<ManagerPrintEvent, { kind: "claim-staker-rewards" }>["l1Withdrawal"] =
      null;
    if (l1Value.type === ClarityType.OptionalSome) {
      const l1 = tuple(l1Value.value, `${path}.l1-withdrawal`);
      l1Withdrawal = {
        requestId: decodeUInt(
          field(l1, "withdrawal-request", `${path}.l1-withdrawal`),
          `${path}.l1-withdrawal.withdrawal-request`,
        ).toString(),
        amountSats: decodeUInt(
          field(l1, "amount", `${path}.l1-withdrawal`),
          `${path}.l1-withdrawal.amount`,
        ).toString(),
        maxFeeSats: decodeUInt(
          field(l1, "max-fee", `${path}.l1-withdrawal`),
          `${path}.l1-withdrawal.max-fee`,
        ).toString(),
      };
    } else if (l1Value.type !== ClarityType.OptionalNone) {
      throw new ClarityCodecError(
        `expected optional, received ${l1Value.type}`,
        `${path}.l1-withdrawal`,
      );
    }
    return {
      kind: "claim-staker-rewards",
      topic: eventTopic,
      stakerPrincipal: principal(field(event, "staker", path), `${path}.staker`),
      rewardCycle: decodeUInt(
        field(event, "reward-cycle", path),
        `${path}.reward-cycle`,
      ).toString(),
      bondIndex: optionalUInt(field(event, "bond-index", path), `${path}.bond-index`),
      amountSats: decodeUInt(field(event, "amount-sats", path), `${path}.amount-sats`).toString(),
      l1Withdrawal,
    };
  }
  if (eventTopic === "reclaim-failed-withdrawal") {
    return {
      kind: "reclaim-failed-withdrawal",
      topic: eventTopic,
      requestId: decodeUInt(field(event, "request-id", path), `${path}.request-id`).toString(),
      stakerPrincipal: principal(field(event, "staker", path), `${path}.staker`),
      amountSats: decodeUInt(field(event, "amount-sats", path), `${path}.amount-sats`).toString(),
    };
  }
  if (eventTopic === "settle-accepted-withdrawal") {
    return {
      kind: "settle-accepted-withdrawal",
      topic: eventTopic,
      requestId: decodeUInt(field(event, "request-id", path), `${path}.request-id`).toString(),
      stakerPrincipal: principal(field(event, "staker", path), `${path}.staker`),
      liabilityReleasedSats: decodeUInt(
        field(event, "liability-released", path),
        `${path}.liability-released`,
      ).toString(),
    };
  }
  return { kind: "other", topic: eventTopic };
}
