import { createHash, randomUUID } from "node:crypto";
import type { ClarityValue } from "@stacks/transactions";
import {
  bufferCV,
  contractPrincipalCV,
  cvToHex,
  falseCV,
  getAddressFromPrivateKey,
  hexToCV,
  listCV,
  makeContractCall,
  noneCV,
  Pc,
  PostConditionMode,
  postConditionToHex,
  principalCV,
  privateKeyToPublic,
  responseOkCV,
  signMessageHashRsv,
  someCV,
  trueCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import type {
  BrowserWalletIntentCreateRequest,
  BrowserWalletTransaction,
} from "@stx-labs/signer-sidekick-api-contracts";
import type { NetworkCompatibilityProfile } from "@stx-labs/signer-sidekick-protocol/network-compatibility";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamHttpError } from "./chain-clients.js";
import type { RuntimeSettingsController } from "./runtime-settings.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";
import { canonicalJsonSha256 } from "./storage/wallet-intent-repository.js";
import type { IndexedTransactionObservation } from "./transaction-engine/live-transaction-reader.js";
import {
  type ManagerClaimWalletEvidence,
  type WalletIntentRuntimeState,
  WalletIntentService,
} from "./wallet-intent-service.js";

const {
  loadNetworkCompatibilityProfilesMock,
  readOperatorAnchorSnapshotMock,
  runOperatorPreflightMock,
} = vi.hoisted(() => ({
  loadNetworkCompatibilityProfilesMock: vi.fn(),
  readOperatorAnchorSnapshotMock: vi.fn(),
  runOperatorPreflightMock: vi.fn(),
}));

vi.mock("./operator-anchor-snapshot.js", () => ({
  readOperatorAnchorSnapshot: readOperatorAnchorSnapshotMock,
}));
vi.mock("./preflight.js", () => ({ runOperatorPreflight: runOperatorPreflightMock }));
vi.mock("./network-compatibility-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./network-compatibility-store.js")>()),
  loadNetworkCompatibilityProfiles: loadNetworkCompatibilityProfilesMock,
}));

const stores: SidekickStore[] = [];
const canRepairSignerRegistration = async () => true;
const senderKey = "1".padStart(64, "0");
const requiredSender = getAddressFromPrivateKey(senderKey, "mainnet");
const otherAdmin = getAddressFromPrivateKey("2".padStart(64, "0"), "mainnet");
const managerPrincipal = `${requiredSender}.signer-manager`;
const pox5ContractId = "SP000000000000000000002Q6VF78.pox-5";
const sbtcTokenContract = `${requiredSender}.sbtc-token`;
const source = "(define-public (ping) (ok true))";
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const compatibilityProfile = {
  schemaVersion: 1,
  id: "wallet-intent-network",
  revision: 1,
  publishedAt: "2026-07-18T00:00:00.000Z",
  label: "Wallet intent test network",
  network: "mainnet",
  networkId: 1,
  pox5: { contractId: pox5ContractId, sourceSha256: "55".repeat(32) },
  sbtc: {
    tokenContract: sbtcTokenContract,
    registryContract: `${requiredSender}.sbtc-registry`,
  },
  referenceManager: {
    profileId: "wallet-intent-test",
    upstream: {
      tag: "test",
      commit: "0".repeat(40),
      sourceSha256: "66".repeat(32),
    },
    expectedReplacements: { pox5: 1, sbtcDeployer: 1 },
    sourceSha256,
    canonicalSha256: sourceSha256,
  },
  capabilities: { pox5SbtcContractFields: true },
  provenance: { stacksCoreTag: "test", stacksCoreCommit: "0".repeat(40) },
  testedNodeBuilds: [],
} satisfies NetworkCompatibilityProfile;

function matchedPreflight(profile = compatibilityProfile) {
  return {
    status: "pass" as const,
    node: { networkId: 1 },
    checks: [
      { id: "node-network", status: "pass" as const, message: "Node network matches" },
      { id: "api-network", status: "pass" as const, message: "API and node networks agree" },
    ],
    compatibility: {
      status: "matched" as const,
      profileId: profile.id,
      profileRevision: profile.revision,
      managerProfileId: profile.referenceManager.profileId,
      managerSourceSha256: profile.referenceManager.sourceSha256,
    },
    pox: { pox5ContractId: profile.pox5.contractId, sbtcTokenContract: profile.sbtc.tokenContract },
  };
}

const indexBlockHash = `0x${"ef".repeat(32)}` as `0x${string}`;
const blockHash = `0x${"ab".repeat(32)}` as `0x${string}`;
const blockHeight = 9_001;

function deploymentFreshState(): WalletIntentRuntimeState {
  return {
    managerPrincipal,
    signerGrant: { verified: null },
  };
}

function reviewedManagerCapabilities(reviewed = true) {
  const ids = [
    "register-self",
    "update-admin",
    "update-fees",
    "withdraw-fees",
    "sweep-fee-refunds",
    "reference-reward-claims",
  ] as const;
  return {
    signerManagerTrait: { compatible: true, reason: "Exact trait signature" },
    observedFunctions: { public: [], readOnly: [] },
    sourceReview: {
      exactReviewed: reviewed,
      reason: reviewed ? "Exact reviewed source" : "No reviewed exact source match",
    },
    eventVocabulary: {
      id: "reference-manager-v1" as const,
      normalizationAvailable: reviewed,
      adapter: reviewed
        ? {
            id: "reference-manager-print-events",
            revision: 1,
            reviewedSourceSha256: sourceSha256,
          }
        : null,
      reason: reviewed ? "Reviewed event vocabulary" : "Generic events only",
    },
    actions: ids.map((id) => ({
      id,
      interfaceAvailable: true,
      executionAvailable: reviewed,
      missingFunctions: [],
      adapter: reviewed
        ? {
            id: `reference-manager-${id}`,
            revision: 1,
            reviewedSourceSha256: sourceSha256,
          }
        : null,
      reason: reviewed ? "Exact reviewed capability" : "No reviewed exact source match",
    })),
  };
}

function trustedManagerSnapshot(options: {
  manager?: string;
  networkId?: number;
  profileId?: string;
  signerKeyHex?: string;
}) {
  const manager = options.manager ?? managerPrincipal;
  const profileId = options.profileId ?? "wallet-intent-test";
  return {
    chainAnchor: {
      stacksBlockHeight: 9_000,
      indexBlockHash,
      burnBlockHeight: 8_000,
      rewardCycle: 5,
      rewardCycleLength: 100,
      prepareCycleLength: 10,
      cyclePosition: 50,
      phase: "reward",
      checkpoint: "second-half",
    },
    preflight: {
      node: { networkId: options.networkId ?? 1 },
      checks: [
        { id: "node-network", status: "pass", message: "Node network matches" },
        { id: "api-network", status: "pass", message: "API and node networks agree" },
      ],
      compatibility: {
        status: "matched",
        profileId: compatibilityProfile.id,
        profileRevision: compatibilityProfile.revision,
        managerProfileId: profileId,
        managerSourceSha256: sourceSha256,
      },
      pox: {
        pox5ContractId,
        sbtcTokenContract,
        pox5Available: true,
        sourceSha256: compatibilityProfile.pox5.sourceSha256,
      },
    },
    manager: {
      managerPrincipal: manager,
      attachAllowed: true,
      capabilities: reviewedManagerCapabilities(),
      provenance: {
        status: "built-in",
        upstreamProfileId: profileId,
        reason: "Built-in reference manager",
      },
      source: {
        recognized: true,
        tier: "reference-built-in",
        profileId,
        sha256: sourceSha256,
        canonicalSha256: sourceSha256,
      },
    },
    registration: options.signerKeyHex
      ? { registered: false, signerKeyGrantValid: false, signerKeyHex: options.signerKeyHex }
      : null,
  };
}

function currentManagerClaimEvidence(): ManagerClaimWalletEvidence {
  const setup = trustedManagerSnapshot({});
  return {
    observedAt: "2026-07-19T12:00:00.000Z",
    setup: {
      ...setup,
      preflight: {
        ...setup.preflight,
        network: "mainnet",
        pox: {
          ...setup.preflight.pox,
          firstRewardCycleId: 0,
        },
      },
    },
    rewards: {
      status: "ready",
      managerPrincipal,
      pox5ContractId,
      rewardCycle: 5,
      observedAt: {
        timestamp: "2026-07-19T12:00:00.000Z",
        burnBlockHeight: 8_000,
        stacksTipHeight: 9_000,
      },
      ingestion: { runId: "claim-run", completedAt: "2026-07-19T11:59:00.000Z" },
      global: {
        lastRewardComputeBurnHeight: "7999",
        lastComputedRewardCycle: "5",
        globalAccruedRewardsSats: "0",
        rewardsPerToken: "1234",
        signerEarnedBeforeManagerClaimSats: "100",
        signerEarnedAcrossBucketsSats: "300",
      },
      calculation: {
        state: "completed",
        targetRewardCycle: 5,
        targetCheckpoint: "first-half",
        expectedLastRewardComputeBurnHeight: 7_999,
        observedLastRewardComputeBurnHeight: "7999",
        next: null,
      },
      buckets: [
        {
          bondIndex: null,
          managerSharesSats: "0",
          signerEarnedBeforeManagerClaimSats: "100",
          rewardsPerToken: "1234",
          feeSnapshotBips: null,
          participating: true,
        },
        {
          bondIndex: "3",
          managerSharesSats: "10000",
          signerEarnedBeforeManagerClaimSats: "200",
          rewardsPerToken: "99",
          feeSnapshotBips: null,
          participating: true,
        },
      ],
      manager: {
        configuredFeeBips: "500",
        feeSnapshotBips: null,
        earnedFeesSats: "0",
        withdrawalLiabilitySats: "0",
        unclaimedStakerRewardsSats: "0",
      },
      totals: {
        stakers: 1,
        grossSats: "0",
        earnedSats: "0",
        feeSats: "0",
        actionableClaims: 0,
        l1ClaimsWaitingForFeeThreshold: 0,
      },
      stakers: [],
    },
  } as unknown as ManagerClaimWalletEvidence;
}

