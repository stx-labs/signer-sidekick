import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bufferCV,
  ClarityVersion,
  contractPrincipalCV,
  cvToHex,
  falseCV,
  getAddressFromPrivateKey,
  hexToCV,
  makeContractCall,
  makeContractDeploy,
  noneCV,
  Pc,
  PostConditionMode,
  principalCV,
  privateKeyToPublic,
  signMessageHashRsv,
  someCV,
  trueCV,
  uintCV,
} from "@stacks/transactions";
import type { BrowserWalletIntentCreateRequest } from "@stx-labs/signer-sidekick-api-contracts";
import type { NetworkCompatibilityProfile } from "@stx-labs/signer-sidekick-protocol/network-compatibility";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamHttpError } from "./chain-clients.js";
import type { ManagerDeploymentManifest } from "./manager-render.js";
import {
  OnboardingWalletIntentService,
  type WalletFreshState,
} from "./onboarding-wallet-intent.js";
import type { RuntimeSettingsController } from "./runtime-settings.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";
import { canonicalJsonSha256 } from "./storage/wallet-intent-repository.js";

const { loadNetworkCompatibilityProfilesMock, readSetupSnapshotMock, runOperatorPreflightMock } =
  vi.hoisted(() => ({
    loadNetworkCompatibilityProfilesMock: vi.fn(),
    readSetupSnapshotMock: vi.fn(),
    runOperatorPreflightMock: vi.fn(),
  }));

vi.mock("./setup-snapshot.js", () => ({ readSetupSnapshot: readSetupSnapshotMock }));
vi.mock("./preflight.js", () => ({ runOperatorPreflight: runOperatorPreflightMock }));
vi.mock("./network-compatibility-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./network-compatibility-store.js")>()),
  loadNetworkCompatibilityProfiles: loadNetworkCompatibilityProfilesMock,
}));

const stores: SidekickStore[] = [];
const directories: string[] = [];
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

function useCompatibilitySource(clarityCode: string): void {
  const hash = createHash("sha256").update(clarityCode).digest("hex");
  const profile: NetworkCompatibilityProfile = {
    ...compatibilityProfile,
    referenceManager: {
      ...compatibilityProfile.referenceManager,
      sourceSha256: hash,
      canonicalSha256: hash,
    },
  };
  runOperatorPreflightMock.mockResolvedValue(matchedPreflight(profile));
  loadNetworkCompatibilityProfilesMock.mockResolvedValue({
    directory: null,
    profiles: [{ profile, origin: "built-in", fileName: null }],
    issues: [],
  });
}

const deploymentArtifactManifest = {
  schemaVersion: 1,
  network: "mainnet",
  adminPrincipal: requiredSender,
  managerPrincipal,
  profile: {
    id: "wallet-intent-test",
    upstreamTag: "test",
    upstreamCommit: "0".repeat(40),
    compatibilityProfileId: compatibilityProfile.id,
    compatibilityProfileRevision: compatibilityProfile.revision,
  },
  contracts: {
    pox5: pox5ContractId,
    sbtcDeployer: requiredSender,
  },
  artifact: {
    sourceFile: "signer-manager.clar",
    sourceSha256,
    canonicalSourceSha256: sourceSha256,
    replacements: { pox5: 1, sbtcDeployer: 1 },
  },
  transaction: {
    type: "smart-contract-deploy",
    contractName: "signer-manager",
    clarityVersion: 6,
    anchorMode: "any",
    postConditionMode: "deny",
    signingAuthority: "external-offline-admin",
  },
  operatorReviewRequired: true,
  warnings: [],
} satisfies ManagerDeploymentManifest;
const indexBlockHash = `0x${"ef".repeat(32)}` as `0x${string}`;
const otherIndexBlockHash = `0x${"cd".repeat(32)}` as `0x${string}`;
const blockHeight = 9_001;

interface SubmittedIntentFixture {
  id: string;
  txid: `0x${string}`;
  transactionHex: string;
  nonce: bigint;
  requiredSender: string;
}

type IndexedLookup =
  | { status: "not-found"; httpStatus: 404 }
  | { status: "unavailable"; httpStatus: number | null; reason: "http-error" }
  | {
      status: "observed";
      httpStatus: 200;
      value: {
        txid: `0x${string}`;
        transactionHex: string;
        nonce: bigint;
        feeUstx: bigint;
        indexBlockHash: `0x${string}`;
        blockHeight: bigint | null;
        isCanonical: boolean;
        resultRepr: string;
      };
    };

type PendingLookup = { status: "not-found"; httpStatus: 404 };

function closeTracked(store: SidekickStore): void {
  const index = stores.indexOf(store);
  if (index !== -1) stores.splice(index, 1);
  store.close();
}

function readerHarness(fixture: SubmittedIntentFixture) {
  const observed: IndexedLookup = {
    status: "observed",
    httpStatus: 200,
    value: {
      txid: fixture.txid,
      transactionHex: fixture.transactionHex,
      nonce: fixture.nonce,
      feeUstx: 1_000n,
      indexBlockHash,
      blockHeight: BigInt(blockHeight),
      isCanonical: true,
      resultRepr: "(ok true)",
    },
  };
  let indexed = observed;
  let pending: PendingLookup = { status: "not-found", httpStatus: 404 };
  return {
    factory: () => ({
      lookupIndexedTransaction: async () => indexed,
      lookupUnconfirmedTransaction: async () => pending,
    }),
    setIndexed(value: IndexedLookup) {
      indexed = value;
    },
    restoreIndexed() {
      indexed = observed;
    },
    setPending(value: PendingLookup) {
      pending = value;
    },
  };
}

function runtimeHarness(
  fixture: SubmittedIntentFixture,
  overrides: {
    summaryTxid?: string;
    status?: "success" | "abort_by_response" | "abort_by_post_condition";
    summaryIndexBlockHash?: string;
    blockIndexBlockHash?: string;
    blockCanonical?: boolean;
  } = {},
) {
  const api = {
    getNodeInfo: vi.fn(async () => ({ network_id: 1 })),
    getTransaction: vi.fn(async () => ({
      tx_id: overrides.summaryTxid ?? fixture.txid,
      status: overrides.status ?? "success",
      block: {
        height: blockHeight,
        index_hash: overrides.summaryIndexBlockHash ?? indexBlockHash,
      },
    })),
    getBlock: vi.fn(async () => ({
      canonical: overrides.blockCanonical ?? true,
      index_block_hash: overrides.blockIndexBlockHash ?? indexBlockHash,
    })),
  };
  return {
    api,
    runtimeSettings: {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node: {
          getInfo: async () => ({ network_id: 1 }),
          getContractSource: async () => {
            throw new UpstreamHttpError("not found", 404);
          },
        },
        api,
      }),
    } as unknown as RuntimeSettingsController,
  };
}

