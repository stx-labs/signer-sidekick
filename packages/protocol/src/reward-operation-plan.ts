import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  Cl,
  compressPublicKey,
  deserializeTransaction,
  getAddressFromPublicKey,
  makeUnsignedContractCall,
  Pc,
  type PostCondition,
  PostConditionMode,
  serializeTransaction,
} from "@stacks/transactions";
import { z } from "zod";
import { parseContractPrincipal, validatePrincipal } from "./principals.js";

/** Closed S4 registry. Adding an entry requires a reviewed builder and an explicit signer method. */
export const rewardOperationAdapterIdSchema = z.enum([
  "pox5-calculate-rewards",
  "reference-manager-claim-rewards",
  "reference-manager-claim-staker-rewards",
  "reference-manager-settle-accepted-withdrawal",
  "reference-manager-reclaim-failed-withdrawal",
]);
export type RewardOperationAdapterId = z.infer<typeof rewardOperationAdapterIdSchema>;

export const REWARD_OPERATION_ADAPTER_REVISIONS = {
  "pox5-calculate-rewards": 1,
  "reference-manager-claim-rewards": 3,
  "reference-manager-claim-staker-rewards": 2,
  "reference-manager-settle-accepted-withdrawal": 1,
  "reference-manager-reclaim-failed-withdrawal": 1,
} as const satisfies Record<RewardOperationAdapterId, number>;

const uintTextSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const indexBlockHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const standardPrincipalSchema = z
  .string()
  .refine(
    (value) => !value.includes(".") && validatePrincipal(value),
    "Expected standard principal",
  );
const contractPrincipalSchema = z.string().refine((value) => {
  try {
    parseContractPrincipal(value);
    return true;
  } catch {
    return false;
  }
}, "Expected contract principal");
const publicKeySchema = z
  .string()
  .regex(/^(02|03)[0-9a-f]{64}$/)
  .refine((value) => {
    try {
      return compressPublicKey(value) === value;
    } catch {
      return false;
    }
  }, "Expected compressed public key");

export const operatorRunAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal("operator-run"),
    runId: z.string().uuid(),
    recipeSha256: hashSchema,
  })
  .strict();
export type OperatorRunAuthorization = z.infer<typeof operatorRunAuthorizationSchema>;

const networkSchema = z
  .object({ kind: z.enum(["mainnet", "testnet"]), chainId: z.number().int().nonnegative() })
  .strict();
const senderSchema = z
  .object({ principal: standardPrincipalSchema, publicKey: publicKeySchema })
  .strict();
const anchorSchema = z
  .object({
    stacksBlockHeight: z.number().int().nonnegative(),
    burnBlockHeight: z.number().int().nonnegative(),
    indexBlockHash: indexBlockHashSchema,
  })
  .strict();
const adapterSchema = z
  .object({ id: rewardOperationAdapterIdSchema, revision: z.number().int().positive() })
  .strict();
const transactionSchema = z
  .object({ nonce: uintTextSchema, feeUstx: uintTextSchema, unsignedTransactionSha256: hashSchema })
  .strict();
const exactEffectSchema = z
  .object({
    kind: z.literal("exact-ft-transfer"),
    asset: z.string().min(1),
    sender: z.string().min(1),
    recipient: z.string().min(1),
    amountSats: uintTextSchema,
  })
  .strict();
const noAssetEffectSchema = z.object({ kind: z.literal("no-asset-transfer") }).strict();

const commonMaterialSchema = z.object({
  schemaVersion: z.literal(2),
  adapter: adapterSchema,
  authorization: operatorRunAuthorizationSchema,
  network: networkSchema,
  chainAnchor: anchorSchema,
  sender: senderSchema,
  managerSourceFingerprint: hashSchema.nullable(),
  transaction: transactionSchema,
});

