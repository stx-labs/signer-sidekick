import { createHash } from "node:crypto";
import {
  ClarityType,
  deserializeTransaction,
  makeUnsignedSTXTokenTransfer,
  PayloadType,
  serializeTransaction,
  type TokenTransferPayloadWire,
  validateStacksAddress,
} from "@stacks/transactions";
import { z } from "zod";

/**
 * Sealed plan for sweeping the gas wallet's remaining STX to an operator-entered address
 * (plan §7.6, ADR 0010 authorization variant `gas-wallet-sweep`).
 *
 * The plan is a pure function of its material: the signer rebuilds the unsigned transaction from
 * the material and refuses to sign unless the bytes and digest match. An STX token-transfer payload
 * fixes the exact amount and recipient in the transaction itself, so the wallet can never send more
 * than the reviewed amount.
 */

export const GAS_WALLET_SWEEP_PLAN_SCHEMA_VERSION = 1 as const;

const ustxSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);

export const gasWalletSweepPlanMaterialSchema = z
  .object({
    schemaVersion: z.literal(GAS_WALLET_SWEEP_PLAN_SCHEMA_VERSION),
    network: z
      .object({
        kind: z.enum(["mainnet", "testnet"]),
        chainId: z.number().int().nonnegative(),
      })
      .strict(),
    sender: z
      .object({
        principal: z.string().min(1),
        publicKey: z.string().regex(/^(02|03)[0-9a-f]{64}$/),
      })
      .strict(),
    recipient: z.string().min(1),
    amountUstx: ustxSchema,
    feeUstx: ustxSchema,
    nonce: ustxSchema,
    balanceUstx: ustxSchema,
    anchor: z
      .object({
        indexBlockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
      })
      .strict(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type GasWalletSweepPlanMaterial = z.infer<typeof gasWalletSweepPlanMaterialSchema>;

export const gasWalletSweepPlanSchema = z
  .object({
    kind: z.literal("gas-wallet-sweep"),
    planSha256: z.string().regex(/^[0-9a-f]{64}$/),
    unsignedTransactionHex: z.string().regex(/^[0-9a-f]+$/),
    unsignedTransactionSha256: z.string().regex(/^[0-9a-f]{64}$/),
    material: gasWalletSweepPlanMaterialSchema,
  })
  .strict();
export type GasWalletSweepPlan = z.infer<typeof gasWalletSweepPlanSchema>;

export class GasWalletSweepPlanError extends Error {
  constructor(
    readonly code:
      | "invalid-recipient"
      | "recipient-is-wallet"
      | "insufficient-balance"
      | "invalid-material"
      | "plan-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "GasWalletSweepPlanError";
  }
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Sweep material is not canonical JSON");
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function transactionNetwork(material: GasWalletSweepPlanMaterial) {
  const mainnet = material.network.kind === "mainnet";
  return {
    chainId: material.network.chainId,
    transactionVersion: mainnet ? 0x00 : 0x80,
    peerNetworkId: mainnet ? 0x1700_0000 : 0xff00_0000,
    magicBytes: mainnet ? "X2" : "T2",
    bootAddress: mainnet ? "SP000000000000000000002Q6VF78" : "ST000000000000000000002AMW42H",
    addressVersion: mainnet ? { singleSig: 22, multiSig: 20 } : { singleSig: 26, multiSig: 21 },
    client: { baseUrl: "http://transaction-planner.invalid" },
  };
}

/** Standard principals only, on the wallet's network, and never the wallet itself. */
export function validateSweepRecipient(
  recipient: string,
  network: "mainnet" | "testnet",
  walletPrincipal: string,
): string {
  const value = recipient.trim();
  if (!value || value.includes(".") || !validateStacksAddress(value)) {
    throw new GasWalletSweepPlanError(
      "invalid-recipient",
      "Sweep recipient must be a standard Stacks address",
    );
  }
  const prefixes = network === "mainnet" ? ["SP", "SM"] : ["ST", "SN"];
  if (!prefixes.some((prefix) => value.startsWith(prefix))) {
    throw new GasWalletSweepPlanError(
      "invalid-recipient",
      `Sweep recipient must be a ${network} address`,
    );
  }
  if (value === walletPrincipal) {
    throw new GasWalletSweepPlanError(
      "recipient-is-wallet",
      "Sweep recipient must be a different address than the gas wallet",
    );
  }
  return value;
}

/** Renders a token-transfer payload recipient; sweeps only ever target standard principals. */
export function sweepPayloadRecipient(payload: TokenTransferPayloadWire): string | null {
  const recipient = payload.recipient as { type: string; value?: unknown };
  if (recipient.type !== ClarityType.PrincipalStandard || typeof recipient.value !== "string") {
    return null;
  }
  return recipient.value;
}

async function buildUnsignedSweep(material: GasWalletSweepPlanMaterial): Promise<string> {
  const amount = BigInt(material.amountUstx);
  const transaction = await makeUnsignedSTXTokenTransfer({
    recipient: material.recipient,
    amount,
    fee: BigInt(material.feeUstx),
    nonce: BigInt(material.nonce),
    publicKey: material.sender.publicKey,
    network: transactionNetwork(material),
    memo: "",
  });
  const hex = serializeTransaction(transaction);
  const roundTrip = deserializeTransaction(hex);
  const payload = roundTrip.payload as TokenTransferPayloadWire;
  if (
    roundTrip.payload.payloadType !== PayloadType.TokenTransfer ||
    payload.amount !== amount ||
    sweepPayloadRecipient(payload) !== material.recipient ||
    roundTrip.auth.spendingCondition.nonce !== BigInt(material.nonce) ||
    roundTrip.auth.spendingCondition.fee !== BigInt(material.feeUstx)
  ) {
    throw new GasWalletSweepPlanError(
      "plan-mismatch",
      "Unsigned sweep did not preserve the sealed amount, recipient, nonce, and fee",
    );
  }
  return hex;
}

export interface PlanGasWalletSweepInput {
  network: "mainnet" | "testnet";
  chainId: number;
  sender: { principal: string; publicKey: string };
  recipient: string;
  balanceUstx: bigint;
  feeUstx: bigint;
  nonce: bigint;
  indexBlockHash: `0x${string}`;
  createdAt: Date;
  expiresAt: Date;
}

/** Builds the sealed sweep plan: `amount = balance - fee` to a standard principal on this network. */
export async function planGasWalletSweep(
  input: PlanGasWalletSweepInput,
): Promise<GasWalletSweepPlan> {
  const recipient = validateSweepRecipient(input.recipient, input.network, input.sender.principal);
  if (input.feeUstx <= 0n) {
    throw new GasWalletSweepPlanError("invalid-material", "Sweep fee must be positive");
  }
  if (input.balanceUstx <= input.feeUstx) {
    throw new GasWalletSweepPlanError(
      "insufficient-balance",
      "The gas wallet balance does not cover the sweep transaction fee",
    );
  }
  const material = gasWalletSweepPlanMaterialSchema.parse({
    schemaVersion: GAS_WALLET_SWEEP_PLAN_SCHEMA_VERSION,
    network: { kind: input.network, chainId: input.chainId },
    sender: { principal: input.sender.principal, publicKey: input.sender.publicKey.toLowerCase() },
    recipient,
    amountUstx: (input.balanceUstx - input.feeUstx).toString(),
    feeUstx: input.feeUstx.toString(),
    nonce: input.nonce.toString(),
    balanceUstx: input.balanceUstx.toString(),
    anchor: { indexBlockHash: input.indexBlockHash },
    createdAt: input.createdAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  } satisfies GasWalletSweepPlanMaterial);
  const unsignedTransactionHex = await buildUnsignedSweep(material);
  return {
    kind: "gas-wallet-sweep",
    planSha256: sha256Hex(canonicalJson(material)),
    unsignedTransactionHex,
    unsignedTransactionSha256: sha256Hex(Buffer.from(unsignedTransactionHex, "hex")),
    material,
  };
}

/** Rebuilds the plan from its material and fails unless every sealed byte matches. */
export async function revalidateGasWalletSweepPlan(
  plan: GasWalletSweepPlan,
): Promise<GasWalletSweepPlan> {
  const parsed = gasWalletSweepPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new GasWalletSweepPlanError("invalid-material", "Sweep plan material is malformed");
  }
  const material = parsed.data.material;
  validateSweepRecipient(material.recipient, material.network.kind, material.sender.principal);
  if (BigInt(material.balanceUstx) !== BigInt(material.amountUstx) + BigInt(material.feeUstx)) {
    throw new GasWalletSweepPlanError("plan-mismatch", "Sweep amount and fee do not cover balance");
  }
  const unsignedTransactionHex = await buildUnsignedSweep(material);
  if (
    unsignedTransactionHex !== parsed.data.unsignedTransactionHex ||
    sha256Hex(Buffer.from(unsignedTransactionHex, "hex")) !==
      parsed.data.unsignedTransactionSha256 ||
    sha256Hex(canonicalJson(material)) !== parsed.data.planSha256
  ) {
    throw new GasWalletSweepPlanError("plan-mismatch", "Sweep plan does not match its material");
  }
  return parsed.data;
}
