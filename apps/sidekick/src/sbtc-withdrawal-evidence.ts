import { ClarityType, type ClarityValue } from "@stacks/transactions";
import {
  ClarityCodecError,
  decodeBuffer,
  decodeUInt,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";

export interface SbtcWithdrawalCompletionProof {
  sweepTxId: `0x${string}`;
  bitcoinBlockHeight: number;
  bitcoinBlockHash: `0x${string}`;
}

function field(tuple: Record<string, ClarityValue>, name: string): ClarityValue {
  const value = tuple[name];
  if (!value) throw new ClarityCodecError(`missing tuple field ${name}`, "withdrawal-completion");
  return value;
}

function hash(value: ClarityValue, path: string): `0x${string}` {
  const hex = decodeBuffer(value, path).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new ClarityCodecError("expected a 32-byte buffer", path);
  }
  return `0x${hex}`;
}

/** Decode the node-readable proof that an sBTC withdrawal was included in a Bitcoin sweep. */
export function decodeSbtcWithdrawalCompletion(
  value: ClarityValue,
): SbtcWithdrawalCompletionProof | null {
  if (value.type === ClarityType.OptionalNone) return null;
  if (value.type !== ClarityType.OptionalSome || value.value.type !== ClarityType.Tuple) {
    throw new ClarityCodecError("expected an optional completion tuple", "withdrawal-completion");
  }
  const tuple = value.value.value;
  const height = decodeUInt(
    field(tuple, "sweep-burn-height"),
    "withdrawal-completion.sweep-burn-height",
  );
  if (height > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ClarityCodecError(
      "Bitcoin block height exceeds the safe integer range",
      "withdrawal-completion.sweep-burn-height",
    );
  }
  return {
    sweepTxId: hash(field(tuple, "sweep-txid"), "withdrawal-completion.sweep-txid"),
    bitcoinBlockHeight: Number(height),
    bitcoinBlockHash: hash(
      field(tuple, "sweep-burn-hash"),
      "withdrawal-completion.sweep-burn-hash",
    ),
  };
}
