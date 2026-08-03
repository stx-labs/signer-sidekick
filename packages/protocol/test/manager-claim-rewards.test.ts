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
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
  MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
  type ManagerClaimRewardsPlanInput,
  planManagerClaimRewards,
} from "../src/manager-claim-rewards.js";

const publicKey = privateKeyToPublic(`${"11".repeat(32)}01`);
const senderPrincipal = getAddressFromPublicKey(publicKey, "testnet");

function fixture(): ManagerClaimRewardsPlanInput {
  return {
    schemaVersion: 1,
    adapterRevision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
    network: { kind: "testnet", chainId: 0x8000_0005 },
    managerContract: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager",
    pox5Contract: "ST000000000000000000002AMW42H.pox-5",
    sbtcTokenContract: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token",
    rewardCycle: 5n,
    expectedSbtcOutflow: 1_234n,
    chainAnchor: {
      stacksBlockHeight: 9_000,
      indexBlockHash: `0x${"ab".repeat(32)}`,
      burnBlockHeight: 4_100,
      rewardCycle: 5n,
      rewardCycleLength: 100,
      prepareCycleLength: 10,
      cyclePosition: 50,
      phase: "reward",
      checkpoint: "second-half",
    },
    attestationDigest: "cd".repeat(32),
    managerSourceFingerprint: "12".repeat(32),
    rewardObservation: {
      calculationCheckpoint: "first-half",
      lastRewardComputeBurnHeight: 4_099,
      rewardsPerToken: 123_456_789n,
    },
    stxEarnedSats: 1_234n,
    bondBuckets: [],
    feeSnapshot: {
      state: "absent",
      effectiveFeeBips: 500n,
    },
    sender: { principal: senderPrincipal, publicKey },
    nonce: 7n,
    fee: 1_000n,
  };
}

function withChange(
  change: (value: ManagerClaimRewardsPlanInput) => void,
): ManagerClaimRewardsPlanInput {
  const value = structuredClone(fixture());
  change(value);
  return value;
}

