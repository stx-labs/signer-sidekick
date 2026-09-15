import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClarityValue } from "@stacks/transactions";
import {
  AnchorMode,
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
  TransactionSigner,
  trueCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import type {
  BrowserWalletIntentCreateRequest,
  BrowserWalletTransaction,
  ConnectionAssessment,
} from "@stx-labs/signer-sidekick-api-contracts";
import type { NetworkCompatibilityProfile } from "@stx-labs/signer-sidekick-protocol/network-compatibility";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StacksApiClient, UpstreamHttpError, UpstreamUnavailableError } from "./chain-clients.js";
import { requireObservationAssessment } from "./connection-assessment.js";
import type { RuntimeSettingsController } from "./runtime-settings.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";
import { canonicalJsonSha256 } from "./storage/wallet-intent-repository.js";
import { apiTransactionReceipt } from "./test-helpers/api-transaction.js";
import { nakamotoBlockBytes as walletBlockBytes } from "./test-helpers/nakamoto-block.js";
import type {
  IndexedTransactionObservation,
  LiveLookup,
  UnconfirmedTransactionObservation,
} from "./transaction-engine/live-transaction-reader.js";
import {
  type ManagerClaimWalletEvidence,
  type WalletIntentRuntimeState,
  WalletIntentService,
} from "./wallet-intent-service.js";

const {
  loadNetworkCompatibilityProfilesMock,
  readOperatorAnchorSnapshotMock,
  runOperatorPreflightMock,
  inspectDeployedManagerMock,
} = vi.hoisted(() => ({
  loadNetworkCompatibilityProfilesMock: vi.fn(),
  readOperatorAnchorSnapshotMock: vi.fn(),
  runOperatorPreflightMock: vi.fn(),
  inspectDeployedManagerMock: vi.fn(),
}));

vi.mock("./operator-anchor-snapshot.js", () => ({
  readOperatorAnchorSnapshot: readOperatorAnchorSnapshotMock,
}));
vi.mock("./preflight.js", () => ({ runOperatorPreflight: runOperatorPreflightMock }));
vi.mock("./manager-verification.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manager-verification.js")>()),
  inspectDeployedManager: inspectDeployedManagerMock,
}));
vi.mock("./network-compatibility-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./network-compatibility-store.js")>()),
  loadNetworkCompatibilityProfiles: loadNetworkCompatibilityProfilesMock,
}));

const stores: SidekickStore[] = [];
const directories: string[] = [];
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
      reviewed: reviewed,
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
  signedAuthority?: Partial<{
    sponsored: boolean;
    anchorMode: "any" | "on_chain_only" | "off_chain_only";
    postConditionMode: "allow" | "deny";
    wrongPostCondition: boolean;
    wrongArgument: boolean;
  }>;
}): Promise<void> {
  const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
  stores.push(store);
  readOperatorAnchorSnapshotMock.mockResolvedValue(
    input.managerSnapshot ?? trustedManagerSnapshot({}),
  );
  inspectDeployedManagerMock.mockResolvedValue(
    (input.managerSnapshot ?? trustedManagerSnapshot({})).manager,
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
      sponsored: false,
      anchor_mode: "any",
      post_condition_mode: "deny",
      tx_result: { hex: "0x0703", repr: "(ok true)" },
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
          getNakamotoBlockById: vi.fn(async () => walletBlockBytes(transactionHex)),
          getNakamotoBlockAtHeight: vi.fn(async () => walletBlockBytes(transactionHex)),
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
            .willSendEq(
              BigInt(input.request.amountSats) +
                (input.signedAuthority?.wrongPostCondition ? 1n : 0n),
            )
            .ft(sbtcTokenContract as `${string}.${string}`, "sbtc-token"),
        ]
      : [];
  const transaction = await makeContractCall({
    contractAddress: requiredSender,
    contractName: "signer-manager",
    functionName: prepared.transaction.params.functionName,
    functionArgs: input.signedAuthority?.wrongArgument
      ? [uintCV(999)]
      : prepared.transaction.params.functionArgs.map(hexToCV),
    senderKey,
    network: "mainnet",
    fee: 1_000,
    nonce: 9,
    sponsored: input.signedAuthority?.sponsored ?? false,
    postConditionMode:
      input.signedAuthority?.postConditionMode === "allow"
        ? PostConditionMode.Allow
        : PostConditionMode.Deny,
    postConditions,
  });
  if (input.signedAuthority?.anchorMode === "on_chain_only") {
    // The v7 factory defaults to Any; explicitly encode and sign the non-matching authority.
    transaction.anchorMode = AnchorMode.OnChainOnly;
    new TransactionSigner(transaction).signOrigin(senderKey);
  }
  txid = `0x${transaction.txid()}`;
  transactionHex = Buffer.from(transaction.serializeBytes()).toString("hex");
  await wallet.submit(prepared.id, txid, "2026-07-19T12:02:00.000Z");
  input.setCanonicalPoststate();
  const expectedOutcome = input.expectedOutcome ?? "complete";
  const snapshotReads = readOperatorAnchorSnapshotMock.mock.calls.length;
  const refreshed = await wallet.refresh(prepared.id, "2026-07-19T12:03:00.000Z");
  if (input.request.action === "withdraw-fees" && expectedOutcome !== "mismatch") {
    expect(readOperatorAnchorSnapshotMock).toHaveBeenCalledTimes(snapshotReads);
    expect(inspectDeployedManagerMock).toHaveBeenCalledWith(
      expect.any(Object),
      "mainnet",
      managerPrincipal,
      undefined,
      { tip: indexBlockHash },
    );
  }
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
  // A later legitimate setting change does not rewrite historical transaction execution.
  if (expectedOutcome === "complete") {
    expect(await wallet.refresh(prepared.id, "2026-07-19T12:03:30.000Z")).toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });
  }
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

