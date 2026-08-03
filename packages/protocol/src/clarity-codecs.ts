import {
  bufferCV,
  ClarityType,
  type ClarityValue,
  cvToHex,
  deserializeCV,
  type ListCV,
  listCV,
  noneCV,
  type OptionalCV,
  principalCV,
  someCV,
  type UIntCV,
  uintCV,
} from "@stacks/transactions";

export type { ClarityValue } from "@stacks/transactions";

export class ClarityCodecError extends Error {
  constructor(
    message: string,
    readonly path = "value",
  ) {
    super(`${path}: ${message}`);
    this.name = "ClarityCodecError";
  }
}

function expectType<T extends ClarityValue["type"]>(
  value: ClarityValue,
  type: T,
  path: string,
): Extract<ClarityValue, { type: T }> {
  if (value.type !== type) {
    throw new ClarityCodecError(`expected ${type}, received ${value.type}`, path);
  }
  return value as Extract<ClarityValue, { type: T }>;
}

export function decodeClarityHex(hex: string): ClarityValue {
  if (!/^(?:0x)?[0-9a-fA-F]+$/.test(hex)) {
    throw new ClarityCodecError("expected a hex-encoded Clarity value");
  }
  return deserializeCV(hex.startsWith("0x") ? hex.slice(2) : hex);
}

export function decodeUInt(value: ClarityValue, path = "value"): bigint {
  const uint = expectType(value, ClarityType.UInt, path);
  return BigInt(uint.value);
}

export function decodeOptionalUInt(value: ClarityValue, path = "value"): bigint | null {
  if (value.type === ClarityType.OptionalNone) return null;
  return decodeUInt(expectType(value, ClarityType.OptionalSome, path).value, path);
}

export function decodeBoolean(value: ClarityValue, path = "value"): boolean {
  if (value.type === ClarityType.BoolTrue) return true;
  if (value.type === ClarityType.BoolFalse) return false;
  throw new ClarityCodecError(`expected boolean, received ${value.type}`, path);
}

export function decodeBuffer(value: ClarityValue, path = "value"): string {
  return expectType(value, ClarityType.Buffer, path).value;
}

export function decodeOptionalBuffer(value: ClarityValue, path = "value"): string | null {
  if (value.type === ClarityType.OptionalNone) return null;
  const buffer = expectType(
    expectType(value, ClarityType.OptionalSome, path).value,
    ClarityType.Buffer,
    path,
  );
  return buffer.value;
}

export function encodePrincipalHex(principal: string): string {
  return cvToHex(principalCV(principal));
}

export function encodeUIntHex(value: bigint): string {
  return cvToHex(uintCV(value));
}

export function encodeOptionalUIntHex(value: bigint | null): string {
  return cvToHex(value === null ? noneCV() : someCV(uintCV(value)));
}

export function encodeBufferHex(hex: string): string {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    throw new ClarityCodecError("expected an even-length hexadecimal buffer");
  }
  return cvToHex(bufferCV(Uint8Array.from(Buffer.from(hex, "hex"))));
}

export function decodeResponseOk(value: ClarityValue, path = "value"): ClarityValue {
  if (value.type === ClarityType.ResponseErr) {
    throw new ClarityCodecError(`contract returned err ${String(value.value)}`, path);
  }
  return expectType(value, ClarityType.ResponseOk, path).value;
}

function tupleField(value: ClarityValue, field: string, path: string): ClarityValue {
  const tuple = expectType(value, ClarityType.Tuple, path);
  const child = tuple.value[field];
  if (!child) throw new ClarityCodecError(`missing tuple field ${field}`, path);
  return child;
}

export interface EarnedStakerRewards {
  earned: bigint;
  fees: bigint;
}

export function decodeEarnedStakerRewards(
  value: ClarityValue,
  path = "get-earned-staker-rewards",
): EarnedStakerRewards {
  return {
    earned: decodeUInt(tupleField(value, "earned", path), `${path}.earned`),
    fees: decodeUInt(tupleField(value, "fees", path), `${path}.fees`),
  };
}