function deploymentSnapshot(matches: boolean) {
  return {
    manager: {
      attachAllowed: matches,
      source: { sha256: matches ? sourceSha256 : "00".repeat(32) },
    },
    registration: null,
  };
}

function deploymentFreshState(clarityCode = source): WalletFreshState {
  const claritySha256 = createHash("sha256").update(clarityCode).digest("hex");
  return {
    managerPrincipal,
    freshInput: { adminPrincipal: requiredSender, authId: "7" },
    managerArtifact: {
      source: clarityCode,
      manifest: {
        ...deploymentArtifactManifest,
        artifact: {
          ...deploymentArtifactManifest.artifact,
          sourceSha256: claritySha256,
          canonicalSourceSha256: claritySha256,
        },
      },
    },
    signerGrant: { verified: null },
  };
}

function registrationSnapshot(signerKeyHex: string, signerKeyGrantValid = true) {
  return {
    chainAnchor: { indexBlockHash },
    preflight: matchedPreflight(),
    manager: {
      managerPrincipal,
      attachAllowed: true,
      source: {
        recognized: true,
        tier: "reference-render",
        profileId: compatibilityProfile.referenceManager.profileId,
        sha256: sourceSha256,
        canonicalSha256: sourceSha256,
      },
    },
    registration: {
      registered: true,
      signerKeyGrantValid,
      signerKeyHex,
    },
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
      },
    },
    manager: {
      managerPrincipal: manager,
      attachAllowed: true,
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

function registrationFreshState(
  signerKeyHex: string,
  signerSignatureHex = "03".repeat(65),
  expectedMessageHashHex = "ab".repeat(32),
): WalletFreshState {
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
): WalletFreshState {
  const signerKeyHex = privateKeyToPublic(signerPrivateKey);
  const signerSignatureHex = signMessageHashRsv({
    messageHash: expectedMessageHashHex,
    privateKey: signerPrivateKey,
  });
  return registrationFreshState(signerKeyHex, signerSignatureHex, expectedMessageHashHex);
}

function registrationRuntimeSettings(
  fixture: SubmittedIntentFixture,
  expectedMessageHashHex: string,
): RuntimeSettingsController {
  const runtime = runtimeHarness(fixture);
  const node = {
    getInfo: vi.fn(async () => ({ network_id: 1 })),
    callReadOnly: vi.fn(async (_principal: string, functionName: string) => {
      if (functionName === "get-signer-grant-message-hash") {
        return bufferCV(Buffer.from(expectedMessageHashHex, "hex"));
      }
      if (functionName === "is-admin") return trueCV();
      throw new Error(`Unexpected read-only call ${functionName}`);
    }),
    getMapEntry: vi.fn(async () => noneCV()),
  };
  return {
    clients: () => ({
      config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
      node,
      api: runtime.api,
    }),
  } as unknown as RuntimeSettingsController;
}

async function createDeploymentIntent(store: SidekickStore): Promise<SubmittedIntentFixture> {
  const transaction = await makeContractDeploy({
    contractName: "signer-manager",
    codeBody: source,
    clarityVersion: ClarityVersion.Clarity6,
    senderKey,
    network: "mainnet",
    fee: 1_000,
    nonce: 7,
    sponsored: false,
    postConditionMode: PostConditionMode.Deny,
    postConditions: [],
  });
  const txid = `0x${transaction.txid()}` as `0x${string}`;
  const transactionHex = Buffer.from(transaction.serializeBytes()).toString("hex");
  const id = randomUUID();
  const factsSha256 = canonicalJsonSha256({
    schemaVersion: 1,
    action: "deploy-manager",
    managerPrincipal,
    profile: deploymentArtifactManifest.profile,
    sourceSha256,
    canonicalSourceSha256: sourceSha256,
    transaction: deploymentArtifactManifest.transaction,
  });
  const manifest = {
    schemaVersion: 1,
    id,
    action: "deploy-manager" as const,
    network: "mainnet" as const,
    chainId: 1,
    requiredSender,
    createdAt: "2026-07-18T18:01:00.000Z",
    expiresAt: "2026-07-18T18:16:00.000Z",
    transaction: {
      method: "stx_deployContract" as const,
      params: {
        name: "signer-manager",
        clarityCode: source,
        clarityVersion: 6 as const,
        network: "mainnet" as const,
        address: requiredSender,
        sponsored: false as const,
        postConditionMode: "deny" as const,
        postConditions: [] as [],
      },
    },
    review: {
      title: "Deploy manager",
      summary: "Deploy exact source",
      expectedPostState: "Exact source is canonical",
    },
    seal: { factsSha256 },
  };
  store.walletIntents.create({
    id,
    action: "deploy-manager",
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
  store.walletIntents.submit({
    id,
    txid,
    submittedAt: "2026-07-18T18:02:00.000Z",
  });
  return { id, txid, transactionHex, nonce: 7n, requiredSender };
}

function createDeploymentReplacement(store: SidekickStore, previousId: string): string {
  const previous = store.walletIntents.get(previousId);
  if (!previous) throw new Error("Previous wallet intent is missing");
  const id = randomUUID();
  const manifest = {
    ...(previous.manifest as Record<string, unknown>),
    id,
    createdAt: "2026-07-18T18:20:00.000Z",
    expiresAt: "2026-07-18T18:35:00.000Z",
  };
  return store.walletIntents.create({
    id,
    action: previous.action,
    scope: previous.scope,
    factsSha256: previous.factsSha256,
    manifest,
    manifestSha256: canonicalJsonSha256(manifest),
    requiredSender: previous.requiredSender,
    network: previous.network,
    chainId: previous.chainId,
    createdAt: "2026-07-18T18:20:00.000Z",
    expiresAt: "2026-07-18T18:35:00.000Z",
  }).intent.id;
}

async function createRegistrationIntent(
  store: SidekickStore,
  signerKeyHex: string,
): Promise<SubmittedIntentFixture> {
  const functionArgs = [
    contractPrincipalCV(requiredSender, "signer-manager"),
    bufferCV(Buffer.from(signerKeyHex, "hex")),
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
  const txid = `0x${transaction.txid()}` as `0x${string}`;
  const transactionHex = Buffer.from(transaction.serializeBytes()).toString("hex");
  const id = randomUUID();
  const functionArgsHex = functionArgs.map(cvToHex);
  const factsSha256 = canonicalJsonSha256({
    action: "register-self",
    signerKeyHex,
    functionArgs: functionArgsHex,
  });
  const manifest = {
    schemaVersion: 1,
    id,
    action: "register-self" as const,
    network: "mainnet" as const,
    chainId: 1,
    requiredSender,
    createdAt: "2026-07-18T18:01:00.000Z",
    expiresAt: "2026-07-18T18:16:00.000Z",
    transaction: {
      method: "stx_callContract" as const,
      params: {
        contract: managerPrincipal,
        functionName: "register-self" as const,
        functionArgs: functionArgsHex,
        network: "mainnet" as const,
        address: requiredSender,
        sponsored: false as const,
        postConditionMode: "deny" as const,
        postConditions: [] as [],
      },
    },
    review: {
      title: "Register manager",
      summary: "Register the sealed signer key",
      expectedPostState: "The exact signer key is registered",
    },
    seal: { factsSha256 },
  };
  store.walletIntents.create({
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
  store.walletIntents.submit({
    id,
    txid,
    submittedAt: "2026-07-18T18:02:00.000Z",
  });
  return { id, txid, transactionHex, nonce: 8n, requiredSender };
}

function reconciler(
  store: SidekickStore,
  runtimeSettings: RuntimeSettingsController,
  reader: ReturnType<typeof readerHarness>,
  readFreshState: () => WalletFreshState = deploymentFreshState,
): OnboardingWalletIntentService {
  return new OnboardingWalletIntentService({
    store,
    runtimeSettings,
    readFreshState,
    readerFactory: reader.factory,
  });
}

async function proveRecurringManagerAction(input: {
  request: Exclude<
    BrowserWalletIntentCreateRequest,
    { action: "deploy-manager" | "register-self" | "claim-rewards" }
  >;
  node: Record<string, unknown>;
  setCanonicalPoststate: () => void;
  restoreAuthoritativeFacts: () => void;
  managerSnapshot?: ReturnType<typeof trustedManagerSnapshot>;
  expectedOutcome?: "complete" | "canonical-success";
  repeatable?: boolean;
}): Promise<void> {
  const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
  stores.push(store);
  readSetupSnapshotMock.mockResolvedValue(input.managerSnapshot ?? trustedManagerSnapshot({}));
  let txid = `0x${"00".repeat(32)}` as `0x${string}`;
  let transactionHex = "";
  const api = {
    getNodeInfo: vi.fn(async () => ({ network_id: 1 })),
    getTransaction: vi.fn(async () => ({
      tx_id: txid,
      status: "success",
      block: { height: blockHeight, index_hash: indexBlockHash },
    })),
    getBlock: vi.fn(async () => ({ canonical: true, index_block_hash: indexBlockHash })),
  };
  const wallet = new OnboardingWalletIntentService({
    store,
    runtimeSettings: {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node: { getInfo: vi.fn(async () => ({ network_id: 1 })), ...input.node },
        api,
      }),
    } as unknown as RuntimeSettingsController,
    readFreshState: deploymentFreshState,
    readWalletState: deploymentFreshState,
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
          resultRepr: "(ok true)",
        },
      }),
      lookupUnconfirmedTransaction: async () => ({ status: "not-found" as const, httpStatus: 404 }),
    }),
  });
  const prepared = await wallet.prepare(input.request, "2026-07-19T12:01:00.000Z");
  if (prepared.transaction.method !== "stx_callContract") {
    throw new Error("Expected manager contract call");
  }
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
  await expect(wallet.refresh(prepared.id, "2026-07-19T12:03:00.000Z")).resolves.toMatchObject({
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

beforeEach(() => {
  runOperatorPreflightMock.mockResolvedValue(matchedPreflight());
  loadNetworkCompatibilityProfilesMock.mockResolvedValue({
    directory: null,
    profiles: [{ profile: compatibilityProfile, origin: "built-in", fileName: null }],
    issues: [],
  });
});

afterEach(async () => {
  readSetupSnapshotMock.mockReset();
  runOperatorPreflightMock.mockReset();
  loadNetworkCompatibilityProfilesMock.mockReset();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("onboarding wallet intent reconciliation", () => {
  it("does not advance a wallet callback until the node returns the exact signed transaction", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const senderKey = "1".padStart(64, "0");
    const requiredSender = getAddressFromPrivateKey(senderKey, "mainnet");
    const source = "(define-public (ping) (ok true))";
    const transaction = await makeContractDeploy({
      contractName: "signer-manager",
      codeBody: source,
      clarityVersion: ClarityVersion.Clarity6,
      senderKey,
      network: "mainnet",
      fee: 1_000,
      nonce: 7,
      sponsored: false,
      postConditionMode: PostConditionMode.Deny,
      postConditions: [],
    });
    const txid = `0x${transaction.txid()}`;
    const transactionHex = Buffer.from(transaction.serializeBytes()).toString("hex");
    const id = randomUUID();
    const factsSha256 = canonicalJsonSha256({ action: "deploy-manager", source });
    const manifest = {
      schemaVersion: 1,
      id,
      action: "deploy-manager" as const,
      network: "mainnet" as const,
      chainId: 1,
      requiredSender,
      createdAt: "2026-07-18T18:01:00.000Z",
      expiresAt: "2026-07-18T18:16:00.000Z",
      transaction: {
        method: "stx_deployContract" as const,
        params: {
          name: "signer-manager",
          clarityCode: source,
          clarityVersion: 6 as const,
          network: "mainnet" as const,
          address: requiredSender,
          sponsored: false as const,
          postConditionMode: "deny" as const,
          postConditions: [] as [],
        },
      },
      review: {
        title: "Deploy manager",
        summary: "Deploy exact source",
        expectedPostState: "Exact source is canonical",
      },
      seal: { factsSha256 },
    };
    store.walletIntents.create({
      id,
      action: "deploy-manager",
      scope: `${requiredSender}.signer-manager`,
      factsSha256,
      manifest,
      manifestSha256: canonicalJsonSha256(manifest),
      requiredSender,
      network: "mainnet",
      chainId: 1,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
    });
    store.walletIntents.submit({
      id,
      txid,
      submittedAt: "2026-07-18T18:02:00.000Z",
    });
    const runtimeSettings = {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node: { getInfo: async () => ({ network_id: 1 }) },
        api: { getNodeInfo: async () => ({ network_id: 1 }) },
      }),
    } as unknown as RuntimeSettingsController;
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings,
      readFreshState: () => {
        throw new Error("Pending reconciliation must not read onboarding poststate");
      },
      readerFactory: () => ({
        lookupIndexedTransaction: async () => ({ status: "not-found", httpStatus: 404 }),
        lookupUnconfirmedTransaction: async () => ({
          status: "observed",
          httpStatus: 200,
          value: {
            txid,
            transactionHex,
            nonce: 7n,
            feeUstx: 1_000n,
            location: { kind: "mempool" as const },
          },
        }),
      }),
    });

    expect(wallet.get(id)).toMatchObject({ status: "submitted", verification: null });
    const observed = await wallet.refresh(id, "2026-07-18T18:03:00.000Z");
    expect(observed).toMatchObject({
      status: "mempool",
      txid,
      verification: { outcome: "mempool", canonical: null },
    });
    const persistedEvidence = JSON.stringify(store.walletIntents.listObservations(id));
    expect(persistedEvidence).not.toContain(transactionHex);
    expect(persistedEvidence).not.toContain("transactionHex");
    await wallet.refresh(id, "2026-07-18T18:04:00.000Z");
    expect(store.walletIntents.listObservations(id)).toHaveLength(1);
  });

  it("supersedes a prepared request when authoritative deployment facts change", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    let fresh = deploymentFreshState();
    const readerFactory = vi.fn();
    const runtimeSettings = {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node: {
          getInfo: async () => ({ network_id: 1 }),
          getContractSource: async () => {
            throw new UpstreamHttpError("not found", 404);
          },
        },
        api: {},
      }),
    } as unknown as RuntimeSettingsController;
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings,
      readFreshState: () => fresh,
      readerFactory,
    });
    const prepared = await wallet.prepare("deploy-manager", "2026-07-18T18:01:00.000Z");

    fresh = deploymentFreshState("(define-public (pong) (ok true))");

    await expect(wallet.refresh(prepared.id, "2026-07-18T18:02:00.000Z")).resolves.toMatchObject({
      id: prepared.id,
      status: "superseded",
      verification: { outcome: "superseded", canonical: null },
    });
    expect(readerFactory).not.toHaveBeenCalled();
  });

  it("fails closed when onboarding changes during asynchronous preparation", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    let fresh = deploymentFreshState();
    let contractReads = 0;
    let releaseSecondRead = () => {};
    let markSecondReadStarted = () => {};
    const secondReadStarted = new Promise<void>((resolve) => {
      markSecondReadStarted = resolve;
    });
    const secondReadGate = new Promise<void>((resolve) => {
      releaseSecondRead = resolve;
    });
    const runtimeSettings = {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node: {
          getInfo: async () => ({ network_id: 1 }),
          getContractSource: async () => {
            contractReads += 1;
            if (contractReads === 2) {
              markSecondReadStarted();
              await secondReadGate;
            }
            throw new UpstreamHttpError("not found", 404);
          },
        },
        api: {},
      }),
    } as unknown as RuntimeSettingsController;
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings,
      readFreshState: () => fresh,
    });

    const preparation = wallet.prepare("deploy-manager", "2026-07-18T18:01:00.000Z");
    await secondReadStarted;
    fresh = deploymentFreshState("(define-public (pong) (ok true))");
    releaseSecondRead();

    await expect(preparation).rejects.toMatchObject({ code: "wallet_intent_conflict" });
    expect(
      store.walletIntents.findActiveScope({
        action: "deploy-manager",
        scope: managerPrincipal,
        now: "2026-07-18T18:01:00.000Z",
      }),
    ).toBeNull();
  });

  it("does not prepare a deployment after the manager exists", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const runtimeSettings = {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node: {
          getInfo: async () => ({ network_id: 1 }),
          getContractSource: async () => ({ source, publish_height: 9_000 }),
        },
        api: {},
      }),
    } as unknown as RuntimeSettingsController;
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings,
      readFreshState: deploymentFreshState,
    });

    await expect(
      wallet.prepare("deploy-manager", "2026-07-18T18:01:00.000Z"),
    ).rejects.toMatchObject({ code: "wallet_intent_invalid" });
  });

  it("rejects ordinary testnet when preparing a PoX-5 Testnet deployment", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const getContractSource = vi.fn();
    const runtimeSettings = {
      clients: () => ({
        config: { network: "testnet", nodeRpcUrl: "http://node:20443" },
        node: {
          getInfo: async () => ({ network_id: 0x80000000 }),
          getContractSource,
        },
        api: {},
      }),
    } as unknown as RuntimeSettingsController;
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings,
      readFreshState: deploymentFreshState,
    });

    await expect(
      wallet.prepare("deploy-manager", "2026-07-18T18:01:00.000Z"),
    ).rejects.toMatchObject({ code: "wallet_execution_unavailable" });
    expect(getContractSource).not.toHaveBeenCalled();
  });

  it("rejects saved manager source bytes that do not match the reviewed hashes", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const getContractSource = vi.fn();
    const state = deploymentFreshState();
    if (!state.managerArtifact) throw new Error("Expected deployment artifact");
    state.managerArtifact.source = "(define-public (tampered) (ok true))";
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: { getContractSource },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readFreshState: () => state,
    });

    await expect(wallet.prepare({ action: "deploy-manager" })).rejects.toMatchObject({
      code: "wallet_intent_conflict",
    });
    expect(getContractSource).not.toHaveBeenCalled();
  });

  it("rejects setup registration when its saved compatibility profile is stale", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const staleProfile: NetworkCompatibilityProfile = {
      ...compatibilityProfile,
      revision: compatibilityProfile.revision + 1,
    };
    loadNetworkCompatibilityProfilesMock.mockResolvedValue({
      directory: null,
      profiles: [{ profile: staleProfile, origin: "built-in", fileName: null }],
      issues: [],
    });
    readSetupSnapshotMock.mockResolvedValue({
      ...registrationSnapshot(`02${"11".repeat(32)}`, false),
      preflight: matchedPreflight(staleProfile),
    });
    const state = registrationFreshState(`02${"11".repeat(32)}`);
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: {},
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readFreshState: () => state,
    });

    await expect(wallet.prepare({ action: "register-self" })).rejects.toMatchObject({
      code: "wallet_intent_conflict",
    });
  });

  it("rejects a consumed signer grant in the Fresh Setup request form", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const signerPrivateKey = `${"33".repeat(32)}01`;
    const expectedMessageHashHex = "bc".repeat(32);
    const state = validRegistrationFreshState(signerPrivateKey, expectedMessageHashHex);
    const signerKeyHex = state.signerGrant.verified?.signerKeyHex;
    if (!signerKeyHex) throw new Error("Signer fixture is incomplete");
    readSetupSnapshotMock.mockResolvedValue(registrationSnapshot(signerKeyHex, false));
    const wallet = new OnboardingWalletIntentService({
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
            getMapEntry: vi.fn(async () => someCV(trueCV())),
          },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readFreshState: () => state,
    });

    await expect(wallet.prepare({ action: "register-self" })).rejects.toThrow("already been used");
  });

  it("does not prepare register-self when the exact signer key and grant are already active", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const signerKeyHex = `02${"11".repeat(32)}`;
    readSetupSnapshotMock.mockResolvedValue(registrationSnapshot(signerKeyHex));
    const runtimeSettings = {
      clients: () => ({
        config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
        node: {},
        api: {},
      }),
    } as unknown as RuntimeSettingsController;
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings,
      readFreshState: () => registrationFreshState(signerKeyHex),
    });

    await expect(wallet.prepare("register-self", "2026-07-18T18:01:00.000Z")).rejects.toMatchObject(
      { code: "wallet_intent_invalid" },
    );
  });

  it("prepares a new registration after a completed signer key rotation is reverified", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const priorSignerKey = `02${"11".repeat(32)}`;
    const nextSignerPrivateKey = `${"22".repeat(32)}01`;
    const expectedMessageHashHex = "ab".repeat(32);
    const fresh = validRegistrationFreshState(nextSignerPrivateKey, expectedMessageHashHex);
    const nextSignerKey = fresh.signerGrant.verified?.signerKeyHex;
    if (!nextSignerKey) throw new Error("Valid registration fixture is missing its signer key");
    const fixture = await createRegistrationIntent(store, priorSignerKey);
    const reader = readerHarness(fixture);
    const runtimeSettings = registrationRuntimeSettings(fixture, expectedMessageHashHex);
    const wallet = reconciler(store, runtimeSettings, reader, () => fresh);
    readSetupSnapshotMock.mockResolvedValue(registrationSnapshot(priorSignerKey));

    await expect(wallet.refresh(fixture.id, "2026-07-18T18:03:00.000Z")).resolves.toMatchObject({
      id: fixture.id,
      status: "complete",
      verification: { outcome: "complete" },
    });

    reader.setIndexed({ status: "unavailable", httpStatus: 503, reason: "http-error" });
    await expect(
      wallet.prepare("register-self", "2026-07-18T18:04:00.000Z"),
    ).resolves.toMatchObject({
      id: fixture.id,
      status: "complete",
    });
    expect(store.walletIntents.latestObservation(fixture.id)?.outcome).toBe("unavailable");

    reader.restoreIndexed();
    const replacement = await wallet.prepare("register-self", "2026-07-18T18:05:00.000Z");
    expect(replacement).toMatchObject({
      action: "register-self",
      status: "prepared",
      requiredSender,
      txid: null,
    });
    expect(replacement.id).not.toBe(fixture.id);
    expect(replacement.review.expectedPostState).toContain(nextSignerKey);
    expect(store.walletIntents.get(fixture.id)?.state).toBe("superseded");
    expect(store.walletIntents.latestObservation(fixture.id)?.outcome).toBe("superseded");

    await expect(
      wallet.prepare("register-self", "2026-07-18T18:06:00.000Z"),
    ).resolves.toMatchObject({
      id: replacement.id,
      status: "prepared",
    });

    reader.setIndexed({ status: "unavailable", httpStatus: 503, reason: "http-error" });
    await expect(wallet.refresh(replacement.id, "2026-07-18T18:07:00.000Z")).resolves.toMatchObject(
      {
        id: replacement.id,
        status: "superseded",
        verification: { outcome: "superseded" },
      },
    );
    expect(store.walletIntents.latestObservation(fixture.id)?.outcome).toBe("unavailable");
  });

  it("re-registers a completed signer after its grant becomes invalid", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const signerPrivateKey = `${"33".repeat(32)}01`;
    const expectedMessageHashHex = "bc".repeat(32);
    const fresh = validRegistrationFreshState(signerPrivateKey, expectedMessageHashHex);
    const signerKey = fresh.signerGrant.verified?.signerKeyHex;
    if (!signerKey) throw new Error("Valid registration fixture is missing its signer key");
    const fixture = await createRegistrationIntent(store, signerKey);
    const reader = readerHarness(fixture);
    const wallet = reconciler(
      store,
      registrationRuntimeSettings(fixture, expectedMessageHashHex),
      reader,
      () => fresh,
    );
    readSetupSnapshotMock.mockResolvedValue(registrationSnapshot(signerKey));

    await expect(wallet.refresh(fixture.id, "2026-07-18T18:03:00.000Z")).resolves.toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });

    readSetupSnapshotMock.mockResolvedValue(registrationSnapshot(signerKey, false));
    await expect(wallet.refresh(fixture.id, "2026-07-18T18:04:00.000Z")).resolves.toMatchObject({
      status: "reobserve",
      verification: { outcome: "canonical-success", canonical: true },
    });

    const replacement = await wallet.prepare("register-self", "2026-07-18T18:05:00.000Z");
    expect(replacement).toMatchObject({
      action: "register-self",
      status: "prepared",
      txid: null,
    });
    expect(replacement.id).not.toBe(fixture.id);
    expect(store.walletIntents.get(fixture.id)?.state).toBe("superseded");
  });

  it("does not prepare changed facts while a same-scope transaction is unresolved", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const fixture = await createDeploymentIntent(store);
    const reader = readerHarness(fixture);
    reader.setIndexed({ status: "unavailable", httpStatus: 503, reason: "http-error" });
    const runtime = runtimeHarness(fixture);
    const changedSource = "(define-public (pong) (ok true))";
    useCompatibilitySource(changedSource);
    const wallet = reconciler(store, runtime.runtimeSettings, reader, () =>
      deploymentFreshState(changedSource),
    );

    await expect(
      wallet.prepare("deploy-manager", "2026-07-18T18:03:00.000Z"),
    ).resolves.toMatchObject({
      id: fixture.id,
      status: "submitted",
      txid: fixture.txid,
      verification: { outcome: "unavailable" },
    });
    expect(
      store.walletIntents.listSubmittedScope({
        action: "deploy-manager",
        scope: managerPrincipal,
      }),
    ).toHaveLength(1);
  });

  it("holds changed-facts replacement until a superseded txid clears propagation grace", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const fixture = await createDeploymentIntent(store);
    store.walletIntents.transition({
      id: fixture.id,
      fromStates: ["submitted"],
      toState: "reobserve",
      updatedAt: "2026-07-18T18:02:30.000Z",
    });
    store.walletIntents.transition({
      id: fixture.id,
      fromStates: ["reobserve"],
      toState: "superseded",
      updatedAt: "2026-07-18T18:02:45.000Z",
    });
    const reader = readerHarness(fixture);
    reader.setIndexed({ status: "not-found", httpStatus: 404 });
    const runtime = runtimeHarness(fixture);
    const changedSource = "(define-public (pong) (ok true))";
    useCompatibilitySource(changedSource);
    const wallet = reconciler(store, runtime.runtimeSettings, reader, () =>
      deploymentFreshState(changedSource),
    );

    await expect(
      wallet.prepare("deploy-manager", "2026-07-18T18:03:00.000Z"),
    ).resolves.toMatchObject({
      id: fixture.id,
      status: "superseded",
      txid: fixture.txid,
      verification: { outcome: "not-found" },
    });

    await expect(
      wallet.prepare("deploy-manager", "2026-07-18T18:18:00.000Z"),
    ).resolves.toMatchObject({
      id: expect.not.stringMatching(fixture.id),
      status: "prepared",
      txid: null,
    });
  });

  it("completes the exact canonical deployment after a process restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-wallet-restart-"));
    directories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const initial = await openSidekickStore(path, "2026-07-18T18:00:00.000Z");
    stores.push(initial.store);
    const fixture = await createDeploymentIntent(initial.store);
    closeTracked(initial.store);

    const reopened = await openSidekickStore(path, "2026-07-18T18:02:30.000Z");
    stores.push(reopened.store);
    const reader = readerHarness(fixture);
    const runtime = runtimeHarness(fixture);
    readSetupSnapshotMock.mockResolvedValue(deploymentSnapshot(true));
    const wallet = reconciler(reopened.store, runtime.runtimeSettings, reader);

    await expect(wallet.refresh(fixture.id, "2026-07-18T18:03:00.000Z")).resolves.toMatchObject({
      status: "complete",
      txid: fixture.txid,
      verification: {
        outcome: "complete",
        canonical: true,
        blockHeight,
        indexBlockHash,
      },
    });
    expect(runtime.api.getTransaction).toHaveBeenCalledWith(fixture.txid);
    expect(readSetupSnapshotMock).toHaveBeenCalledOnce();
  });

  it("holds canonical success at confirmed until the exact deployment poststate is visible", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const fixture = await createDeploymentIntent(store);
    const reader = readerHarness(fixture);
    const runtime = runtimeHarness(fixture);
    const wallet = reconciler(store, runtime.runtimeSettings, reader);
    readSetupSnapshotMock.mockResolvedValueOnce(deploymentSnapshot(false));

    await expect(wallet.refresh(fixture.id, "2026-07-18T18:03:00.000Z")).resolves.toMatchObject({
      status: "confirmed",
      verification: { outcome: "canonical-success", canonical: true },
    });

    readSetupSnapshotMock.mockResolvedValueOnce(deploymentSnapshot(true));
    await expect(wallet.refresh(fixture.id, "2026-07-18T18:04:00.000Z")).resolves.toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });
  });

  it.each([
    ["transaction id", { summaryTxid: `0x${"ab".repeat(32)}` }],
    ["block identity", { summaryIndexBlockHash: otherIndexBlockHash }],
  ] as const)("rejects API %s disagreement", async (_kind, overrides) => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const fixture = await createDeploymentIntent(store);
    const reader = readerHarness(fixture);
    const runtime = runtimeHarness(fixture, overrides);
    const wallet = reconciler(store, runtime.runtimeSettings, reader);

    await expect(wallet.refresh(fixture.id, "2026-07-18T18:03:00.000Z")).resolves.toMatchObject({
      status: "reobserve",
      verification: { outcome: "noncanonical", canonical: false },
    });
    expect(readSetupSnapshotMock).not.toHaveBeenCalled();
  });

  it("records a canonical abort as failed without consulting poststate", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const fixture = await createDeploymentIntent(store);
    const reader = readerHarness(fixture);
    const runtime = runtimeHarness(fixture, { status: "abort_by_response" });
    const wallet = reconciler(store, runtime.runtimeSettings, reader);

    await expect(wallet.refresh(fixture.id, "2026-07-18T18:03:00.000Z")).resolves.toMatchObject({
      status: "failed",
      verification: {
        outcome: "abort",
        canonical: true,
        detail:
          "Transaction failed on-chain: abort by response. Prepare a new transaction if the action is still needed",
      },
    });
    expect(readSetupSnapshotMock).not.toHaveBeenCalled();
  });

  it("retires a failed attempt and blocks its unsigned replacement if a reorg makes it succeed", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const fixture = await createDeploymentIntent(store);
    const reader = readerHarness(fixture);
    const abortRuntime = runtimeHarness(fixture, { status: "abort_by_response" });
    const wallet = reconciler(store, abortRuntime.runtimeSettings, reader);

    await expect(wallet.refresh(fixture.id, "2026-07-18T18:03:00.000Z")).resolves.toMatchObject({
      status: "failed",
      verification: { outcome: "abort", canonical: true },
    });

    const replacement = await wallet.prepare("deploy-manager", "2026-07-18T18:04:00.000Z");
    expect(replacement).toMatchObject({ status: "prepared", txid: null });
    expect(replacement.id).not.toBe(fixture.id);
    expect(store.walletIntents.get(fixture.id)).toMatchObject({ state: "superseded" });

    const reorgWallet = reconciler(store, runtimeHarness(fixture).runtimeSettings, reader);
    readSetupSnapshotMock.mockResolvedValueOnce(deploymentSnapshot(true));
    await expect(
      reorgWallet.refresh(replacement.id, "2026-07-18T18:05:00.000Z"),
    ).resolves.toMatchObject({
      id: replacement.id,
      status: "superseded",
      verification: { outcome: "superseded" },
    });
    expect(reorgWallet.get(fixture.id)).toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });
  });

  it("records nullable-height noncanonical inclusion without breaking reconciliation", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const fixture = await createDeploymentIntent(store);
    const reader = readerHarness(fixture);
    reader.setIndexed({
      status: "observed",
      httpStatus: 200,
      value: {
        txid: fixture.txid,
        transactionHex: fixture.transactionHex,
        nonce: fixture.nonce,
        feeUstx: 1_000n,
        indexBlockHash,
        blockHeight: null,
        isCanonical: false,
        resultRepr: "(ok true)",
      },
    });
    const runtime = runtimeHarness(fixture);
    const wallet = reconciler(store, runtime.runtimeSettings, reader);

    await expect(wallet.refresh(fixture.id, "2026-07-18T18:03:00.000Z")).resolves.toMatchObject({
      status: "reobserve",
      verification: {
        outcome: "noncanonical",
        canonical: false,
        blockHeight: null,
        indexBlockHash: null,
      },
    });
    expect(runtime.api.getTransaction).not.toHaveBeenCalled();
  });

  it("demotes completed work to reobserve when the transaction disappears", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const fixture = await createDeploymentIntent(store);
    const reader = readerHarness(fixture);
    const runtime = runtimeHarness(fixture);
    const wallet = reconciler(store, runtime.runtimeSettings, reader);
    readSetupSnapshotMock.mockResolvedValue(deploymentSnapshot(true));
    await expect(wallet.refresh(fixture.id, "2026-07-18T18:03:00.000Z")).resolves.toMatchObject({
      status: "complete",
    });

    reader.setIndexed({ status: "not-found", httpStatus: 404 });
    reader.setPending({ status: "not-found", httpStatus: 404 });
    await expect(wallet.refresh(fixture.id, "2026-07-18T18:04:00.000Z")).resolves.toMatchObject({
      status: "reobserve",
      verification: { outcome: "not-found", canonical: null },
    });
  });

  it("reconciles a superseded transaction that reappears before its replacement is signed", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const fixture = await createDeploymentIntent(store);
    const reader = readerHarness(fixture);
    const runtime = runtimeHarness(fixture);
    const wallet = reconciler(store, runtime.runtimeSettings, reader);

    reader.setIndexed({ status: "not-found", httpStatus: 404 });
    await expect(wallet.refresh(fixture.id, "2026-07-18T18:18:00.000Z")).resolves.toMatchObject({
      status: "reobserve",
      verification: { outcome: "not-found" },
    });
    store.walletIntents.transition({
      id: fixture.id,
      fromStates: ["reobserve"],
      toState: "superseded",
      updatedAt: "2026-07-18T18:20:00.000Z",
    });
    const replacementId = createDeploymentReplacement(store, fixture.id);

    reader.restoreIndexed();
    readSetupSnapshotMock.mockResolvedValue(deploymentSnapshot(true));
    await expect(wallet.refresh(replacementId, "2026-07-18T18:21:00.000Z")).resolves.toMatchObject({
      id: replacementId,
      status: "superseded",
      verification: { outcome: "superseded" },
    });
    expect(store.walletIntents.get(fixture.id)).toMatchObject({ state: "superseded" });
    expect(wallet.get(fixture.id)).toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });

    reader.setIndexed({ status: "unavailable", httpStatus: 503, reason: "http-error" });
    await expect(wallet.refresh(fixture.id, "2026-07-18T18:21:30.000Z")).resolves.toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });
    expect(store.walletIntents.listObservations(fixture.id).at(-1)).toMatchObject({
      outcome: "unavailable",
    });

    reader.setIndexed({ status: "not-found", httpStatus: 404 });
    await expect(wallet.refresh(fixture.id, "2026-07-18T18:22:00.000Z")).resolves.toMatchObject({
      status: "superseded",
      verification: { outcome: "not-found", canonical: null },
    });
    reader.setIndexed({ status: "unavailable", httpStatus: 503, reason: "http-error" });
    await expect(wallet.refresh(fixture.id, "2026-07-18T18:23:00.000Z")).resolves.toMatchObject({
      status: "superseded",
      verification: { outcome: "unavailable", canonical: null },
    });
    expect(store.walletIntents.get(fixture.id)).toMatchObject({ state: "superseded" });
  });

  it.each([
    ["canonical abort", "abort"],
    ["transaction mismatch", "mismatch"],
    ["noncanonical inclusion", "noncanonical"],
  ] as const)("keeps a replacement signable after a superseded %s", async (_label, outcome) => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const fixture = await createDeploymentIntent(store);
    store.walletIntents.transition({
      id: fixture.id,
      fromStates: ["submitted"],
      toState: "reobserve",
      updatedAt: "2026-07-18T18:18:00.000Z",
    });
    store.walletIntents.transition({
      id: fixture.id,
      fromStates: ["reobserve"],
      toState: "superseded",
      updatedAt: "2026-07-18T18:20:00.000Z",
    });
    const replacementId = createDeploymentReplacement(store, fixture.id);
    const reader = readerHarness(fixture);
    if (outcome !== "abort") {
      reader.setIndexed({
        status: "observed",
        httpStatus: 200,
        value: {
          txid: fixture.txid,
          transactionHex: outcome === "mismatch" ? "00" : fixture.transactionHex,
          nonce: fixture.nonce,
          feeUstx: 1_000n,
          indexBlockHash,
          blockHeight: BigInt(blockHeight),
          isCanonical: outcome !== "noncanonical",
          resultRepr: "(ok true)",
        },
      });
    }
    const runtime = runtimeHarness(fixture, {
      status: outcome === "abort" ? "abort_by_response" : "success",
    });
    const wallet = reconciler(store, runtime.runtimeSettings, reader);

    await expect(wallet.refresh(replacementId, "2026-07-18T18:21:00.000Z")).resolves.toMatchObject({
      id: replacementId,
      status: "prepared",
      verification: null,
    });
    expect(wallet.get(fixture.id)).toMatchObject({
      status: "superseded",
      verification: { outcome },
    });
    expect(store.walletIntents.get(fixture.id)).toMatchObject({ state: "superseded" });
  });

  it("binds registration completion to the signer key sealed in the transaction", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-18T18:00:00.000Z");
    stores.push(store);
    const sealedSignerKey = `02${"11".repeat(32)}`;
    const laterSignerKey = `03${"22".repeat(32)}`;
    const fixture = await createRegistrationIntent(store, sealedSignerKey);
    const reader = readerHarness(fixture);
    const runtime = runtimeHarness(fixture);
    const wallet = reconciler(
      store,
      runtime.runtimeSettings,
      reader,
      () => ({ signerGrant: { verified: { signerKeyHex: laterSignerKey } } }) as never,
    );
    readSetupSnapshotMock.mockResolvedValueOnce(registrationSnapshot(sealedSignerKey));

    await expect(wallet.refresh(fixture.id, "2026-07-18T18:03:00.000Z")).resolves.toMatchObject({
      status: "complete",
      verification: { outcome: "complete" },
    });

    readSetupSnapshotMock.mockResolvedValueOnce(registrationSnapshot(laterSignerKey));
    await expect(wallet.refresh(fixture.id, "2026-07-18T18:04:00.000Z")).resolves.toMatchObject({
      status: "reobserve",
      verification: { outcome: "canonical-success" },
    });
  });
});