const operationMaterialSchema = z.discriminatedUnion("kind", [
  commonMaterialSchema
    .extend({
      kind: z.literal("calculate-rewards"),
      pox5Contract: contractPrincipalSchema,
      bondPeriods: z.array(uintTextSchema).max(6),
      targetRewardCycle: uintTextSchema,
      targetCheckpoint: z.enum(["first-half", "second-half"]),
      expectedLastRewardComputeBurnHeight: z.number().int().nonnegative(),
      expectedEffect: noAssetEffectSchema,
    })
    .strict(),
  commonMaterialSchema
    .extend({
      kind: z.literal("claim-rewards"),
      managerContract: contractPrincipalSchema,
      pox5Contract: contractPrincipalSchema,
      sbtcTokenContract: contractPrincipalSchema,
      rewardCycle: uintTextSchema,
      bondPeriods: z.array(uintTextSchema).max(6),
      expectedEffect: exactEffectSchema,
    })
    .strict(),
  commonMaterialSchema
    .extend({
      kind: z.literal("claim-staker-rewards"),
      managerContract: contractPrincipalSchema,
      sbtcTokenContract: contractPrincipalSchema,
      stakerPrincipal: z.string().refine(validatePrincipal),
      rewardCycle: uintTextSchema,
      bondIndex: uintTextSchema.nullable(),
      payoutRoute: z.enum(["direct-sbtc", "bitcoin-l1"]),
      grossSats: uintTextSchema,
      feeSats: uintTextSchema,
      expectedEffect: exactEffectSchema,
    })
    .strict(),
  commonMaterialSchema
    .extend({
      kind: z.literal("settle-accepted-withdrawal"),
      managerContract: contractPrincipalSchema,
      requestId: uintTextSchema,
      stakerPrincipal: z.string().refine(validatePrincipal),
      expectedEffect: noAssetEffectSchema,
    })
    .strict(),
  commonMaterialSchema
    .extend({
      kind: z.literal("reclaim-failed-withdrawal"),
      managerContract: contractPrincipalSchema,
      sbtcTokenContract: contractPrincipalSchema,
      requestId: uintTextSchema,
      stakerPrincipal: z.string().refine(validatePrincipal),
      withdrawalAmountSats: uintTextSchema,
      maxFeeSats: uintTextSchema,
      expectedEffect: exactEffectSchema,
    })
    .strict(),
]);

export const rewardOperationPlanSchema = z
  .object({
    kind: z.literal("reward-operation"),
    planSha256: hashSchema,
    unsignedTransactionHex: z.string().regex(/^[0-9a-f]+$/),
    unsignedTransactionSha256: hashSchema,
    material: operationMaterialSchema,
  })
  .strict();
export type RewardOperationPlan = z.infer<typeof rewardOperationPlanSchema>;
export type RewardOperationMaterial = RewardOperationPlan["material"];
export type RewardOperationKind = RewardOperationMaterial["kind"];

export interface RewardOperationCommonInput {
  authorization: OperatorRunAuthorization;
  network: { kind: "mainnet" | "testnet"; chainId: number };
  chainAnchor: { stacksBlockHeight: number; burnBlockHeight: number; indexBlockHash: string };
  sender: { principal: string; publicKey: string };
  managerSourceFingerprint?: string | null;
  nonce: bigint;
  feeUstx: bigint;
}

export type RewardOperationPlanInput =
  | (RewardOperationCommonInput & {
      kind: "calculate-rewards";
      pox5Contract: string;
      bondPeriods: readonly bigint[];
      targetRewardCycle: bigint;
      targetCheckpoint: "first-half" | "second-half";
      expectedLastRewardComputeBurnHeight: number;
    })
  | (RewardOperationCommonInput & {
      kind: "claim-rewards";
      managerContract: string;
      pox5Contract: string;
      sbtcTokenContract: string;
      rewardCycle: bigint;
      bondPeriods: readonly bigint[];
      expectedSbtcOutflow: bigint;
    })
  | (RewardOperationCommonInput & {
      kind: "claim-staker-rewards";
      managerContract: string;
      sbtcTokenContract: string;
      stakerPrincipal: string;
      rewardCycle: bigint;
      bondIndex: bigint | null;
      payoutRoute: "direct-sbtc" | "bitcoin-l1";
      grossSats: bigint;
      feeSats: bigint;
      expectedNetSats: bigint;
    })
  | (RewardOperationCommonInput & {
      kind: "settle-accepted-withdrawal";
      managerContract: string;
      requestId: bigint;
      stakerPrincipal: string;
    })
  | (RewardOperationCommonInput & {
      kind: "reclaim-failed-withdrawal";
      managerContract: string;
      sbtcTokenContract: string;
      requestId: bigint;
      stakerPrincipal: string;
      withdrawalAmountSats: bigint;
      maxFeeSats: bigint;
    });

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Plan material is not canonical JSON");
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertCommon(input: RewardOperationPlanInput): void {
  operatorRunAuthorizationSchema.parse(input.authorization);
  networkSchema.parse(input.network);
  anchorSchema.parse(input.chainAnchor);
  senderSchema.parse(input.sender);
  if (
    getAddressFromPublicKey(input.sender.publicKey, input.network.kind) !== input.sender.principal
  ) {
    throw new Error("Reward-operation sender does not match its public key");
  }
  if (input.nonce < 0n || input.feeUstx < 0n) throw new Error("Nonce and fee must be non-negative");
  if (input.network.kind === "mainnet" && input.network.chainId !== 1) {
    throw new Error("Mainnet reward operations require chain ID 1");
  }
  if (input.network.kind === "testnet" && (input.network.chainId & 0x8000_0000) === 0) {
    throw new Error("Testnet reward operations require a testnet chain ID");
  }
}

