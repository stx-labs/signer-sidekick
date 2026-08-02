import {
  ClarityType,
  deserializeTransaction,
  getAddressFromPublicKey,
  PayloadType,
  PostConditionMode,
  privateKeyToPublic,
  wireToPostCondition,
} from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  MANAGER_CLAIM_STAKER_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_STAKER_REWARDS_ADAPTER_REVISION,
  MANAGER_CLAIM_STAKER_REWARDS_FUNCTION_NAME,
  type ManagerClaimStakerRewardsPlanInput,
  planManagerClaimStakerRewards,
} from "../src/manager-claim-staker-rewards.js";

const publicKey = privateKeyToPublic(`${"11".repeat(32)}01`);
const senderPrincipal = getAddressFromPublicKey(publicKey, "testnet");
const managerContract = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
const sbtcTokenContract = "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token";
const stakerPrincipal = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";

function fixture(): ManagerClaimStakerRewardsPlanInput {
  return {
    schemaVersion: 1,
    adapterRevision: MANAGER_CLAIM_STAKER_REWARDS_ADAPTER_REVISION,
    network: { kind: "testnet", chainId: 0x8000_0005 },
    managerContract,
    sbtcTokenContract,
    stakerPrincipal,
    rewardCycle: 5n,
    bondIndex: null,
    chainAnchor: {
      stacksBlockHeight: 9_000,
      indexBlockHash: `0x${"ab".repeat(32)}`,
      burnBlockHeight: 4_100,
      rewardCycle: 5n,
    },
    attestationDigest: "cd".repeat(32),
    managerSourceFingerprint: "12".repeat(32),
    grossSats: 1_000n,
    feeSats: 50n,
    expectedNetSats: 950n,
    feeSnapshot: { state: "present", effectiveFeeBips: 500n },
    managerUnclaimedStakerRewardsSats: 10_000n,
    payout: { kind: "direct-sbtc" },
    sender: { principal: senderPrincipal, publicKey },
    nonce: 7n,
    fee: 1_000n,
  };
}

function withChange(
  change: (value: ManagerClaimStakerRewardsPlanInput) => void,
): ManagerClaimStakerRewardsPlanInput {
  const value = structuredClone(fixture());
  change(value);
  return value;
}

function l1Fixture(): ManagerClaimStakerRewardsPlanInput {
  return withChange((value) => {
    value.payout = {
      kind: "bitcoin-l1",
      poxAddress: { versionHex: "00", hashbytesHex: "07".repeat(20) },
      maxFeeSats: 100n,
    };
  });
}