describe("manager wallet action preparation", () => {
  it("seals an actor-authorized fee update in a V2 manifest", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    readSetupSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
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
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings,
      readFreshState: deploymentFreshState,
      readWalletState: deploymentFreshState,
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

  it("allows a fixed external action without source or compatibility-profile trust", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const snapshot = trustedManagerSnapshot({});
    readSetupSnapshotMock.mockResolvedValue({
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
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings,
      readFreshState: deploymentFreshState,
      readWalletState: deploymentFreshState,
    });

    const intent = await wallet.prepare({
      action: "update-fees",
      actorPrincipal: requiredSender,
      feeBips: "250",
    });

    expect(intent).toMatchObject({ status: "prepared", action: "update-fees" });
    expect(intent.review.fields).toContainEqual({
      label: "Source assurance",
      value: "Unverified or custom manager — review in signing tool",
    });
  });

  it("still rejects an external action when the manager is technically incompatible", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const snapshot = trustedManagerSnapshot({});
    readSetupSnapshotMock.mockResolvedValue({
      ...snapshot,
      manager: { ...snapshot.manager, attachAllowed: false },
    });
    const callReadOnly = vi.fn();
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: { callReadOnly },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readFreshState: deploymentFreshState,
      readWalletState: deploymentFreshState,
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

  it("requires a current admin actor and prohibits self-removal", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    readSetupSnapshotMock.mockResolvedValue(trustedManagerSnapshot({}));
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
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings,
      readFreshState: deploymentFreshState,
      readWalletState: deploymentFreshState,
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
    const state: WalletFreshState = {
      managerPrincipal: testnetManager,
      freshInput: null,
      managerArtifact: null,
      signerGrant: { verified: null },
    };
    readSetupSnapshotMock.mockResolvedValue(
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
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings,
      readFreshState: () => state,
      readWalletState: () => state,
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
    const state: WalletFreshState = {
      managerPrincipal: privateManager,
      freshInput: null,
      managerArtifact: null,
      signerGrant: { verified: null },
    };
    const snapshot = trustedManagerSnapshot({ manager: privateManager, networkId: chainId });
    const custom = network === "devnet";
    readSetupSnapshotMock.mockResolvedValue({
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
    const wallet = new OnboardingWalletIntentService({
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
      readFreshState: () => state,
      readWalletState: () => state,
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
    const wallet = new OnboardingWalletIntentService({
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
      readFreshState: deploymentFreshState,
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

  it.each([
    "api-network",
    "node-chain-id",
  ] as const)("rejects external actions when the %s binding fails", async (failure) => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const snapshot = trustedManagerSnapshot({});
    readSetupSnapshotMock.mockResolvedValue({
      ...snapshot,
      preflight: {
        ...snapshot.preflight,
        node: { networkId: failure === "node-chain-id" ? 2 : 1 },
        checks: snapshot.preflight.checks.map((check) =>
          failure === "api-network" && check.id === "api-network"
            ? { ...check, status: "fail" }
            : check,
        ),
      },
    });
    const callReadOnly = vi.fn();
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: { callReadOnly },
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readFreshState: deploymentFreshState,
      readWalletState: deploymentFreshState,
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

  it("rejects a persisted generic signer grant after PoX-5 consumed it", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-19T12:00:00.000Z");
    stores.push(store);
    const signerPrivateKey = `${"44".repeat(32)}01`;
    const expectedMessageHashHex = "de".repeat(32);
    const state = validRegistrationFreshState(signerPrivateKey, expectedMessageHashHex);
    const signerKeyHex = state.signerGrant.verified?.signerKeyHex;
    if (!signerKeyHex) throw new Error("Signer fixture is incomplete");
    readSetupSnapshotMock.mockResolvedValue(trustedManagerSnapshot({ signerKeyHex }));
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
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings,
      readFreshState: () => state,
      readWalletState: () => state,
    });

    await expect(
      wallet.prepare({ action: "register-self", actorPrincipal: requiredSender }),
    ).rejects.toThrow("already been used");
  });
});