function contractCall(input: RewardOperationPlanInput): {
  contract: string;
  functionName: string;
  functionArgs: ReturnType<typeof Cl.uint>[] | ReturnType<typeof Cl.principal>[] | unknown[];
  postConditions: PostCondition[];
  material: Omit<RewardOperationMaterial, keyof z.infer<typeof commonMaterialSchema>> &
    Partial<RewardOperationMaterial>;
} {
  switch (input.kind) {
    case "calculate-rewards":
      return {
        contract: input.pox5Contract,
        functionName: "calculate-rewards",
        functionArgs: [Cl.list(input.bondPeriods.map((period) => Cl.uint(period)))],
        postConditions: [],
        material: {
          kind: input.kind,
          pox5Contract: input.pox5Contract,
          bondPeriods: input.bondPeriods.map(String),
          targetRewardCycle: input.targetRewardCycle.toString(),
          targetCheckpoint: input.targetCheckpoint,
          expectedLastRewardComputeBurnHeight: input.expectedLastRewardComputeBurnHeight,
          expectedEffect: { kind: "no-asset-transfer" },
        },
      };
    case "claim-rewards": {
      if (input.expectedSbtcOutflow <= 0n) throw new Error("Collect must move positive sBTC");
      const effect = {
        kind: "exact-ft-transfer" as const,
        asset: `${input.sbtcTokenContract}::sbtc-token`,
        sender: input.pox5Contract,
        recipient: input.managerContract,
        amountSats: input.expectedSbtcOutflow.toString(),
      };
      return {
        contract: input.managerContract,
        functionName: "claim-rewards",
        functionArgs: [
          Cl.list(input.bondPeriods.map((period) => Cl.uint(period))),
          Cl.uint(input.rewardCycle),
        ],
        postConditions: [
          Pc.principal(effect.sender)
            .willSendEq(input.expectedSbtcOutflow)
            .ft(input.sbtcTokenContract as `${string}.${string}`, "sbtc-token"),
        ],
        material: {
          kind: input.kind,
          managerContract: input.managerContract,
          pox5Contract: input.pox5Contract,
          sbtcTokenContract: input.sbtcTokenContract,
          rewardCycle: input.rewardCycle.toString(),
          bondPeriods: input.bondPeriods.map(String),
          expectedEffect: effect,
        },
      };
    }
    case "claim-staker-rewards": {
      if (
        input.expectedNetSats <= 0n ||
        input.grossSats - input.feeSats !== input.expectedNetSats
      ) {
        throw new Error("Staker payout must equal positive gross rewards minus manager fee");
      }
      const effect = {
        kind: "exact-ft-transfer" as const,
        asset: `${input.sbtcTokenContract}::sbtc-token`,
        sender: input.managerContract,
        recipient: input.payoutRoute === "direct-sbtc" ? input.stakerPrincipal : "sbtc-withdrawal",
        amountSats: input.expectedNetSats.toString(),
      };
      return {
        contract: input.managerContract,
        functionName: "claim-staker-rewards",
        functionArgs: [
          Cl.principal(input.stakerPrincipal),
          Cl.uint(input.rewardCycle),
          input.bondIndex === null ? Cl.none() : Cl.some(Cl.uint(input.bondIndex)),
        ],
        postConditions: [
          Pc.principal(effect.sender)
            .willSendEq(input.expectedNetSats)
            .ft(input.sbtcTokenContract as `${string}.${string}`, "sbtc-token"),
        ],
        material: {
          kind: input.kind,
          managerContract: input.managerContract,
          sbtcTokenContract: input.sbtcTokenContract,
          stakerPrincipal: input.stakerPrincipal,
          rewardCycle: input.rewardCycle.toString(),
          bondIndex: input.bondIndex?.toString() ?? null,
          payoutRoute: input.payoutRoute,
          grossSats: input.grossSats.toString(),
          feeSats: input.feeSats.toString(),
          expectedEffect: effect,
        },
      };
    }
    case "settle-accepted-withdrawal":
      return {
        contract: input.managerContract,
        functionName: "settle-accepted-withdrawal",
        functionArgs: [Cl.uint(input.requestId)],
        postConditions: [],
        material: {
          kind: input.kind,
          managerContract: input.managerContract,
          requestId: input.requestId.toString(),
          stakerPrincipal: input.stakerPrincipal,
          expectedEffect: { kind: "no-asset-transfer" },
        },
      };
    case "reclaim-failed-withdrawal": {
      const refund = input.withdrawalAmountSats + input.maxFeeSats;
      if (refund <= 0n) throw new Error("Withdrawal reclaim must return positive sBTC");
      const effect = {
        kind: "exact-ft-transfer" as const,
        asset: `${input.sbtcTokenContract}::sbtc-token`,
        sender: input.managerContract,
        recipient: input.stakerPrincipal,
        amountSats: refund.toString(),
      };
      return {
        contract: input.managerContract,
        functionName: "reclaim-failed-withdrawal",
        functionArgs: [Cl.uint(input.requestId)],
        postConditions: [
          Pc.principal(effect.sender)
            .willSendEq(refund)
            .ft(input.sbtcTokenContract as `${string}.${string}`, "sbtc-token"),
        ],
        material: {
          kind: input.kind,
          managerContract: input.managerContract,
          sbtcTokenContract: input.sbtcTokenContract,
          requestId: input.requestId.toString(),
          stakerPrincipal: input.stakerPrincipal,
          withdrawalAmountSats: input.withdrawalAmountSats.toString(),
          maxFeeSats: input.maxFeeSats.toString(),
          expectedEffect: effect,
        },
      };
    }
  }
}