async function submittedFeeActionHarness(databasePath = ":memory:") {
  const { store } = await openSidekickStore(databasePath, "2026-07-19T12:00:00.000Z");
  stores.push(store);
  readOperatorAnchorSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
  let currentFeeBips = 100n;
  let indexed: IndexedLookup = { status: "not-found", httpStatus: 404 };
  let txid = `0x${"00".repeat(32)}` as `0x${string}`;
  const node = {
    getInfo: vi.fn(async () => ({ network_id: 1 })),
    callReadOnly: vi.fn(async () => trueCV()),
    getDataVar: vi.fn(async () => uintCV(currentFeeBips)),
    getTenureInfo: vi.fn(async () => ({
      tip_height: blockHeight + 1,
      tip_block_id: indexBlockHash,
    })),
    getNakamotoBlockById: vi.fn<() => Promise<Uint8Array>>(),
    getNakamotoBlockAtHeight: vi.fn<() => Promise<Uint8Array>>(),
  };
  const api = {
    getNodeInfo: vi.fn(async () => ({ network_id: 1 })),
    getTransactionDetails: vi.fn<() => Promise<unknown>>(async () => {
      throw new UpstreamHttpError("not found", 404);
    }),
    getBlock: vi.fn(async () => ({
      canonical: true,
      hash: blockHash,
      height: blockHeight,
      index_block_hash: indexBlockHash,
    })),
  };
  const runtimeSettings = {
    clients: () => ({
      config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
      node,
      api,
    }),
  } as unknown as RuntimeSettingsController;
  const readerFactory = () => ({
    lookupIndexedTransaction: lookupIndexed,
    lookupUnconfirmedTransaction: lookupPending,
  });
  const lookupIndexed = vi.fn(async () => indexed);
  const lookupPending = vi.fn<() => Promise<LiveLookup<UnconfirmedTransactionObservation>>>(
    async () => ({ status: "not-found", httpStatus: 404 }),
  );
  const createWallet = (
    overrides: Partial<ConstructorParameters<typeof WalletIntentService>[0]> = {},
  ) =>
    new WalletIntentService({
      store,
      runtimeSettings,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
      readerFactory,
      ...overrides,
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
    node,
    api,
    lookupIndexed,
    lookupPending,
    runtimeSettings,
    setCurrentFee(value: bigint) {
      currentFeeBips = value;
    },
    setIndexed(value: IndexedLookup) {
      indexed = value;
    },
  };
}

async function rememberMempool(
  h: Awaited<ReturnType<typeof submittedFeeActionHarness>>,
  at = "2026-07-19T12:03:00.000Z",
) {
  h.setIndexed({ status: "not-found", httpStatus: 404 });
  h.lookupPending.mockResolvedValue({
    status: "observed",
    httpStatus: 200,
    value: { ...h.observed.value, location: { kind: "mempool" } },
  });
  expect(await h.wallet.refresh(h.prepared.id, at)).toMatchObject({
    status: "mempool",
    verification: { outcome: "mempool" },
  });
  h.lookupPending.mockResolvedValue({ status: "not-found", httpStatus: 404 });
}

function reportApiMempool(
  h: Awaited<ReturnType<typeof submittedFeeActionHarness>>,
  txStatus: "pending" | "dropped_replace_by_fee",
) {
  if (h.prepared.transaction.method !== "stx_callContract") throw new Error("Expected call");
  // Exercise the real HTTP schema: Hiro returns 200 without canonical/block/result fields.
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      tx_id: h.observed.value.txid,
      tx_status: txStatus,
      sender_address: requiredSender,
      tx_type: "contract_call",
      contract_call: {
        contract_id: managerPrincipal,
        function_name: "update-fees",
        function_args: [
          { hex: cvToHex(uintCV(250)), repr: "u250", name: "fee-bips", type: "uint" },
        ],
      },
      nonce: 9,
      fee_rate: "1000",
      post_conditions: [],
      sponsored: false,
      anchor_mode: "any",
      post_condition_mode: "deny",
      receipt_time: 1784462580,
      receipt_time_iso: "2026-07-19T12:03:00.000Z",
      replaced_by_tx_id: null,
    }),
  );
  const client = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);
  h.api.getTransactionDetails.mockImplementation(() =>
    client.getTransactionDetails(h.observed.value.txid),
  );
  return fetchImpl;
}

function reportApiExecution(
  h: Awaited<ReturnType<typeof submittedFeeActionHarness>>,
  txStatus: "success" | "abort_by_response" | "abort_by_post_condition" = "success",
) {
  const client = new StacksApiClient(
    "https://api.example.test",
    undefined,
    undefined,
    vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json(
        apiTransactionReceipt({
          txId: h.observed.value.txid,
          blockHash,
          blockHeight,
          sender: requiredSender,
          status: txStatus,
          resultRepr: txStatus === "success" ? "(ok true)" : "(err u1)",
        }),
      ),
    ),
  );
  h.api.getTransactionDetails.mockImplementation(() =>
    client.getTransactionDetails(h.observed.value.txid),
  );
}

function nodeOffline(h: Awaited<ReturnType<typeof submittedFeeActionHarness>>) {
  h.node.getInfo.mockRejectedValue(new UpstreamUnavailableError("node offline"));
  h.node.getTenureInfo.mockRejectedValue(new UpstreamUnavailableError("node offline"));
  h.lookupIndexed.mockRejectedValue(new UpstreamUnavailableError("index offline"));
}

async function calculateRewardsWalletHarness() {
  const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
  stores.push(store);
  readOperatorAnchorSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
  let lastComputeHeight = 7_949n;
  let resultRepr = "(ok (tuple (stx-cycle u5) (calculation-height u7999)))";
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
    transactionHex,
    node,
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
  inspectDeployedManagerMock.mockResolvedValue(trustedManagerSnapshot({}).manager);
  runOperatorPreflightMock.mockResolvedValue(matchedPreflight());
  loadNetworkCompatibilityProfilesMock.mockResolvedValue({
    directory: null,
    profiles: [{ profile: compatibilityProfile, origin: "built-in", fileName: null }],
    issues: [],
  });
});

