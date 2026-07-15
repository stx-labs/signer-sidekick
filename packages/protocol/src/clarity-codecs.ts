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

export function decodeBoolean(value: ClarityValue, path = "value"): boolean {
  if (value.type === ClarityType.BoolTrue) return true;
  if (value.type === ClarityType.BoolFalse) return false;
  throw new ClarityCodecError(`expected boolean, received ${value.type}`, path);
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