describe("reference-manager claim-rewards transaction planner", () => {
  it("emits the reviewed deterministic testnet vector", async () => {
    const plan = await planManagerClaimRewards(fixture());

    expect(plan).toMatchObject({
      kind: "manager-claim-rewards",
      intentHash: "550fe51e946c58570645d6858bde2d73c1cb01e11865b0bb58e0ecad528b0a18",
      unsignedTransactionSha256: "17beb820be1e1568cb52c53d2ea17ac3705c39d6381a0bb9a7e5ac56567ee995",
      material: {
        adapter: {
          id: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
          revision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
        },
        chainAnchor: {
          stacksBlockHeight: 9_000,
          indexBlockHash: `0x${"ab".repeat(32)}`,
          burnBlockHeight: 4_100,
          rewardCycle: "5",
          rewardCycleLength: 100,
          prepareCycleLength: 10,
          cyclePosition: 50,
          phase: "reward",
          checkpoint: "second-half",
        },
        attestationDigest: "cd".repeat(32),
        managerSourceFingerprint: "12".repeat(32),
        rewardObservation: {
          calculationCheckpoint: "first-half",
          lastRewardComputeBurnHeight: 4_099,
          rewardsPerToken: "123456789",
        },
        stxEarnedSats: "1234",
        bondBuckets: [],
        feeSnapshot: {
          state: "absent",
          effectiveFeeBips: "500",
        },
        call: {
          contract: fixture().managerContract,
          functionName: MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
          bondPeriods: [],
          rewardCycle: "5",
        },
        expectedEffect: {
          asset: `${fixture().sbtcTokenContract}::sbtc-token`,
          sender: fixture().pox5Contract,
          recipient: fixture().managerContract,
          amount: "1234",
          condition: "eq",
          postConditionMode: "deny",
        },
        transaction: {
          nonce: "7",
          fee: "1000",
          unsignedTransactionSha256:
            "17beb820be1e1568cb52c53d2ea17ac3705c39d6381a0bb9a7e5ac56567ee995",
        },
      },
    });
    expect(plan.unsignedTransactionHex).toBe(
      "80800000050400fc7250a211deddc70ee5a2738de5f07817351cef000000000000000700000000000003e800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003020000000101031a000000000000000000000000000000000000000005706f782d3515f748f5d5313ff79c32b976ecf5bcd60600f75aec0a736274632d746f6b656e0a736274632d746f6b656e0100000000000004d2021a6d78de7b0625dfbfc16c3a8a5735f6dc3dc3f2ce0e7369676e65722d6d616e616765720d636c61696d2d72657761726473000000020b000000000100000000000000000000000000000005",
    );
  });

  it("serializes the fixed call, empty STX-only bond list, and exact Deny-mode outflow", async () => {
    const input = fixture();
    const plan = await planManagerClaimRewards(input);
    const transaction = deserializeTransaction(plan.unsignedTransactionHex);

    expect(transaction.transactionVersion).toBe(0x80);
    expect(transaction.chainId).toBe(input.network.chainId);
    expect(transaction.postConditionMode).toBe(PostConditionMode.Deny);
    expect(transaction.postConditions.values.map(wireToPostCondition)).toEqual([
      {
        type: "ft-postcondition",
        address: input.pox5Contract,
        condition: "eq",
        amount: input.expectedSbtcOutflow.toString(),
        asset: `${input.sbtcTokenContract}::sbtc-token`,
      },
    ]);
    expect(transaction.auth.spendingCondition).toMatchObject({
      nonce: input.nonce,
      fee: input.fee,
    });
    expect(transaction.payload.payloadType).toBe(PayloadType.ContractCall);
    if (transaction.payload.payloadType !== PayloadType.ContractCall) {
      throw new Error("Expected a contract-call transaction");
    }
    expect(transaction.payload.contractName.content).toBe("signer-manager");
    expect(transaction.payload.functionName.content).toBe(MANAGER_CLAIM_REWARDS_FUNCTION_NAME);
    expect(transaction.payload.functionArgs).toHaveLength(2);
    expect(transaction.payload.functionArgs[0]).toMatchObject({
      type: ClarityType.List,
      value: [],
    });
    expect(transaction.payload.functionArgs[1]).toMatchObject({
      type: ClarityType.UInt,
      value: 5n,
    });
  });

  it("uses mainnet transaction and address versions only with mainnet facts", async () => {
    const input = withChange((value) => {
      value.network = { kind: "mainnet", chainId: 1 };
      value.managerContract = "SP000000000000000000002Q6VF78.signer-manager";
      value.pox5Contract = "SP000000000000000000002Q6VF78.pox-5";
      value.sbtcTokenContract = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
      value.sender.principal = getAddressFromPublicKey(value.sender.publicKey, "mainnet");
    });

    const plan = await planManagerClaimRewards(input);
    const transaction = deserializeTransaction(plan.unsignedTransactionHex);
    expect(transaction.transactionVersion).toBe(0x00);
    expect(transaction.chainId).toBe(1);
    expect(plan.material.network).toEqual({ kind: "mainnet", chainId: 1 });
    expect(transaction.postConditions.values.map(wireToPostCondition)).toMatchObject([
      {
        address: input.pox5Contract,
        asset: `${input.sbtcTokenContract}::sbtc-token`,
      },
    ]);
  });

  it("is stable across calls and normalizes non-semantic hex casing", async () => {
    const first = await planManagerClaimRewards(fixture());
    const second = await planManagerClaimRewards(fixture());
    const uppercaseHex = withChange((value) => {
      value.attestationDigest = value.attestationDigest.toUpperCase();
      value.chainAnchor.indexBlockHash = value.chainAnchor.indexBlockHash.toUpperCase();
      value.managerSourceFingerprint = value.managerSourceFingerprint.toUpperCase();
      value.sender.publicKey = value.sender.publicKey.toUpperCase();
    });
    const normalized = await planManagerClaimRewards(uppercaseHex);

    expect(second).toEqual(first);
    expect(normalized).toEqual(first);
  });

  it("binds runtime observations without allowing them to alter the sealed transaction", async () => {
    const baseline = await planManagerClaimRewards(fixture());
    const observationChanges = [
      withChange((value) => {
        value.chainAnchor.stacksBlockHeight += 1;
      }),
      withChange((value) => {
        value.chainAnchor.rewardCycleLength += 2;
        value.chainAnchor.cyclePosition += 1;
      }),
      withChange((value) => {
        value.managerSourceFingerprint = "34".repeat(32);
      }),
      withChange((value) => {
        value.chainAnchor.rewardCycle += 1n;
        value.chainAnchor.burnBlockHeight = 4_160;
        value.chainAnchor.cyclePosition = 10;
        value.chainAnchor.checkpoint = "first-half";
        value.rewardObservation.calculationCheckpoint = "second-half";
        value.rewardObservation.lastRewardComputeBurnHeight = 4_149;
      }),
      withChange((value) => {
        value.rewardObservation.rewardsPerToken += 1n;
      }),
      withChange((value) => {
        value.feeSnapshot.state = "present";
        value.feeSnapshot.effectiveFeeBips += 1n;
      }),
    ];

    for (const changedInput of observationChanges) {
      const changed = await planManagerClaimRewards(changedInput);
      expect(changed.intentHash).not.toBe(baseline.intentHash);
      expect(changed.unsignedTransactionHex).toBe(baseline.unsignedTransactionHex);
      expect(changed.unsignedTransactionSha256).toBe(baseline.unsignedTransactionSha256);
    }
  });

  it("binds every mutable authority, anchor, effect, sender, and transaction input", async () => {
    const baseline = await planManagerClaimRewards(fixture());
    const otherPublicKey = privateKeyToPublic(`${"22".repeat(32)}01`);
    const variations: ManagerClaimRewardsPlanInput[] = [
      withChange((value) => {
        value.network.chainId += 1;
      }),
      withChange((value) => {
        value.managerContract = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.other-reference-manager";
      }),
      withChange((value) => {
        value.pox5Contract = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.pox-5";
      }),
      withChange((value) => {
        value.sbtcTokenContract = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-token";
      }),
      withChange((value) => {
        value.rewardCycle += 1n;
        value.chainAnchor.rewardCycle += 1n;
      }),
      withChange((value) => {
        value.expectedSbtcOutflow += 1n;
        value.stxEarnedSats += 1n;
      }),
      withChange((value) => {
        value.chainAnchor.stacksBlockHeight += 1;
      }),
      withChange((value) => {
        value.chainAnchor.indexBlockHash = `0x${"ef".repeat(32)}`;
      }),
      withChange((value) => {
        value.chainAnchor.burnBlockHeight += 1;
        value.chainAnchor.cyclePosition += 1;
      }),
      withChange((value) => {
        value.chainAnchor.rewardCycleLength += 2;
        value.chainAnchor.cyclePosition += 1;
      }),
      withChange((value) => {
        value.chainAnchor.prepareCycleLength -= 1;
      }),
      withChange((value) => {
        value.chainAnchor.cyclePosition += 1;
        value.rewardObservation.lastRewardComputeBurnHeight -= 1;
      }),
      withChange((value) => {
        value.chainAnchor.cyclePosition = 95;
        value.chainAnchor.phase = "prepare";
        value.chainAnchor.checkpoint = "second-half";
        value.rewardObservation.lastRewardComputeBurnHeight = 4_054;
      }),
      withChange((value) => {
        value.attestationDigest = "ef".repeat(32);
      }),
      withChange((value) => {
        value.managerSourceFingerprint = "34".repeat(32);
      }),
      withChange((value) => {
        value.chainAnchor.rewardCycle += 1n;
        value.chainAnchor.burnBlockHeight = 4_160;
        value.chainAnchor.cyclePosition = 10;
        value.chainAnchor.checkpoint = "first-half";
        value.rewardObservation.calculationCheckpoint = "second-half";
        value.rewardObservation.lastRewardComputeBurnHeight = 4_149;
      }),
      withChange((value) => {
        value.rewardObservation.rewardsPerToken += 1n;
      }),
      withChange((value) => {
        value.stxEarnedSats = 1_034n;
        value.bondBuckets = [
          {
            bondIndex: 0n,
            managerSharesSats: 9n,
            earnedSats: 200n,
            feeSnapshot: { state: "absent", effectiveFeeBips: 500n },
          },
        ];
      }),
      withChange((value) => {
        value.feeSnapshot.state = "present";
      }),
      withChange((value) => {
        value.feeSnapshot.effectiveFeeBips += 1n;
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
      const changed = await planManagerClaimRewards(variation);
      expect(changed.intentHash).not.toBe(baseline.intentHash);
    }
  });

  it("puts the bond-index list in the transaction and the bucket readings in the intent only", async () => {
    function bucketed(
      buckets: NonNullable<ManagerClaimRewardsPlanInput["bondBuckets"]>,
      stxEarnedSats: bigint,
    ): ManagerClaimRewardsPlanInput {
      return withChange((value) => {
        value.stxEarnedSats = stxEarnedSats;
        value.bondBuckets = buckets;
      });
    }
    const bucket = {
      bondIndex: 2n,
      managerSharesSats: 5_000n,
      earnedSats: 200n,
      feeSnapshot: { state: "present", effectiveFeeBips: 500n },
    } as const;

    const stxOnly = await planManagerClaimRewards(fixture());
    const withBond = await planManagerClaimRewards(bucketed([bucket], 1_034n));
    // The list is a call argument, so naming a bucket must change the signed bytes.
    expect(withBond.unsignedTransactionHex).not.toBe(stxOnly.unsignedTransactionHex);
    expect(withBond.material.call.bondPeriods).toEqual(["2"]);

    // Re-reading the same bucket at different values keeps the call identical but must not
    // reuse the earlier intent hash: the operator approved a specific set of readings.
    const restatedShares = await planManagerClaimRewards(
      bucketed([{ ...bucket, managerSharesSats: 4_000n }], 1_034n),
    );
    expect(restatedShares.unsignedTransactionHex).toBe(withBond.unsignedTransactionHex);
    expect(restatedShares.intentHash).not.toBe(withBond.intentHash);

    const restatedFee = await planManagerClaimRewards(
      bucketed([{ ...bucket, feeSnapshot: { state: "absent", effectiveFeeBips: 500n } }], 1_034n),
    );
    expect(restatedFee.unsignedTransactionHex).toBe(withBond.unsignedTransactionHex);
    expect(restatedFee.intentHash).not.toBe(withBond.intentHash);
  });

  it("keeps a zero-earning bucket in the claim so its fee snapshot is pinned", async () => {
    // PoX-5 returns a `bond-rewards` entry for every index passed, and the manager `map-insert`s a
    // fee for each. Dropping a zero-earning bucket would leave its fee to a later, possibly
    // different, configured value.
    const plan = await planManagerClaimRewards(
      withChange((value) => {
        value.bondBuckets = [
          {
            bondIndex: 4n,
            managerSharesSats: 9_000n,
            earnedSats: 0n,
            feeSnapshot: { state: "absent", effectiveFeeBips: 500n },
          },
        ];
      }),
    );

    expect(plan.material.call.bondPeriods).toEqual(["4"]);
    expect(plan.material.bondBuckets).toEqual([
      {
        bondIndex: "4",
        managerSharesSats: "9000",
        earnedSats: "0",
        feeSnapshot: { state: "absent", effectiveFeeBips: "500" },
      },
    ]);
    // The outflow is unchanged: a zero-earning bucket contributes nothing to the transfer.
    expect(plan.material.expectedEffect.amount).toBe("1234");
  });

  it("accepts the exact serialization limits", async () => {
    const input = withChange((value) => {
      value.rewardCycle = (1n << 128n) - 1n;
      value.chainAnchor.rewardCycle = value.rewardCycle;
      value.expectedSbtcOutflow = (1n << 64n) - 1n;
      value.stxEarnedSats = value.expectedSbtcOutflow;
      value.nonce = (1n << 64n) - 1n;
      value.fee = (1n << 64n) - 1n;
    });

    await expect(planManagerClaimRewards(input)).resolves.toMatchObject({
      kind: "manager-claim-rewards",
    });
  });

  it.each([
    ["unknown top-level field", (value: Record<string, unknown>) => (value.functionName = "evil")],
    ["wrong adapter revision", (value: Record<string, unknown>) => (value.adapterRevision = 3)],
    [
      "unsupported network",
      (value: Record<string, unknown>) => (value.network = { kind: "devnet", chainId: 0x80000000 }),
    ],
    [
      "mainnet-like test chain ID",
      (value: Record<string, unknown>) => (value.network = { kind: "testnet", chainId: 1 }),
    ],
    [
      "non-mainnet mainnet chain ID",
      (value: Record<string, unknown>) => (value.network = { kind: "mainnet", chainId: 2 }),
    ],
    [
      "invalid manager",
      (value: Record<string, unknown>) => (value.managerContract = "not-a-principal"),
    ],
    [
      "wrong-network manager",
      (value: Record<string, unknown>) =>
        (value.managerContract = "SP000000000000000000002Q6VF78.manager"),
    ],
    [
      "wrong PoX contract name",
      (value: Record<string, unknown>) =>
        (value.pox5Contract = "ST000000000000000000002AMW42H.pox-4"),
    ],
    [
      "wrong token contract name",
      (value: Record<string, unknown>) =>
        (value.sbtcTokenContract = "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.token"),
    ],
    ["negative reward cycle", (value: Record<string, unknown>) => (value.rewardCycle = -1n)],
    ["uint128 overflow", (value: Record<string, unknown>) => (value.rewardCycle = 1n << 128n)],
    [
      "zero expected outflow",
      (value: Record<string, unknown>) => {
        value.expectedSbtcOutflow = 0n;
        value.stxEarnedSats = 0n;
      },
    ],
    [
      "postcondition overflow",
      (value: Record<string, unknown>) => {
        value.expectedSbtcOutflow = 1n << 64n;
        value.stxEarnedSats = 1n << 64n;
      },
    ],
    [
      "mismatched anchor cycle",
      (value: Record<string, unknown>) =>
        ((value.chainAnchor as Record<string, unknown>).rewardCycle = 6n),
    ],
    [
      "unsafe anchor height",
      (value: Record<string, unknown>) =>
        ((value.chainAnchor as Record<string, unknown>).stacksBlockHeight =
          Number.MAX_SAFE_INTEGER + 1),
    ],
    [
      "invalid index hash",
      (value: Record<string, unknown>) =>
        ((value.chainAnchor as Record<string, unknown>).indexBlockHash = "0x01"),
    ],
    [
      "unknown anchor field",
      (value: Record<string, unknown>) =>
        ((value.chainAnchor as Record<string, unknown>).tip = "latest"),
    ],
    [
      "missing full anchor observation",
      (value: Record<string, unknown>) =>
        delete (value.chainAnchor as Record<string, unknown>).rewardCycleLength,
    ],
    [
      "zero reward-cycle length",
      (value: Record<string, unknown>) =>
        ((value.chainAnchor as Record<string, unknown>).rewardCycleLength = 0),
    ],
    [
      "odd reward-cycle length",
      (value: Record<string, unknown>) =>
        ((value.chainAnchor as Record<string, unknown>).rewardCycleLength = 99),
    ],
    [
      "prepare-cycle length exceeding reward-cycle length",
      (value: Record<string, unknown>) =>
        ((value.chainAnchor as Record<string, unknown>).prepareCycleLength = 101),
    ],
    [
      "cycle position outside the reward cycle",
      (value: Record<string, unknown>) =>
        ((value.chainAnchor as Record<string, unknown>).cyclePosition = 100),
    ],
    [
      "phase inconsistent with cycle position",
      (value: Record<string, unknown>) =>
        ((value.chainAnchor as Record<string, unknown>).phase = "prepare"),
    ],
    [
      "checkpoint inconsistent with cycle position",
      (value: Record<string, unknown>) =>
        ((value.chainAnchor as Record<string, unknown>).checkpoint = "first-half"),
    ],
    [
      "calculation checkpoint inconsistent with anchor",
      (value: Record<string, unknown>) =>
        ((value.rewardObservation as Record<string, unknown>).calculationCheckpoint =
          "second-half"),
    ],
    [
      "invalid attestation digest",
      (value: Record<string, unknown>) => (value.attestationDigest = "ab"),
    ],
    [
      "invalid manager source fingerprint",
      (value: Record<string, unknown>) => (value.managerSourceFingerprint = "12"),
    ],
    [
      "missing manager source fingerprint",
      (value: Record<string, unknown>) => delete value.managerSourceFingerprint,
    ],
    [
      "zero last reward-compute height",
      (value: Record<string, unknown>) =>
        ((value.rewardObservation as Record<string, unknown>).lastRewardComputeBurnHeight = 0),
    ],
    [
      "last reward-compute height after the anchor",
      (value: Record<string, unknown>) =>
        ((value.rewardObservation as Record<string, unknown>).lastRewardComputeBurnHeight = 4_101),
    ],
    [
      "negative rewards-per-token checkpoint",
      (value: Record<string, unknown>) =>
        ((value.rewardObservation as Record<string, unknown>).rewardsPerToken = -1n),
    ],
    [
      "rewards-per-token checkpoint overflow",
      (value: Record<string, unknown>) =>
        ((value.rewardObservation as Record<string, unknown>).rewardsPerToken = 1n << 128n),
    ],
    [
      "unknown reward observation field",
      (value: Record<string, unknown>) =>
        ((value.rewardObservation as Record<string, unknown>).tip = "latest"),
    ],
    [
      "missing reward observation",
      (value: Record<string, unknown>) => delete value.rewardObservation,
    ],
    ["missing bond buckets", (value: Record<string, unknown>) => delete value.bondBuckets],
    ["missing STX earnings", (value: Record<string, unknown>) => delete value.stxEarnedSats],
    [
      "more bond buckets than PoX-5 accepts",
      (value: Record<string, unknown>) => {
        value.stxEarnedSats = 1_234n;
        value.bondBuckets = Array.from({ length: 7 }, (_unused, index) => ({
          bondIndex: BigInt(index),
          managerSharesSats: 1n,
          earnedSats: 0n,
          feeSnapshot: { state: "absent", effectiveFeeBips: 500n },
        }));
      },
    ],
    [
      "duplicate bond bucket",
      (value: Record<string, unknown>) => {
        value.stxEarnedSats = 1_234n;
        value.bondBuckets = [0n, 0n].map((bondIndex) => ({
          bondIndex,
          managerSharesSats: 1n,
          earnedSats: 0n,
          feeSnapshot: { state: "absent", effectiveFeeBips: 500n },
        }));
      },
    ],
    [
      "descending bond buckets",
      (value: Record<string, unknown>) => {
        value.stxEarnedSats = 1_234n;
        value.bondBuckets = [2n, 1n].map((bondIndex) => ({
          bondIndex,
          managerSharesSats: 1n,
          earnedSats: 0n,
          feeSnapshot: { state: "absent", effectiveFeeBips: 500n },
        }));
      },
    ],
    [
      "bond bucket with neither shares nor earnings",
      (value: Record<string, unknown>) => {
        value.stxEarnedSats = 1_234n;
        value.bondBuckets = [
          {
            bondIndex: 0n,
            managerSharesSats: 0n,
            earnedSats: 0n,
            feeSnapshot: { state: "absent", effectiveFeeBips: 500n },
          },
        ];
      },
    ],
    [
      "outflow that does not cover every claimed bucket",
      (value: Record<string, unknown>) => {
        value.stxEarnedSats = 1_234n;
        value.bondBuckets = [
          {
            bondIndex: 0n,
            managerSharesSats: 10n,
            earnedSats: 7n,
            feeSnapshot: { state: "absent", effectiveFeeBips: 500n },
          },
        ];
      },
    ],
    [
      "unknown bond bucket field",
      (value: Record<string, unknown>) => {
        value.stxEarnedSats = 1_234n;
        value.bondBuckets = [
          {
            bondIndex: 0n,
            managerSharesSats: 10n,
            earnedSats: 0n,
            isL1Lock: true,
            feeSnapshot: { state: "absent", effectiveFeeBips: 500n },
          },
        ];
      },
    ],
    [
      "invalid fee-snapshot state",
      (value: Record<string, unknown>) =>
        ((value.feeSnapshot as Record<string, unknown>).state = "unknown"),
    ],
    [
      "negative fee-snapshot value",
      (value: Record<string, unknown>) =>
        ((value.feeSnapshot as Record<string, unknown>).effectiveFeeBips = -1n),
    ],
    [
      "fee-snapshot value outside the manager range",
      (value: Record<string, unknown>) =>
        ((value.feeSnapshot as Record<string, unknown>).effectiveFeeBips = 10_000n),
    ],
    [
      "unknown fee-snapshot field",
      (value: Record<string, unknown>) =>
        ((value.feeSnapshot as Record<string, unknown>).source = "default"),
    ],
    ["missing fee snapshot", (value: Record<string, unknown>) => delete value.feeSnapshot],
    [
      "invalid public key",
      (value: Record<string, unknown>) =>
        ((value.sender as Record<string, unknown>).publicKey = `02${"ff".repeat(32)}`),
    ],
    [
      "sender mismatch",
      (value: Record<string, unknown>) =>
        ((value.sender as Record<string, unknown>).principal = "ST000000000000000000002AMW42H"),
    ],
    [
      "unknown sender field",
      (value: Record<string, unknown>) =>
        ((value.sender as Record<string, unknown>).privateKey = "forbidden"),
    ],
    ["negative nonce", (value: Record<string, unknown>) => (value.nonce = -1n)],
    ["fee overflow", (value: Record<string, unknown>) => (value.fee = 1n << 64n)],
    [
      "caller-selected bond periods",
      (value: Record<string, unknown>) => (value.bondPeriods = [1n]),
    ],
    [
      "caller-selected postcondition mode",
      (value: Record<string, unknown>) => (value.postConditionMode = "allow"),
    ],
    [
      "caller-selected recipient",
      (value: Record<string, unknown>) => (value.recipient = "ST000000000000000000002AMW42H"),
    ],
  ])("rejects %s", async (_label, mutate) => {
    const input = structuredClone(fixture()) as unknown as Record<string, unknown>;
    mutate(input);
    await expect(
      planManagerClaimRewards(input as unknown as ManagerClaimRewardsPlanInput),
    ).rejects.toThrow();
  });
});
