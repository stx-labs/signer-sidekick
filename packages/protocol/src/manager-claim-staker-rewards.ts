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

export const MANAGER_CLAIM_STAKER_REWARDS_ADAPTER_ID =
  "reference-manager-claim-staker-rewards" as const;
export const MANAGER_CLAIM_STAKER_REWARDS_ADAPTER_REVISION = 1 as const;
export const MANAGER_CLAIM_STAKER_REWARDS_FUNCTION_NAME = "claim-staker-rewards" as const;
export const MANAGER_CLAIM_STAKER_REWARDS_SBTC_ASSET_NAME = "sbtc-token" as const;

const MAX_UINT32 = 0xffff_ffff;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_FEE_BIPS = 9_999n;
const MAX_BIPS = 10_000n;
/**
 * `sbtc-withdrawal` asserts `(> amount DUST_LIMIT)` on the withdrawn amount, where the withdrawn
 * amount is the net payout minus the staker's fee budget. Strictly greater, so a payout must clear
 * the limit by at least one sat.
 */
const SBTC_WITHDRAWAL_DUST_LIMIT = 546n;
const MAINNET_CHAIN_ID = 0x0000_0001;
const TESTNET_CHAIN_ID_MASK = 0x8000_0000;
const intentDomain = "signer-sidekick:reference-manager-claim-staker-rewards:intent:v1";

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

/**
 * The manager's `claim-staker-rewards` routes to Bitcoin L1 when the staker registered a
 * `pox-addr` while staking, and pays sBTC directly otherwise. That choice belongs to the staker
 * and is independent of bond participation — an STX-only staker can be on the L1 route and a bond
 * participant can be on the direct route.
 */
const payoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct-sbtc") }).strict(),
  z
    .object({
      kind: z.literal("bitcoin-l1"),
      poxAddress: z
        .object({
          versionHex: z.string().regex(/^[0-9a-f]{2}$/i),
          hashbytesHex: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i),
        })
        .strict(),
      maxFeeSats: uint64Schema,
    })
    .strict(),
]);

export const managerClaimStakerRewardsPlanInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapterRevision: z.literal(MANAGER_CLAIM_STAKER_REWARDS_ADAPTER_REVISION),
    network: z
      .object({
        kind: z.enum(["mainnet", "testnet"]),
        chainId: z.number().int().nonnegative().max(MAX_UINT32),
      })
      .strict(),
    managerContract: contractPrincipalSchema,
    sbtcTokenContract: contractPrincipalSchema,
    stakerPrincipal: z.string().refine(validatePrincipal, "Expected a valid staker principal"),
    rewardCycle: uint128Schema,
    /** `null` claims the STX-only bucket; a value claims one bond bucket. */
    bondIndex: uint128Schema.nullable(),
    chainAnchor: z
      .object({
        stacksBlockHeight: z.number().int().nonnegative().safe(),
        indexBlockHash: indexBlockHashSchema,
        burnBlockHeight: z.number().int().nonnegative().safe(),
        rewardCycle: uint128Schema,
      })
      .strict(),
    attestationDigest: digestSchema,
    managerSourceFingerprint: digestSchema,
    /** Pre-fee rewards PoX-5 has settled for this staker in this bucket. */
    grossSats: uint64Schema,
    /** The manager's cut, `gross * feeBips / 10000` under Clarity integer division. */
    feeSats: uint64Schema,
    /** `gross - fees`: exactly what leaves the manager's sBTC balance. */
    expectedNetSats: uint64Schema.refine((value) => value > 0n, {
      message: "Expected net payout must be greater than zero",
    }),
    /**
     * The manager `map-insert`s this snapshot inside `claim-rewards`, so a present snapshot is
     * anchored proof that the manager already pulled this bucket's rewards in. Absent means the
     * manager holds nothing for the bucket yet and the call would revert on its own balance checks.
     */
    feeSnapshot: z
      .object({
        state: z.literal("present"),
        effectiveFeeBips: z.bigint().min(0n).max(MAX_FEE_BIPS),
      })
      .strict(),
    /** `get-unclaimed-staker-rewards`; the manager asserts this covers the gross payout. */
    managerUnclaimedStakerRewardsSats: uint64Schema,
    payout: payoutSchema,
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
    if (value.grossSats - value.feeSats !== value.expectedNetSats) {
      context.addIssue({
        code: "custom",
        path: ["expectedNetSats"],
        message: "Expected net payout must equal gross rewards minus the manager fee",
      });
    }
    if ((value.grossSats * value.feeSnapshot.effectiveFeeBips) / MAX_BIPS !== value.feeSats) {
      context.addIssue({
        code: "custom",
        path: ["feeSats"],
        message: "Fee must equal the snapshotted fee bips applied to gross rewards",
      });
    }
    // Two separate floors sit under an L1 payout. The manager rejects a net below the staker's fee
    // budget, and sbtc-withdrawal then rejects a withdrawn amount that does not clear the dust
    // limit. Planning below either is a transaction Sidekick knows will revert.
    if (value.payout.kind === "bitcoin-l1") {
      if (value.expectedNetSats < value.payout.maxFeeSats) {
        context.addIssue({
          code: "custom",
          path: ["expectedNetSats"],
          message:
            "A Bitcoin L1 payout must cover the staker's maximum withdrawal fee; the manager rejects it otherwise",
        });
      } else if (value.expectedNetSats - value.payout.maxFeeSats <= SBTC_WITHDRAWAL_DUST_LIMIT) {
        context.addIssue({
          code: "custom",
          path: ["expectedNetSats"],
          message: `A Bitcoin L1 withdrawal must exceed the ${SBTC_WITHDRAWAL_DUST_LIMIT}-sat dust limit after the fee budget`,
        });
      }
    }
    if (value.managerUnclaimedStakerRewardsSats < value.grossSats) {
      context.addIssue({
        code: "custom",
        path: ["managerUnclaimedStakerRewardsSats"],
        message:
          "The manager does not hold enough unclaimed staker rewards to cover this payout; claim manager rewards first",
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

export type ManagerClaimStakerRewardsPlanInput = z.input<
  typeof managerClaimStakerRewardsPlanInputSchema
>;
type ParsedManagerClaimStakerRewardsPlanInput = z.output<
  typeof managerClaimStakerRewardsPlanInputSchema
>;

export interface ManagerClaimStakerRewardsIntentMaterial {
  readonly schemaVersion: 1;
  readonly adapter: {
    readonly id: typeof MANAGER_CLAIM_STAKER_REWARDS_ADAPTER_ID;
    readonly revision: typeof MANAGER_CLAIM_STAKER_REWARDS_ADAPTER_REVISION;
  };
  readonly network: {
    readonly kind: "mainnet" | "testnet";
    readonly chainId: number;
  };
  readonly chainAnchor: {
    readonly stacksBlockHeight: number;
    readonly indexBlockHash: string;
    readonly burnBlockHeight: number;
    readonly rewardCycle: string;
  };
  readonly attestationDigest: string;
  readonly managerSourceFingerprint: string;
  readonly rewardObservation: {
    readonly grossSats: string;
    readonly feeSats: string;
    readonly managerUnclaimedStakerRewardsSats: string;
    readonly feeSnapshot: {
      readonly state: "present";
      readonly effectiveFeeBips: string;
    };
  };
  readonly payout:
    | { readonly kind: "direct-sbtc" }
    | {
        readonly kind: "bitcoin-l1";
        readonly poxAddress: { readonly versionHex: string; readonly hashbytesHex: string };
        readonly maxFeeSats: string;
        readonly withdrawalAmountSats: string;
      };
  readonly sender: {
    readonly principal: string;
    readonly publicKey: string;
  };
  readonly call: {
    readonly contract: string;
    readonly functionName: typeof MANAGER_CLAIM_STAKER_REWARDS_FUNCTION_NAME;
    readonly stakerPrincipal: string;
    readonly rewardCycle: string;
    readonly bondIndex: string | null;
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

export interface ManagerClaimStakerRewardsPlan {
  readonly kind: "manager-claim-staker-rewards";
  readonly intentHash: string;
  readonly unsignedTransactionHex: string;
  readonly unsignedTransactionSha256: string;
  readonly material: ManagerClaimStakerRewardsIntentMaterial;
}

type TransactionNetwork = Exclude<
  NonNullable<Parameters<typeof makeUnsignedContractCall>[0]["network"]>,
  string
>;

function transactionNetwork(value: ParsedManagerClaimStakerRewardsPlanInput): TransactionNetwork {
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
 * Builds one operator-signed `claim-staker-rewards` call for a single
 * `(staker, reward-cycle, bond-index)` tuple.
 *
 * The call is permissionless and always pays the staker named in the arguments, never the sender,
 * so the operator can settle a staker without holding any authority over their funds. Both payout
 * routes reduce the manager's `sbtc-token` balance by exactly the net amount — the direct route
 * transfers it to the staker, the L1 route has `protocol-lock` burn it into the withdrawal system —
 * so one equality postcondition on the manager covers either outcome and rejects the other.
 *
 * Performs no reads, signing, fee estimation, nonce lookup, or broadcast.
 */
export async function planManagerClaimStakerRewards(
  input: ManagerClaimStakerRewardsPlanInput,
): Promise<ManagerClaimStakerRewardsPlan> {
  const value = managerClaimStakerRewardsPlanInputSchema.parse(input);
  const manager = parseContractPrincipal(value.managerContract);
  const postCondition = Pc.principal(value.managerContract)
    .willSendEq(value.expectedNetSats)
    .ft(
      value.sbtcTokenContract as `${string}.${string}`,
      MANAGER_CLAIM_STAKER_REWARDS_SBTC_ASSET_NAME,
    );
  const transaction = await makeUnsignedContractCall({
    contractAddress: manager.address,
    contractName: manager.contractName,
    functionName: MANAGER_CLAIM_STAKER_REWARDS_FUNCTION_NAME,
    functionArgs: [
      Cl.principal(value.stakerPrincipal),
      Cl.uint(value.rewardCycle),
      value.bondIndex === null ? Cl.none() : Cl.some(Cl.uint(value.bondIndex)),
    ],
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
    encodedPostConditions[0].address !== value.managerContract ||
    encodedPostConditions[0].condition !== "eq" ||
    BigInt(encodedPostConditions[0].amount) !== value.expectedNetSats ||
    encodedPostConditions[0].asset !==
      `${value.sbtcTokenContract}::${MANAGER_CLAIM_STAKER_REWARDS_SBTC_ASSET_NAME}`
  ) {
    throw new Error("Unsigned staker claim did not preserve the sealed postcondition");
  }

  const material: ManagerClaimStakerRewardsIntentMaterial = {
    schemaVersion: 1,
    adapter: {
      id: MANAGER_CLAIM_STAKER_REWARDS_ADAPTER_ID,
      revision: MANAGER_CLAIM_STAKER_REWARDS_ADAPTER_REVISION,
    },
    network: value.network,
    chainAnchor: {
      ...value.chainAnchor,
      rewardCycle: value.chainAnchor.rewardCycle.toString(),
    },
    attestationDigest: value.attestationDigest,
    managerSourceFingerprint: value.managerSourceFingerprint,
    rewardObservation: {
      grossSats: value.grossSats.toString(),
      feeSats: value.feeSats.toString(),
      managerUnclaimedStakerRewardsSats: value.managerUnclaimedStakerRewardsSats.toString(),
      feeSnapshot: {
        state: value.feeSnapshot.state,
        effectiveFeeBips: value.feeSnapshot.effectiveFeeBips.toString(),
      },
    },
    payout:
      value.payout.kind === "bitcoin-l1"
        ? {
            kind: "bitcoin-l1",
            poxAddress: {
              versionHex: value.payout.poxAddress.versionHex.toLowerCase(),
              hashbytesHex: value.payout.poxAddress.hashbytesHex.toLowerCase(),
            },
            maxFeeSats: value.payout.maxFeeSats.toString(),
            withdrawalAmountSats: (value.expectedNetSats - value.payout.maxFeeSats).toString(),
          }
        : { kind: "direct-sbtc" },
    sender: value.sender,
    call: {
      contract: value.managerContract,
      functionName: MANAGER_CLAIM_STAKER_REWARDS_FUNCTION_NAME,
      stakerPrincipal: value.stakerPrincipal,
      rewardCycle: value.rewardCycle.toString(),
      bondIndex: value.bondIndex === null ? null : value.bondIndex.toString(),
    },
    expectedEffect: {
      asset: `${value.sbtcTokenContract}::${MANAGER_CLAIM_STAKER_REWARDS_SBTC_ASSET_NAME}`,
      sender: value.managerContract,
      recipient: value.payout.kind === "bitcoin-l1" ? "sbtc-withdrawal" : value.stakerPrincipal,
      amount: value.expectedNetSats.toString(),
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
    kind: "manager-claim-staker-rewards",
    intentHash,
    unsignedTransactionHex,
    unsignedTransactionSha256,
    material,
  };
}