export interface PoxAddressPreference {
  versionHex: string;
  hashbytesHex: string;
  maxFee: bigint;
}

export function decodePoxAddressPreference(
  value: ClarityValue,
  path = "get-pox-addr",
): PoxAddressPreference | null {
  if (value.type === ClarityType.OptionalNone) return null;
  const preference = expectType(value, ClarityType.OptionalSome, path).value;
  const poxAddress = tupleField(preference, "pox-addr", path);
  const version = expectType(
    tupleField(poxAddress, "version", `${path}.pox-addr`),
    ClarityType.Buffer,
    `${path}.pox-addr.version`,
  );
  const hashbytes = expectType(
    tupleField(poxAddress, "hashbytes", `${path}.pox-addr`),
    ClarityType.Buffer,
    `${path}.pox-addr.hashbytes`,
  );
  return {
    versionHex: version.value,
    hashbytesHex: hashbytes.value,
    maxFee: decodeUInt(tupleField(preference, "max-fee", path), `${path}.max-fee`),
  };
}

export function decodeOptionalPrincipal(value: ClarityValue, path = "value"): string | null {
  if (value.type === ClarityType.OptionalNone) return null;
  const principal = expectType(value, ClarityType.OptionalSome, path).value;
  if (
    principal.type !== ClarityType.PrincipalStandard &&
    principal.type !== ClarityType.PrincipalContract
  ) {
    throw new ClarityCodecError(`expected principal, received ${principal.type}`, path);
  }
  return principal.value;
}

export interface Pox5StakerInfo {
  amountUstx: bigint;
  firstRewardCycle: bigint;
  numCycles: bigint;
  signer: string;
}

export function decodePox5StakerInfo(
  value: ClarityValue,
  path = "get-staker-info",
): Pox5StakerInfo | null {
  if (value.type === ClarityType.OptionalNone) return null;
  const info = expectType(value, ClarityType.OptionalSome, path).value;
  const signer = tupleField(info, "signer", path);
  if (
    signer.type !== ClarityType.PrincipalStandard &&
    signer.type !== ClarityType.PrincipalContract
  ) {
    throw new ClarityCodecError(`expected principal, received ${signer.type}`, `${path}.signer`);
  }
  return {
    amountUstx: decodeUInt(tupleField(info, "amount-ustx", path), `${path}.amount-ustx`),
    firstRewardCycle: decodeUInt(
      tupleField(info, "first-reward-cycle", path),
      `${path}.first-reward-cycle`,
    ),
    numCycles: decodeUInt(tupleField(info, "num-cycles", path), `${path}.num-cycles`),
    signer: signer.value,
  };
}

export interface Pox5CycleMembership {
  amountUstx: bigint;
  signer: string;
}

export function decodePox5CycleMembership(
  value: ClarityValue,
  path = "get-signer-cycle-membership",
): Pox5CycleMembership | null {
  if (value.type === ClarityType.OptionalNone) return null;
  const membership = expectType(value, ClarityType.OptionalSome, path).value;
  const signer = tupleField(membership, "signer", path);
  if (
    signer.type !== ClarityType.PrincipalStandard &&
    signer.type !== ClarityType.PrincipalContract
  ) {
    throw new ClarityCodecError(`expected principal, received ${signer.type}`, `${path}.signer`);
  }
  return {
    amountUstx: decodeUInt(tupleField(membership, "amount-ustx", path), `${path}.amount-ustx`),
    signer: signer.value,
  };
}

export interface Pox5BondMembership {
  bondIndex: bigint;
  amountUstx: bigint;
  amountSats: bigint;
  isL1Lock: boolean;
  signer: string;
}

/**
 * Decodes `get-bond-membership`. PoX-5 returns `none` both when the staker never joined a bond
 * and once the membership's term has ended, so a `null` here means "no active bond at this tip",
 * not "no bond row exists".
 */