function registrationFreshState(
  signerKeyHex: string,
  signerSignatureHex = "03".repeat(65),
  expectedMessageHashHex = "ab".repeat(32),
): WalletIntentRuntimeState {
  const functionArgs = [
    cvToHex(contractPrincipalCV(requiredSender, "signer-manager")),
    cvToHex(bufferCV(Buffer.from(signerKeyHex, "hex"))),
    cvToHex(uintCV(7)),
    cvToHex(bufferCV(Buffer.from(signerSignatureHex, "hex"))),
  ];
  return {
    ...deploymentFreshState(),
    signerGrant: {
      verified: {
        managerPrincipal,
        pox5ContractId,
        authId: "7",
        signerKeyHex,
        signerSignatureHex,
        expectedMessageHashHex,
        signatureValid: true,
        registerSelfCall: {
          contract: managerPrincipal,
          functionName: "register-self",
          arguments: functionArgs,
          signingPrincipal: requiredSender,
          signingAuthority: "external-offline-admin",
        },
      },
    },
  };
}

function validRegistrationFreshState(
  signerPrivateKey: string,
  expectedMessageHashHex: string,
): WalletIntentRuntimeState {
  const signerKeyHex = privateKeyToPublic(signerPrivateKey);
  const signerSignatureHex = signMessageHashRsv({
    messageHash: expectedMessageHashHex,
    privateKey: signerPrivateKey,
  });
  return registrationFreshState(signerKeyHex, signerSignatureHex, expectedMessageHashHex);
}

async function proveRecurringManagerAction(input: {
  request: Exclude<
    BrowserWalletIntentCreateRequest,
    { action: "register-self" | "claim-rewards" | "calculate-rewards" }
  >;
  node: Record<string, unknown>;
  setCanonicalPoststate: () => void;
  restoreAuthoritativeFacts: () => void;
  managerSnapshot?: ReturnType<typeof trustedManagerSnapshot>;
  expectedOutcome?: "complete" | "canonical-success" | "mismatch";
  repeatable?: boolean;
  transactionIndexUnavailable?: boolean;
  transactionMissingFromIndex?: boolean;
  apiDetails?: Partial<{
    sponsored: boolean;
    anchorMode: "any" | "on_chain_only" | "off_chain_only";
    postConditionMode: "allow" | "deny";
  }>;
}): Promise<void> {
  const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
  stores.push(store);
  readOperatorAnchorSnapshotMock.mockResolvedValue(
    input.managerSnapshot ?? trustedManagerSnapshot({}),
  );
  let txid = `0x${"00".repeat(32)}` as `0x${string}`;
  let transactionHex = "";
  let preparedTransaction: BrowserWalletTransaction | null = null;
  const api = {
    getNodeInfo: vi.fn(async () => ({ network_id: 1 })),
    getTransaction: vi.fn(async () => ({
      tx_id: txid,
      status: "success",
      block: { height: blockHeight, index_hash: indexBlockHash },
    })),
    getTransactionDetails: vi.fn(async () => ({
      tx_id: txid,
      tx_status: "success",
      sender_address: requiredSender,
      tx_type: "contract_call",
      contract_call: preparedTransaction
        ? {
            contract_id: preparedTransaction.params.contract,
            function_name: preparedTransaction.params.functionName,
            function_args: preparedTransaction.params.functionArgs.map((hex) => ({ hex })),
          }
        : null,
      post_conditions: preparedTransaction?.params.postConditions.map(() => ({})) ?? [],
      sponsored: input.apiDetails?.sponsored ?? false,
      anchor_mode: input.apiDetails?.anchorMode ?? "any",
      post_condition_mode: input.apiDetails?.postConditionMode ?? "deny",
      canonical: true,
      block_hash: blockHash,
      block_height: blockHeight,
    })),
    getBlock: vi.fn(async () => ({
      canonical: true,
      height: blockHeight,
      hash: blockHash,
      index_block_hash: indexBlockHash,
    })),
  };
  const wallet = new WalletIntentService({
    store,
    runtimeSettings: {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node: {
          getInfo: vi.fn(async () => ({ network_id: 1 })),
          getTenureInfo: vi.fn(async () => ({
            tip_block_id: `0x${"99".repeat(32)}`,
            tip_height: blockHeight + 100,
            reward_cycle: 141,
          })),
          getNakamotoBlockById: vi.fn(async () => Uint8Array.of(1, 2, 3)),
          getNakamotoBlockAtHeight: vi.fn(async () => Uint8Array.of(1, 2, 3)),
          ...input.node,
        },
        api,
      }),
    } as unknown as RuntimeSettingsController,
    readState: deploymentFreshState,
    canRepairSignerRegistration,
    readerFactory: () => ({
      lookupIndexedTransaction: async () =>
        input.transactionMissingFromIndex
          ? {
              status: "not-found" as const,
              httpStatus: 404 as const,
            }
          : input.transactionIndexUnavailable
            ? {
                status: "unavailable" as const,
                httpStatus: 501,
                reason: "transaction-index-unavailable" as const,
              }
            : {
                status: "observed" as const,
                httpStatus: 200,
                value: {
                  txid,
                  transactionHex,
                  nonce: 9n,
                  feeUstx: 1_000n,
                  indexBlockHash,
                  blockHeight: BigInt(blockHeight),
                  isCanonical: true,
                  resultRepr: "(ok true)",
                },
              },
      lookupUnconfirmedTransaction: async () => ({ status: "not-found" as const, httpStatus: 404 }),
    }),
  });
  const prepared = await wallet.prepare(input.request, "2026-07-19T12:01:00.000Z");
  if (prepared.transaction.method !== "stx_callContract") {
    throw new Error("Expected manager contract call");
  }
  preparedTransaction = prepared.transaction;
  const postConditions =
    input.request.action === "withdraw-fees"
      ? [
          Pc.principal(managerPrincipal)
            .willSendEq(BigInt(input.request.amountSats))
            .ft(sbtcTokenContract as `${string}.${string}`, "sbtc-token"),
        ]
      : [];
  const transaction = await makeContractCall({
    contractAddress: requiredSender,
    contractName: "signer-manager",
    functionName: prepared.transaction.params.functionName,
    functionArgs: prepared.transaction.params.functionArgs.map(hexToCV),
    senderKey,
    network: "mainnet",
    fee: 1_000,
    nonce: 9,
    sponsored: false,
    postConditionMode: PostConditionMode.Deny,
    postConditions,
  });
  txid = `0x${transaction.txid()}`;
  transactionHex = Buffer.from(transaction.serializeBytes()).toString("hex");
  await wallet.submit(prepared.id, txid, "2026-07-19T12:02:00.000Z");
  input.setCanonicalPoststate();
  const expectedOutcome = input.expectedOutcome ?? "complete";
  const refreshed = await wallet.refresh(prepared.id, "2026-07-19T12:03:00.000Z");
  if (expectedOutcome === "mismatch") {
    expect(refreshed).toMatchObject({
      status: "failed",
      verification: { outcome: "mismatch", canonical: null },
    });
    return;
  }
  expect(refreshed).toMatchObject({
    status: expectedOutcome === "complete" ? "complete" : "confirmed",
    verification: { outcome: expectedOutcome, canonical: true },
  });

  input.restoreAuthoritativeFacts();
  const replacement = await wallet.prepare(input.request, "2026-07-19T12:04:00.000Z");
  if (input.repeatable === false) {
    expect(replacement).toMatchObject({
      id: prepared.id,
      action: input.request.action,
      status: "confirmed",
      txid,
    });
    return;
  }
  expect(replacement).toMatchObject({
    action: input.request.action,
    status: "prepared",
    txid: null,
  });
  expect(replacement.id).not.toBe(prepared.id);
  expect(store.walletIntents.get(prepared.id)?.state).toBe("superseded");
  expect(store.walletIntents.listObservations(prepared.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ outcome: expectedOutcome, canonical: true }),
    ]),
  );
}

type IndexedLookup =
  | { status: "not-found"; httpStatus: 404 }
  | { status: "unavailable"; httpStatus: number | null; reason: "http-error" }
  | { status: "observed"; httpStatus: 200; value: IndexedTransactionObservation };