function adapter(input: RewardOperationPlanInput): RewardOperationMaterial["adapter"] {
  const id: RewardOperationAdapterId =
    input.kind === "calculate-rewards"
      ? "pox5-calculate-rewards"
      : input.kind === "claim-rewards"
        ? "reference-manager-claim-rewards"
        : input.kind === "claim-staker-rewards"
          ? "reference-manager-claim-staker-rewards"
          : input.kind === "settle-accepted-withdrawal"
            ? "reference-manager-settle-accepted-withdrawal"
            : "reference-manager-reclaim-failed-withdrawal";
  return { id, revision: REWARD_OPERATION_ADAPTER_REVISIONS[id] };
}

/** Build one reviewed, deny-mode S4 call. This function performs no reads, signing, or broadcast. */
export async function planRewardOperation(
  input: RewardOperationPlanInput,
): Promise<RewardOperationPlan> {
  assertCommon(input);
  const call = contractCall(input);
  const contract = parseContractPrincipal(call.contract);
  if (contract.network !== input.network.kind) throw new Error("Call contract network mismatch");
  const transaction = await makeUnsignedContractCall({
    contractAddress: contract.address,
    contractName: contract.contractName,
    functionName: call.functionName,
    functionArgs: call.functionArgs as Parameters<
      typeof makeUnsignedContractCall
    >[0]["functionArgs"],
    publicKey: input.sender.publicKey,
    nonce: input.nonce,
    fee: input.feeUstx,
    network: input.network.kind,
    postConditionMode: PostConditionMode.Deny,
    postConditions: call.postConditions,
  });
  const unsignedTransactionHex = serializeTransaction(transaction);
  deserializeTransaction(unsignedTransactionHex);
  const unsignedTransactionSha256 = sha256(Buffer.from(unsignedTransactionHex, "hex"));
  const material = operationMaterialSchema.parse({
    schemaVersion: 2,
    ...call.material,
    adapter: adapter(input),
    authorization: input.authorization,
    network: input.network,
    chainAnchor: input.chainAnchor,
    sender: input.sender,
    managerSourceFingerprint: input.managerSourceFingerprint ?? null,
    transaction: {
      nonce: input.nonce.toString(),
      feeUstx: input.feeUstx.toString(),
      unsignedTransactionSha256,
    },
  });
  return rewardOperationPlanSchema.parse({
    kind: "reward-operation",
    planSha256: sha256(`signer-sidekick:reward-operation-plan:v2\0${canonicalJson(material)}`),
    unsignedTransactionHex,
    unsignedTransactionSha256,
    material,
  });
}

