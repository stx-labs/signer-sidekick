import { createHash } from "node:crypto";
import {
  Cl,
  compressPublicKey,
  deserializeTransaction,
  getAddressFromPublicKey,
  makeUnsignedContractCall,
  Pc,
  PostConditionMode,
  serializeTransaction,
  wireToPostCondition,
} from "@stacks/transactions";
import { z } from "zod";
import { parseContractPrincipal, validatePrincipal } from "./principals.js";

export const MANAGER_CLAIM_REWARDS_ADAPTER_ID = "reference-manager-claim-rewards" as const;
export const MANAGER_CLAIM_REWARDS_ADAPTER_REVISION = 1 as const;
export const MANAGER_CLAIM_REWARDS_FUNCTION_NAME = "claim-rewards" as const;
export const MANAGER_CLAIM_REWARDS_SBTC_ASSET_NAME = "sbtc-token" as const;

const MAX_UINT32 = 0xffff_ffff;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_FEE_BIPS = 9_999n;
const MAINNET_CHAIN_ID = 0x0000_0001;
const TESTNET_CHAIN_ID_MASK = 0x8000_0000;
const intentDomain = "signer-sidekick:reference-manager-claim-rewards:intent:v1";

const uint64Schema = z.bigint().min(0n).max(MAX_UINT64);
const uint128Schema = z.bigint().min(0n).max(MAX_UINT128);
const digestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/i)
  .transform((value) => value.toLowerCase());
const indexBlockHashSchema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i)
  .transform((value) => value.toLowerCase());
const compressedPublicKeySchema = z
  .string()
  .regex(/^(02|03)[0-9a-f]{64}$/i)
  .transform((value) => value.toLowerCase())
  .refine((value) => {
    try {
      return compressPublicKey(value) === value;
    } catch {
      return false;
    }
  }, "Expected a valid compressed secp256k1 public key");