async function submittedFeeActionHarness() {
  const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
  stores.push(store);
  readOperatorAnchorSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
  let currentFeeBips = 100n;
  let indexed: IndexedLookup = { status: "not-found", httpStatus: 404 };
  let txid = `0x${"00".repeat(32)}` as `0x${string}`;
  const node = {
    getInfo: vi.fn(async () => ({ network_id: 1 })),
    callReadOnly: vi.fn(async () => trueCV()),
    getDataVar: vi.fn(async () => uintCV(currentFeeBips)),
  };
  const api = {
    getNodeInfo: vi.fn(async () => ({ network_id: 1 })),
    getTransactionDetails: vi.fn(async () => {
      throw new UpstreamHttpError("not found", 404);
    }),
  };
  const runtimeSettings = {
    clients: () => ({
      config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
      node,
      api,
    }),
  } as unknown as RuntimeSettingsController;
  const readerFactory = () => ({
    lookupIndexedTransaction: async () => indexed,
    lookupUnconfirmedTransaction: async () => ({ status: "not-found" as const, httpStatus: 404 }),
  });
  const createWallet = () =>
    new WalletIntentService({
      store,
      runtimeSettings,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
      readerFactory,
    });
  const wallet = createWallet();
  const prepared = await wallet.prepare(
    { action: "update-fees", actorPrincipal: requiredSender, feeBips: "250" },
    "2026-07-19T12:01:00.000Z",
  );
  if (prepared.transaction.method !== "stx_callContract") {
    throw new Error("Expected fee update contract call");
  }
  const transaction = await makeContractCall({
    contractAddress: requiredSender,
    contractName: "signer-manager",
    functionName: prepared.transaction.params.functionName,
    functionArgs: prepared.transaction.params.functionArgs.map(hexToCV),
    senderKey,
    network: "mainnet",
    fee: 1_000,
    nonce: 9,
    sponsored: false,
    postConditionMode: PostConditionMode.Deny,
    postConditions: [],
  });
  txid = `0x${transaction.txid()}`;
  const observed: IndexedLookup = {
    status: "observed",
    httpStatus: 200,
    value: {
      txid,
      transactionHex: Buffer.from(transaction.serializeBytes()).toString("hex"),
      nonce: 9n,
      feeUstx: 1_000n,
      indexBlockHash,
      blockHeight: BigInt(blockHeight),
      isCanonical: true,
      resultRepr: "(ok true)",
    },
  };
  indexed = observed;
  await wallet.submit(prepared.id, txid, "2026-07-19T12:02:00.000Z");
  return {
    store,
    wallet,
    prepared,
    observed,
    createWallet,
    setCurrentFee(value: bigint) {
      currentFeeBips = value;
    },
    setIndexed(value: IndexedLookup) {
      indexed = value;
    },
  };
}

async function calculateRewardsWalletHarness() {
  const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
  stores.push(store);
  readOperatorAnchorSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
  let lastComputeHeight = 7_949n;
  let resultRepr = "(ok true)";
  let transactionHex = "";
  let txid = `0x${"00".repeat(32)}` as `0x${string}`;
  const node = {
    getInfo: vi.fn(async () => ({ network_id: 1 })),
    callReadOnly: vi.fn(
      async (_principal: string, functionName: string, _sender: string, args: string[]) => {
        if (functionName === "get-last-reward-compute-height") {
          return uintCV(lastComputeHeight);
        }
        if (functionName === "get-new-rewards") return uintCV(2_000);
        if (functionName === "bond-period-to-reward-cycle") return uintCV(1);
        if (functionName === "get-protocol-bond") return noneCV();
        if (functionName === "is-bond-active-at-height") {
          expect(args[1]).toBe(cvToHex(uintCV(7_999)));
          return falseCV();
        }
        throw new Error(`Unexpected read-only call ${functionName}`);
      },
    ),
    getDataVar: vi.fn(),
    getMapEntry: vi.fn(),
  };
  const wallet = new WalletIntentService({
    store,
    runtimeSettings: {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node,
        api: { getNodeInfo: vi.fn(async () => ({ network_id: 1 })) },
      }),
    } as unknown as RuntimeSettingsController,
    readState: deploymentFreshState,
    canRepairSignerRegistration,
    readerFactory: () => ({
      lookupIndexedTransaction: async () => ({
        status: "observed" as const,
        httpStatus: 200,
        value: {
          txid,
          transactionHex,
          nonce: 9n,
          feeUstx: 1_000n,
          indexBlockHash,
          blockHeight: BigInt(blockHeight),
          isCanonical: true,
          resultRepr,
        },
      }),
      lookupUnconfirmedTransaction: async () => ({
        status: "not-found" as const,
        httpStatus: 404,
      }),
    }),
  });
  const prepared = await wallet.prepare(
    { action: "calculate-rewards", actorPrincipal: requiredSender },
    "2026-07-19T12:01:00.000Z",
  );
  if (prepared.transaction.method !== "stx_callContract") throw new Error("Expected call");
  const transaction = await makeContractCall({
    contractAddress: "SP000000000000000000002Q6VF78",
    contractName: "pox-5",
    functionName: "calculate-rewards",
    functionArgs: prepared.transaction.params.functionArgs.map(hexToCV),
    senderKey,
    network: "mainnet",
    fee: 1_000,
    nonce: 9,
    sponsored: false,
    postConditionMode: PostConditionMode.Deny,
    postConditions: [],
  });
  txid = `0x${transaction.txid()}`;
  transactionHex = Buffer.from(transaction.serializeBytes()).toString("hex");
  return {
    store,
    wallet,
    prepared,
    txid,
    setLastComputeHeight(value: bigint) {
      lastComputeHeight = value;
    },
    setResultRepr(value: string) {
      resultRepr = value;
    },
  };
}

async function createSubmittedRegistration(input: { store: SidekickStore; signerKeyHex: string }) {
  const functionArgs = [
    contractPrincipalCV(requiredSender, "signer-manager"),
    bufferCV(Buffer.from(input.signerKeyHex, "hex")),
    uintCV(7),
    bufferCV(Uint8Array.from({ length: 65 }, () => 3)),
  ];
  const transaction = await makeContractCall({
    contractAddress: requiredSender,
    contractName: "signer-manager",
    functionName: "register-self",
    functionArgs,
    senderKey,
    network: "mainnet",
    fee: 1_000,
    nonce: 8,
    sponsored: false,
    postConditionMode: PostConditionMode.Deny,
    postConditions: [],
  });
  const id = randomUUID();
  const txid = `0x${transaction.txid()}` as `0x${string}`;
  const factsSha256 = canonicalJsonSha256({
    action: "register-self",
    signerKeyHex: input.signerKeyHex,
    functionArgs: functionArgs.map(cvToHex),
  });
  const manifest = {
    schemaVersion: 2 as const,
    id,
    action: "register-self" as const,
    network: "mainnet" as const,
    chainId: 1 as const,
    requiredSender,
    createdAt: "2026-07-19T12:01:00.000Z",
    expiresAt: "2026-07-19T12:16:00.000Z",
    transaction: {
      method: "stx_callContract" as const,
      params: {
        contract: managerPrincipal,
        functionName: "register-self" as const,
        functionArgs: functionArgs.map(cvToHex),
        network: "mainnet" as const,
        address: requiredSender,
        sponsored: false as const,
        postConditionMode: "deny" as const,
        postConditions: [] as string[],
      },
    },
    review: {
      title: "Register manager",
      summary: "Register the sealed signer key",
      expectedPostState: "The exact signer key is registered",
      fields: [{ label: "Manager", value: managerPrincipal }],
    },
    request: { action: "register-self" as const, actorPrincipal: requiredSender },
    seal: { factsSha256 },
  };
  input.store.walletIntents.create({
    id,
    action: "register-self",
    scope: managerPrincipal,
    factsSha256,
    manifest,
    manifestSha256: canonicalJsonSha256(manifest),
    requiredSender,
    network: "mainnet",
    chainId: 1,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
  });
  input.store.walletIntents.submit({ id, txid, submittedAt: "2026-07-19T12:02:00.000Z" });
  return {
    id,
    txid,
    transactionHex: Buffer.from(transaction.serializeBytes()).toString("hex"),
  };
}

beforeEach(() => {
  runOperatorPreflightMock.mockResolvedValue(matchedPreflight());
  loadNetworkCompatibilityProfilesMock.mockResolvedValue({
    directory: null,
    profiles: [{ profile: compatibilityProfile, origin: "built-in", fileName: null }],
    issues: [],
  });
});

afterEach(() => {
  readOperatorAnchorSnapshotMock.mockReset();
  runOperatorPreflightMock.mockReset();
  loadNetworkCompatibilityProfilesMock.mockReset();
  for (const store of stores.splice(0)) store.close();
});