function rebuildInput(plan: RewardOperationPlan): RewardOperationPlanInput {
  const common: RewardOperationCommonInput = {
    authorization: plan.material.authorization,
    network: plan.material.network,
    chainAnchor: plan.material.chainAnchor,
    sender: plan.material.sender,
    managerSourceFingerprint: plan.material.managerSourceFingerprint,
    nonce: BigInt(plan.material.transaction.nonce),
    feeUstx: BigInt(plan.material.transaction.feeUstx),
  };
  const material = plan.material;
  switch (material.kind) {
    case "calculate-rewards":
      return {
        ...common,
        kind: material.kind,
        pox5Contract: material.pox5Contract,
        bondPeriods: material.bondPeriods.map(BigInt),
        targetRewardCycle: BigInt(material.targetRewardCycle),
        targetCheckpoint: material.targetCheckpoint,
        expectedLastRewardComputeBurnHeight: material.expectedLastRewardComputeBurnHeight,
      };
    case "claim-rewards":
      return {
        ...common,
        kind: material.kind,
        managerContract: material.managerContract,
        pox5Contract: material.pox5Contract,
        sbtcTokenContract: material.sbtcTokenContract,
        rewardCycle: BigInt(material.rewardCycle),
        bondPeriods: material.bondPeriods.map(BigInt),
        expectedSbtcOutflow: BigInt(material.expectedEffect.amountSats),
      };
    case "claim-staker-rewards":
      return {
        ...common,
        kind: material.kind,
        managerContract: material.managerContract,
        sbtcTokenContract: material.sbtcTokenContract,
        stakerPrincipal: material.stakerPrincipal,
        rewardCycle: BigInt(material.rewardCycle),
        bondIndex: material.bondIndex === null ? null : BigInt(material.bondIndex),
        payoutRoute: material.payoutRoute,
        grossSats: BigInt(material.grossSats),
        feeSats: BigInt(material.feeSats),
        expectedNetSats: BigInt(material.expectedEffect.amountSats),
      };
    case "settle-accepted-withdrawal":
      return {
        ...common,
        kind: material.kind,
        managerContract: material.managerContract,
        requestId: BigInt(material.requestId),
        stakerPrincipal: material.stakerPrincipal,
      };
    case "reclaim-failed-withdrawal":
      return {
        ...common,
        kind: material.kind,
        managerContract: material.managerContract,
        sbtcTokenContract: material.sbtcTokenContract,
        requestId: BigInt(material.requestId),
        stakerPrincipal: material.stakerPrincipal,
        withdrawalAmountSats: BigInt(material.withdrawalAmountSats),
        maxFeeSats: BigInt(material.maxFeeSats),
      };
  }
}

/** Rebuild byte-for-byte before signing; persisted or API-supplied bytes are never trusted. */
export async function revalidateRewardOperationPlan(
  input: RewardOperationPlan,
): Promise<RewardOperationPlan> {
  const parsed = rewardOperationPlanSchema.parse(input);
  const rebuilt = await planRewardOperation(rebuildInput(parsed));
  if (!isDeepStrictEqual(parsed, rebuilt)) throw new Error("Reward-operation sealed plan mismatch");
  return rebuilt;
}