afterEach(async () => {
  inspectDeployedManagerMock.mockReset();
  readOperatorAnchorSnapshotMock.mockReset();
  runOperatorPreflightMock.mockReset();
  loadNetworkCompatibilityProfilesMock.mockReset();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
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

  it("rejects a retired single-job manager-claim binding", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
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
      canRepairSignerRegistration,
      readManagerClaimEvidence: async () => currentManagerClaimEvidence(),
    });

    await expect(
      wallet.prepare({
        action: "claim-rewards",
        actorPrincipal: requiredSender,
        jobId: "9284f4f4-7277-57f3-a251-08e9daf5f28a",
      }),
    ).rejects.toThrow(
      "Legacy manager-claim jobs are read-only; prepare a current claim from Rewards",
    );
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
      resultRepr: "(ok (tuple (stx-cycle u5) (calculation-height u7999)))",
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

  it.each([
    ["(ok (tuple (stx-cycle u5) (calculation-height u7999)))", "complete"],
    ["(ok (tuple (stx-cycle u6) (calculation-height u7999)))", "canonical-success"],
    ["(ok (tuple (stx-cycle u5) (calculation-height u8000)))", "canonical-success"],
    ["(ok true)", "canonical-success"],
  ])("uses calculation receipt %s without a poststate read", async (repr, outcome) => {
    const h = await calculateRewardsWalletHarness();
    h.setResultRepr(repr);
    await h.wallet.submit(h.prepared.id, h.txid, "2026-07-19T12:02:00.000Z");
    h.node.callReadOnly.mockReset().mockRejectedValue(new UpstreamUnavailableError("offline"));
    readOperatorAnchorSnapshotMock.mockClear();
    expect(
      (await h.wallet.refresh(h.prepared.id, "2026-07-19T12:03:00.000Z")).verification?.outcome,
    ).toBe(outcome);
    expect(h.node.callReadOnly).not.toHaveBeenCalled();
    expect(readOperatorAnchorSnapshotMock).not.toHaveBeenCalled();
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

  it("retains completed execution when the transaction temporarily disappears from lookups", async () => {
    const harness = await submittedFeeActionHarness();
    harness.setCurrentFee(250n);
    await expect(
      harness.wallet.refresh(harness.prepared.id, "2026-07-19T12:03:00.000Z"),
    ).resolves.toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });
    if (harness.observed.status !== "observed") throw new Error("Missing fixture");
    harness.setIndexed({
      ...harness.observed,
      value: { ...harness.observed.value, blockHeight: null },
    });
    expect(
      await harness.wallet.refresh(harness.prepared.id, "2026-07-19T12:03:30.000Z"),
    ).toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });

    harness.setIndexed({ status: "not-found", httpStatus: 404 });
    await expect(
      harness.wallet.refresh(harness.prepared.id, "2026-07-19T12:04:00.000Z"),
    ).resolves.toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
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

  it("checks full postcondition contents even when the API's count matches", async () => {
    await proveRecurringManagerAction({
      request: {
        action: "withdraw-fees",
        actorPrincipal: requiredSender,
        amountSats: "50",
        recipient: requiredSender,
      },
      node: {
        callReadOnly: vi.fn(async (_contract, fn) =>
          fn === "get-earned-fees" ? uintCV(100) : trueCV(),
        ),
      },
      transactionIndexUnavailable: true,
      signedAuthority: { wrongPostCondition: true },
      expectedOutcome: "mismatch",
      setCanonicalPoststate: () => {},
      restoreAuthoritativeFacts: () => {},
    });
  });

  it.each([
    "success",
    "abort",
    "orphaned-abort",
    "absent",
    "reorged",
    "malformed",
    "wrong-bytes",
  ])("handles API fallback %s only after exact canonical verification", async (kind) => {
    const h = await submittedFeeActionHarness();
    if (h.observed.status !== "observed") throw new Error("Missing fixture");
    h.setIndexed({ status: "not-found", httpStatus: 404 });
    const bytes = walletBlockBytes(h.observed.value.transactionHex);
    h.node.getNakamotoBlockById.mockResolvedValue(bytes);
    h.node.getNakamotoBlockAtHeight.mockResolvedValue(bytes);
    h.api.getTransactionDetails.mockResolvedValue({
      tx_id: h.observed.value.txid,
      tx_status: kind.includes("abort") ? "abort_by_response" : "success",
      tx_result: { repr: kind.includes("abort") ? "(err u1)" : "(ok true)" },
      canonical: kind !== "orphaned-abort",
      block_hash: blockHash,
      block_height: blockHeight,
    });
    if (kind === "absent") {
      h.node.getNakamotoBlockById.mockResolvedValue(new Uint8Array(220));
      h.node.getNakamotoBlockAtHeight.mockResolvedValue(new Uint8Array(220));
    }
    if (kind === "reorged") h.node.getNakamotoBlockAtHeight.mockResolvedValue(new Uint8Array(220));
    if (kind === "malformed") {
      h.node.getNakamotoBlockById.mockResolvedValue(bytes.slice(0, -1));
      h.node.getNakamotoBlockAtHeight.mockResolvedValue(bytes.slice(0, -1));
    }
    if (kind === "wrong-bytes") {
      const wrong = await makeContractCall({
        contractAddress: requiredSender,
        contractName: "signer-manager",
        functionName: "update-fees",
        functionArgs: [uintCV(999)],
        senderKey,
        network: "mainnet",
        fee: 1000,
        nonce: 9,
        postConditionMode: PostConditionMode.Deny,
      });
      // A different transaction in the canonical block cannot prove the bound ID's inclusion.
      const wrongBytes = walletBlockBytes(wrong.serialize());
      h.node.getNakamotoBlockById.mockResolvedValue(wrongBytes);
      h.node.getNakamotoBlockAtHeight.mockResolvedValue(wrongBytes);
    }
    const expected =
      kind === "success"
        ? ["complete", "complete"]
        : kind === "abort"
          ? ["failed", "abort"]
          : ["absent", "reorged", "wrong-bytes"].includes(kind)
            ? ["reobserve", "noncanonical"]
            : ["submitted", "unavailable"];
    expect(await h.wallet.refresh(h.prepared.id, "2026-07-19T12:03:00.000Z")).toMatchObject({
      status: expected[0],
      verification: { outcome: expected[1] },
    });
    if (expected[1] === "noncanonical")
      await expect(h.wallet.replace(h.prepared.id, "2026-07-19T12:20:00.000Z")).rejects.toThrow();
    if (expected[1] === "noncanonical") expect(h.lookupPending).not.toHaveBeenCalled();
  });

  it.each([
    "pending",
    "dropped_replace_by_fee",
  ] as const)("verifies node mempool bytes after HTTP 200 %s and later completes using API evidence", async (txStatus) => {
    const h = await submittedFeeActionHarness();
    const fetchImpl = reportApiMempool(h, txStatus);
    await rememberMempool(h);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.example.test/extended/v1/tx/${h.observed.value.txid}`,
      expect.any(Object),
    );
    expect(h.lookupPending).toHaveBeenCalledOnce();
    expect(h.store.walletIntents.latestObservation(h.prepared.id)).toMatchObject({
      outcome: "mempool",
      canonical: null,
      evidence: { decoded: { txid: h.observed.value.txid } },
    });
    nodeOffline(h);
    reportApiExecution(h);
    expect(await h.wallet.refresh(h.prepared.id, "2026-07-19T12:04:00.000Z")).toMatchObject({
      status: "complete",
      verification: { outcome: "complete", executionSource: "api" },
    });
  });

  it.each([
    429,
    503,
    "malformed",
  ] as const)("keeps exact mempool evidence usable during API %s", async (failure) => {
    const h = await submittedFeeActionHarness();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        failure === "malformed"
          ? Response.json({ tx_id: h.observed.value.txid, tx_status: "success" })
          : Response.json(
              { error: "unavailable" },
              { status: failure, headers: { "Retry-After": failure === 503 ? "0" : "90" } },
            ),
      );
    const api = new StacksApiClient("https://api.example.test", undefined, undefined, fetchImpl);
    h.api.getTransactionDetails.mockImplementation(() =>
      api.getTransactionDetails(h.observed.value.txid),
    );
    await rememberMempool(h);
    expect(fetchImpl).toHaveBeenCalledTimes(failure === 503 ? 4 : 1);
    expect(h.lookupPending).toHaveBeenCalledOnce();
    expect(h.store.walletIntents.latestObservation(h.prepared.id)).toMatchObject({
      outcome: "mempool",
      canonical: null,
    });
    nodeOffline(h);
    reportApiExecution(h);
    expect(await h.wallet.refresh(h.prepared.id, "2026-07-19T12:04:00.000Z")).toMatchObject({
      status: "complete",
      verification: { outcome: "complete", executionSource: "api" },
    });
  });

  it.each([
    "not-found",
    "unavailable",
  ] as const)("does not permit replacement on API failure plus %s mempool", async (pendingStatus) => {
    const h = await submittedFeeActionHarness();
    h.setIndexed({ status: "not-found", httpStatus: 404 });
    await h.wallet.refresh(h.prepared.id, "2026-07-19T12:02:30.000Z");
    expect(h.wallet.get(h.prepared.id).verification?.outcome).toBe("not-found");
    h.lookupPending.mockClear();
    h.api.getTransactionDetails.mockRejectedValue(new UpstreamUnavailableError("API offline"));
    h.lookupPending.mockResolvedValue(
      pendingStatus === "not-found"
        ? { status: "not-found", httpStatus: 404 }
        : { status: "unavailable", httpStatus: 503, reason: "http-error" },
    );
    expect(await h.wallet.refresh(h.prepared.id, "2026-07-19T12:03:00.000Z")).toMatchObject({
      status: "reobserve",
      verification: { outcome: "unavailable" },
    });
    expect(h.lookupPending).toHaveBeenCalledOnce();
    await expect(h.wallet.replace(h.prepared.id, "2026-07-19T12:20:00.000Z")).rejects.toThrow();
  });

  it("keeps a dropped API record non-terminal and retains the full missing-transaction replacement grace", async () => {
    const h = await submittedFeeActionHarness();
    reportApiMempool(h, "dropped_replace_by_fee");
    h.setIndexed({ status: "not-found", httpStatus: 404 });
    expect(await h.wallet.refresh(h.prepared.id, "2026-07-19T12:03:00.000Z")).toMatchObject({
      status: "reobserve",
      verification: { outcome: "not-found" },
    });
    expect(h.lookupPending).toHaveBeenCalledOnce();
    expect(
      h.store.walletIntents.listObservations(h.prepared.id).some((o) => o.outcome === "mempool"),
    ).toBe(false);
    await expect(h.wallet.replace(h.prepared.id, "2026-07-19T12:16:59.999Z")).rejects.toThrow(
      "Wait at least 15 minutes",
    );
    expect(await h.wallet.replace(h.prepared.id, "2026-07-19T12:17:00.000Z")).toMatchObject({
      status: "prepared",
      txid: null,
    });
    expect(h.wallet.get(h.prepared.id).status).toBe("superseded");
  });

  it("uses durable exact mempool verification after file-backed restart and intervening missing observations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wallet-api-completion-"));
    directories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const h = await submittedFeeActionHarness(path);
    await rememberMempool(h);
    expect(await h.wallet.refresh(h.prepared.id, "2026-07-19T12:04:00.000Z")).toMatchObject({
      status: "reobserve",
      verification: { outcome: "not-found" },
    });
    h.store.close();
    stores.splice(stores.indexOf(h.store), 1);
    const { store } = await openSidekickStore(path);
    stores.push(store);
    let assessment = { status: "unavailable" } as ConnectionAssessment;
    const restarted = h.createWallet({
      store,
      observationRuntimeContext: () => {
        requireObservationAssessment(assessment);
        return h.runtimeSettings.clients();
      },
    });
    nodeOffline(h);
    reportApiExecution(h);
    await restarted.observeSubmitted("2026-07-19T12:05:00.000Z");
    expect(restarted.get(h.prepared.id)).toMatchObject({
      status: "complete",
      verification: { outcome: "complete", executionSource: "api" },
    });
    const observations = store.walletIntents.listObservations(h.prepared.id);
    expect(observations.some((o) => o.outcome === "mempool")).toBe(true);
    expect(JSON.stringify(observations)).not.toContain(h.observed.value.transactionHex);
    const persistedCompletion = observations.at(-1);
    if (!persistedCompletion) throw new Error("Missing persisted completion");
    expect(persistedCompletion.evidence).toMatchObject({ decoded: { executionSource: "api" } });
    expect(
      (persistedCompletion.evidence as { verification: unknown }).verification,
    ).not.toHaveProperty("executionSource");
    const apiCalls = h.api.getTransactionDetails.mock.calls.length;
    await restarted.observeSubmitted("2026-07-19T12:06:00.000Z");
    expect(h.api.getTransactionDetails).toHaveBeenCalledTimes(apiCalls);
    assessment = { status: "blocked" } as ConnectionAssessment;
    await restarted.refresh(h.prepared.id, "2026-07-19T12:07:00.000Z");
    expect(h.api.getTransactionDetails).toHaveBeenCalledTimes(apiCalls);
    expect(restarted.get(h.prepared.id).status).toBe("complete");
    expect(store.walletIntents.latestObservation(h.prepared.id)?.outcome).toBe("unavailable");
    const final = await openSidekickStore(path);
    stores.push(final.store);
    expect(
      h.createWallet({ store: final.store }).get(h.prepared.id).verification?.executionSource,
    ).toBe("api");
  });

  it.each([
    "success",
    "abort_by_response",
    "abort_by_post_condition",
  ])("accepts API-supported %s only after exact mempool verification", async (status) => {
    const h = await submittedFeeActionHarness();
    await rememberMempool(h);
    nodeOffline(h);
    reportApiExecution(h, status);
    const result = await h.wallet.refresh(h.prepared.id, "2026-07-19T12:04:00.000Z");
    expect(result).toMatchObject({
      status: status === "success" ? "complete" : "failed",
      verification: {
        outcome: status === "success" ? "complete" : "abort",
        executionSource: "api",
      },
    });
  });

  it.each([
    "missing",
    "decoded-null",
    "txid",
    "sender",
    "chain",
    "version",
    "sponsored",
    "postcondition-mode",
    "postcondition-count",
    "contract",
    "arguments",
    "canonical",
    "verification-outcome",
    "legacy-api-summary",
  ])("refuses API-only completion with %s stored proof", async (kind) => {
    const h = await submittedFeeActionHarness();
    if (kind !== "missing") {
      await rememberMempool(h);
      const proof = h.store.walletIntents.latestObservation(h.prepared.id);
      if (!proof) throw new Error("Expected proof");
      const evidence = structuredClone(proof.evidence) as {
        verification: { outcome: string };
        decoded: Record<string, unknown> & { payload: Record<string, unknown> };
      };
      if (kind === "txid") evidence.decoded.txid = `0x${"00".repeat(32)}`;
      if (kind === "sender") evidence.decoded.sender = otherAdmin;
      if (kind === "chain") evidence.decoded.chainId = 0x80000000;
      if (kind === "version") evidence.decoded.transactionVersion = 128;
      if (kind === "sponsored") evidence.decoded.sponsored = true;
      if (kind === "postcondition-mode") evidence.decoded.postConditionMode = "allow";
      if (kind === "postcondition-count") evidence.decoded.postConditionCount = 1;
      if (kind === "contract") evidence.decoded.payload.contract = `${otherAdmin}.other`;
      if (kind === "arguments") evidence.decoded.payload.argumentsSha256 = "00".repeat(32);
      if (kind === "verification-outcome") evidence.verification.outcome = "canonical-success";
      const corrupt = {
        ...proof,
        evidence: kind === "decoded-null" ? { ...evidence, decoded: null } : evidence,
        canonical: kind === "canonical" ? true : null,
      };
      // Simulate corrupt legacy storage at the repository seam without admitting raw bytes or
      // weakening the real byte verifier. Ordinary observations continue through the real store.
      const latest = h.store.walletIntents.latestObservation.bind(h.store.walletIntents);
      vi.spyOn(h.store.walletIntents, "latestObservation").mockImplementation((id, options) => {
        if (options?.outcomes?.includes("mempool"))
          return kind === "legacy-api-summary" ? null : corrupt;
        return latest(id, options);
      });
    }
    nodeOffline(h);
    reportApiExecution(h);
    expect(await h.wallet.refresh(h.prepared.id, "2026-07-19T12:04:00.000Z")).toMatchObject({
      verification: { outcome: "unavailable" },
    });
    expect(h.wallet.get(h.prepared.id).status).not.toBe("complete");
  });

  it("does not let later pending or unavailable observations erase a positive canonical conflict", async () => {
    const h = await submittedFeeActionHarness();
    await rememberMempool(h);
    h.setIndexed({ ...h.observed, value: { ...h.observed.value, isCanonical: false } });
    expect(await h.wallet.refresh(h.prepared.id, "2026-07-19T12:04:00.000Z")).toMatchObject({
      verification: { outcome: "noncanonical" },
    });
    await rememberMempool(h, "2026-07-19T12:05:00.000Z");
    nodeOffline(h);
    reportApiExecution(h);
    const restarted = h.createWallet();
    expect(await restarted.refresh(h.prepared.id, "2026-07-19T12:06:00.000Z")).toMatchObject({
      verification: { outcome: "unavailable" },
    });
    await expect(restarted.replace(h.prepared.id, "2026-07-19T12:25:00.000Z")).rejects.toThrow();
    h.node.getInfo.mockResolvedValue({ network_id: 1 });
    h.lookupIndexed.mockResolvedValue(h.observed);
    expect(await restarted.refresh(h.prepared.id, "2026-07-19T12:26:00.000Z")).toMatchObject({
      status: "complete",
      verification: { executionSource: "node" },
    });
  });

  it.each([
    "node-network",
    "assessment",
    "configured-network",
    "manifest",
  ])("keeps %s refusal ahead of API-only wallet completion", async (kind) => {
    const h = await submittedFeeActionHarness();
    await rememberMempool(h);
    reportApiExecution(h);
    h.api.getTransactionDetails.mockClear();
    if (kind === "node-network") h.node.getInfo.mockResolvedValue({ network_id: 0x80000000 });
    const wallet = h.createWallet({
      observationRuntimeContext: () => {
        if (kind === "assessment")
          requireObservationAssessment({ status: "blocked" } as ConnectionAssessment);
        const clients = h.runtimeSettings.clients();
        return kind === "configured-network"
          ? { ...clients, config: { ...clients.config, network: "testnet" } }
          : clients;
      },
    });
    if (kind === "manifest") {
      const record = h.store.walletIntents.get(h.prepared.id);
      if (!record) throw new Error("Missing intent");
      vi.spyOn(h.store.walletIntents, "get").mockReturnValue({
        ...record,
        manifestSha256: "00".repeat(32),
      });
      await expect(wallet.refresh(h.prepared.id, "2026-07-19T12:04:00.000Z")).rejects.toThrow(
        "integrity check",
      );
    } else {
      expect(await wallet.refresh(h.prepared.id, "2026-07-19T12:04:00.000Z")).toMatchObject({
        verification: { outcome: "unavailable" },
      });
    }
    expect(h.api.getTransactionDetails).not.toHaveBeenCalled();
  });

  it.each([
    "success",
    "abort_by_response",
  ])("retains calculation %s evidence without depending on unavailable checkpoint reads", async (status) => {
    const h = await calculateRewardsWalletHarness();
    const details = vi.fn<() => Promise<unknown>>(async () => {
      throw new UpstreamHttpError("not found", 404);
    });
    const node = {
      ...h.node,
      getTenureInfo: vi.fn(async () => {
        throw new UpstreamUnavailableError("offline");
      }),
    };
    const wallet = new WalletIntentService({
      store: h.store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node,
          api: {
            getNodeInfo: async () => ({ network_id: 1 }),
            getTransactionDetails: details,
            getBlock: async () => ({
              canonical: true,
              hash: blockHash,
              height: blockHeight,
              index_block_hash: indexBlockHash,
            }),
          },
        }),
      } as unknown as RuntimeSettingsController,
      readState: deploymentFreshState,
      canRepairSignerRegistration,
      readerFactory: () => ({
        lookupIndexedTransaction: async () => ({ status: "not-found", httpStatus: 404 }),
        lookupUnconfirmedTransaction: async () => ({
          status: "observed",
          httpStatus: 200,
          value: {
            txid: h.txid,
            transactionHex: h.transactionHex,
            nonce: 9n,
            feeUstx: 1000n,
            location: { kind: "mempool" },
          },
        }),
      }),
    });
    await wallet.submit(h.prepared.id, h.txid, "2026-07-19T12:02:00.000Z");
    expect((await wallet.refresh(h.prepared.id, "2026-07-19T12:03:00.000Z")).status).toBe(
      "mempool",
    );
    details.mockResolvedValue({
      tx_id: h.txid,
      tx_status: status,
      tx_result: { repr: status === "success" ? "(ok true)" : "(err u32)" },
      canonical: true,
      block_hash: blockHash,
      block_height: blockHeight,
    });
    node.getInfo.mockRejectedValue(new UpstreamUnavailableError("offline"));
    node.callReadOnly.mockRejectedValue(new UpstreamUnavailableError("checkpoint unavailable"));
    const result = await wallet.refresh(h.prepared.id, "2026-07-19T12:04:00.000Z");
    expect(result).toMatchObject({
      status: status === "success" ? "confirmed" : "failed",
      verification: {
        outcome: status === "success" ? "canonical-success" : "abort",
        executionSource: "api",
      },
    });
    if (status === "success") {
      expect(result.verification?.detail).toContain("sealed cycle and checkpoint");
      const countBefore = details.mock.calls.length;
      const first = h.store.walletIntents.latestObservation(h.prepared.id);
      const hydrate = vi.spyOn(h.store.walletIntents, "get");
      const allManifests = vi.spyOn(h.store.walletIntents, "listAwaitingObservation");
      const startAt = Date.parse("2026-07-19T12:04:00.000Z");
      const at = (seconds: number) => new Date(startAt + seconds * 1000).toISOString();
      for (let seconds = 0; seconds < 3600; seconds += 5)
        await wallet.observeSubmitted(at(seconds));
      expect(details).toHaveBeenCalledTimes(countBefore + 15);
      expect(allManifests).not.toHaveBeenCalled();
      expect(hydrate.mock.calls.length).toBeLessThan(100); // 720 scans, only 15 due reads
      hydrate.mockRestore();
      allManifests.mockRestore();
      expect(h.store.walletIntents.latestObservation(h.prepared.id)?.id).toBe(first?.id);
      expect(wallet.get(h.prepared.id)).toMatchObject({
        status: "confirmed",
        verification: { outcome: "canonical-success", executionSource: "api" },
      });
      // Changed diagnostic/evidence gets the ordinary cadence; manual reads bypass backoff.
      details.mockResolvedValue({
        tx_id: h.txid,
        tx_status: "success",
        canonical: true,
        block_hash: blockHash,
        block_height: blockHeight,
        tx_result: { repr: "(err (tuple (stx-cycle u5) (calculation-height u7999)))" },
      });
      expect(await wallet.refresh(h.prepared.id, at(3601))).toMatchObject({
        status: "confirmed",
        verification: { outcome: "canonical-success", executionSource: "api" },
      });
      expect(h.store.walletIntents.latestObservation(h.prepared.id)?.id).not.toBe(first?.id);
      await wallet.observeSubmitted(at(3630));
      expect(details).toHaveBeenCalledTimes(countBefore + 16);
      await wallet.observeSubmitted(at(3631));
      expect(details).toHaveBeenCalledTimes(countBefore + 17);
      details.mockResolvedValue({
        tx_id: h.txid,
        tx_status: "success",
        canonical: true,
        block_hash: blockHash,
        block_height: blockHeight,
        tx_result: { repr: "(ok (tuple (stx-cycle u5) (calculation-height u7999)))" },
      });
      node.callReadOnly.mockClear();
      expect(await wallet.refresh(h.prepared.id, at(3632))).toMatchObject({
        status: "complete",
        verification: { outcome: "complete", executionSource: "api" },
      });
      expect(node.callReadOnly).not.toHaveBeenCalled();
      await wallet.observeSubmitted(at(4000));
      expect(details).toHaveBeenCalledTimes(countBefore + 18);
    }
  });

  it("observes submitted work after service restart without a browser, and stops querying terminal history", async () => {
    const h = await submittedFeeActionHarness();
    const restarted = h.createWallet();
    await restarted.observeSubmitted();
    expect(restarted.get(h.prepared.id)).toMatchObject({ status: "complete" });
    h.lookupIndexed.mockClear();
    await restarted.observeSubmitted();
    expect(h.lookupIndexed).not.toHaveBeenCalled();
    expect(h.store.walletIntents.listAwaitingObservation()).toEqual([]);
  });

  it("bounds missing-submission observations per hour without retiring the intent, then finds a late confirmation", async () => {
    const h = await submittedFeeActionHarness();
    h.setIndexed({ status: "not-found", httpStatus: 404 });
    const startedAt = Date.parse("2026-07-19T12:03:00.000Z");
    const at = (seconds: number) => new Date(startedAt + seconds * 1000).toISOString();
    for (let seconds = 0; seconds < 3600; seconds += 5) {
      await h.wallet.observeSubmitted(at(seconds));
    }
    // 0, 30, 90, 210, 450 seconds, then every 300 seconds (12/hour at the cap).
    expect(h.lookupIndexed).toHaveBeenCalledTimes(15);
    expect(h.api.getNodeInfo).toHaveBeenCalledTimes(15);
    expect(h.api.getTransactionDetails).toHaveBeenCalledTimes(15);
    expect(h.wallet.get(h.prepared.id)).toMatchObject({
      status: "reobserve",
      verification: { outcome: "not-found" },
    });
    expect(h.store.walletIntents.listAwaitingObservation().map(({ id }) => id)).toEqual([
      h.prepared.id,
    ]);
    h.setIndexed(h.observed);
    await h.wallet.observeSubmitted(at(3749));
    expect(h.lookupIndexed).toHaveBeenCalledTimes(15);
    await h.wallet.observeSubmitted(at(3750));
    expect(h.lookupIndexed).toHaveBeenCalledTimes(16);
    expect(h.wallet.get(h.prepared.id).status).toBe("complete");
    await h.wallet.observeSubmitted(at(4050));
    expect(h.lookupIndexed).toHaveBeenCalledTimes(16);
    expect(h.store.walletIntents.listAwaitingObservation()).toEqual([]);
  });

  // Exercise every five-second tick and concurrent scan; allow CPU contention in the full suite.
  it("paces superseded siblings independently with concurrent scans and preserves late completion", async () => {
    const h = await submittedFeeActionHarness();
    h.setIndexed({ status: "not-found", httpStatus: 404 });
    await h.wallet.refresh(h.prepared.id, "2026-07-19T12:18:00.000Z");
    const replacement = await h.wallet.replace(h.prepared.id, "2026-07-19T12:20:00.000Z");
    const transaction = await makeContractCall({
      contractAddress: requiredSender,
      contractName: "signer-manager",
      functionName: "update-fees",
      functionArgs: [uintCV(250)],
      senderKey,
      network: "mainnet",
      fee: 1000,
      nonce: 10,
      postConditionMode: PostConditionMode.Deny,
    });
    const replacementTxid = `0x${transaction.txid()}`;
    await h.wallet.submit(replacement.id, replacementTxid, "2026-07-19T12:21:00.000Z");
    let oldConfirmed = false;
    h.lookupIndexed.mockImplementation(async (...args: unknown[]) =>
      oldConfirmed && args[0] === h.observed.value.txid
        ? h.observed
        : { status: "not-found", httpStatus: 404 },
    );
    h.lookupPending.mockImplementation(async (...args: unknown[]) =>
      args[0] === replacementTxid
        ? {
            status: "observed",
            httpStatus: 200,
            value: {
              txid: replacementTxid as `0x${string}`,
              transactionHex: transaction.serialize(),
              nonce: 10n,
              feeUstx: 1000n,
              location: { kind: "mempool" },
            },
          }
        : { status: "not-found", httpStatus: 404 },
    );
    const wallet = h.createWallet();
    h.lookupIndexed.mockClear();
    h.lookupPending.mockClear();
    const start = Date.parse("2026-07-19T12:22:00.000Z");
    const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
    for (let seconds = 0; seconds < 3600; seconds += 5)
      await Promise.all([
        wallet.observeSubmitted(at(seconds)),
        wallet.observeSubmitted(at(seconds)),
      ]);
    const reads = (txid: string) =>
      h.lookupIndexed.mock.calls.filter((args) => (args as unknown[])[0] === txid).length;
    expect(reads(h.observed.value.txid)).toBe(15);
    expect(reads(replacementTxid)).toBe(120);
    expect(wallet.get(replacement.id).status).toBe("mempool");
    expect(h.store.walletIntents.listAwaitingObservation()).toHaveLength(2);
    oldConfirmed = true;
    await wallet.observeSubmitted(at(3749));
    expect(reads(h.observed.value.txid)).toBe(15);
    await wallet.observeSubmitted(at(3750));
    expect(reads(h.observed.value.txid)).toBe(16);
    expect(wallet.get(h.prepared.id).status).toBe("complete");
    expect(wallet.get(replacement.id).status).toBe("superseded");
  }, 20_000);

  it("keeps manual wallet refresh immediate during missing-submission backoff", async () => {
    const h = await submittedFeeActionHarness();
    h.setIndexed({ status: "not-found", httpStatus: 404 });
    for (const time of ["12:03:00", "12:03:30", "12:04:30", "12:06:30", "12:10:30"]) {
      await h.wallet.observeSubmitted(`2026-07-19T${time}.000Z`);
    }
    expect(h.lookupIndexed).toHaveBeenCalledTimes(5);
    h.setIndexed(h.observed);
    await h.wallet.observeSubmitted("2026-07-19T12:10:31.000Z");
    expect(h.lookupIndexed).toHaveBeenCalledTimes(5);
    expect(await h.wallet.refresh(h.prepared.id, "2026-07-19T12:10:31.000Z")).toMatchObject({
      status: "complete",
    });
    expect(h.lookupIndexed).toHaveBeenCalledTimes(6);
  });

  it("backs off unavailable wallet sources without recording a missing transaction", async () => {
    const h = await submittedFeeActionHarness();
    h.setIndexed({ status: "not-found", httpStatus: 404 });
    h.api.getTransactionDetails.mockRejectedValue(new UpstreamHttpError("unavailable", 503));
    const startedAt = Date.parse("2026-07-19T12:03:00.000Z");
    for (let seconds = 0; seconds < 120; seconds += 5) {
      await h.wallet.observeSubmitted(new Date(startedAt + seconds * 1000).toISOString());
    }
    expect(h.lookupIndexed).toHaveBeenCalledTimes(3);
    expect(h.wallet.get(h.prepared.id).verification?.outcome).toBe("unavailable");
    expect(h.store.walletIntents.listAwaitingObservation()).toHaveLength(1);
  });

  it("observes a superseded late broadcast even when its replacement is still unsigned", async () => {
    const h = await submittedFeeActionHarness();
    h.setIndexed({ status: "not-found", httpStatus: 404 });
    await h.wallet.refresh(h.prepared.id, "2026-07-19T12:18:00.000Z");
    const replacement = await h.wallet.replace(h.prepared.id, "2026-07-19T12:20:00.000Z");
    expect(replacement.status).toBe("prepared");
    h.setIndexed(h.observed);
    const restarted = h.createWallet();
    await restarted.observeSubmitted();
    expect(restarted.get(h.prepared.id).status).toBe("complete");
    expect(restarted.get(replacement.id).status).toBe("superseded");
    expect(h.store.walletIntents.listAwaitingObservation()).toEqual([]);
  });

  it("coalesces foreground and background observation of the same transaction", async () => {
    const h = await submittedFeeActionHarness();
    const deferred = Promise.withResolvers<IndexedLookup>();
    h.lookupIndexed.mockReturnValue(deferred.promise);
    const background = h.wallet.observeSubmitted();
    const foreground = h.wallet.refresh(h.prepared.id);
    await vi.waitFor(() => expect(h.lookupIndexed).toHaveBeenCalledOnce());
    deferred.resolve(h.observed);
    await Promise.all([background, foreground]);
    expect(h.lookupIndexed).toHaveBeenCalledOnce();
    expect(h.wallet.get(h.prepared.id).status).toBe("complete");
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
    ["different arguments", { wrongArgument: true }],
  ])("rejects exact block bytes with %s authority despite an API summary claiming a match", async (_label, signedAuthority) => {
    let currentFeeBips = 100n;
    await proveRecurringManagerAction({
      request: { action: "update-fees", actorPrincipal: requiredSender, feeBips: "250" },
      transactionIndexUnavailable: true,
      expectedOutcome: "mismatch",
      signedAuthority,
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

  it("completes a fee update even when a later update already changed the current fee", async () => {
    const currentFeeBips = 100n;
    await proveRecurringManagerAction({
      request: {
        action: "update-fees",
        actorPrincipal: requiredSender,
        feeBips: "250",
      },
      expectedOutcome: "complete",
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

  it("maps configured testnet only to the dedicated Testnet chain", async () => {
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
        networkId: 0x80000000,
        profileId: "testnet-reference-manager",
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
      network: "testnet",
      chainId: 0x80000000,
      requiredSender: testnetActor,
      transaction: { params: { network: "testnet" } },
    });
    expect(store.walletIntents.get(intent.id)).toMatchObject({
      network: "testnet",
      chainId: 0x80000000,
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
      value: "Custom manager source — review in signing tool",
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
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });
  });

  describe("staker reward claims", () => {
    const staker = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";

    async function stakerClaimWallet(
      reads: {
        earned: bigint;
        fees: bigint;
        unclaimed: bigint;
        poxAddr?: ClarityValue;
        feeBips?: bigint;
        /** `null` models an unclaimed bucket: the manager never inserted a fee snapshot for it. */
        feeSnapshot?: bigint | null;
      },
      readerFactory?: ConstructorParameters<typeof WalletIntentService>[0]["readerFactory"],
    ) {
      const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
      stores.push(store);
      readOperatorAnchorSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
      return new WalletIntentService({
        readerFactory,
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

    it("keeps a successful first-half settlement complete after the same account accrues again", async () => {
      const reads = { earned: 9_000n, fees: 1_000n, unclaimed: 10_000n };
      let indexed: IndexedLookup = { status: "not-found", httpStatus: 404 };
      const wallet = await stakerClaimWallet(reads, () => ({
        lookupIndexedTransaction: async () => indexed,
        lookupUnconfirmedTransaction: async () => ({ status: "not-found", httpStatus: 404 }),
      }));
      const prepared = await wallet.prepare(request, "2026-07-19T12:01:00.000Z");
      const transaction = await makeContractCall({
        contractAddress: requiredSender,
        contractName: "signer-manager",
        functionName: "claim-staker-rewards",
        functionArgs: prepared.transaction.params.functionArgs.map(hexToCV),
        postConditions: prepared.transaction.params.postConditions,
        postConditionMode: PostConditionMode.Deny,
        senderKey,
        network: "mainnet",
        nonce: 9,
        fee: 1000,
      });
      const txid = `0x${transaction.txid()}` as const;
      await wallet.submit(prepared.id, txid, "2026-07-19T12:02:00.000Z");
      indexed = {
        status: "observed",
        httpStatus: 200,
        value: {
          txid,
          transactionHex: transaction.serialize(),
          nonce: 9n,
          feeUstx: 1000n,
          indexBlockHash,
          blockHeight: BigInt(blockHeight),
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      };
      reads.earned = 0n;
      expect((await wallet.refresh(prepared.id, "2026-07-19T12:03:00.000Z")).status).toBe(
        "complete",
      );
      reads.earned = 20_000n;
      expect(await wallet.refresh(prepared.id, "2026-07-19T12:04:00.000Z")).toMatchObject({
        status: "complete",
        verification: { outcome: "complete", canonical: true },
      });
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