const contractPrincipalSchema = z.string().refine((value) => {
  try {
    parseContractPrincipal(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a valid contract principal");
const standardPrincipalSchema = z
  .string()
  .refine(
    (value) => !value.includes(".") && validatePrincipal(value),
    "Expected a valid standard principal",
  );

export const managerClaimRewardsPlanInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapterRevision: z.literal(MANAGER_CLAIM_REWARDS_ADAPTER_REVISION),
    network: z
      .object({
        kind: z.enum(["mainnet", "testnet"]),
        chainId: z.number().int().nonnegative().max(MAX_UINT32),
      })
      .strict(),
    managerContract: contractPrincipalSchema,
    pox5Contract: contractPrincipalSchema,
    sbtcTokenContract: contractPrincipalSchema,
    rewardCycle: uint128Schema,
    expectedSbtcOutflow: uint64Schema.refine((value) => value > 0n, {
      message: "Expected sBTC outflow must be greater than zero",
    }),
    chainAnchor: z
      .object({
        stacksBlockHeight: z.number().int().nonnegative().safe(),
        indexBlockHash: indexBlockHashSchema,
        burnBlockHeight: z.number().int().nonnegative().safe(),
        rewardCycle: uint128Schema,
        rewardCycleLength: z.number().int().positive().safe(),
        prepareCycleLength: z.number().int().nonnegative().safe(),
        cyclePosition: z.number().int().nonnegative().safe(),
        phase: z.enum(["reward", "prepare"]),
        checkpoint: z.enum(["first-half", "second-half"]),
      })
      .strict(),
    attestationDigest: digestSchema,
    managerSourceFingerprint: digestSchema,
    rewardObservation: z
      .object({
        calculationCheckpoint: z.enum(["first-half", "second-half"]),
        lastRewardComputeBurnHeight: z.number().int().positive().safe(),
        rewardsPerToken: uint128Schema,
      })
      .strict(),
    noBondParticipation: z
      .object({
        proven: z.literal(true),
        evidenceDigest: digestSchema,
      })
      .strict(),
    feeSnapshot: z
      .object({
        state: z.enum(["absent", "present"]),
        effectiveFeeBips: z.bigint().min(0n).max(MAX_FEE_BIPS),
      })
      .strict(),
    sender: z
      .object({
        principal: standardPrincipalSchema,
        publicKey: compressedPublicKeySchema,
      })
      .strict(),
    nonce: uint64Schema,
    fee: uint64Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.chainAnchor.prepareCycleLength > value.chainAnchor.rewardCycleLength) {
      context.addIssue({
        code: "custom",
        path: ["chainAnchor", "prepareCycleLength"],
        message: "Prepare-cycle length cannot exceed reward-cycle length",
      });
    }
    if (value.chainAnchor.cyclePosition >= value.chainAnchor.rewardCycleLength) {
      context.addIssue({
        code: "custom",
        path: ["chainAnchor", "cyclePosition"],
        message: "Cycle position must be within the reward cycle",
      });
    } else {
      const expectedPhase =
        value.chainAnchor.cyclePosition >=
        value.chainAnchor.rewardCycleLength - value.chainAnchor.prepareCycleLength
          ? "prepare"
          : "reward";
      if (value.chainAnchor.phase !== expectedPhase) {
        context.addIssue({
          code: "custom",
          path: ["chainAnchor", "phase"],
          message: `Chain-anchor phase must be ${expectedPhase} at this cycle position`,
        });
      }
      const expectedCheckpoint =
        value.chainAnchor.cyclePosition < Math.floor(value.chainAnchor.rewardCycleLength / 2)
          ? "first-half"
          : "second-half";
      if (value.chainAnchor.checkpoint !== expectedCheckpoint) {
        context.addIssue({
          code: "custom",
          path: ["chainAnchor", "checkpoint"],
          message: `Chain-anchor checkpoint must be ${expectedCheckpoint} at this cycle position`,
        });
      }
    }
    if (value.chainAnchor.rewardCycleLength % 2 !== 0) {
      context.addIssue({
        code: "custom",
        path: ["chainAnchor", "rewardCycleLength"],
        message: "Manager claims require an even reward-cycle length",
      });
    } else {
      const cycleStart = value.chainAnchor.burnBlockHeight - value.chainAnchor.cyclePosition;
      if (cycleStart < 0) {
        context.addIssue({
          code: "custom",
          path: ["chainAnchor", "burnBlockHeight"],
          message: "Chain-anchor burn height cannot precede the current cycle start",
        });
      } else if (
        value.chainAnchor.checkpoint === "first-half" &&
        (value.chainAnchor.rewardCycle === 0n || cycleStart === 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["chainAnchor", "rewardCycle"],
          message: "A first-half anchor has no completed reward calculation in cycle zero",
        });
      } else {
        const firstHalfComplete = value.chainAnchor.checkpoint === "second-half";
        const expectedRewardCycle = firstHalfComplete
          ? value.chainAnchor.rewardCycle
          : value.chainAnchor.rewardCycle - 1n;
        const expectedCalculationCheckpoint = firstHalfComplete ? "first-half" : "second-half";
        const expectedComputeHeight = firstHalfComplete
          ? cycleStart + value.chainAnchor.rewardCycleLength / 2 - 1
          : cycleStart - 1;
        if (value.rewardCycle !== expectedRewardCycle) {
          context.addIssue({
            code: "custom",
            path: ["rewardCycle"],
            message: `Claimed reward cycle must be ${expectedRewardCycle} at this anchor`,
          });
        }
        if (value.rewardObservation.calculationCheckpoint !== expectedCalculationCheckpoint) {
          context.addIssue({
            code: "custom",
            path: ["rewardObservation", "calculationCheckpoint"],
            message: `Calculation checkpoint must be ${expectedCalculationCheckpoint} at this anchor`,
          });
        }
        if (value.rewardObservation.lastRewardComputeBurnHeight !== expectedComputeHeight) {
          context.addIssue({
            code: "custom",
            path: ["rewardObservation", "lastRewardComputeBurnHeight"],
            message: `Last reward-compute height must be ${expectedComputeHeight} at this anchor`,
          });
        }
      }
    }
    if (value.rewardObservation.lastRewardComputeBurnHeight > value.chainAnchor.burnBlockHeight) {
      context.addIssue({
        code: "custom",
        path: ["rewardObservation", "lastRewardComputeBurnHeight"],
        message: "Last reward-compute height cannot be later than the chain anchor",
      });
    }

    if (value.network.kind === "mainnet" && value.network.chainId !== MAINNET_CHAIN_ID) {
      context.addIssue({
        code: "custom",
        path: ["network", "chainId"],
        message: `Mainnet transactions require chain ID ${MAINNET_CHAIN_ID}`,
      });
    }
    if (value.network.kind === "testnet" && (value.network.chainId & TESTNET_CHAIN_ID_MASK) === 0) {
      context.addIssue({
        code: "custom",
        path: ["network", "chainId"],
        message: "Testnet transaction chain IDs must have the testnet bit set",
      });
    }

    for (const [field, principal] of [
      ["managerContract", value.managerContract],
      ["pox5Contract", value.pox5Contract],
      ["sbtcTokenContract", value.sbtcTokenContract],
    ] as const) {
      if (parseContractPrincipal(principal).network !== value.network.kind) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Contract principal must be on ${value.network.kind}`,
        });
      }
    }

    if (parseContractPrincipal(value.pox5Contract).contractName !== "pox-5") {
      context.addIssue({
        code: "custom",
        path: ["pox5Contract"],
        message: "PoX-5 contract principal must name the pox-5 contract",
      });
    }
    if (parseContractPrincipal(value.sbtcTokenContract).contractName !== "sbtc-token") {
      context.addIssue({
        code: "custom",
        path: ["sbtcTokenContract"],
        message: "sBTC token principal must name the sbtc-token contract",
      });
    }

    const derivedSender = getAddressFromPublicKey(value.sender.publicKey, value.network.kind);
    if (derivedSender !== value.sender.principal) {
      context.addIssue({
        code: "custom",
        path: ["sender", "principal"],
        message: "Sender principal does not match the supplied public key",
      });
    }
  });

export type ManagerClaimRewardsPlanInput = z.input<typeof managerClaimRewardsPlanInputSchema>;
type ParsedManagerClaimRewardsPlanInput = z.output<typeof managerClaimRewardsPlanInputSchema>;

export interface ManagerClaimRewardsChainAnchor {
  readonly stacksBlockHeight: number;
  readonly indexBlockHash: string;
  readonly burnBlockHeight: number;
  readonly rewardCycle: string;
  readonly rewardCycleLength: number;
  readonly prepareCycleLength: number;
  readonly cyclePosition: number;
  readonly phase: "reward" | "prepare";
  readonly checkpoint: "first-half" | "second-half";
}

export interface ManagerClaimRewardsIntentMaterial {
  readonly schemaVersion: 1;
  readonly adapter: {
    readonly id: typeof MANAGER_CLAIM_REWARDS_ADAPTER_ID;
    readonly revision: typeof MANAGER_CLAIM_REWARDS_ADAPTER_REVISION;
  };
  readonly network: {
    readonly kind: "mainnet" | "testnet";
    readonly chainId: number;
  };
  readonly chainAnchor: ManagerClaimRewardsChainAnchor;
  readonly attestationDigest: string;
  readonly managerSourceFingerprint: string;
  readonly rewardObservation: {
    readonly calculationCheckpoint: "first-half" | "second-half";
    readonly lastRewardComputeBurnHeight: number;
    readonly rewardsPerToken: string;
  };
  readonly noBondParticipation: {
    readonly proven: true;
    readonly evidenceDigest: string;
  };
  readonly feeSnapshot: {
    readonly state: "absent" | "present";
    readonly effectiveFeeBips: string;
  };
  readonly sender: {
    readonly principal: string;
    readonly publicKey: string;
  };
  readonly call: {
    readonly contract: string;
    readonly functionName: typeof MANAGER_CLAIM_REWARDS_FUNCTION_NAME;
    readonly bondPeriods: readonly [];
    readonly rewardCycle: string;
  };
  readonly expectedEffect: {
    readonly asset: string;
    readonly sender: string;
    readonly recipient: string;
    readonly amount: string;
    readonly condition: "eq";
    readonly postConditionMode: "deny";
  };
  readonly transaction: {
    readonly nonce: string;
    readonly fee: string;
    readonly unsignedTransactionSha256: string;
  };
}

export interface ManagerClaimRewardsPlan {
  readonly kind: "manager-claim-rewards";
  readonly intentHash: string;
  readonly unsignedTransactionHex: string;
  readonly unsignedTransactionSha256: string;
  readonly material: ManagerClaimRewardsIntentMaterial;
}

type TransactionNetwork = Exclude<
  NonNullable<Parameters<typeof makeUnsignedContractCall>[0]["network"]>,
  string
>;

function transactionNetwork(value: ParsedManagerClaimRewardsPlanInput): TransactionNetwork {
  const mainnet = value.network.kind === "mainnet";
  return {
    chainId: value.network.chainId,
    transactionVersion: mainnet ? 0x00 : 0x80,
    peerNetworkId: mainnet ? 0x1700_0000 : 0xff00_0000,
    magicBytes: mainnet ? "X2" : "T2",
    bootAddress: mainnet ? "SP000000000000000000002Q6VF78" : "ST000000000000000000002AMW42H",
    addressVersion: mainnet ? { singleSig: 22, multiSig: 20 } : { singleSig: 26, multiSig: 21 },
    client: { baseUrl: "http://transaction-planner.invalid" },
  };
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
  if (typeof value !== "object") throw new Error("Intent material is not canonical JSON");
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

/**
 * Builds the only V1 manager-claim call supported by the reference-manager adapter.
 *
 * The function performs no reads, signing, fee estimation, nonce lookup, or broadcast. The caller
 * must supply already-fenced chain facts and the exact expected sBTC amount. The empty bond list is
 * deliberate: this vector is restricted to a manager proven to have no bond participation.
 */
export async function planManagerClaimRewards(
  input: ManagerClaimRewardsPlanInput,
): Promise<ManagerClaimRewardsPlan> {
  const value = managerClaimRewardsPlanInputSchema.parse(input);
  const manager = parseContractPrincipal(value.managerContract);
  const postCondition = Pc.principal(value.pox5Contract)
    .willSendEq(value.expectedSbtcOutflow)
    .ft(value.sbtcTokenContract as `${string}.${string}`, MANAGER_CLAIM_REWARDS_SBTC_ASSET_NAME);
  const transaction = await makeUnsignedContractCall({
    contractAddress: manager.address,
    contractName: manager.contractName,
    functionName: MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
    functionArgs: [Cl.list([]), Cl.uint(value.rewardCycle)],
    publicKey: value.sender.publicKey,
    fee: value.fee,
    nonce: value.nonce,
    network: transactionNetwork(value),
    postConditionMode: PostConditionMode.Deny,
    postConditions: [postCondition],
  });
  const unsignedTransactionHex = serializeTransaction(transaction);
  const unsignedTransactionSha256 = sha256Hex(Buffer.from(unsignedTransactionHex, "hex"));
  const roundTrip = deserializeTransaction(unsignedTransactionHex);
  const encodedPostConditions = roundTrip.postConditions.values.map(wireToPostCondition);
  if (
    roundTrip.postConditionMode !== PostConditionMode.Deny ||
    encodedPostConditions.length !== 1 ||
    encodedPostConditions[0]?.type !== "ft-postcondition" ||
    encodedPostConditions[0].address !== value.pox5Contract ||
    encodedPostConditions[0].condition !== "eq" ||
    BigInt(encodedPostConditions[0].amount) !== value.expectedSbtcOutflow ||
    encodedPostConditions[0].asset !==
      `${value.sbtcTokenContract}::${MANAGER_CLAIM_REWARDS_SBTC_ASSET_NAME}`
  ) {
    throw new Error("Unsigned manager claim did not preserve the sealed postcondition");
  }

  const material: ManagerClaimRewardsIntentMaterial = {
    schemaVersion: 1,
    adapter: {
      id: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
      revision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
    },
    network: value.network,
    chainAnchor: {
      ...value.chainAnchor,
      rewardCycle: value.chainAnchor.rewardCycle.toString(),
    },
    attestationDigest: value.attestationDigest,
    managerSourceFingerprint: value.managerSourceFingerprint,
    rewardObservation: {
      calculationCheckpoint: value.rewardObservation.calculationCheckpoint,
      lastRewardComputeBurnHeight: value.rewardObservation.lastRewardComputeBurnHeight,
      rewardsPerToken: value.rewardObservation.rewardsPerToken.toString(),
    },
    noBondParticipation: value.noBondParticipation,
    feeSnapshot: {
      state: value.feeSnapshot.state,
      effectiveFeeBips: value.feeSnapshot.effectiveFeeBips.toString(),
    },
    sender: value.sender,
    call: {
      contract: value.managerContract,
      functionName: MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
      bondPeriods: [],
      rewardCycle: value.rewardCycle.toString(),
    },
    expectedEffect: {
      asset: `${value.sbtcTokenContract}::${MANAGER_CLAIM_REWARDS_SBTC_ASSET_NAME}`,
      sender: value.pox5Contract,
      recipient: value.managerContract,
      amount: value.expectedSbtcOutflow.toString(),
      condition: "eq",
      postConditionMode: "deny",
    },
    transaction: {
      nonce: value.nonce.toString(),
      fee: value.fee.toString(),
      unsignedTransactionSha256,
    },
  };
  const intentHash = sha256Hex(`${intentDomain}\0${canonicalJson(material)}`);

  return {
    kind: "manager-claim-rewards",
    intentHash,
    unsignedTransactionHex,
    unsignedTransactionSha256,
    material,
  };
}
