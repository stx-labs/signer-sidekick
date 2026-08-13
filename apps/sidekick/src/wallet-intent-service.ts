import { createHash, randomUUID } from "node:crypto";
import {
  boolCV,
  bufferCV,
  ClarityType,
  cvToHex,
  hexToCV,
  noneCV,
  Pc,
  postConditionToHex,
  principalCV,
  someCV,
  tupleCV,
  uintCV,
  validateStacksAddress,
} from "@stacks/transactions";
import {
  type BrowserWalletIntent,
  type BrowserWalletIntentAction,
  type BrowserWalletIntentNetwork,
  type BrowserWalletIntentStatus,
  type BrowserWalletTransaction,
  browserWalletIntentSchema,
  browserWalletTransactionSchema,
  type RecurringBrowserWalletIntentCreateRequest,
  type RecurringWalletIntentAction,
  recurringBrowserWalletIntentCreateRequestSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import {
  decodeBoolean,
  decodeEarnedStakerRewards,
  decodeOptionalUInt,
  decodePoxAddressPreference,
  decodeResponseOk,
  decodeUInt,
  encodeOptionalUIntHex,
  encodePrincipalHex,
  encodeUIntHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import { validatePrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import { UpstreamHttpError } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import { managerActionCapability } from "./manager-capabilities.js";
import type { ManagerVerificationContext } from "./manager-verification.js";
import {
  type OperatorAnchorSnapshot,
  readOperatorAnchorSnapshot,
} from "./operator-anchor-snapshot.js";
import type { RuntimeSettingsController } from "./runtime-settings.js";
import { type VerifiedSignerGrant, verifySignerGrantOutput } from "./signer-grant.js";
import type { SidekickStore } from "./storage/store.js";
import {
  canonicalJsonSha256,
  type StoredWalletIntent,
  WalletIntentRepositoryError,
} from "./storage/wallet-intent-repository.js";
import {
  type IndexedTransactionObservation,
  LiveTransactionReader,
  type UnconfirmedTransactionObservation,
} from "./transaction-engine/live-transaction-reader.js";
import {
  type ManagerClaimWalletAuthoritativeObservation,
  ManagerClaimWalletIntentError,
  managerClaimWalletJobStatus,
  prepareManagerClaimWalletIntent,
  readBoundManagerClaimWalletIntent,
} from "./transaction-engine/manager-claim-wallet-intent.js";
import {
  managerCapabilityForWalletAction,
  walletIntentTransactionMatchesAction,
  walletOperationContract,
} from "./wallet-operation-contracts.js";
import {
  createWalletTransactionNetworkBinding,
  defaultPrivateChainId,
  mainnetChainId,
  mainnetWalletNetwork,
  pox5TestnetChainId,
  pox5TestnetWalletNetwork,
  type VerifiedWalletTransaction,
  verifyWalletTransactionHex,
  WalletTransactionMismatchError,
  type WalletTransactionNetworkBinding,
} from "./wallet-transaction-verification.js";

const intentLifetimeMs = 15 * 60 * 1_000;
const replacementGraceMs = 15 * 60 * 1_000;
const activeIntentStates = new Set([
  "prepared",
  "submitted",
  "mempool",
  "confirmed",
  "complete",
  "reobserve",
]);
const historicalScopeBlockers = new Set([
  "submitted",
  "mempool",
  "canonical-success",
  "complete",
  "unavailable",
]);

const storedManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    action: z.enum(["deploy-manager", "register-self"]),
    network: z.literal("mainnet"),
    chainId: z.literal(mainnetChainId),
    requiredSender: z.string().min(1),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    transaction: browserWalletTransactionSchema,
    review: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        expectedPostState: z.string().min(1),
      })
      .strict(),
    seal: z.object({ factsSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.action === "deploy-manager" && value.transaction.method !== "stx_deployContract") ||
      (value.action === "register-self" && value.transaction.method !== "stx_callContract")
    ) {
      context.addIssue({
        code: "custom",
        path: ["transaction", "method"],
        message: "Wallet intent action and transaction method do not match",
      });
    }
  });

const walletIntentRequestSchema = recurringBrowserWalletIntentCreateRequestSchema;

function walletNetworkChecksPass(snapshot: OperatorAnchorSnapshot, chainId: number): boolean {
  const nodeNetwork = snapshot.preflight.checks.find((check) => check.id === "node-network");
  const nodeSync = snapshot.preflight.checks.find((check) => check.id === "node-sync");
  return (
    snapshot.preflight.node.networkId === chainId &&
    nodeNetwork?.status === "pass" &&
    (!nodeSync || nodeSync.status === "pass")
  );
}

type WalletRuntimeClients = ReturnType<RuntimeSettingsController["clients"]>;

const storedManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.uuid(),
    action: z.enum([
      "register-self",
      "add-admin",
      "remove-admin",
      "update-fees",
      "withdraw-fees",
      "sweep-fee-refunds",
      "claim-rewards",
      "claim-staker-rewards",
    ]),
    request: walletIntentRequestSchema,
    network: z.enum(["mainnet", "pox5-testnet", "devnet", "regtest"]),
    chainId: z.number().int().nonnegative().max(0xffff_ffff),
    requiredSender: z.string().min(1),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    transaction: browserWalletTransactionSchema,
    review: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        expectedPostState: z.string().min(1),
        fields: z
          .array(z.object({ label: z.string().min(1), value: z.string().min(1) }).strict())
          .min(1)
          .max(16),
      })
      .strict(),
    seal: z.object({ factsSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.request.action !== value.action) {
      context.addIssue({
        code: "custom",
        path: ["request"],
        message: "Wallet intent request and action do not match",
      });
    }
    const expectedChainId =
      value.network === "mainnet"
        ? mainnetChainId
        : value.network === "pox5-testnet"
          ? pox5TestnetChainId
          : null;
    if (
      (expectedChainId !== null && value.chainId !== expectedChainId) ||
      value.transaction.params.network !== value.network
    ) {
      context.addIssue({
        code: "custom",
        path: ["network"],
        message: "Wallet intent network binding does not match",
      });
    }
    if (!walletIntentTransactionMatchesAction(value.action, value.transaction)) {
      context.addIssue({
        code: "custom",
        path: ["transaction"],
        message: "Wallet intent action and transaction do not match",
      });
    }
  });

const storedManifestSchema = z.union([storedManifestV1Schema, storedManifestV2Schema]);
type StoredManifest = z.infer<typeof storedManifestSchema>;

const publicVerificationSchema = z
  .object({
    outcome: z.enum([
      "submitted",
      "mempool",
      "canonical-success",
      "complete",
      "not-found",
      "noncanonical",
      "superseded",
      "mismatch",
      "abort",
      "unavailable",
    ]),
    observedAt: z.iso.datetime(),
    canonical: z.boolean().nullable(),
    blockHeight: z.number().int().nonnegative().nullable(),
    indexBlockHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    detail: z.string().min(1),
  })
  .strict();

const observationEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    verification: publicVerificationSchema,
    decoded: z.unknown().nullable(),
  })
  .strict();

export interface WalletIntentRuntimeState {
  managerPrincipal: string;
  signerGrant: { verified: VerifiedSignerGrant | null };
}

type WalletReader = Pick<
  LiveTransactionReader,
  "lookupIndexedTransaction" | "lookupUnconfirmedTransaction"
>;

interface AuthoritativeIntentFacts {
  scope: string;
  facts: unknown;
  requiredSender: string;
  network: BrowserWalletIntentNetwork;
  chainId: number;
  transaction: BrowserWalletTransaction;
  review: BrowserWalletIntent["review"];
}

interface EquivalentIntentFacts {
  action: RecurringWalletIntentAction;
  scope: string;
  factsSha256: string;
}

/** `sbtc-withdrawal` asserts `(> amount DUST_LIMIT)`; the withdrawn amount is net minus fee budget. */
const SBTC_WITHDRAWAL_DUST_LIMIT = 546n;

export class WalletIntentError extends Error {
  constructor(
    readonly code:
      | "wallet_execution_unavailable"
      | "wallet_intent_not_found"
      | "wallet_intent_invalid"
      | "wallet_intent_conflict"
      | "wallet_intent_expired"
      | "wallet_transaction_mismatch",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WalletIntentError";
  }
}

function asIntentError(error: unknown): never {
  if (error instanceof WalletIntentError) throw error;
  if (error instanceof WalletIntentRepositoryError) {
    const code = error.code === "expired" ? "wallet_intent_expired" : "wallet_intent_conflict";
    throw new WalletIntentError(code, error.message);
  }
  throw error;
}

function nowPlusLifetime(observedAt: string): string {
  const milliseconds = Date.parse(observedAt);
  if (!Number.isFinite(milliseconds)) {
    throw new WalletIntentError("wallet_intent_invalid", "Invalid observation time");
  }
  return new Date(milliseconds + intentLifetimeMs).toISOString();
}

function normalizedTxid(txid: string): `0x${string}` {
  const value = txid.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new WalletIntentError(
      "wallet_intent_invalid",
      "Transaction ID must be 0x followed by 64 hexadecimal characters",
    );
  }
  return value as `0x${string}`;
}

function textSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class WalletIntentService {
  constructor(
    private readonly options: {
      store: SidekickStore;
      runtimeSettings: RuntimeSettingsController;
      managerVerification?: ManagerVerificationContext;
      readState: () => WalletIntentRuntimeState;
      transactionEngineRequestedMode?: "observe" | "assist";
      observeManagerClaimWalletJob?: (
        jobId: string,
      ) => Promise<ManagerClaimWalletAuthoritativeObservation>;
      readerFactory?: (nodeRpcUrl: string) => WalletReader;
    },
  ) {}

  async prepare(
    requestInput: RecurringBrowserWalletIntentCreateRequest,
    observedAt = new Date().toISOString(),
    ignoredSupersededId?: string,
  ): Promise<BrowserWalletIntent> {
    const request = this.parsePrepareRequest(requestInput);
    const action = request.action;
    let ignoredId = ignoredSupersededId;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const authoritative = await this.authoritativeFacts(request);
      const authoritativeSha256 = this.authoritativeSha256(authoritative);
      const factsSha256 = canonicalJsonSha256(authoritative.facts);
      const historicalBlocker = await this.reconcileHistoricalScope(
        action,
        authoritative.scope,
        factsSha256,
        observedAt,
        ignoredId,
      );
      ignoredId = undefined;
      if (historicalBlocker) return this.publicIntent(historicalBlocker);

      const active = this.options.store.walletIntents.findActiveScope({
        action,
        scope: authoritative.scope,
        now: observedAt,
      });
      if (active) {
        if (active.factsSha256 === factsSha256) {
          if (active.txid || active.state === "complete") {
            const refreshed = await this.refreshStored(active, observedAt);
            const current = this.requireStored(active.id);
            const verification = this.latestVerification(current.id);
            const completedActionCanRepeat =
              this.hasCanonicalExecution(current.id, action) &&
              verification?.canonical === true &&
              (verification.outcome === "canonical-success" || verification.outcome === "complete");
            if (!completedActionCanRepeat) return refreshed;
            const latest = await this.authoritativeFacts(request);
            if (this.authoritativeSha256(latest) !== authoritativeSha256) continue;
            const superseded = this.transition(current, "superseded", observedAt);
            this.recordObservation(superseded, {
              outcome: "superseded",
              observedAt,
              canonical: null,
              blockHeight: null,
              indexBlockHash: null,
              detail: "Completed wallet action retired after fresh authoritative validation",
            });
          } else {
            const current = await this.authoritativeFacts(request);
            if (this.authoritativeSha256(current) !== authoritativeSha256) continue;
            return this.publicIntent(active);
          }
        } else if (active.state === "prepared") {
          const superseded = this.transition(active, "superseded", observedAt);
          this.recordObservation(superseded, {
            outcome: "superseded",
            observedAt,
            canonical: null,
            blockHeight: null,
            indexBlockHash: null,
            detail: "Authoritative setup facts changed before wallet signing",
          });
        } else {
          const refreshed = await this.refreshStored(active, observedAt);
          let current = this.requireStored(active.id);
          const verification = this.latestVerification(current.id);
          const completedActionCanRepeat =
            this.hasCanonicalExecution(current.id, action) &&
            verification?.canonical === true &&
            (verification.outcome === "canonical-success" || verification.outcome === "complete");
          if (current.state === "failed") {
            current = this.retireFailedIntent(current, observedAt);
          } else if (completedActionCanRepeat) {
            const latest = await this.authoritativeFacts(request);
            if (this.authoritativeSha256(latest) !== authoritativeSha256) continue;
            current = this.transition(current, "superseded", observedAt);
            this.recordObservation(current, {
              outcome: "superseded",
              observedAt,
              canonical: null,
              blockHeight: null,
              indexBlockHash: null,
              detail: "Completed wallet action retired because its authoritative facts changed",
            });
          } else if (activeIntentStates.has(current.state)) {
            return refreshed;
          }
        }
      }

      const current = await this.authoritativeFacts(request);
      if (this.authoritativeSha256(current) !== authoritativeSha256) continue;
      const currentFactsSha256 = canonicalJsonSha256(current.facts);
      const id = randomUUID();
      const manifest = storedManifestV2Schema.parse({
        schemaVersion: 2,
        id,
        action,
        request,
        network: current.network,
        chainId: current.chainId,
        requiredSender: current.requiredSender,
        createdAt: observedAt,
        expiresAt: nowPlusLifetime(observedAt),
        transaction: current.transaction,
        review: current.review,
        seal: { factsSha256: currentFactsSha256 },
      });
      try {
        const stored = this.options.store.walletIntents.create({
          id,
          action,
          scope: current.scope,
          factsSha256: currentFactsSha256,
          manifest,
          manifestSha256: canonicalJsonSha256(manifest),
          requiredSender: current.requiredSender,
          network: current.network === "pox5-testnet" ? "testnet" : current.network,
          chainId: current.chainId,
          createdAt: observedAt,
          expiresAt: manifest.expiresAt,
        }).intent;
        return this.publicIntent(stored);
      } catch (error) {
        return asIntentError(error);
      }
    }
    throw new WalletIntentError(
      "wallet_intent_conflict",
      "Setup state changed while preparing the transaction. Review the latest state and try again",
    );
  }

  get(id: string): BrowserWalletIntent {
    const stored = this.options.store.walletIntents.get(z.uuid().parse(id));
    if (!stored) {
      throw new WalletIntentError("wallet_intent_not_found", "Wallet intent not found");
    }
    return this.publicIntent(stored);
  }

  async submit(
    id: string,
    txidInput: string,
    observedAt = new Date().toISOString(),
  ): Promise<BrowserWalletIntent> {
    const stored = this.requireStored(id);
    try {
      const submitted = this.options.store.walletIntents.submit({
        id: stored.id,
        txid: normalizedTxid(txidInput),
        submittedAt: observedAt,
      });
      if (stored.txid === null) {
        this.recordObservation(submitted, {
          outcome: "submitted",
          observedAt,
          canonical: null,
          blockHeight: null,
          indexBlockHash: null,
          detail: "Transaction submitted. Waiting for on-chain verification",
        });
      }
      return this.publicIntent(submitted);
    } catch (error) {
      return asIntentError(error);
    }
  }

  async refresh(id: string, observedAt = new Date().toISOString()): Promise<BrowserWalletIntent> {
    let initial = this.requireStored(id);
    if (initial.state === "failed" && initial.txid) {
      const active = this.options.store.walletIntents.findActiveScope({
        action: initial.action,
        scope: initial.scope,
        now: observedAt,
      });
      if (active && active.id !== initial.id) {
        initial = this.retireFailedIntent(initial, observedAt);
      }
    }
    if (initial.state === "prepared" && initial.action !== "deploy-manager") {
      const blocker = await this.reconcileHistoricalScope(
        initial.action,
        initial.scope,
        initial.factsSha256,
        observedAt,
      );
      if (blocker) {
        const superseded = this.transition(initial, "superseded", observedAt);
        this.recordObservation(superseded, {
          outcome: "superseded",
          observedAt,
          canonical: null,
          blockHeight: null,
          indexBlockHash: null,
          detail: "An earlier transaction may still complete. Do not submit another one yet",
        });
        return this.publicIntent(superseded);
      }
    } else if (initial.state !== "superseded" && initial.action !== "deploy-manager") {
      const completed = await this.reconcileSuperseded(
        {
          action: initial.action,
          scope: initial.scope,
          factsSha256: initial.factsSha256,
        },
        observedAt,
      );
      if (completed && initial.state !== "complete") {
        return this.publicIntent(this.requireStored(initial.id));
      }
    }
    const refreshed = await this.refreshStored(this.requireStored(initial.id), observedAt);
    if (
      initial.state === "superseded" &&
      refreshed.verification?.outcome === "complete" &&
      refreshed.verification.canonical
    ) {
      this.resolveEquivalentCompletion(initial.id, observedAt);
      return this.publicIntent(this.requireStored(initial.id));
    }
    return refreshed;
  }

  private async refreshStored(
    input: StoredWalletIntent,
    observedAt: string,
  ): Promise<BrowserWalletIntent> {
    let stored = input;
    const manifest = this.parseStoredManifest(stored);
    if (stored.state === "prepared" && Date.parse(observedAt) >= Date.parse(stored.expiresAt)) {
      stored = this.transition(stored, "expired", observedAt);
      return this.publicIntent(stored);
    }
    if (stored.state === "prepared") {
      let authoritative: AuthoritativeIntentFacts;
      try {
        authoritative = await this.authoritativeFacts(this.requestFromManifest(manifest));
      } catch (error) {
        if (!(error instanceof WalletIntentError)) throw error;
        const superseded = this.transition(stored, "superseded", observedAt);
        this.recordObservation(superseded, {
          outcome: "superseded",
          observedAt,
          canonical: null,
          blockHeight: null,
          indexBlockHash: null,
          detail: "Setup state changed. Prepare a new transaction",
        });
        return this.publicIntent(superseded);
      }
      const factsSha256 = canonicalJsonSha256(authoritative.facts);
      if (
        authoritative.scope !== stored.scope ||
        authoritative.requiredSender !== stored.requiredSender ||
        (manifest.schemaVersion === 2 && factsSha256 !== stored.factsSha256) ||
        canonicalJsonSha256(authoritative.transaction) !== canonicalJsonSha256(manifest.transaction)
      ) {
        const superseded = this.transition(stored, "superseded", observedAt);
        this.recordObservation(superseded, {
          outcome: "superseded",
          observedAt,
          canonical: null,
          blockHeight: null,
          indexBlockHash: null,
          detail: "Setup state changed before signing. Prepare a new transaction",
        });
        return this.publicIntent(superseded);
      }
    }
    if (!stored.txid) return this.publicIntent(stored);

    const clients = this.options.runtimeSettings.clients();
    try {
      await this.assertCurrentNetworkRouting(manifest, clients);
    } catch (error) {
      this.recordUnavailable(
        stored,
        observedAt,
        `Verification paused: ${error instanceof Error ? error.message : "network check failed"}`,
      );
      return this.publicIntent(stored);
    }
    const { config } = clients;
    const reader =
      this.options.readerFactory?.(config.nodeRpcUrl) ??
      new LiveTransactionReader({ baseUrl: config.nodeRpcUrl });
    const indexed = await reader.lookupIndexedTransaction(stored.txid);
    if (indexed.status === "observed") {
      return await this.refreshIndexed(stored, manifest, indexed.value, observedAt, clients);
    }
    if (indexed.status === "unavailable" && indexed.reason === "transaction-index-unavailable") {
      const fallback = await this.refreshIndexedFromApi(stored, manifest, observedAt, clients);
      if (fallback) return fallback;
    }
    if (indexed.status !== "not-found") {
      this.recordUnavailable(
        stored,
        observedAt,
        `Confirmed transaction lookup is unavailable (${indexed.reason}). Sidekick will retry`,
      );
      return this.publicIntent(stored);
    }

    const pending = await reader.lookupUnconfirmedTransaction(stored.txid);
    if (pending.status === "observed") {
      return this.refreshPending(stored, manifest, pending.value, observedAt);
    }
    if (pending.status !== "not-found") {
      this.recordUnavailable(
        stored,
        observedAt,
        `Pending transaction lookup is unavailable (${pending.reason}). Sidekick will retry`,
      );
      return this.publicIntent(stored);
    }

    if (["submitted", "mempool", "confirmed", "complete", "failed"].includes(stored.state)) {
      stored = this.transition(stored, "reobserve", observedAt);
    }
    this.recordObservation(stored, {
      outcome: "not-found",
      observedAt,
      canonical: null,
      blockHeight: null,
      indexBlockHash: null,
      detail:
        "Transaction is not visible in pending or confirmed node state. Wait and retry; replacement is available after 15 minutes",
    });
    return this.publicIntent(stored);
  }

  async replace(id: string, observedAt = new Date().toISOString()): Promise<BrowserWalletIntent> {
    const before = this.requireStored(id);
    if (before.state !== "reobserve" || !before.submittedAt) {
      throw new WalletIntentError(
        "wallet_intent_conflict",
        "This transaction is not eligible for replacement",
      );
    }
    if (Date.parse(observedAt) < Date.parse(before.submittedAt) + replacementGraceMs) {
      throw new WalletIntentError(
        "wallet_intent_conflict",
        "Wait at least 15 minutes after submission before replacing a transaction",
      );
    }
    const refreshed = await this.refresh(id, observedAt);
    if (refreshed.status !== "reobserve" || refreshed.verification?.outcome !== "not-found") {
      throw new WalletIntentError(
        "wallet_intent_conflict",
        "The transaction is still visible to the node. Wait before replacing it",
      );
    }
    const stored = this.requireStored(id);
    const manifest = this.parseStoredManifest(stored);
    const request = this.requestFromManifest(manifest);
    await this.authoritativeFacts(request);
    const superseded = this.transition(stored, "superseded", observedAt);
    this.recordObservation(superseded, {
      outcome: "superseded",
      observedAt,
      canonical: null,
      blockHeight: null,
      indexBlockHash: null,
      detail: "Transaction remained absent after 15 minutes and was replaced",
    });
    return await this.prepare(request, observedAt, superseded.id);
  }

  private authoritativeSha256(authoritative: AuthoritativeIntentFacts): string {
    return canonicalJsonSha256({
      scope: authoritative.scope,
      facts: authoritative.facts,
      requiredSender: authoritative.requiredSender,
      network: authoritative.network,
      chainId: authoritative.chainId,
      transaction: authoritative.transaction,
      review: authoritative.review,
    });
  }

  private parsePrepareRequest(
    input: RecurringBrowserWalletIntentCreateRequest,
  ): RecurringBrowserWalletIntentCreateRequest {
    return walletIntentRequestSchema.parse(input);
  }

  private requestFromManifest(manifest: StoredManifest): RecurringBrowserWalletIntentCreateRequest {
    if (manifest.schemaVersion === 2) return manifest.request;
    throw new WalletIntentError(
      "wallet_intent_invalid",
      "Legacy setup transactions cannot be prepared again; start the recurring operation again",
    );
  }

  private readState(): WalletIntentRuntimeState {
    try {
      return this.options.readState();
    } catch {
      throw new WalletIntentError(
        "wallet_intent_invalid",
        "Manager operation state is unavailable. Refresh the Manager page and try again",
      );
    }
  }

  private runtimeStateSha256(
    action: RecurringWalletIntentAction,
    state: WalletIntentRuntimeState,
  ): string {
    return canonicalJsonSha256({
      action,
      managerPrincipal: state.managerPrincipal,
      signerGrant: action === "register-self" ? state.signerGrant.verified : null,
    });
  }

  private walletNetwork(
    config: Pick<SidekickConfig, "network" | "expectedNetworkId">,
  ): WalletTransactionNetworkBinding {
    if (config.network === "mainnet") return mainnetWalletNetwork;
    if (config.network === "testnet") return pox5TestnetWalletNetwork;
    return createWalletTransactionNetworkBinding(
      config.network,
      config.expectedNetworkId ?? defaultPrivateChainId,
    );
  }

  private async assertCurrentNetworkRouting(
    manifest: StoredManifest,
    clients: WalletRuntimeClients,
  ): Promise<void> {
    const current = this.walletNetwork(clients.config);
    if (current.network !== manifest.network || current.chainId !== manifest.chainId) {
      throw new Error("Sidekick's configured network changed. Prepare a new transaction");
    }
    const nodeInfo = await clients.node.getInfo();
    if (nodeInfo.network_id !== manifest.chainId) {
      throw new Error(
        "The local node no longer matches this transaction's network. Check Settings, then retry",
      );
    }
  }

  private assertManagerActionTarget(
    snapshot: OperatorAnchorSnapshot,
    managerPrincipal: string,
    network: WalletTransactionNetworkBinding,
    action: RecurringWalletIntentAction,
  ): void {
    const capabilityId = managerCapabilityForWalletAction(action);
    const capability = capabilityId
      ? managerActionCapability(snapshot.manager.capabilities, capabilityId)
      : null;
    if (
      snapshot.manager.managerPrincipal !== managerPrincipal ||
      !snapshot.manager.attachAllowed ||
      !capability?.executionAvailable ||
      !walletNetworkChecksPass(snapshot, network.chainId)
    ) {
      throw new WalletIntentError(
        "wallet_execution_unavailable",
        capability?.reason ??
          "The configured manager is unavailable or lacks a reviewed capability on this network",
      );
    }
  }

  private assertActionPrincipal(principal: string, network: BrowserWalletIntentNetwork): void {
    if (!validatePrincipal(principal)) {
      throw new WalletIntentError("wallet_intent_invalid", "Invalid Stacks principal");
    }
    const address = principal.split(".", 1)[0] ?? "";
    const isMainnet = address.startsWith("SP") || address.startsWith("SM");
    if (isMainnet !== (network === "mainnet")) {
      throw new WalletIntentError(
        "wallet_intent_invalid",
        "The action principal does not match the configured network",
      );
    }
  }

  private async authoritativeFacts(
    request: RecurringBrowserWalletIntentCreateRequest,
  ): Promise<AuthoritativeIntentFacts> {
    const action = request.action;
    const { config, node, api } = this.options.runtimeSettings.clients();
    const network = this.walletNetwork(config);
    const state = this.readState();
    const stateSha256 = this.runtimeStateSha256(action, state);
    const assertStateUnchanged = () => {
      const latest = this.readState();
      if (this.runtimeStateSha256(action, latest) !== stateSha256) {
        throw new WalletIntentError(
          "wallet_intent_conflict",
          "Manager or signer authorization changed. Review the latest state and prepare again",
        );
      }
    };

    const managerPrincipal = state.managerPrincipal;
    const snapshot = await readOperatorAnchorSnapshot({
      config,
      node,
      api,
      managerPrincipal,
      managerVerification: this.options.managerVerification,
      reportMissingManager: true,
    });
    if (snapshot.preflight.node.networkId !== network.chainId) {
      throw new WalletIntentError(
        "wallet_execution_unavailable",
        "The node does not match the selected wallet network. Check Settings and try again",
      );
    }
    this.assertManagerActionTarget(snapshot, managerPrincipal, network, action);
    if (action === "register-self") {
      const verified = state.signerGrant.verified;
      if (!verified) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "Generate and verify a signer authorization before registration",
        );
      }
      if (
        snapshot.registration?.registered &&
        snapshot.registration.signerKeyHex === verified.signerKeyHex &&
        snapshot.registration.signerKeyGrantValid
      ) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "This signer key is already registered and authorized",
        );
      }
    }

    const actorPrincipal = request.actorPrincipal;
    if (!actorPrincipal || !validateStacksAddress(actorPrincipal)) {
      throw new WalletIntentError(
        "wallet_intent_invalid",
        "Connect a valid Stacks account for this network",
      );
    }
    this.assertActionPrincipal(actorPrincipal, network.network);
    const readOptions = snapshot.chainAnchor?.indexBlockHash
      ? { tip: snapshot.chainAnchor.indexBlockHash }
      : undefined;
    if (action === "claim-rewards") {
      const profileId = snapshot.manager.source.profileId;
      if (!profileId) {
        throw new WalletIntentError(
          "wallet_execution_unavailable",
          "The trusted manager profile is unavailable for this claim job",
        );
      }
      try {
        const observeManagerClaimWalletJob = this.options.observeManagerClaimWalletJob;
        if (!observeManagerClaimWalletJob) {
          throw new WalletIntentError(
            "wallet_execution_unavailable",
            "Browser-wallet claims are unavailable because the transaction engine is not running",
          );
        }
        const observation = await observeManagerClaimWalletJob(request.jobId);
        if (!observation) {
          throw new Error("Manager-claim wallet observation returned no result");
        }
        const prepared = await prepareManagerClaimWalletIntent({
          repository: this.options.store.transactionEngine,
          jobId: request.jobId,
          actorPrincipal,
          observation,
          live: {
            requestedMode: this.options.transactionEngineRequestedMode ?? "assist",
            network: {
              name: network.network,
              kind: config.network === "mainnet" ? "mainnet" : "testnet",
              chainId: network.chainId,
            },
            manager: {
              principal: managerPrincipal,
              profileId,
              sourceSha256: snapshot.manager.source.sha256,
            },
          },
        });
        assertStateUnchanged();
        return prepared;
      } catch (error) {
        if (error instanceof WalletIntentError) throw error;
        if (error instanceof ManagerClaimWalletIntentError) {
          throw new WalletIntentError(
            error.code === "unavailable"
              ? "wallet_execution_unavailable"
              : "wallet_intent_conflict",
            error.message,
            error.retryable,
          );
        }
        throw error;
      }
    }
    const authority = walletOperationContract(action).authority;
    if (authority === "manager-admin" || authority === "manager-admin-and-signer-grant") {
      const isAdmin = decodeBoolean(
        await node.callReadOnly(
          managerPrincipal,
          "is-admin",
          actorPrincipal,
          [encodePrincipalHex(actorPrincipal)],
          readOptions,
        ),
        "is-admin",
      );
      if (!isAdmin) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "Connect a current manager-admin account",
        );
      }
    }
    const commonFields = [
      { label: "Manager", value: managerPrincipal },
      { label: "Sender", value: actorPrincipal },
      { label: "Network", value: network.network },
      {
        label: "Source assurance",
        value:
          snapshot.manager.source.tier === "reference-built-in" ||
          snapshot.manager.source.tier === "reference-render"
            ? "Verified reference manager"
            : "Unverified or custom manager — review in signing tool",
      },
    ];
    const transaction = (
      functionName:
        | "register-self"
        | "update-admin"
        | "update-fees"
        | "withdraw-fees"
        | "sweep-fee-refunds"
        | "claim-staker-rewards",
      functionArgs: string[],
      postConditions: string[] = [],
    ): BrowserWalletTransaction => ({
      method: "stx_callContract",
      params: {
        contract: managerPrincipal,
        functionName,
        functionArgs,
        network: network.network,
        address: actorPrincipal,
        sponsored: false,
        postConditionMode: "deny",
        postConditions,
      },
    });

    if (action === "register-self") {
      const verified = state.signerGrant.verified;
      if (!verified) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "Generate and verify a signer authorization before registration",
        );
      }
      if (snapshot.preflight.pox.pox5ContractId !== verified.pox5ContractId) {
        throw new WalletIntentError(
          "wallet_intent_conflict",
          "The active PoX-5 contract changed. Generate and verify a new signer authorization",
        );
      }
      if (
        snapshot.registration?.registered &&
        snapshot.registration.signerKeyHex === verified.signerKeyHex &&
        snapshot.registration.signerKeyGrantValid
      ) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "This signer key is already registered and authorized",
        );
      }
      const currentGrant = await verifySignerGrantOutput(
        node,
        verified.pox5ContractId,
        managerPrincipal,
        verified.authId,
        {
          signerManager: managerPrincipal,
          authId: verified.authId,
          signerKey: verified.signerKeyHex,
          signerSignature: verified.signerSignatureHex,
        },
      );
      const usedGrantKey = cvToHex(
        tupleCV({
          "signer-key": bufferCV(Buffer.from(currentGrant.signerKeyHex, "hex")),
          "signer-manager": principalCV(managerPrincipal),
          "auth-id": uintCV(BigInt(currentGrant.authId)),
        }),
      );
      const currentUsedGrant = await node.getMapEntry(
        verified.pox5ContractId,
        "used-signer-key-grants",
        usedGrantKey,
        readOptions,
      );
      if (
        currentUsedGrant.type === ClarityType.OptionalSome &&
        decodeBoolean(currentUsedGrant.value, "used-signer-key-grants")
      ) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "This signer authorization has already been used. Generate and verify a new one",
        );
      }
      assertStateUnchanged();
      return {
        scope: managerPrincipal,
        requiredSender: actorPrincipal,
        network: network.network,
        chainId: network.chainId,
        facts: {
          schemaVersion: 2,
          request,
          managerPrincipal,
          pox5ContractId: currentGrant.pox5ContractId,
          authId: currentGrant.authId,
          signerKeyHex: currentGrant.signerKeyHex,
          signerSignatureHex: currentGrant.signerSignatureHex,
          expectedMessageHashHex: currentGrant.expectedMessageHashHex,
          call: currentGrant.registerSelfCall,
        },
        transaction: transaction("register-self", currentGrant.registerSelfCall.arguments),
        review: {
          title: "Register the signer manager",
          summary: `Register the verified signer key through ${managerPrincipal}.`,
          expectedPostState: `PoX-5 registers signer key ${currentGrant.signerKeyHex}.`,
          fields: [
            ...commonFields,
            { label: "Signer key", value: currentGrant.signerKeyHex },
            { label: "Auth ID", value: currentGrant.authId },
          ],
        },
      };
    }

    if (action === "add-admin" || action === "remove-admin") {
      if (!validateStacksAddress(request.adminPrincipal)) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "Manager admins must be standard Stacks account principals",
        );
      }
      this.assertActionPrincipal(request.adminPrincipal, network.network);
      if (action === "remove-admin" && request.adminPrincipal === actorPrincipal) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "An admin cannot remove itself through Sidekick",
        );
      }
      const enabled = action === "add-admin";
      const currentlyEnabled = decodeBoolean(
        await node.callReadOnly(
          managerPrincipal,
          "is-admin",
          actorPrincipal,
          [encodePrincipalHex(request.adminPrincipal)],
          readOptions,
        ),
        "is-admin",
      );
      if (currentlyEnabled === enabled) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          enabled
            ? "This account is already a manager admin"
            : "This account is not a manager admin",
        );
      }
      assertStateUnchanged();
      return {
        scope: managerPrincipal,
        requiredSender: actorPrincipal,
        network: network.network,
        chainId: network.chainId,
        facts: { schemaVersion: 2, request, managerPrincipal, currentlyEnabled },
        transaction: transaction("update-admin", [
          encodePrincipalHex(request.adminPrincipal),
          cvToHex(boolCV(enabled)),
        ]),
        review: {
          title: enabled ? "Add manager admin" : "Remove manager admin",
          summary: `${enabled ? "Enable" : "Disable"} ${request.adminPrincipal} as a manager admin.`,
          expectedPostState: `${request.adminPrincipal} is ${enabled ? "an active" : "not an"} admin.`,
          fields: [
            ...commonFields,
            { label: "Admin", value: request.adminPrincipal },
            { label: "Enabled", value: String(enabled) },
          ],
        },
      };
    }

    if (action === "update-fees") {
      const nextFees = BigInt(request.feeBips);
      const currentFees = decodeUInt(
        await node.getDataVar(managerPrincipal, "fees-bips", readOptions),
        "fees-bips",
      );
      if (currentFees === nextFees) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "The manager already uses this fee rate",
        );
      }
      assertStateUnchanged();
      return {
        scope: managerPrincipal,
        requiredSender: actorPrincipal,
        network: network.network,
        chainId: network.chainId,
        facts: {
          schemaVersion: 2,
          request,
          managerPrincipal,
          currentFeeBips: currentFees.toString(),
        },
        transaction: transaction("update-fees", [encodeUIntHex(nextFees)]),
        review: {
          title: "Update manager fees",
          summary: `Set the manager fee rate to ${request.feeBips} basis points.`,
          expectedPostState: `The configured manager fee is ${request.feeBips} basis points.`,
          fields: [
            ...commonFields,
            { label: "Current fee (bips)", value: currentFees.toString() },
            { label: "New fee (bips)", value: request.feeBips },
          ],
        },
      };
    }

    const sbtcTokenContract = snapshot.preflight.pox.sbtcTokenContract;
    if (!sbtcTokenContract) {
      throw new WalletIntentError(
        "wallet_execution_unavailable",
        "The matched network does not expose the trusted sBTC token contract",
      );
    }

    if (action === "claim-staker-rewards") {
      // `claim-staker-rewards` is permissionless and always pays the staker named in its
      // arguments, never the sender, so the operator settles a staker without holding any
      // authority over their funds. It takes one staker and has no batch form: settling a pool is
      // one transaction per (staker, reward-cycle, bond-index).
      this.assertActionPrincipal(request.stakerPrincipal, network.network);
      const rewardCycle = BigInt(request.rewardCycle);
      const bondIndex = request.bondIndex === null ? null : BigInt(request.bondIndex);
      const bucketArgs = [
        encodePrincipalHex(request.stakerPrincipal),
        encodeUIntHex(rewardCycle),
        encodeOptionalUIntHex(bondIndex),
      ];
      const [rewardsValue, payoutValue, feeSnapshotValue, unclaimedValue] = await Promise.all([
        node.callReadOnly(
          managerPrincipal,
          "get-earned-staker-rewards",
          actorPrincipal,
          bucketArgs,
          readOptions,
        ),
        node.callReadOnly(
          managerPrincipal,
          "get-pox-addr",
          actorPrincipal,
          [encodePrincipalHex(request.stakerPrincipal)],
          readOptions,
        ),
        // The map entry itself, not `get-fee-bips-for-cycle`, whose `default-to u0` makes an
        // unclaimed bucket indistinguishable from a genuine zero-fee one.
        node.getMapEntry(
          managerPrincipal,
          "fee-bips-for-cycle",
          cvToHex(
            tupleCV({
              "reward-cycle": uintCV(rewardCycle),
              "bond-index": bondIndex === null ? noneCV() : someCV(uintCV(bondIndex)),
            }),
          ),
          readOptions,
        ),
        node.callReadOnly(
          managerPrincipal,
          "get-unclaimed-staker-rewards",
          actorPrincipal,
          [],
          readOptions,
        ),
      ]);
      const rewards = decodeEarnedStakerRewards(rewardsValue);
      const payout = decodePoxAddressPreference(payoutValue);
      // `map-insert` only happens inside `claim-rewards`, so a present entry is anchored proof the
      // manager already pulled this bucket's rewards in. Absent means the payout would revert on
      // the manager's own balance checks, whatever unrelated funds it happens to hold.
      const feeBips = decodeOptionalUInt(feeSnapshotValue, "fee-bips-for-cycle");
      const unclaimed = decodeUInt(unclaimedValue, "get-unclaimed-staker-rewards");
      const gross = rewards.earned + rewards.fees;

      // Every refusal below is a call the manager or sBTC would reject. Sidekick must not spend a
      // transaction discovering that.
      if (rewards.earned === 0n) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "This bucket has nothing settled for the staker",
        );
      }
      if (feeBips === null) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "The manager has not claimed this bucket yet; claim manager rewards first",
        );
      }
      if (unclaimed < gross) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "The manager has not claimed these rewards yet; claim manager rewards first",
        );
      }
      if (payout !== null) {
        if (rewards.earned < payout.maxFee) {
          throw new WalletIntentError(
            "wallet_intent_invalid",
            "The payout does not cover the staker's maximum Bitcoin withdrawal fee",
          );
        }
        if (rewards.earned - payout.maxFee <= SBTC_WITHDRAWAL_DUST_LIMIT) {
          throw new WalletIntentError(
            "wallet_intent_invalid",
            `A Bitcoin L1 withdrawal must exceed the ${SBTC_WITHDRAWAL_DUST_LIMIT}-sat dust limit after the fee budget`,
          );
        }
      }

      // Both payout routes reduce the manager's sbtc-token balance by exactly the net amount --
      // a direct transfer, or `protocol-lock` burning it into the withdrawal system -- so one
      // equality postcondition covers either outcome and rejects the other.
      const postCondition = postConditionToHex(
        Pc.principal(managerPrincipal)
          .willSendEq(rewards.earned)
          .ft(sbtcTokenContract as `${string}.${string}`, "sbtc-token"),
      );
      assertStateUnchanged();
      const bucketLabel = bondIndex === null ? "STX-only" : `bond period ${bondIndex}`;
      return {
        scope: managerPrincipal,
        requiredSender: actorPrincipal,
        network: network.network,
        chainId: network.chainId,
        facts: {
          schemaVersion: 2,
          request,
          managerPrincipal,
          grossSats: gross.toString(),
          feeSats: rewards.fees.toString(),
          netSats: rewards.earned.toString(),
          feeSnapshotBips: feeBips.toString(),
          unclaimedStakerRewardsSats: unclaimed.toString(),
          payout:
            payout === null
              ? { kind: "direct-sbtc" }
              : {
                  kind: "bitcoin-l1",
                  maxFeeSats: payout.maxFee.toString(),
                  withdrawalAmountSats: (rewards.earned - payout.maxFee).toString(),
                },
          postCondition,
        },
        transaction: transaction("claim-staker-rewards", bucketArgs, [postCondition]),
        review: {
          title: "Claim staker rewards",
          summary: `Pay ${rewards.earned} sats of ${bucketLabel} rewards for cycle ${rewardCycle} to ${request.stakerPrincipal}.`,
          expectedPostState:
            payout === null
              ? "The staker receives the exact sBTC amount and the bucket settles to zero."
              : "The exact sBTC amount enters the withdrawal system for the staker's Bitcoin address and the bucket settles to zero.",
          fields: [
            ...commonFields,
            { label: "Staker", value: request.stakerPrincipal },
            { label: "Reward cycle", value: rewardCycle.toString() },
            { label: "Bucket", value: bucketLabel },
            { label: "Gross (sats)", value: gross.toString() },
            { label: "Manager fee (sats)", value: rewards.fees.toString() },
            { label: "Fee snapshot (bips)", value: feeBips.toString() },
            { label: "Staker receives (sats)", value: rewards.earned.toString() },
            {
              label: "Payout route",
              value: payout === null ? "Direct sBTC" : "Bitcoin L1 withdrawal",
            },
          ],
        },
      };
    }

    if (!("recipient" in request)) {
      throw new WalletIntentError(
        "wallet_intent_invalid",
        "Wallet action request is missing its recipient",
      );
    }
    this.assertActionPrincipal(request.recipient, network.network);
    if (action === "withdraw-fees") {
      const amount = BigInt(request.amountSats);
      const earnedFees = decodeUInt(
        await node.callReadOnly(
          managerPrincipal,
          "get-earned-fees",
          actorPrincipal,
          [],
          readOptions,
        ),
        "get-earned-fees",
      );
      if (amount > earnedFees) {
        throw new WalletIntentError(
          "wallet_intent_invalid",
          "Withdrawal amount exceeds the currently earned manager fees",
        );
      }
      const postCondition = postConditionToHex(
        Pc.principal(managerPrincipal)
          .willSendEq(amount)
          .ft(sbtcTokenContract as `${string}.${string}`, "sbtc-token"),
      );
      assertStateUnchanged();
      return {
        scope: managerPrincipal,
        requiredSender: actorPrincipal,
        network: network.network,
        chainId: network.chainId,
        facts: {
          schemaVersion: 2,
          request,
          managerPrincipal,
          earnedFees: earnedFees.toString(),
          postCondition,
        },
        transaction: transaction(
          "withdraw-fees",
          [encodeUIntHex(amount), encodePrincipalHex(request.recipient)],
          [postCondition],
        ),
        review: {
          title: "Withdraw manager fees",
          summary: `Withdraw ${request.amountSats} sats of earned fees to ${request.recipient}.`,
          expectedPostState: "The exact sBTC amount is transferred and deducted from earned fees.",
          fields: [
            ...commonFields,
            { label: "Amount (sats)", value: request.amountSats },
            { label: "Recipient", value: request.recipient },
            { label: "Available fees (sats)", value: earnedFees.toString() },
          ],
        },
      };
    }

    const [balanceValue, earnedFeesValue, liabilityValue, unclaimedValue] = await Promise.all([
      node.callReadOnly(
        sbtcTokenContract,
        "get-balance",
        actorPrincipal,
        [encodePrincipalHex(managerPrincipal)],
        readOptions,
      ),
      node.callReadOnly(managerPrincipal, "get-earned-fees", actorPrincipal, [], readOptions),
      node.callReadOnly(
        managerPrincipal,
        "get-withdrawal-liability",
        actorPrincipal,
        [],
        readOptions,
      ),
      node.callReadOnly(
        managerPrincipal,
        "get-unclaimed-staker-rewards",
        actorPrincipal,
        [],
        readOptions,
      ),
    ]);
    const balance = decodeUInt(decodeResponseOk(balanceValue, "get-balance"), "get-balance");
    const earnedFees = decodeUInt(earnedFeesValue, "get-earned-fees");
    const liability = decodeUInt(liabilityValue, "get-withdrawal-liability");
    const unclaimed = decodeUInt(unclaimedValue, "get-unclaimed-staker-rewards");
    const reserved = earnedFees + liability + unclaimed;
    const sweepable = balance >= reserved ? balance - reserved : 0n;
    if (sweepable === 0n) {
      throw new WalletIntentError(
        "wallet_intent_invalid",
        "No fee refunds are currently available to sweep",
      );
    }
    const postCondition = postConditionToHex(
      Pc.principal(managerPrincipal)
        .willSendEq(sweepable)
        .ft(sbtcTokenContract as `${string}.${string}`, "sbtc-token"),
    );
    assertStateUnchanged();
    return {
      scope: managerPrincipal,
      requiredSender: actorPrincipal,
      network: network.network,
      chainId: network.chainId,
      facts: {
        schemaVersion: 2,
        request,
        managerPrincipal,
        balance: balance.toString(),
        reserved: reserved.toString(),
        sweepable: sweepable.toString(),
        postCondition,
      },
      transaction: transaction(
        "sweep-fee-refunds",
        [encodePrincipalHex(request.recipient)],
        [postCondition],
      ),
      review: {
        title: "Sweep fee refunds",
        summary: `Sweep ${sweepable} sats of unreserved sBTC to ${request.recipient}.`,
        expectedPostState: "The exact unreserved sBTC balance is transferred to the recipient.",
        fields: [
          ...commonFields,
          { label: "Sweep amount (sats)", value: sweepable.toString() },
          { label: "Recipient", value: request.recipient },
          { label: "Reserved balance (sats)", value: reserved.toString() },
        ],
      },
    };
  }

  private async refreshIndexed(
    stored: StoredWalletIntent,
    manifest: StoredManifest,
    indexed: IndexedTransactionObservation,
    observedAt: string,
    clients: WalletRuntimeClients,
    verifiedByApi?: VerifiedWalletTransaction,
  ): Promise<BrowserWalletIntent> {
    const decoded =
      verifiedByApi ?? this.verifyObserved(stored, manifest, indexed.transactionHex, observedAt);
    if (!decoded) return this.publicIntent(this.requireStored(stored.id));
    if (!indexed.isCanonical || indexed.blockHeight === null) {
      const next =
        stored.state === "superseded" ? stored : this.transition(stored, "reobserve", observedAt);
      const blockHeight = indexed.blockHeight === null ? null : Number(indexed.blockHeight);
      const hasSafeHeight = blockHeight !== null && Number.isSafeInteger(blockHeight);
      this.recordObservation(
        next,
        {
          outcome: indexed.isCanonical ? "unavailable" : "noncanonical",
          observedAt,
          canonical: indexed.isCanonical ? null : false,
          blockHeight: hasSafeHeight ? blockHeight : null,
          indexBlockHash: hasSafeHeight ? indexed.indexBlockHash : null,
          detail: indexed.isCanonical
            ? "The confirmed transaction has no anchored block height. Sidekick will retry"
            : "The transaction is no longer canonical. Sidekick will keep checking",
        },
        decoded,
      );
      return this.publicIntent(next);
    }

    const blockHeight = Number(indexed.blockHeight);
    if (!Number.isSafeInteger(blockHeight)) {
      this.recordUnavailable(stored, observedAt, "Indexed block height is outside the safe range");
      return this.publicIntent(stored);
    }
    try {
      const { config, node, api } = clients;
      if (!verifiedByApi && !indexed.resultRepr.trimStart().startsWith("(ok")) {
        const next = stored.state === "superseded" ? stored : this.toFailed(stored, observedAt);
        this.recordObservation(
          next,
          {
            outcome: "abort",
            observedAt,
            canonical: true,
            blockHeight,
            indexBlockHash: indexed.indexBlockHash,
            detail:
              "Transaction failed on-chain. Prepare a new transaction if the action is still needed",
          },
          decoded,
        );
        return this.publicIntent(next);
      }

      let next =
        stored.state === "complete" || stored.state === "superseded"
          ? stored
          : this.toConfirmed(stored, observedAt);
      let complete = false;
      let customAssetSemanticsUnattested = false;
      if (manifest.action === "deploy-manager") {
        if (manifest.transaction.method !== "stx_deployContract") {
          throw new WalletIntentError(
            "wallet_intent_invalid",
            "Deployment intent contains the wrong transaction method",
          );
        }
        if (decoded.payload.kind !== "deploy-contract") {
          throw new WalletIntentError(
            "wallet_intent_invalid",
            "Deployment verification contains the wrong decoded payload",
          );
        }
        const managerPrincipal = `${manifest.requiredSender}.${manifest.transaction.params.name}`;
        const snapshot = await readOperatorAnchorSnapshot({
          config,
          node,
          api,
          managerPrincipal,
          managerVerification: this.options.managerVerification,
          reportMissingManager: true,
        });
        complete =
          snapshot.manager.attachAllowed &&
          snapshot.manager.source.sha256 === textSha256(manifest.transaction.params.clarityCode);
      } else {
        if (manifest.transaction.method !== "stx_callContract") {
          throw new WalletIntentError(
            "wallet_intent_invalid",
            "Contract-call intent contains the wrong transaction method",
          );
        }
        if (decoded.payload.kind !== "call-contract") {
          throw new WalletIntentError(
            "wallet_intent_invalid",
            "Contract-call verification contains the wrong decoded payload",
          );
        }
        const managerPrincipal = manifest.transaction.params.contract;
        const request = this.requestFromManifest(manifest);
        if (manifest.action === "claim-rewards") {
          if (!("jobId" in request) || !("actorPrincipal" in request)) {
            throw new WalletIntentError(
              "wallet_intent_invalid",
              "Manager-claim intent is missing its exact job binding",
            );
          }
          const walletNetwork = this.walletNetwork(config);
          const bound = readBoundManagerClaimWalletIntent({
            repository: this.options.store.transactionEngine,
            jobId: request.jobId,
            actorPrincipal: request.actorPrincipal,
            network: {
              name: walletNetwork.network,
              kind: config.network === "mainnet" ? "mainnet" : "testnet",
              chainId: walletNetwork.chainId,
            },
            managerPrincipal,
          });
          if (
            bound.scope !== stored.scope ||
            bound.requiredSender !== stored.requiredSender ||
            canonicalJsonSha256(bound.facts) !== stored.factsSha256 ||
            canonicalJsonSha256(bound.transaction) !== canonicalJsonSha256(manifest.transaction)
          ) {
            throw new WalletIntentError(
              "wallet_transaction_mismatch",
              "Canonical manager claim does not bind the stored engine job",
            );
          }
          const jobStatus = managerClaimWalletJobStatus({
            repository: this.options.store.transactionEngine,
            binding: bound.facts.job,
          });
          if (jobStatus === "superseded") {
            next =
              next.state === "superseded" ? next : this.transition(next, "superseded", observedAt);
            this.recordObservation(
              next,
              {
                outcome: "superseded",
                observedAt,
                canonical: true,
                blockHeight,
                indexBlockHash: indexed.indexBlockHash,
                detail:
                  "Transaction confirmed, but its claim job was superseded. Refresh Operations",
              },
              decoded,
            );
            return this.publicIntent(next);
          }
          complete = jobStatus === "complete";
        } else if (manifest.action === "register-self") {
          const snapshot = await readOperatorAnchorSnapshot({
            config,
            node,
            api,
            managerPrincipal,
            managerVerification: this.options.managerVerification,
            reportMissingManager: true,
          });
          complete = Boolean(
            decoded.payload.signerKeyHex &&
              snapshot.registration?.registered &&
              snapshot.registration.signerKeyGrantValid &&
              snapshot.registration.signerKeyHex === decoded.payload.signerKeyHex,
          );
        } else if (manifest.action === "add-admin" || manifest.action === "remove-admin") {
          if (!("adminPrincipal" in request)) {
            throw new WalletIntentError(
              "wallet_intent_invalid",
              "Admin intent is missing its target principal",
            );
          }
          complete =
            decodeBoolean(
              await node.callReadOnly(managerPrincipal, "is-admin", manifest.requiredSender, [
                encodePrincipalHex(request.adminPrincipal),
              ]),
              "is-admin",
            ) ===
            (manifest.action === "add-admin");
        } else if (manifest.action === "update-fees") {
          if (!("feeBips" in request)) {
            throw new WalletIntentError(
              "wallet_intent_invalid",
              "Fee intent is missing its target rate",
            );
          }
          complete =
            decodeUInt(await node.getDataVar(managerPrincipal, "fees-bips"), "fees-bips") ===
            BigInt(request.feeBips);
        } else if (manifest.action === "claim-staker-rewards") {
          if (!("stakerPrincipal" in request) || !("rewardCycle" in request)) {
            throw new WalletIntentError(
              "wallet_intent_invalid",
              "Staker-claim intent is missing its settlement tuple",
            );
          }
          // Canonical post-state: `claim-staker-rewards-for-signer` zeroes the staker's unclaimed
          // balance for the bucket, so the tuple reads back as settled regardless of which payout
          // route ran. This also confirms a completion that some other caller produced, since the
          // call is permissionless.
          const settled = decodeEarnedStakerRewards(
            await node.callReadOnly(
              managerPrincipal,
              "get-earned-staker-rewards",
              manifest.requiredSender,
              [
                encodePrincipalHex(request.stakerPrincipal),
                encodeUIntHex(BigInt(request.rewardCycle)),
                encodeOptionalUIntHex(
                  request.bondIndex === null ? null : BigInt(request.bondIndex),
                ),
              ],
            ),
          );
          complete = settled.earned === 0n;
        } else {
          const snapshot = await readOperatorAnchorSnapshot({
            config,
            node,
            api,
            managerPrincipal,
            managerVerification: this.options.managerVerification,
            reportMissingManager: true,
          });
          const verifiedReferenceManager =
            (snapshot.manager.source.tier === "reference-built-in" &&
              snapshot.manager.provenance.status === "built-in") ||
            (snapshot.manager.source.tier === "reference-render" &&
              snapshot.manager.provenance.status === "verified");
          // The exact-equality sBTC postcondition binds the manager, amount, and asset. Only a
          // verified reference source gives Sidekick enough semantic assurance to claim that the
          // recipient argument produced the expected poststate.
          customAssetSemanticsUnattested = Boolean(verifiedByApi) || !verifiedReferenceManager;
          complete = !verifiedByApi && decoded.postConditionCount === 1 && verifiedReferenceManager;
        }
      }
      if (complete && !["complete", "superseded"].includes(next.state))
        next = this.transition(next, "complete", observedAt);
      if (!complete && next.state === "complete")
        next = this.transition(next, "reobserve", observedAt);
      this.recordObservation(
        next,
        {
          outcome: complete ? "complete" : "canonical-success",
          observedAt,
          canonical: true,
          blockHeight,
          indexBlockHash: indexed.indexBlockHash,
          detail: complete
            ? verifiedByApi
              ? "Transaction inclusion confirmed by the configured API and expected on-chain state verified. Node transaction indexing is disabled, so Sidekick could not inspect raw transaction bytes"
              : "Transaction and expected on-chain state verified"
            : verifiedByApi
              ? "Transaction inclusion confirmed by the configured API. Node transaction indexing is disabled, so Sidekick could not inspect raw transaction bytes"
              : customAssetSemanticsUnattested && decoded.postConditionCount === 1
                ? "Transaction and exact asset transfer verified. Sidekick cannot attest the custom manager's resulting state"
                : "Transaction confirmed. Waiting for the expected on-chain state",
        },
        decoded,
      );
      return this.publicIntent(next);
    } catch (error) {
      const current = this.requireStored(stored.id);
      this.recordUnavailable(
        current,
        observedAt,
        `Post-state verification is temporarily unavailable: ${error instanceof Error ? error.message : "the verifier returned no diagnostic detail"}. Sidekick will retry`,
      );
      return this.publicIntent(current);
    }
  }

  private async refreshIndexedFromApi(
    stored: StoredWalletIntent,
    manifest: StoredManifest,
    observedAt: string,
    clients: WalletRuntimeClients,
  ): Promise<BrowserWalletIntent | null> {
    try {
      const apiInfo = await clients.api.getNodeInfo();
      if (apiInfo.network_id !== manifest.chainId) {
        this.recordUnavailable(
          stored,
          observedAt,
          "Configured API does not match this transaction's network. Check Settings, then retry",
        );
        return this.publicIntent(stored);
      }
      const details = await clients.api.getTransactionDetails(stored.txid ?? "");
      if (details.tx_status !== "success") {
        const next = stored.state === "superseded" ? stored : this.toFailed(stored, observedAt);
        this.recordObservation(next, {
          outcome: "abort",
          observedAt,
          canonical: details.canonical,
          blockHeight: details.block_height,
          indexBlockHash: null,
          detail: `Transaction failed on-chain: ${details.tx_status.replaceAll("_", " ")}. Prepare a new transaction if the action is still needed`,
        });
        return this.publicIntent(next);
      }
      if (!details.canonical || !details.block_hash) {
        this.recordUnavailable(
          stored,
          observedAt,
          "Configured API has not confirmed this transaction in a canonical block. Sidekick will retry",
        );
        return this.publicIntent(stored);
      }
      const block = await clients.api.getBlock(details.block_hash);
      if (
        !block.canonical ||
        block.hash !== details.block_hash ||
        block.height !== details.block_height
      ) {
        this.recordUnavailable(
          stored,
          observedAt,
          "Configured API transaction and block records are not yet coherent. Sidekick will retry",
        );
        return this.publicIntent(stored);
      }
      // The API does not publish a transaction-level chain ID. The explicit API network check
      // above binds this fallback without making normal local-node verification depend on it.
      const verified = this.verifyApiIndexedTransaction(stored, manifest, details, observedAt);
      if (!verified) return this.publicIntent(this.requireStored(stored.id));
      return await this.refreshIndexed(
        stored,
        manifest,
        {
          txid: details.tx_id,
          transactionHex: "",
          nonce: 0n,
          feeUstx: 0n,
          indexBlockHash: block.index_block_hash,
          blockHeight: BigInt(block.height),
          isCanonical: true,
          resultRepr: "",
        },
        observedAt,
        clients,
        verified,
      );
    } catch (error) {
      if (error instanceof UpstreamHttpError && error.status === 404) return null;
      this.recordUnavailable(
        stored,
        observedAt,
        `Configured API transaction lookup is unavailable: ${error instanceof Error ? error.message : "the API returned no diagnostic detail"}. Sidekick will retry`,
      );
      return this.publicIntent(stored);
    }
  }

  private verifyApiIndexedTransaction(
    stored: StoredWalletIntent,
    manifest: StoredManifest,
    details: Awaited<ReturnType<WalletRuntimeClients["api"]["getTransactionDetails"]>>,
    observedAt: string,
  ): VerifiedWalletTransaction | null {
    const fail = (detail: string) => {
      const next = stored.state === "superseded" ? stored : this.toFailed(stored, observedAt);
      this.recordObservation(next, {
        outcome: "mismatch",
        observedAt,
        canonical: null,
        blockHeight: null,
        indexBlockHash: null,
        detail: `Configured API transaction does not match the prepared request (${detail})`,
      });
      return null;
    };
    if (details.tx_id !== stored.txid) return fail("transaction ID");
    if (details.sender_address !== manifest.requiredSender) return fail("sender");
    if (details.sponsored) return fail("sponsored authorization");
    if (details.anchor_mode !== "any") return fail("anchor mode");
    if (details.post_condition_mode !== "deny") return fail("post-condition mode");
    if (manifest.transaction.method === "stx_deployContract") {
      if (details.tx_type !== "smart_contract") return fail("transaction type");
      return {
        txid: details.tx_id,
        sender: details.sender_address,
        chainId: manifest.chainId,
        transactionVersion: createWalletTransactionNetworkBinding(
          manifest.network,
          manifest.chainId,
        ).transactionVersion,
        sponsored: false,
        anchorMode: "any",
        postConditionMode: "deny",
        postConditionCount: details.post_conditions.length,
        payload: {
          kind: "deploy-contract",
          contractName: manifest.transaction.params.name,
          clarityVersion: manifest.transaction.params.clarityVersion,
          sourceSha256: textSha256(manifest.transaction.params.clarityCode),
        },
      };
    }
    const call = details.contract_call;
    const expected = manifest.transaction.params;
    if (
      details.tx_type !== "contract_call" ||
      !call ||
      call.contract_id !== expected.contract ||
      call.function_name !== expected.functionName ||
      JSON.stringify(call.function_args.map(({ hex }) => hex.toLowerCase())) !==
        JSON.stringify(expected.functionArgs.map((hex) => hex.toLowerCase())) ||
      details.post_conditions.length !== expected.postConditions.length
    ) {
      return fail("contract call");
    }
    const signerKey =
      expected.functionName === "register-self"
        ? (() => {
            const value = hexToCV(expected.functionArgs[1] ?? "");
            return value.type === ClarityType.Buffer ? value.value : null;
          })()
        : null;
    return {
      txid: details.tx_id,
      sender: details.sender_address,
      chainId: manifest.chainId,
      transactionVersion: createWalletTransactionNetworkBinding(manifest.network, manifest.chainId)
        .transactionVersion,
      sponsored: false,
      anchorMode: "any",
      postConditionMode: "deny",
      postConditionCount: details.post_conditions.length,
      payload: {
        kind: "call-contract",
        contract: expected.contract,
        functionName: expected.functionName,
        argumentsSha256: textSha256(
          JSON.stringify(expected.functionArgs.map((hex) => hex.toLowerCase())),
        ),
        signerKeyHex: signerKey,
      },
    };
  }

  private refreshPending(
    stored: StoredWalletIntent,
    manifest: StoredManifest,
    pending: UnconfirmedTransactionObservation,
    observedAt: string,
  ): BrowserWalletIntent {
    const decoded = this.verifyObserved(stored, manifest, pending.transactionHex, observedAt);
    if (!decoded) return this.publicIntent(this.requireStored(stored.id));
    let next = stored;
    if (next.state !== "superseded") {
      if (["confirmed", "complete", "failed"].includes(next.state)) {
        next = this.transition(next, "reobserve", observedAt);
      }
      next = this.transition(next, "mempool", observedAt);
    }
    this.recordObservation(
      next,
      {
        outcome: "mempool",
        observedAt,
        canonical: null,
        blockHeight: null,
        indexBlockHash: null,
        detail:
          pending.location.kind === "mempool"
            ? "Transaction is pending in the node mempool"
            : "Transaction is pending in a microblock",
      },
      decoded,
    );
    return this.publicIntent(next);
  }

  private verifyObserved(
    stored: StoredWalletIntent,
    manifest: StoredManifest,
    transactionHex: string,
    observedAt: string,
  ): ReturnType<typeof verifyWalletTransactionHex> | null {
    try {
      return verifyWalletTransactionHex({
        expectedTxid: stored.txid ?? "",
        requiredSender: manifest.requiredSender,
        request: manifest.transaction,
        transactionHex,
        expectedNetwork: createWalletTransactionNetworkBinding(manifest.network, manifest.chainId),
      });
    } catch (error) {
      if (!(error instanceof WalletTransactionMismatchError)) throw error;
      const next = stored.state === "superseded" ? stored : this.toFailed(stored, observedAt);
      this.recordObservation(next, {
        outcome: "mismatch",
        observedAt,
        canonical: null,
        blockHeight: null,
        indexBlockHash: null,
        detail: error.message,
      });
      return null;
    }
  }

  private async reconcileSuperseded(
    facts: EquivalentIntentFacts,
    observedAt: string,
  ): Promise<StoredWalletIntent | null> {
    const candidates = this.options.store.walletIntents
      .listSubmittedEquivalent({
        action: facts.action,
        scope: facts.scope,
        factsSha256: facts.factsSha256,
      })
      .filter((intent) => intent.state === "superseded");
    for (const candidate of candidates) {
      const refreshed = await this.refreshStored(candidate, observedAt);
      if (refreshed.verification?.outcome === "complete" && refreshed.verification.canonical) {
        this.resolveEquivalentCompletion(candidate.id, observedAt);
        return this.requireStored(candidate.id);
      }
    }
    return null;
  }

  private async reconcileHistoricalScope(
    action: RecurringWalletIntentAction,
    scope: string,
    _factsSha256: string,
    observedAt: string,
    ignoredId?: string,
  ): Promise<StoredWalletIntent | null> {
    const candidates = this.options.store.walletIntents
      .listSubmittedScope({ action, scope })
      .filter(
        (intent) => ["failed", "superseded"].includes(intent.state) && intent.id !== ignoredId,
      );
    for (const input of candidates) {
      const candidate =
        input.state === "failed" ? this.retireFailedIntent(input, observedAt) : input;
      const refreshed = await this.refreshStored(candidate, observedAt);
      const verification = this.latestVerification(candidate.id) ?? refreshed.verification;
      const completedPriorAction = this.hasCanonicalExecution(candidate.id, action);
      if (
        verification &&
        historicalScopeBlockers.has(verification.outcome) &&
        !completedPriorAction
      ) {
        return this.requireStored(candidate.id);
      }
      if (
        verification?.outcome === "not-found" &&
        candidate.submittedAt &&
        Date.parse(observedAt) < Date.parse(candidate.submittedAt) + replacementGraceMs
      ) {
        return this.requireStored(candidate.id);
      }
    }
    return null;
  }

  private latestVerification(intentId: string): z.infer<typeof publicVerificationSchema> | null {
    const latest = this.options.store.walletIntents.latestObservation(intentId);
    const evidence = latest ? observationEvidenceSchema.safeParse(latest.evidence) : null;
    return evidence?.success ? evidence.data.verification : null;
  }

  private hasCanonicalExecution(intentId: string, action: BrowserWalletIntentAction): boolean {
    const observation = this.options.store.walletIntents.latestObservation(intentId, {
      excludeOutcomes: ["superseded"],
    });
    const evidence = observation ? observationEvidenceSchema.safeParse(observation.evidence) : null;
    const currentCanonicalExecution = Boolean(
      observation &&
        (observation.outcome === "complete" || observation.outcome === "canonical-success") &&
        observation.canonical === true &&
        evidence?.success &&
        (evidence.data.verification.outcome === "complete" ||
          evidence.data.verification.outcome === "canonical-success") &&
        evidence.data.verification.canonical === true,
    );
    if (!currentCanonicalExecution) return false;
    if (
      observation?.outcome === "complete" ||
      action === "withdraw-fees" ||
      action === "sweep-fee-refunds"
    ) {
      return true;
    }
    return this.options.store.walletIntents.listObservations(intentId).some((candidate) => {
      const candidateEvidence = observationEvidenceSchema.safeParse(candidate.evidence);
      return (
        candidate.outcome === "complete" &&
        candidate.canonical === true &&
        candidateEvidence.success &&
        candidateEvidence.data.verification.outcome === "complete" &&
        candidateEvidence.data.verification.canonical === true
      );
    });
  }

  private retireFailedIntent(stored: StoredWalletIntent, observedAt: string): StoredWalletIntent {
    const superseded = this.transition(stored, "superseded", observedAt);
    this.recordObservation(superseded, {
      outcome: "superseded",
      observedAt,
      canonical: null,
      blockHeight: null,
      indexBlockHash: null,
      detail: "Failed transaction retired before preparing a replacement",
    });
    return superseded;
  }

  private resolveEquivalentCompletion(winnerId: string, observedAt: string): void {
    const displaced = this.options.store.walletIntents.supersedeActiveEquivalent({
      winnerId,
      updatedAt: observedAt,
    });
    for (const intent of displaced) {
      this.recordObservation(intent, {
        outcome: "superseded",
        observedAt,
        canonical: null,
        blockHeight: null,
        indexBlockHash: null,
        detail: "An earlier equivalent transaction completed on-chain",
      });
    }
  }

  private publicIntent(stored: StoredWalletIntent): BrowserWalletIntent {
    const manifest = this.parseStoredManifest(stored);
    const latest = this.options.store.walletIntents.latestObservation(stored.id);
    const priorConclusion =
      stored.state === "superseded" && latest?.outcome === "unavailable"
        ? this.options.store.walletIntents.latestObservation(stored.id, {
            excludeOutcomes: ["unavailable"],
          })
        : null;
    const effective =
      priorConclusion?.outcome === "complete" && priorConclusion.canonical
        ? priorConclusion
        : latest;
    const evidence = effective ? observationEvidenceSchema.safeParse(effective.evidence) : null;
    const verification = evidence?.success ? evidence.data.verification : null;
    return browserWalletIntentSchema.parse({
      ...manifest,
      seal: { ...manifest.seal, manifestSha256: stored.manifestSha256 },
      status:
        stored.state === "superseded" && verification?.outcome === "complete"
          ? "complete"
          : stored.state,
      txid: stored.txid,
      verification,
    });
  }

  private parseStoredManifest(stored: StoredWalletIntent): StoredManifest {
    const manifest = storedManifestSchema.safeParse(stored.manifest);
    if (
      !manifest.success ||
      manifest.data.id !== stored.id ||
      manifest.data.action !== stored.action ||
      manifest.data.seal.factsSha256 !== stored.factsSha256 ||
      canonicalJsonSha256(manifest.data) !== stored.manifestSha256
    ) {
      throw new WalletIntentError(
        "wallet_intent_invalid",
        "Stored transaction request failed its integrity check. Prepare a new transaction",
      );
    }
    return manifest.data;
  }

  private requireStored(id: string): StoredWalletIntent {
    const stored = this.options.store.walletIntents.get(z.uuid().parse(id));
    if (!stored) {
      throw new WalletIntentError("wallet_intent_not_found", "Wallet intent not found");
    }
    return stored;
  }

  private transition(
    stored: StoredWalletIntent,
    state: BrowserWalletIntentStatus,
    observedAt: string,
  ): StoredWalletIntent {
    if (stored.state === state) return stored;
    try {
      return this.options.store.walletIntents.transition({
        id: stored.id,
        fromStates: [stored.state],
        toState: state,
        updatedAt: observedAt,
      });
    } catch (error) {
      return asIntentError(error);
    }
  }

  private toConfirmed(stored: StoredWalletIntent, observedAt: string): StoredWalletIntent {
    const current =
      stored.state === "failed" ? this.transition(stored, "reobserve", observedAt) : stored;
    return this.transition(current, "confirmed", observedAt);
  }

  private toFailed(stored: StoredWalletIntent, observedAt: string): StoredWalletIntent {
    const current =
      stored.state === "complete" ? this.transition(stored, "reobserve", observedAt) : stored;
    return this.transition(current, "failed", observedAt);
  }

  private recordObservation(
    stored: StoredWalletIntent,
    verification: z.infer<typeof publicVerificationSchema>,
    decoded: unknown = null,
  ): void {
    const previous = this.options.store.walletIntents.latestObservation(stored.id);
    const previousEvidence = previous
      ? observationEvidenceSchema.safeParse(previous.evidence)
      : null;
    const fingerprint = (value: z.infer<typeof publicVerificationSchema>, decodedValue: unknown) =>
      canonicalJsonSha256({
        outcome: value.outcome,
        canonical: value.canonical,
        blockHeight: value.blockHeight,
        indexBlockHash: value.indexBlockHash,
        detail: value.detail,
        decoded: decodedValue,
      });
    if (
      previousEvidence?.success &&
      fingerprint(previousEvidence.data.verification, previousEvidence.data.decoded) ===
        fingerprint(verification, decoded)
    ) {
      return;
    }
    this.options.store.walletIntents.appendObservation({
      intentId: stored.id,
      outcome: verification.outcome,
      canonical: verification.canonical,
      blockHeight: verification.blockHeight,
      indexBlockHash: verification.indexBlockHash,
      evidence: { schemaVersion: 1, verification, decoded },
      observedAt: verification.observedAt,
    });
  }

  private recordUnavailable(stored: StoredWalletIntent, observedAt: string, detail: string): void {
    this.recordObservation(stored, {
      outcome: "unavailable",
      observedAt,
      canonical: null,
      blockHeight: null,
      indexBlockHash: null,
      detail,
    });
  }
}