describe("manager wallet action preparation", () => {
  it("prepares a manual all-bucket manager claim without an Assist job or attestation", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const getDataVar = vi.fn(async (_principal: string, variableName: string) => {
      if (variableName === "rewards-paused") return falseCV();
      throw new Error(`Unexpected data-var read ${variableName}`);
    });
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: { getDataVar },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
      readManagerClaimEvidence: async () => currentManagerClaimEvidence(),
    });

    const intent = await wallet.prepare(
      { action: "claim-rewards", actorPrincipal: requiredSender },
      "2026-07-19T12:01:00.000Z",
    );
    const expectedPostCondition = postConditionToHex(
      Pc.principal(pox5ContractId)
        .willSendEq(300n)
        .ft(sbtcTokenContract as `${string}.${string}`, "sbtc-token"),
    );
    expect(intent).toMatchObject({
      action: "claim-rewards",
      request: { action: "claim-rewards", actorPrincipal: requiredSender },
      requiredSender,
      transaction: {
        method: "stx_callContract",
        params: {
          contract: managerPrincipal,
          functionName: "claim-rewards",
          functionArgs: [cvToHex(listCV([uintCV(3)])), cvToHex(uintCV(5))],
          address: requiredSender,
          postConditionMode: "deny",
          postConditions: [expectedPostCondition],
        },
      },
    });
    expect(intent.review.fields).toEqual(
      expect.arrayContaining([
        { label: "Bond periods", value: "3" },
        { label: "Expected sBTC (sats)", value: "300" },
        { label: "STX bucket fee", value: "500 bips (pins with this claim)" },
      ]),
    );
    expect(readOperatorAnchorSnapshotMock).not.toHaveBeenCalled();
    expect(getDataVar).toHaveBeenCalledWith(
      "SP000000000000000000002Q6VF78.pox-5",
      "rewards-paused",
      {
        tip: indexBlockHash,
      },
    );
  });

  it("refuses a new manual manager claim while PoX-5 rewards are paused", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: { getDataVar: vi.fn(async () => trueCV()) },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
      readManagerClaimEvidence: async () => currentManagerClaimEvidence(),
    });

    await expect(
      wallet.prepare({ action: "claim-rewards", actorPrincipal: requiredSender }),
    ).rejects.toThrow("manager reward claims are currently paused");
  });

  it("defers a manual manager claim to an eligible Observe job for the same checkpoint", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const getDataVar = vi.fn();
    const findEligibleManagerClaimWalletJob = vi.fn(async () => ({
      jobId: "9284f4f4-7277-57f3-a251-08e9daf5f28a",
    }));
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: { getDataVar },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
      readManagerClaimEvidence: async () => currentManagerClaimEvidence(),
      findEligibleManagerClaimWalletJob,
    });

    await expect(
      wallet.prepare({ action: "claim-rewards", actorPrincipal: requiredSender }),
    ).rejects.toThrow("eligible Observe claim job already exists");
    expect(findEligibleManagerClaimWalletJob).toHaveBeenCalledOnce();
    expect(getDataVar).not.toHaveBeenCalled();
  });

  it("seals an actor-authorized fee update in a V2 manifest", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    readOperatorAnchorSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
    const runtimeSettings = {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node: {
          callReadOnly: vi.fn(async (_principal: string, functionName: string) => {
            if (functionName === "is-admin") return trueCV();
            throw new Error(`Unexpected read-only call ${functionName}`);
          }),
          getDataVar: vi.fn(async () => uintCV(100)),
        },
        api: {},
      }),
    } as unknown as RuntimeSettingsController;
    const wallet = new WalletIntentService({
      store,
      runtimeSettings,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
    });

    const intent = await wallet.prepare(
      { action: "update-fees", actorPrincipal: requiredSender, feeBips: "250" },
      "2026-07-19T12:01:00.000Z",
    );
    expect(intent).toMatchObject({
      schemaVersion: 2,
      action: "update-fees",
      request: { actorPrincipal: requiredSender, feeBips: "250" },
      network: "mainnet",
      chainId: 1,
      requiredSender,
      status: "prepared",
      transaction: {
        method: "stx_callContract",
        params: {
          contract: managerPrincipal,
          functionName: "update-fees",
          functionArgs: [cvToHex(uintCV(250))],
          postConditions: [],
        },
      },
    });
    expect(intent.review.fields).toContainEqual({ label: "New fee (bips)", value: "250" });
    expect(store.walletIntents.get(intent.id)).toMatchObject({
      action: "update-fees",
      network: "mainnet",
      chainId: 1,
    });
  });

  it.each([
    {
      name: "canonically completes the reviewed permissionless PoX-5 calculation",
      resultRepr: "(ok true)",
      expectedStatus: "complete",
      expectedOutcome: "complete",
    },
    {
      name: "records a losing permissionless calculation race as superseded",
      resultRepr: "(err u21)",
      expectedStatus: "superseded",
      expectedOutcome: "superseded",
    },
  ] as const)("$name", async ({ resultRepr, expectedStatus, expectedOutcome }) => {
    const harness = await calculateRewardsWalletHarness();
    const { prepared } = harness;
    expect(prepared).toMatchObject({
      action: "calculate-rewards",
      request: { action: "calculate-rewards", actorPrincipal: requiredSender },
      binding: {
        kind: "calculate-rewards",
        pox5ContractId,
        targetRewardCycle: 5,
        targetCheckpoint: "first-half",
        expectedLastRewardComputeBurnHeight: 7_999,
      },
      transaction: {
        method: "stx_callContract",
        params: {
          contract: pox5ContractId,
          functionName: "calculate-rewards",
          functionArgs: ["0x0b00000000"],
          postConditions: [],
        },
      },
    });
    harness.setResultRepr(resultRepr);
    await harness.wallet.submit(prepared.id, harness.txid, "2026-07-19T12:02:00.000Z");
    harness.setLastComputeHeight(7_999n);
    await expect(
      harness.wallet.refresh(prepared.id, "2026-07-19T12:03:00.000Z"),
    ).resolves.toMatchObject({
      status: expectedStatus,
      verification: { outcome: expectedOutcome, canonical: true },
    });
  });

  it("supersedes an unsigned calculation when the reviewed checkpoint changes", async () => {
    const harness = await calculateRewardsWalletHarness();
    harness.setLastComputeHeight(7_999n);

    await expect(
      harness.wallet.refresh(harness.prepared.id, "2026-07-19T12:02:00.000Z"),
    ).resolves.toMatchObject({
      status: "superseded",
      verification: { outcome: "superseded", canonical: null },
    });
  });

  it("refuses reward calculation without an exact reviewed PoX-5 profile", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const snapshot = trustedManagerSnapshot({});
    readOperatorAnchorSnapshotMock.mockResolvedValue({
      ...snapshot,
      preflight: {
        ...snapshot.preflight,
        compatibility: {
          ...snapshot.preflight.compatibility,
          status: "unrecognized",
          profileId: null,
          profileRevision: null,
        },
      },
    });
    const callReadOnly = vi.fn();
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: { callReadOnly },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
    });

    await expect(
      wallet.prepare({ action: "calculate-rewards", actorPrincipal: requiredSender }),
    ).rejects.toMatchObject({
      code: "wallet_execution_unavailable",
      message: expect.stringContaining("matches an installed reviewed network profile"),
    });
    expect(callReadOnly).not.toHaveBeenCalled();
  });

  it("blocks a reference-shaped action without an exact reviewed source", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const snapshot = trustedManagerSnapshot({});
    readOperatorAnchorSnapshotMock.mockResolvedValue({
      ...snapshot,
      preflight: {
        ...snapshot.preflight,
        compatibility: {
          ...snapshot.preflight.compatibility,
          status: "unrecognized",
          profileId: null,
          profileRevision: null,
          managerProfileId: null,
          managerSourceSha256: null,
        },
      },
      manager: {
        ...snapshot.manager,
        automationEligible: false,
        capabilities: reviewedManagerCapabilities(false),
        source: {
          ...snapshot.manager.source,
          recognized: false,
          tier: "unrecognized",
          profileId: null,
        },
      },
    });
    const runtimeSettings = {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node: {
          callReadOnly: vi.fn(async () => trueCV()),
          getDataVar: vi.fn(async () => uintCV(100)),
        },
        api: {},
      }),
    } as unknown as RuntimeSettingsController;
    const wallet = new WalletIntentService({
      store,
      runtimeSettings,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
    });

    await expect(
      wallet.prepare({
        action: "update-fees",
        actorPrincipal: requiredSender,
        feeBips: "250",
      }),
    ).rejects.toMatchObject({
      code: "wallet_execution_unavailable",
      message: "No reviewed exact source match",
    });
  });

  it("still rejects an external action when the manager is technically incompatible", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const snapshot = trustedManagerSnapshot({});
    readOperatorAnchorSnapshotMock.mockResolvedValue({
      ...snapshot,
      manager: { ...snapshot.manager, attachAllowed: false },
    });
    const callReadOnly = vi.fn();
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: { callReadOnly },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
    });

    await expect(
      wallet.prepare({
        action: "update-fees",
        actorPrincipal: requiredSender,
        feeBips: "250",
      }),
    ).rejects.toMatchObject({ code: "wallet_execution_unavailable" });
    expect(callReadOnly).not.toHaveBeenCalled();
  });

  it("prepares a new fee update when completed facts recur", async () => {
    let currentFeeBips = 100n;
    await proveRecurringManagerAction({
      request: { action: "update-fees", actorPrincipal: requiredSender, feeBips: "250" },
      node: {
        callReadOnly: vi.fn(async () => trueCV()),
        getDataVar: vi.fn(async () => uintCV(currentFeeBips)),
      },
      setCanonicalPoststate: () => {
        currentFeeBips = 250n;
      },
      restoreAuthoritativeFacts: () => {
        currentFeeBips = 100n;
      },
    });
  });

  it("demotes a completed recurring action when its canonical transaction disappears", async () => {
    const harness = await submittedFeeActionHarness();
    harness.setCurrentFee(250n);
    await expect(
      harness.wallet.refresh(harness.prepared.id, "2026-07-19T12:03:00.000Z"),
    ).resolves.toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });

    harness.setIndexed({ status: "not-found", httpStatus: 404 });
    await expect(
      harness.wallet.refresh(harness.prepared.id, "2026-07-19T12:04:00.000Z"),
    ).resolves.toMatchObject({
      status: "reobserve",
      verification: { outcome: "not-found", canonical: null },
    });
  });

  it("holds transaction replacement for the full propagation grace period", async () => {
    const harness = await submittedFeeActionHarness();
    harness.setIndexed({ status: "not-found", httpStatus: 404 });
    await expect(
      harness.wallet.refresh(harness.prepared.id, "2026-07-19T12:03:00.000Z"),
    ).resolves.toMatchObject({ status: "reobserve", verification: { outcome: "not-found" } });

    await expect(
      harness.wallet.replace(harness.prepared.id, "2026-07-19T12:16:59.999Z"),
    ).rejects.toThrow("Wait at least 15 minutes");
    expect(harness.wallet.get(harness.prepared.id)).toMatchObject({
      status: "reobserve",
      txid: harness.observed.status === "observed" ? harness.observed.value.txid : null,
    });
  });

  it("holds a failed transaction that disappears until propagation grace expires", async () => {
    const harness = await submittedFeeActionHarness();
    if (harness.observed.status !== "observed") throw new Error("Observed fixture is incomplete");
    harness.setIndexed({
      ...harness.observed,
      value: { ...harness.observed.value, resultRepr: "(err u1)" },
    });
    await expect(
      harness.wallet.refresh(harness.prepared.id, "2026-07-19T12:03:00.000Z"),
    ).resolves.toMatchObject({ status: "failed", verification: { outcome: "abort" } });
    harness.setIndexed({ status: "not-found", httpStatus: 404 });

    await expect(
      harness.wallet.prepare(
        { action: "update-fees", actorPrincipal: requiredSender, feeBips: "250" },
        "2026-07-19T12:10:00.000Z",
      ),
    ).resolves.toMatchObject({
      id: harness.prepared.id,
      status: "superseded",
      verification: { outcome: "not-found" },
    });
    await expect(
      harness.wallet.prepare(
        { action: "update-fees", actorPrincipal: requiredSender, feeBips: "250" },
        "2026-07-19T12:17:00.000Z",
      ),
    ).resolves.toMatchObject({ status: "prepared", txid: null });
  });

  it("recovers a submitted recurring action from the durable store after restart", async () => {
    const harness = await submittedFeeActionHarness();
    harness.setCurrentFee(250n);
    const restarted = harness.createWallet();

    await expect(
      restarted.refresh(harness.prepared.id, "2026-07-19T12:03:00.000Z"),
    ).resolves.toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });
  });

  it("records a nullable-height noncanonical recurring action without losing it", async () => {
    const harness = await submittedFeeActionHarness();
    if (harness.observed.status !== "observed") throw new Error("Observed fixture is incomplete");
    harness.setIndexed({
      ...harness.observed,
      value: {
        ...harness.observed.value,
        blockHeight: null,
        isCanonical: false,
      },
    });

    await expect(
      harness.wallet.refresh(harness.prepared.id, "2026-07-19T12:03:00.000Z"),
    ).resolves.toMatchObject({
      status: "reobserve",
      verification: {
        outcome: "noncanonical",
        canonical: false,
        blockHeight: null,
        indexBlockHash: null,
      },
    });
  });

  it("retires an unsigned replacement when its superseded transaction reappears", async () => {
    const harness = await submittedFeeActionHarness();
    harness.setIndexed({ status: "not-found", httpStatus: 404 });
    await expect(
      harness.wallet.refresh(harness.prepared.id, "2026-07-19T12:18:00.000Z"),
    ).resolves.toMatchObject({ status: "reobserve", verification: { outcome: "not-found" } });
    const replacement = await harness.wallet.replace(
      harness.prepared.id,
      "2026-07-19T12:20:00.000Z",
    );
    expect(replacement).toMatchObject({ status: "prepared", txid: null });

    harness.setCurrentFee(250n);
    harness.setIndexed(harness.observed);
    await expect(
      harness.wallet.refresh(replacement.id, "2026-07-19T12:21:00.000Z"),
    ).resolves.toMatchObject({ status: "superseded" });
    expect(harness.wallet.get(harness.prepared.id)).toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });
  });

  it("retires a failed recurring attempt and blocks its replacement if a reorg makes it succeed", async () => {
    const harness = await submittedFeeActionHarness();
    if (harness.observed.status !== "observed") throw new Error("Observed fixture is incomplete");
    harness.setIndexed({
      ...harness.observed,
      value: { ...harness.observed.value, resultRepr: "(err u1)" },
    });
    await expect(
      harness.wallet.refresh(harness.prepared.id, "2026-07-19T12:03:00.000Z"),
    ).resolves.toMatchObject({
      status: "failed",
      verification: { outcome: "abort", canonical: true },
    });

    const replacement = await harness.wallet.prepare(
      { action: "update-fees", actorPrincipal: requiredSender, feeBips: "250" },
      "2026-07-19T12:04:00.000Z",
    );
    expect(replacement).toMatchObject({ status: "prepared", txid: null });
    expect(replacement.id).not.toBe(harness.prepared.id);

    harness.setCurrentFee(250n);
    harness.setIndexed(harness.observed);
    await expect(
      harness.createWallet().refresh(replacement.id, "2026-07-19T12:05:00.000Z"),
    ).resolves.toMatchObject({
      id: replacement.id,
      status: "superseded",
      verification: { outcome: "superseded" },
    });
    expect(harness.wallet.get(harness.prepared.id)).toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });
  });

  it.each([
    "abort",
    "mismatch",
    "noncanonical",
  ] as const)("keeps a replacement signable after a superseded recurring %s", async (outcome) => {
    const harness = await submittedFeeActionHarness();
    harness.setIndexed({ status: "not-found", httpStatus: 404 });
    await harness.wallet.refresh(harness.prepared.id, "2026-07-19T12:18:00.000Z");
    const replacement = await harness.wallet.replace(
      harness.prepared.id,
      "2026-07-19T12:20:00.000Z",
    );
    if (harness.observed.status !== "observed") throw new Error("Observed fixture is incomplete");
    harness.setIndexed(
      outcome === "abort"
        ? {
            ...harness.observed,
            value: { ...harness.observed.value, resultRepr: "(err u1)" },
          }
        : outcome === "mismatch"
          ? {
              ...harness.observed,
              value: { ...harness.observed.value, transactionHex: "00" },
            }
          : {
              ...harness.observed,
              value: { ...harness.observed.value, isCanonical: false },
            },
    );

    await expect(
      harness.wallet.refresh(replacement.id, "2026-07-19T12:21:00.000Z"),
    ).resolves.toMatchObject({
      id: replacement.id,
      status: "prepared",
      verification: null,
    });
    expect(harness.wallet.get(harness.prepared.id)).toMatchObject({
      status: "superseded",
      verification: { outcome },
    });
  });

  it("falls back to the configured API when node transaction indexing is unavailable", async () => {
    let currentFeeBips = 100n;
    await proveRecurringManagerAction({
      request: { action: "update-fees", actorPrincipal: requiredSender, feeBips: "250" },
      transactionIndexUnavailable: true,
      node: {
        callReadOnly: vi.fn(async () => trueCV()),
        getDataVar: vi.fn(async () => uintCV(currentFeeBips)),
      },
      setCanonicalPoststate: () => {
        currentFeeBips = 250n;
      },
      restoreAuthoritativeFacts: () => {
        currentFeeBips = 100n;
      },
    });
  });

  it("uses node-canonical block proof when a historical transaction is absent from the index", async () => {
    let currentFeeBips = 100n;
    await proveRecurringManagerAction({
      request: { action: "update-fees", actorPrincipal: requiredSender, feeBips: "250" },
      transactionMissingFromIndex: true,
      node: {
        callReadOnly: vi.fn(async () => trueCV()),
        getDataVar: vi.fn(async () => uintCV(currentFeeBips)),
      },
      setCanonicalPoststate: () => {
        currentFeeBips = 250n;
      },
      restoreAuthoritativeFacts: () => {
        currentFeeBips = 100n;
      },
    });
  });

  it.each([
    ["sponsored", { sponsored: true }],
    ["on-chain-only", { anchorMode: "on_chain_only" as const }],
    ["allow post-condition", { postConditionMode: "allow" as const }],
  ])("rejects API fallback with %s transaction authority", async (_label, apiDetails) => {
    let currentFeeBips = 100n;
    await proveRecurringManagerAction({
      request: { action: "update-fees", actorPrincipal: requiredSender, feeBips: "250" },
      transactionIndexUnavailable: true,
      expectedOutcome: "mismatch",
      apiDetails,
      node: {
        callReadOnly: vi.fn(async () => trueCV()),
        getDataVar: vi.fn(async () => uintCV(currentFeeBips)),
      },
      setCanonicalPoststate: () => {
        currentFeeBips = 250n;
      },
      restoreAuthoritativeFacts: () => {
        currentFeeBips = 100n;
      },
    });
  });

  it("does not repeat a non-asset action before its expected poststate is verified", async () => {
    const currentFeeBips = 100n;
    await proveRecurringManagerAction({
      request: {
        action: "update-fees",
        actorPrincipal: requiredSender,
        feeBips: "250",
      },
      expectedOutcome: "canonical-success",
      repeatable: false,
      node: {
        callReadOnly: vi.fn(async () => trueCV()),
        getDataVar: vi.fn(async () => uintCV(currentFeeBips)),
      },
      setCanonicalPoststate: () => {},
      restoreAuthoritativeFacts: () => {},
    });
  });

  it("prepares a new admin update when completed facts recur", async () => {
    let targetEnabled = false;
    const targetHex = cvToHex(principalCV(otherAdmin));
    await proveRecurringManagerAction({
      request: { action: "add-admin", actorPrincipal: requiredSender, adminPrincipal: otherAdmin },
      node: {
        callReadOnly: vi.fn(
          async (_manager: string, functionName: string, _sender: string, args: string[]) => {
            if (functionName !== "is-admin") throw new Error("Unexpected manager read");
            return args[0] === targetHex ? (targetEnabled ? trueCV() : falseCV()) : trueCV();
          },
        ),
      },
      setCanonicalPoststate: () => {
        targetEnabled = true;
      },
      restoreAuthoritativeFacts: () => {
        targetEnabled = false;
      },
    });
  });

  it("prepares a new asset withdrawal when completed facts recur", async () => {
    let earnedFees = 500n;
    await proveRecurringManagerAction({
      request: {
        action: "withdraw-fees",
        actorPrincipal: requiredSender,
        amountSats: "100",
        recipient: requiredSender,
      },
      node: {
        callReadOnly: vi.fn(async (_manager: string, functionName: string) => {
          if (functionName === "is-admin") return trueCV();
          if (functionName === "get-earned-fees") return uintCV(earnedFees);
          throw new Error(`Unexpected manager read ${functionName}`);
        }),
      },
      setCanonicalPoststate: () => {
        earnedFees = 400n;
      },
      restoreAuthoritativeFacts: () => {
        earnedFees = 500n;
      },
    });
  });

  it("keeps custom-manager asset success canonical while allowing a later action", async () => {
    let earnedFees = 500n;
    const snapshot = trustedManagerSnapshot({});
    await proveRecurringManagerAction({
      request: {
        action: "withdraw-fees",
        actorPrincipal: requiredSender,
        amountSats: "100",
        recipient: requiredSender,
      },
      managerSnapshot: {
        ...snapshot,
        manager: {
          ...snapshot.manager,
          provenance: {
            status: "not-applicable",
            upstreamProfileId: null,
            reason: "Custom manager",
          },
          source: {
            ...snapshot.manager.source,
            recognized: false,
            tier: "custom-observe",
            profileId: null,
          },
        },
      },
      expectedOutcome: "canonical-success",
      node: {
        callReadOnly: vi.fn(async (_manager: string, functionName: string) => {
          if (functionName === "is-admin") return trueCV();
          if (functionName === "get-earned-fees") return uintCV(earnedFees);
          throw new Error(`Unexpected manager read ${functionName}`);
        }),
      },
      setCanonicalPoststate: () => {
        earnedFees = 400n;
      },
      restoreAuthoritativeFacts: () => {
        earnedFees = 500n;
      },
    });
  });

  it("seals a fee-refund sweep to the exact unreserved sBTC balance", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    readOperatorAnchorSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
    let balance = 1_000n;
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: {
            callReadOnly: vi.fn(
              async (principal: string, functionName: string): Promise<ClarityValue> => {
                if (functionName === "is-admin") return trueCV();
                if (principal === sbtcTokenContract && functionName === "get-balance") {
                  return responseOkCV(uintCV(balance));
                }
                if (functionName === "get-earned-fees") return uintCV(100);
                if (functionName === "get-withdrawal-liability") return uintCV(200);
                if (functionName === "get-unclaimed-staker-rewards") return uintCV(300);
                throw new Error(`Unexpected read-only call ${principal}.${functionName}`);
              },
            ),
          },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
    });

    const intent = await wallet.prepare({
      action: "sweep-fee-refunds",
      actorPrincipal: requiredSender,
      recipient: otherAdmin,
    });
    const expectedPostCondition = postConditionToHex(
      Pc.principal(managerPrincipal)
        .willSendEq(400n)
        .ft(sbtcTokenContract as `${string}.${string}`, "sbtc-token"),
    );
    expect(intent).toMatchObject({
      action: "sweep-fee-refunds",
      transaction: {
        method: "stx_callContract",
        params: {
          functionName: "sweep-fee-refunds",
          functionArgs: [cvToHex(principalCV(otherAdmin))],
          postConditionMode: "deny",
          postConditions: [expectedPostCondition],
        },
      },
    });
    expect(intent.review.fields).toEqual(
      expect.arrayContaining([
        { label: "Sweep amount (sats)", value: "400" },
        { label: "Reserved balance (sats)", value: "600" },
      ]),
    );

    balance = 600n;
    await expect(
      wallet.prepare({
        action: "sweep-fee-refunds",
        actorPrincipal: requiredSender,
        recipient: otherAdmin,
      }),
    ).rejects.toThrow("No fee refunds are currently available to sweep");
  });

  it("requires a current admin actor and prohibits self-removal", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    readOperatorAnchorSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
    let actorIsAdmin = false;
    const runtimeSettings = {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node: {
          callReadOnly: vi.fn(async () => (actorIsAdmin ? trueCV() : falseCV())),
        },
        api: {},
      }),
    } as unknown as RuntimeSettingsController;
    const wallet = new WalletIntentService({
      store,
      runtimeSettings,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
    });

    await expect(
      wallet.prepare({
        action: "remove-admin",
        actorPrincipal: requiredSender,
        adminPrincipal: requiredSender,
      }),
    ).rejects.toMatchObject({ code: "wallet_intent_invalid" });
    actorIsAdmin = true;
    await expect(
      wallet.prepare({
        action: "remove-admin",
        actorPrincipal: requiredSender,
        adminPrincipal: requiredSender,
      }),
    ).rejects.toThrow("cannot remove itself");
  });

  it("maps configured testnet only to the dedicated PoX-5 Testnet chain", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const testnetActor = getAddressFromPrivateKey(senderKey, "testnet");
    const testnetManager = `${testnetActor}.signer-manager`;
    const state: WalletIntentRuntimeState = {
      managerPrincipal: testnetManager,
      freshInput: null,
      managerArtifact: null,
      signerGrant: { verified: null },
    };
    readOperatorAnchorSnapshotMock.mockResolvedValue(
      trustedManagerSnapshot({
        manager: testnetManager,
        networkId: 0x80000005,
        profileId: "pox5-testnet-reference-manager",
      }),
    );
    const runtimeSettings = {
      clients: () => ({
        config: { network: "testnet", nodeRpcUrl: "http://node:20443" },
        node: {
          callReadOnly: vi.fn(async () => trueCV()),
          getDataVar: vi.fn(async () => uintCV(100)),
        },
        api: {},
      }),
    } as unknown as RuntimeSettingsController;
    const wallet = new WalletIntentService({
      store,
      runtimeSettings,
      readState: () => state,
      canRepairSignerRegistration,
    });

    const intent = await wallet.prepare({
      action: "update-fees",
      actorPrincipal: testnetActor,
      feeBips: "200",
    });
    expect(intent).toMatchObject({
      network: "pox5-testnet",
      chainId: 0x80000005,
      requiredSender: testnetActor,
      transaction: { params: { network: "pox5-testnet" } },
    });
    expect(store.walletIntents.get(intent.id)).toMatchObject({
      network: "testnet",
      chainId: 0x80000005,
    });
  });

  it.each([
    ["devnet", 0x80000000],
    ["regtest", 256],
  ] as const)("allows source-independent %s external actions on the exact configured private chain", async (network, chainId) => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const actorPrincipal = getAddressFromPrivateKey(senderKey, "testnet");
    const privateManager = `${actorPrincipal}.signer-manager`;
    const state: WalletIntentRuntimeState = {
      managerPrincipal: privateManager,
      freshInput: null,
      managerArtifact: null,
      signerGrant: { verified: null },
    };
    const snapshot = trustedManagerSnapshot({ manager: privateManager, networkId: chainId });
    const custom = network === "devnet";
    readOperatorAnchorSnapshotMock.mockResolvedValue({
      ...snapshot,
      preflight: {
        ...snapshot.preflight,
        compatibility: {
          ...snapshot.preflight.compatibility,
          status: "unrecognized",
          profileId: null,
          profileRevision: null,
          managerProfileId: null,
          managerSourceSha256: null,
        },
      },
      manager: {
        ...snapshot.manager,
        automationEligible: false,
        provenance: {
          status: custom ? "not-applicable" : "failed",
          upstreamProfileId: null,
          reason: custom ? "Operator-installed custom manager" : "Manager source is unrecognized",
        },
        source: {
          ...snapshot.manager.source,
          recognized: custom,
          tier: custom ? "custom-observe" : "unrecognized",
          profileId: custom ? `custom-${network}-manager` : null,
        },
      },
    });
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: {
            network,
            expectedNetworkId: chainId,
            nodeRpcUrl: "http://node:20443",
          },
          node: {
            callReadOnly: vi.fn(async () => trueCV()),
            getDataVar: vi.fn(async () => uintCV(100)),
          },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: () => state,
      canRepairSignerRegistration,
    });

    const intent = await wallet.prepare({
      action: "update-fees",
      actorPrincipal,
      feeBips: "200",
    });

    expect(intent).toMatchObject({
      network,
      chainId,
      requiredSender: actorPrincipal,
      transaction: { params: { network } },
    });
    expect(intent.review.fields).toContainEqual({
      label: "Source assurance",
      value: "Unverified or custom manager — review in signing tool",
    });
    expect(store.walletIntents.get(intent.id)).toMatchObject({ network, chainId });
  });

  it("does not reconcile a private-network intent after the logical network changes", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const actorPrincipal = getAddressFromPrivateKey(senderKey, "testnet");
    const privateManager = `${actorPrincipal}.signer-manager`;
    const id = randomUUID();
    const txid = `0x${"ab".repeat(32)}`;
    const facts = {
      schemaVersion: 2,
      request: { action: "update-fees", actorPrincipal, feeBips: "250" },
      managerPrincipal: privateManager,
      currentFeeBips: "100",
    };
    const factsSha256 = canonicalJsonSha256(facts);
    const manifest = {
      schemaVersion: 2 as const,
      id,
      action: "update-fees" as const,
      request: { action: "update-fees" as const, actorPrincipal, feeBips: "250" },
      network: "devnet" as const,
      chainId: 0x80000000,
      requiredSender: actorPrincipal,
      createdAt: "2026-07-19T12:00:00.000Z",
      expiresAt: "2026-07-19T12:15:00.000Z",
      transaction: {
        method: "stx_callContract" as const,
        params: {
          contract: privateManager,
          functionName: "update-fees" as const,
          functionArgs: [cvToHex(uintCV(250))],
          network: "devnet" as const,
          address: actorPrincipal,
          sponsored: false as const,
          postConditionMode: "deny" as const,
          postConditions: [] as [],
        },
      },
      review: {
        title: "Update manager fees",
        summary: "Set the manager fee rate to 250 basis points.",
        expectedPostState: "The configured manager fee is 250 basis points.",
        fields: [{ label: "Manager", value: privateManager }],
      },
      seal: { factsSha256 },
    };
    store.walletIntents.create({
      id,
      action: "update-fees",
      scope: privateManager,
      factsSha256,
      manifest,
      manifestSha256: canonicalJsonSha256(manifest),
      requiredSender: actorPrincipal,
      network: "devnet",
      chainId: manifest.chainId,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
    });
    store.walletIntents.submit({
      id,
      txid,
      submittedAt: "2026-07-19T12:01:00.000Z",
    });
    const readerFactory = vi.fn();
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: {
            network: "regtest",
            expectedNetworkId: manifest.chainId,
            nodeRpcUrl: "http://node:20443",
          },
          node: { getInfo: async () => ({ network_id: manifest.chainId }) },
          api: { getNodeInfo: async () => ({ network_id: manifest.chainId }) },
        }),
      } as unknown as RuntimeSettingsController,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
      readerFactory,
    });

    await expect(wallet.refresh(id, "2026-07-19T12:02:00.000Z")).resolves.toMatchObject({
      status: "submitted",
      verification: {
        outcome: "unavailable",
        detail: expect.stringContaining("configured network changed"),
      },
    });
    expect(readerFactory).not.toHaveBeenCalled();
  });

  it("rejects external actions when the local node chain ID binding fails", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const snapshot = trustedManagerSnapshot({});
    readOperatorAnchorSnapshotMock.mockResolvedValue({
      ...snapshot,
      preflight: {
        ...snapshot.preflight,
        node: { networkId: 2 },
      },
    });
    const callReadOnly = vi.fn();
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: { callReadOnly },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
    });

    await expect(
      wallet.prepare({
        action: "update-fees",
        actorPrincipal: requiredSender,
        feeBips: "250",
      }),
    ).rejects.toMatchObject({ code: "wallet_execution_unavailable" });
    expect(callReadOnly).not.toHaveBeenCalled();
  });

  it("keeps external wallet actions available when only the API network check fails", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const snapshot = trustedManagerSnapshot({});
    readOperatorAnchorSnapshotMock.mockResolvedValue({
      ...snapshot,
      preflight: {
        ...snapshot.preflight,
        checks: snapshot.preflight.checks.map((check) =>
          check.id === "api-network" ? { ...check, status: "fail" as const } : check,
        ),
      },
    });
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: {
            callReadOnly: vi.fn(async () => trueCV()),
            getDataVar: vi.fn(async () => uintCV(100)),
          },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
    });

    await expect(
      wallet.prepare({
        action: "update-fees",
        actorPrincipal: requiredSender,
        feeBips: "250",
      }),
    ).resolves.toMatchObject({
      transaction: { method: "stx_callContract", params: { functionName: "update-fees" } },
    });
  });

  it("refuses first-time signer registration when no current or next-cycle participation exists", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    readOperatorAnchorSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: {},
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: deploymentFreshState,
      canRepairSignerRegistration: async () => false,
    });

    await expect(
      wallet.prepare({ action: "register-self", actorPrincipal: requiredSender }),
    ).rejects.toMatchObject({
      code: "wallet_execution_unavailable",
      message:
        "Signer registration is available only as a repair or key rotation for established current or next-cycle participation; use Zero to Signing for first-time setup",
    });
  });

  it("rejects a persisted generic signer grant after PoX-5 consumed it", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const signerPrivateKey = `${"44".repeat(32)}01`;
    const expectedMessageHashHex = "de".repeat(32);
    const state = validRegistrationFreshState(signerPrivateKey, expectedMessageHashHex);
    const signerKeyHex = state.signerGrant.verified?.signerKeyHex;
    if (!signerKeyHex) throw new Error("Signer fixture is incomplete");
    readOperatorAnchorSnapshotMock.mockResolvedValue(trustedManagerSnapshot({ signerKeyHex }));
    const runtimeSettings = {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node: {
          callReadOnly: vi.fn(async (_principal: string, functionName: string) => {
            if (functionName === "is-admin") return trueCV();
            if (functionName === "get-signer-grant-message-hash") {
              return bufferCV(Buffer.from(expectedMessageHashHex, "hex"));
            }
            throw new Error(`Unexpected read-only call ${functionName}`);
          }),
          getMapEntry: vi.fn(async () => someCV(trueCV())),
        },
        api: {},
      }),
    } as unknown as RuntimeSettingsController;
    const wallet = new WalletIntentService({
      store,
      runtimeSettings,
      readState: () => state,
      canRepairSignerRegistration,
    });

    await expect(
      wallet.prepare({ action: "register-self", actorPrincipal: requiredSender }),
    ).rejects.toThrow("already been used");
  });

  it("re-verifies a rotated signer grant and refuses facts that changed during preparation", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const expectedMessageHashHex = "ca".repeat(32);
    const first = validRegistrationFreshState(`${"44".repeat(32)}01`, expectedMessageHashHex);
    const rotated = validRegistrationFreshState(`${"45".repeat(32)}01`, expectedMessageHashHex);
    const rotatedKey = rotated.signerGrant.verified?.signerKeyHex;
    if (!rotatedKey) throw new Error("Rotated signer fixture is incomplete");
    readOperatorAnchorSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
    let current = first;
    let reads = 0;
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: {
            callReadOnly: vi.fn(async (_principal: string, functionName: string) => {
              if (functionName === "is-admin") return trueCV();
              if (functionName === "get-signer-grant-message-hash") {
                return bufferCV(Buffer.from(expectedMessageHashHex, "hex"));
              }
              throw new Error(`Unexpected read-only call ${functionName}`);
            }),
            getMapEntry: vi.fn(async () => noneCV()),
          },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: () => {
        reads += 1;
        if (reads === 2) current = rotated;
        return current;
      },
      canRepairSignerRegistration,
    });

    await expect(
      wallet.prepare({ action: "register-self", actorPrincipal: requiredSender }),
    ).rejects.toMatchObject({ code: "wallet_intent_conflict" });
    expect(
      store.walletIntents.findActiveScope({
        action: "register-self",
        scope: managerPrincipal,
        now: "2026-07-19T12:01:00.000Z",
      }),
    ).toBeNull();

    await expect(
      wallet.prepare({ action: "register-self", actorPrincipal: requiredSender }),
    ).resolves.toMatchObject({
      status: "prepared",
      transaction: {
        params: {
          functionName: "register-self",
          functionArgs: expect.arrayContaining([cvToHex(bufferCV(Buffer.from(rotatedKey, "hex")))]),
        },
      },
    });
  });

  it("allows re-registration when the existing signer key grant is no longer valid", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const expectedMessageHashHex = "db".repeat(32);
    const state = validRegistrationFreshState(`${"46".repeat(32)}01`, expectedMessageHashHex);
    const signerKeyHex = state.signerGrant.verified?.signerKeyHex;
    if (!signerKeyHex) throw new Error("Signer fixture is incomplete");
    const snapshot = trustedManagerSnapshot({ signerKeyHex });
    readOperatorAnchorSnapshotMock.mockResolvedValue({
      ...snapshot,
      registration: { registered: true, signerKeyGrantValid: false, signerKeyHex },
    });
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: {
            callReadOnly: vi.fn(async (_principal: string, functionName: string) => {
              if (functionName === "is-admin") return trueCV();
              if (functionName === "get-signer-grant-message-hash") {
                return bufferCV(Buffer.from(expectedMessageHashHex, "hex"));
              }
              throw new Error(`Unexpected read-only call ${functionName}`);
            }),
            getMapEntry: vi.fn(async () => noneCV()),
          },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: () => state,
      canRepairSignerRegistration,
    });

    await expect(
      wallet.prepare({ action: "register-self", actorPrincipal: requiredSender }),
    ).resolves.toMatchObject({
      status: "prepared",
      transaction: { params: { functionName: "register-self" } },
    });
  });

  it("reconciles a submitted registration against its sealed signer key", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const sealedSignerKey = `02${"11".repeat(32)}`;
    const laterSignerKey = `03${"22".repeat(32)}`;
    const fixture = await createSubmittedRegistration({
      store,
      signerKeyHex: sealedSignerKey,
    });
    const registeredSnapshot = (signerKeyHex: string) => {
      const snapshot = trustedManagerSnapshot({ signerKeyHex });
      return {
        ...snapshot,
        registration: { registered: true, signerKeyGrantValid: true, signerKeyHex },
      };
    };
    readOperatorAnchorSnapshotMock
      .mockResolvedValueOnce(registeredSnapshot(sealedSignerKey))
      .mockResolvedValueOnce(registeredSnapshot(laterSignerKey));
    const wallet = new WalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: { getInfo: vi.fn(async () => ({ network_id: 1 })) },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readState: () => registrationFreshState(laterSignerKey),
      canRepairSignerRegistration,
      readerFactory: () => ({
        lookupIndexedTransaction: async () => ({
          status: "observed" as const,
          httpStatus: 200,
          value: {
            txid: fixture.txid,
            transactionHex: fixture.transactionHex,
            nonce: 8n,
            feeUstx: 1_000n,
            indexBlockHash,
            blockHeight: BigInt(blockHeight),
            isCanonical: true,
            resultRepr: "(ok true)",
          },
        }),
        lookupUnconfirmedTransaction: async () => ({
          status: "not-found" as const,
          httpStatus: 404,
        }),
      }),
    });

    await expect(wallet.refresh(fixture.id, "2026-07-19T12:03:00.000Z")).resolves.toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });
    await expect(wallet.refresh(fixture.id, "2026-07-19T12:04:00.000Z")).resolves.toMatchObject({
      status: "reobserve",
      verification: { outcome: "canonical-success", canonical: true },
    });
  });

  describe("staker reward claims", () => {
    const staker = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";

    async function stakerClaimWallet(reads: {
      earned: bigint;
      fees: bigint;
      unclaimed: bigint;
      poxAddr?: ClarityValue;
      feeBips?: bigint;
      /** `null` models an unclaimed bucket: the manager never inserted a fee snapshot for it. */
      feeSnapshot?: bigint | null;
    }) {
      const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
      stores.push(store);
      readOperatorAnchorSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
      return new WalletIntentService({
        store,
        runtimeSettings: {
          clients: () => ({
            config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
            node: {
              getInfo: vi.fn(async () => ({ network_id: 1 })),
              getMapEntry: vi.fn(async () =>
                reads.feeSnapshot === null ? noneCV() : someCV(uintCV(reads.feeSnapshot ?? 1_000n)),
              ),
              callReadOnly: vi.fn(async (_manager: string, functionName: string) => {
                if (functionName === "is-admin") {
                  throw new Error("Permissionless staker claims must not read manager-admin state");
                }
                if (functionName === "get-earned-staker-rewards") {
                  return tupleCV({ earned: uintCV(reads.earned), fees: uintCV(reads.fees) });
                }
                if (functionName === "get-pox-addr") return reads.poxAddr ?? noneCV();
                if (functionName === "get-fee-bips-for-cycle")
                  return uintCV(reads.feeBips ?? 1_000n);
                if (functionName === "get-unclaimed-staker-rewards") return uintCV(reads.unclaimed);
                throw new Error(`Unexpected manager read ${functionName}`);
              }),
            },
            api: { getNodeInfo: vi.fn(async () => ({ network_id: 1 })) },
          }),
        } as unknown as RuntimeSettingsController,
        readState: deploymentFreshState,
        canRepairSignerRegistration,
      });
    }

    const request = {
      action: "claim-staker-rewards",
      actorPrincipal: requiredSender,
      stakerPrincipal: staker,
      rewardCycle: "141",
      bondIndex: null,
    } as const;

    it("pins the manager's exact outflow for a direct sBTC payout", async () => {
      const wallet = await stakerClaimWallet({ earned: 9_000n, fees: 1_000n, unclaimed: 10_000n });

      const prepared = await wallet.prepare(request, "2026-07-19T12:01:00.000Z");

      expect(prepared.transaction.method).toBe("stx_callContract");
      if (prepared.transaction.method !== "stx_callContract") throw new Error("expected a call");
      expect(prepared.transaction.params.functionName).toBe("claim-staker-rewards");
      // (staker, reward-cycle, bond-index) -- exactly one settleable tuple per transaction.
      expect(prepared.transaction.params.functionArgs).toHaveLength(3);
      expect(prepared.transaction.params.postConditions).toHaveLength(1);
      expect(prepared.review.fields).toEqual(
        expect.arrayContaining([{ label: "Staker receives (sats)", value: "9000" }]),
      );
    });

    it("does not require the fee payer to be a manager admin", async () => {
      const wallet = await stakerClaimWallet({ earned: 9_000n, fees: 1_000n, unclaimed: 10_000n });

      await expect(wallet.prepare(request, "2026-07-19T12:01:00.000Z")).resolves.toMatchObject({
        action: "claim-staker-rewards",
        requiredSender,
      });
    });

    it("claims a bond bucket by naming its index", async () => {
      const wallet = await stakerClaimWallet({ earned: 500n, fees: 0n, unclaimed: 500n });

      const prepared = await wallet.prepare(
        { ...request, bondIndex: "3" },
        "2026-07-19T12:01:00.000Z",
      );

      expect(prepared.review.fields).toEqual(
        expect.arrayContaining([{ label: "Bucket", value: "bond period 3" }]),
      );
    });

    it.each([
      ["nothing settled in the bucket", { earned: 0n, fees: 0n, unclaimed: 10_000n }],
      [
        "the manager has not pulled the rewards in yet",
        { earned: 9_000n, fees: 1_000n, unclaimed: 0n },
      ],
      [
        // `get-fee-bips-for-cycle` would read this as a zero-fee bucket. Only the map entry itself
        // separates "never claimed" from "claimed at zero fee", and unrelated manager funds satisfy
        // the unclaimed-balance check on their own.
        "the bucket has no fee snapshot despite the manager holding funds",
        { earned: 9_000n, fees: 0n, unclaimed: 10_000n, feeSnapshot: null },
      ],
    ])("refuses a call the manager would reject: %s", async (_label, reads) => {
      const wallet = await stakerClaimWallet(reads);

      await expect(wallet.prepare(request, "2026-07-19T12:01:00.000Z")).rejects.toMatchObject({
        code: "wallet_intent_invalid",
      });
    });

    it("refuses a Bitcoin L1 payout that would revert on fee budget or dust", async () => {
      const l1 = (maxFee: bigint) =>
        someCV(
          tupleCV({
            "max-fee": uintCV(maxFee),
            "pox-addr": tupleCV({
              version: bufferCV(Uint8Array.of(0)),
              hashbytes: bufferCV(new Uint8Array(20).fill(7)),
            }),
          }),
        );

      // Below the staker's own fee budget: the manager rejects it.
      await expect(
        (
          await stakerClaimWallet({
            earned: 400n,
            fees: 0n,
            unclaimed: 400n,
            poxAddr: l1(500n),
            feeBips: 0n,
          })
        ).prepare(request, "2026-07-19T12:01:00.000Z"),
      ).rejects.toMatchObject({ code: "wallet_intent_invalid" });

      // Clears the fee budget but leaves a withdrawal at the dust limit: sbtc-withdrawal rejects it.
      await expect(
        (
          await stakerClaimWallet({
            earned: 1_046n,
            fees: 0n,
            unclaimed: 1_046n,
            poxAddr: l1(500n),
            feeBips: 0n,
          })
        ).prepare(request, "2026-07-19T12:01:00.000Z"),
      ).rejects.toMatchObject({ code: "wallet_intent_invalid" });

      // One sat clear of the dust limit is plannable.
      const prepared = await (
        await stakerClaimWallet({
          earned: 1_047n,
          fees: 0n,
          unclaimed: 1_047n,
          poxAddr: l1(500n),
          feeBips: 0n,
        })
      ).prepare(request, "2026-07-19T12:01:00.000Z");
      expect(prepared.review.fields).toEqual(
        expect.arrayContaining([{ label: "Payout route", value: "Bitcoin L1 withdrawal" }]),
      );
    });
  });
});