export function decodePox5BondMembership(
  value: ClarityValue,
  path = "get-bond-membership",
): Pox5BondMembership | null {
  if (value.type === ClarityType.OptionalNone) return null;
  const membership = expectType(value, ClarityType.OptionalSome, path).value;
  const signer = tupleField(membership, "signer", path);
  if (
    signer.type !== ClarityType.PrincipalStandard &&
    signer.type !== ClarityType.PrincipalContract
  ) {
    throw new ClarityCodecError(`expected principal, received ${signer.type}`, `${path}.signer`);
  }
  return {
    bondIndex: decodeUInt(tupleField(membership, "bond-index", path), `${path}.bond-index`),
    amountUstx: decodeUInt(tupleField(membership, "amount-ustx", path), `${path}.amount-ustx`),
    amountSats: decodeUInt(tupleField(membership, "amount-sats", path), `${path}.amount-sats`),
    isL1Lock: decodeBoolean(tupleField(membership, "is-l1-lock", path), `${path}.is-l1-lock`),
    signer: signer.value,
  };
}

export interface Pox5ProtocolBond {
  targetRate: bigint;
  stxValueRatio: bigint;
  minUstxRatio: bigint;
}

/** Decodes `get-protocol-bond`. `none` means the bond index was never set up. */
export function decodePox5ProtocolBond(
  value: ClarityValue,
  path = "get-protocol-bond",
): Pox5ProtocolBond | null {
  if (value.type === ClarityType.OptionalNone) return null;
  const bond = expectType(value, ClarityType.OptionalSome, path).value;
  return {
    targetRate: decodeUInt(tupleField(bond, "target-rate", path), `${path}.target-rate`),
    stxValueRatio: decodeUInt(tupleField(bond, "stx-value-ratio", path), `${path}.stx-value-ratio`),
    minUstxRatio: decodeUInt(tupleField(bond, "min-ustx-ratio", path), `${path}.min-ustx-ratio`),
  };
}

export interface ClaimRewardsResult {
  totalRewards: bigint;
  bondTotals: bigint;
  stxRewards: {
    earned: bigint;
    rewardsPerToken: bigint;
  };
  bondRewards: Array<{
    bondIndex: bigint;
    earned: bigint;
    rewardsPerToken: bigint;
  }>;
}

export function decodeClaimRewardsResult(
  value: ClarityValue,
  path = "claim-rewards",
): ClaimRewardsResult {
  const result = decodeResponseOk(value, path);
  const stxRewards = tupleField(result, "stx-rewards", path);
  const bondRewards = expectType(
    tupleField(result, "bond-rewards", path),
    ClarityType.List,
    `${path}.bond-rewards`,
  );

  return {
    totalRewards: decodeUInt(tupleField(result, "total-rewards", path), `${path}.total-rewards`),
    bondTotals: decodeUInt(tupleField(result, "bond-totals", path), `${path}.bond-totals`),
    stxRewards: {
      earned: decodeUInt(tupleField(stxRewards, "earned", path), `${path}.stx-rewards.earned`),
      rewardsPerToken: decodeUInt(
        tupleField(stxRewards, "rewards-per-token", path),
        `${path}.stx-rewards.rewards-per-token`,
      ),
    },
    bondRewards: bondRewards.value.map((entry, index) => ({
      bondIndex: decodeUInt(
        tupleField(entry, "bond-index", `${path}.bond-rewards[${index}]`),
        `${path}.bond-rewards[${index}].bond-index`,
      ),
      earned: decodeUInt(
        tupleField(entry, "earned", `${path}.bond-rewards[${index}]`),
        `${path}.bond-rewards[${index}].earned`,
      ),
      rewardsPerToken: decodeUInt(
        tupleField(entry, "rewards-per-token", `${path}.bond-rewards[${index}]`),
        `${path}.bond-rewards[${index}].rewards-per-token`,
      ),
    })),
  };
}

export function encodeOptionalBondIndex(value: bigint | null): OptionalCV<UIntCV> {
  return value === null ? noneCV() : someCV(uintCV(value));
}

export function encodeBondPeriods(values: readonly bigint[]): ListCV<UIntCV> {
  if (values.length > 6) throw new ClarityCodecError("at most six bond periods are allowed");
  return listCV(values.map((value) => uintCV(value)));
}