describe("reference-manager claim-staker-rewards transaction planner", () => {
  it("serializes the tuple the contract takes and pins the manager's exact outflow", async () => {
    const plan = await planManagerClaimStakerRewards(fixture());
    const transaction = deserializeTransaction(plan.unsignedTransactionHex);

    expect(plan.kind).toBe("manager-claim-staker-rewards");
    expect(transaction.postConditionMode).toBe(PostConditionMode.Deny);
    // The payout leaves the manager, not the sender: the call is permissionless and the operator
    // signing it never touches the staker's funds.
    expect(transaction.postConditions.values.map(wireToPostCondition)).toEqual([
      {
        type: "ft-postcondition",
        address: managerContract,
        condition: "eq",
        amount: "950",
        asset: `${sbtcTokenContract}::sbtc-token`,
      },
    ]);
    expect(transaction.payload.payloadType).toBe(PayloadType.ContractCall);
    if (transaction.payload.payloadType !== PayloadType.ContractCall) {
      throw new Error("Expected a contract-call transaction");
    }
    expect(transaction.payload.functionName.content).toBe(
      MANAGER_CLAIM_STAKER_REWARDS_FUNCTION_NAME,
    );
    expect(transaction.payload.functionArgs).toHaveLength(3);
    expect(transaction.payload.functionArgs[0]).toMatchObject({
      type: ClarityType.PrincipalStandard,
    });
    expect(transaction.payload.functionArgs[1]).toMatchObject({
      type: ClarityType.UInt,
      value: 5n,
    });
    expect(transaction.payload.functionArgs[2]).toMatchObject({
      type: ClarityType.OptionalNone,
    });
    expect(plan.material).toMatchObject({
      adapter: {
        id: MANAGER_CLAIM_STAKER_REWARDS_ADAPTER_ID,
        revision: MANAGER_CLAIM_STAKER_REWARDS_ADAPTER_REVISION,
      },
      call: {
        contract: managerContract,
        functionName: MANAGER_CLAIM_STAKER_REWARDS_FUNCTION_NAME,
        stakerPrincipal,
        rewardCycle: "5",
        bondIndex: null,
      },
      payout: { kind: "direct-sbtc" },
      expectedEffect: {
        sender: managerContract,
        recipient: stakerPrincipal,
        amount: "950",
        condition: "eq",
        postConditionMode: "deny",
      },
    });
  });

  it("claims a bond bucket by passing the bond index as a some", async () => {
    const plan = await planManagerClaimStakerRewards(
      withChange((value) => {
        value.bondIndex = 3n;
      }),
    );
    const transaction = deserializeTransaction(plan.unsignedTransactionHex);
    if (transaction.payload.payloadType !== PayloadType.ContractCall) {
      throw new Error("Expected a contract-call transaction");
    }

    expect(transaction.payload.functionArgs[2]).toMatchObject({
      type: ClarityType.OptionalSome,
      value: { type: ClarityType.UInt, value: 3n },
    });
    expect(plan.material.call.bondIndex).toBe("3");
    // Same staker and cycle, different bucket: this must never collide with the STX-only claim.
    const stxOnly = await planManagerClaimStakerRewards(fixture());
    expect(plan.intentHash).not.toBe(stxOnly.intentHash);
    expect(plan.unsignedTransactionHex).not.toBe(stxOnly.unsignedTransactionHex);
  });

  it("uses one postcondition shape for both payout routes", async () => {
    const direct = await planManagerClaimStakerRewards(fixture());
    const l1 = await planManagerClaimStakerRewards(l1Fixture());

    // `protocol-lock` burns the manager's sbtc-token to fund the withdrawal, so the manager's
    // balance falls by the same net amount a direct transfer would move.
    const [directCondition] = deserializeTransaction(
      direct.unsignedTransactionHex,
    ).postConditions.values.map(wireToPostCondition);
    const [l1Condition] = deserializeTransaction(
      l1.unsignedTransactionHex,
    ).postConditions.values.map(wireToPostCondition);
    expect(l1Condition).toEqual(directCondition);

    // The routes still have to be distinguishable in what the operator approved.
    expect(l1.intentHash).not.toBe(direct.intentHash);
    expect(l1.material.payout).toEqual({
      kind: "bitcoin-l1",
      poxAddress: { versionHex: "00", hashbytesHex: "07".repeat(20) },
      maxFeeSats: "100",
      withdrawalAmountSats: "850",
    });
    expect(l1.material.expectedEffect.recipient).toBe("sbtc-withdrawal");
  });

  it("is stable across calls and normalizes non-semantic hex casing", async () => {
    const first = await planManagerClaimStakerRewards(l1Fixture());
    const second = await planManagerClaimStakerRewards(l1Fixture());
    const uppercase = await planManagerClaimStakerRewards(
      withChange((value) => {
        value.attestationDigest = value.attestationDigest.toUpperCase();
        value.managerSourceFingerprint = value.managerSourceFingerprint.toUpperCase();
        value.chainAnchor.indexBlockHash = value.chainAnchor.indexBlockHash.toUpperCase();
        value.sender.publicKey = value.sender.publicKey.toUpperCase();
        value.payout = {
          kind: "bitcoin-l1",
          poxAddress: { versionHex: "00", hashbytesHex: "07".repeat(20).toUpperCase() },
          maxFeeSats: 100n,
        };
      }),
    );

    expect(second).toEqual(first);
    expect(uppercase).toEqual(first);
  });

  it("binds every observation, anchor, and transaction input into the intent", async () => {
    const baseline = await planManagerClaimStakerRewards(fixture());
    const otherPublicKey = privateKeyToPublic(`${"22".repeat(32)}01`);
    const variations = [
      withChange((value) => {
        value.stakerPrincipal = "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5";
      }),
      withChange((value) => {
        value.rewardCycle += 1n;
      }),
      withChange((value) => {
        value.chainAnchor.stacksBlockHeight += 1;
      }),
      withChange((value) => {
        value.chainAnchor.indexBlockHash = `0x${"ef".repeat(32)}`;
      }),
      withChange((value) => {
        value.attestationDigest = "ef".repeat(32);
      }),
      withChange((value) => {
        value.managerSourceFingerprint = "34".repeat(32);
      }),
      withChange((value) => {
        // A different gross at the same net changes what the operator was shown.
        value.grossSats = 2_000n;
        value.feeSats = 1_050n;
        value.feeSnapshot = { state: "present", effectiveFeeBips: 5_250n };
      }),
      withChange((value) => {
        value.sender = {
          publicKey: otherPublicKey,
          principal: getAddressFromPublicKey(otherPublicKey, "testnet"),
        };
      }),
      withChange((value) => {
        value.nonce += 1n;
      }),
      withChange((value) => {
        value.fee += 1n;
      }),
    ];

    for (const variation of variations) {
      const changed = await planManagerClaimStakerRewards(variation);
      expect(changed.intentHash).not.toBe(baseline.intentHash);
    }
  });

  it.each([
    [
      "net that does not equal gross minus fee",
      (value: Record<string, unknown>) => (value.expectedNetSats = 951n),
    ],
    [
      "fee that does not match the snapshotted bips",
      (value: Record<string, unknown>) => {
        value.feeSats = 60n;
        value.expectedNetSats = 940n;
      },
    ],
    [
      "zero net payout",
      (value: Record<string, unknown>) => {
        value.grossSats = 0n;
        value.feeSats = 0n;
        value.expectedNetSats = 0n;
      },
    ],
    ["unknown top-level field", (value: Record<string, unknown>) => (value.broadcast = true)],
    ["wrong adapter revision", (value: Record<string, unknown>) => (value.adapterRevision = 2)],
    [
      "sender mismatch",
      (value: Record<string, unknown>) =>
        ((value.sender as Record<string, unknown>).principal = "ST000000000000000000002AMW42H"),
    ],
    [
      "mainnet chain id on testnet principals",
      (value: Record<string, unknown>) => (value.network = { kind: "mainnet", chainId: 1 }),
    ],
    [
      "non-sBTC asset contract",
      (value: Record<string, unknown>) =>
        (value.sbtcTokenContract = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.other-token"),
    ],
    [
      "invalid staker principal",
      (value: Record<string, unknown>) => (value.stakerPrincipal = "not-a-principal"),
    ],
  ])("rejects %s", async (_label, mutate) => {
    const input = structuredClone(fixture()) as unknown as Record<string, unknown>;
    mutate(input);
    await expect(
      planManagerClaimStakerRewards(input as unknown as ManagerClaimStakerRewardsPlanInput),
    ).rejects.toThrow();
  });

  it("rejects an L1 payout that cannot cover the staker's maximum withdrawal fee", async () => {
    // The manager returns ERR_NO_CLAIMABLE_REWARDS in this case, so planning it would hand the
    // operator a transaction that is known to revert.
    await expect(
      planManagerClaimStakerRewards(
        withChange((value) => {
          value.payout = {
            kind: "bitcoin-l1",
            poxAddress: { versionHex: "00", hashbytesHex: "07".repeat(20) },
            maxFeeSats: 951n,
          };
        }),
      ),
    ).rejects.toThrow();
  });

  it("enforces the sBTC dust limit on the withdrawn amount, not just the fee budget", async () => {
    // net 950, fee budget 403 -> withdrawn 547, one sat clear of the strict `> 546` assert.
    const atLimit = await planManagerClaimStakerRewards(
      withChange((value) => {
        value.payout = {
          kind: "bitcoin-l1",
          poxAddress: { versionHex: "00", hashbytesHex: "07".repeat(20) },
          maxFeeSats: 403n,
        };
      }),
    );
    expect(atLimit.material.payout).toMatchObject({ withdrawalAmountSats: "547" });

    // Exactly at the dust limit reverts in sbtc-withdrawal, so it must not be planned.
    for (const maxFeeSats of [404n, 950n]) {
      await expect(
        planManagerClaimStakerRewards(
          withChange((value) => {
            value.payout = {
              kind: "bitcoin-l1",
              poxAddress: { versionHex: "00", hashbytesHex: "07".repeat(20) },
              maxFeeSats,
            };
          }),
        ),
      ).rejects.toThrow();
    }
  });

  it("requires anchored proof that the manager already pulled the rewards in", async () => {
    // The manager only `map-insert`s a fee snapshot inside `claim-rewards`, so an absent snapshot
    // means it holds nothing for this bucket and the payout would revert on its own balance check.
    await expect(
      planManagerClaimStakerRewards(
        withChange((value) => {
          value.feeSnapshot = { state: "absent", effectiveFeeBips: 500n } as never;
        }),
      ),
    ).rejects.toThrow();

    await expect(
      planManagerClaimStakerRewards(
        withChange((value) => {
          value.managerUnclaimedStakerRewardsSats = 999n;
        }),
      ),
    ).rejects.toThrow();
  });
});
