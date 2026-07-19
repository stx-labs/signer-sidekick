import { createHash, randomUUID } from "node:crypto";
import {
  boolCV,
  bufferCV,
  ClarityType,
  cvToHex,
  Pc,
  postConditionToHex,
  principalCV,
  tupleCV,
  uintCV,
  validateStacksAddress,
} from "@stacks/transactions";
import {
  type BrowserWalletIntent,
  type BrowserWalletIntentAction,
  type BrowserWalletIntentNetwork,
  type BrowserWalletIntentRequest,
  type BrowserWalletIntentStatus,
  type BrowserWalletTransaction,
  browserWalletIntentCreateRequestSchema,
  browserWalletIntentSchema,
  browserWalletTransactionSchema,
  onboardingBrowserWalletIntentCreateRequestSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import {
  decodeBoolean,
  decodeResponseOk,
  decodeUInt,
  encodePrincipalHex,
  encodeUIntHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import {
  canonicalizeClaritySource,
  claritySourceSha256,
} from "@stx-labs/signer-sidekick-protocol/manager-adapter";
import { managerArtifactFromNetworkProfile } from "@stx-labs/signer-sidekick-protocol/network-manager-artifact";
import { validatePrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import { UpstreamHttpError } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import {
  type ManagerDeploymentManifest,
  managerDeploymentManifestSchema,
} from "./manager-render.js";
import type { ManagerVerificationContext } from "./manager-verification.js";
import {
  compatibilityProfileByIdentity,
  loadNetworkCompatibilityProfiles,
} from "./network-compatibility-store.js";
import {
  createWalletTransactionNetworkBinding,
  defaultPrivateChainId,
  mainnetChainId,
  mainnetWalletNetwork,
  pox5TestnetChainId,
  pox5TestnetWalletNetwork,
  verifyWalletTransactionHex,
  WalletTransactionMismatchError,
  type WalletTransactionNetworkBinding,
} from "./onboarding-wallet-verification.js";
import { type PreflightResult, runOperatorPreflight } from "./preflight.js";
import type { RuntimeSettingsController } from "./runtime-settings.js";
import { readSetupSnapshot, type SetupSnapshot } from "./setup-snapshot.js";
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
  readManagerClaimWalletIntent,
} from "./transaction-engine/manager-claim-wallet-intent.js";

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

const walletIntentRequestSchema = z.union([
  onboardingBrowserWalletIntentCreateRequestSchema,
  browserWalletIntentCreateRequestSchema,
]);

function transactionMatchesAction(
  action: BrowserWalletIntentAction,
  transaction: BrowserWalletTransaction,
): boolean {
  if (action === "deploy-manager") return transaction.method === "stx_deployContract";
  if (transaction.method !== "stx_callContract") return false;
  const expectedFunction =
    action === "add-admin" || action === "remove-admin" ? "update-admin" : action;
  return transaction.params.functionName === expectedFunction;
}

function walletNetworkChecksPass(snapshot: SetupSnapshot, chainId: number): boolean {
  return (
    snapshot.preflight.node.networkId === chainId &&
    ["node-network", "api-network"].every((id) =>
      snapshot.preflight.checks.some((check) => check.id === id && check.status === "pass"),
    )
  );
}

type WalletRuntimeClients = ReturnType<RuntimeSettingsController["clients"]>;

const storedManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.uuid(),
    action: z.enum([
      "deploy-manager",
      "register-self",
      "add-admin",
      "remove-admin",
      "update-fees",
      "withdraw-fees",
      "sweep-fee-refunds",
      "claim-rewards",
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
    if (!transactionMatchesAction(value.action, value.transaction)) {
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

export interface WalletFreshState {
  managerPrincipal: string;
  freshInput: null | { adminPrincipal: string; authId: string };
  managerArtifact: null | { source: string; manifest: ManagerDeploymentManifest };
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
  action: BrowserWalletIntentAction;
  scope: string;
  factsSha256: string;
}

export class OnboardingWalletIntentError extends Error {
  constructor(
    readonly code:
      | "wallet_execution_unavailable"
      | "wallet_intent_not_found"
      | "wallet_intent_invalid"
      | "wallet_intent_conflict"
      | "wallet_intent_expired"
      | "wallet_transaction_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "OnboardingWalletIntentError";
  }
}

function asIntentError(error: unknown): never {
  if (error instanceof OnboardingWalletIntentError) throw error;
  if (error instanceof WalletIntentRepositoryError) {
    const code = error.code === "expired" ? "wallet_intent_expired" : "wallet_intent_conflict";
    throw new OnboardingWalletIntentError(code, error.message);
  }
  throw error;
}

function nowPlusLifetime(observedAt: string): string {
  const milliseconds = Date.parse(observedAt);
  if (!Number.isFinite(milliseconds)) {
    throw new OnboardingWalletIntentError("wallet_intent_invalid", "Invalid observation time");
  }
  return new Date(milliseconds + intentLifetimeMs).toISOString();
}

function normalizedTxid(txid: string): `0x${string}` {
  const value = txid.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new OnboardingWalletIntentError("wallet_intent_invalid", "Invalid transaction ID");
  }
  return value as `0x${string}`;
}

function textSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class OnboardingWalletIntentService {
  constructor(
    private readonly options: {
      store: SidekickStore;
      runtimeSettings: RuntimeSettingsController;
      managerVerification?: ManagerVerificationContext;
      readFreshState: () => WalletFreshState;
      readWalletState?: () => WalletFreshState;
      transactionEngineRequestedMode?: "observe" | "assist";
      observeManagerClaimWalletJob?: (
        jobId: string,
      ) => Promise<ManagerClaimWalletAuthoritativeObservation>;
      readerFactory?: (nodeRpcUrl: string) => WalletReader;
    },
  ) {}

  async prepare(
    requestInput: BrowserWalletIntentRequest | BrowserWalletIntentAction,
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
              action !== "deploy-manager" &&
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
            action !== "deploy-manager" &&
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
    throw new OnboardingWalletIntentError(
      "wallet_intent_conflict",
      "Setup state changed while preparing the wallet request; review it and try again",
    );
  }

  get(id: string): BrowserWalletIntent {
    const stored = this.options.store.walletIntents.get(z.uuid().parse(id));
    if (!stored) {
      throw new OnboardingWalletIntentError("wallet_intent_not_found", "Wallet intent not found");
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
          detail: "Wallet reported the transaction ID; independent chain verification is pending",
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
    if (initial.state === "prepared") {
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
          detail: "An earlier transaction for this action may still take effect",
        });
        return this.publicIntent(superseded);
      }
    } else if (initial.state !== "superseded") {
      const completed = await this.reconcileSuperseded(initial, observedAt);
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
        if (!(error instanceof OnboardingWalletIntentError)) throw error;
        const superseded = this.transition(stored, "superseded", observedAt);
        this.recordObservation(superseded, {
          outcome: "superseded",
          observedAt,
          canonical: null,
          blockHeight: null,
          indexBlockHash: null,
          detail: "The authoritative setup state is no longer valid for this wallet request",
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
          detail: "Authoritative setup facts changed before wallet signing",
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
        `Network-bound verification is unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
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
    if (indexed.status !== "not-found") {
      this.recordUnavailable(stored, observedAt, `Indexed transaction lookup: ${indexed.reason}`);
      return this.publicIntent(stored);
    }

    const pending = await reader.lookupUnconfirmedTransaction(stored.txid);
    if (pending.status === "observed") {
      return this.refreshPending(stored, manifest, pending.value, observedAt);
    }
    if (pending.status !== "not-found") {
      this.recordUnavailable(stored, observedAt, `Pending transaction lookup: ${pending.reason}`);
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
      detail: "Transaction is not currently indexed or pending",
    });
    return this.publicIntent(stored);
  }

  async replace(id: string, observedAt = new Date().toISOString()): Promise<BrowserWalletIntent> {
    const before = this.requireStored(id);
    if (before.state !== "reobserve" || !before.submittedAt) {
      throw new OnboardingWalletIntentError(
        "wallet_intent_conflict",
        "Only a submitted transaction awaiting reobservation can be replaced",
      );
    }
    if (Date.parse(observedAt) < Date.parse(before.submittedAt) + replacementGraceMs) {
      throw new OnboardingWalletIntentError(
        "wallet_intent_conflict",
        "Wait at least 15 minutes after submission before replacing a transaction",
      );
    }
    const refreshed = await this.refresh(id, observedAt);
    if (refreshed.status !== "reobserve" || refreshed.verification?.outcome !== "not-found") {
      throw new OnboardingWalletIntentError(
        "wallet_intent_conflict",
        "The transaction must be absent from both indexed and pending node state before replacement",
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
      detail: "Operator requested a replacement after the transaction remained absent",
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
    input: BrowserWalletIntentRequest | BrowserWalletIntentAction,
  ): BrowserWalletIntentRequest {
    if (typeof input === "string") {
      return onboardingBrowserWalletIntentCreateRequestSchema.parse({ action: input });
    }
    return walletIntentRequestSchema.parse(input);
  }

  private requestFromManifest(manifest: StoredManifest): BrowserWalletIntentRequest {
    if (manifest.schemaVersion === 2) return manifest.request;
    return manifest.action === "deploy-manager"
      ? { action: "deploy-manager" }
      : { action: "register-self" };
  }

  private readFreshState(): WalletFreshState {
    try {
      return this.options.readFreshState();
    } catch {
      throw new OnboardingWalletIntentError(
        "wallet_intent_invalid",
        "Fresh onboarding state is no longer active",
      );
    }
  }

  private readWalletState(): WalletFreshState {
    try {
      return (this.options.readWalletState ?? this.options.readFreshState)();
    } catch {
      throw new OnboardingWalletIntentError(
        "wallet_intent_invalid",
        "Manager state is unavailable; attach or complete setup before preparing this action",
      );
    }
  }

  private freshStateSha256(action: BrowserWalletIntentAction, fresh: WalletFreshState): string {
    return canonicalJsonSha256({
      action,
      managerPrincipal: fresh.managerPrincipal,
      freshInput: fresh.freshInput,
      managerArtifact: fresh.managerArtifact,
      signerGrant: action === "register-self" ? fresh.signerGrant.verified : null,
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
      throw new Error("the current Sidekick network no longer matches the sealed wallet intent");
    }
    const [nodeInfo, apiInfo] = await Promise.all([
      clients.node.getInfo(),
      clients.api.getNodeInfo(),
    ]);
    if (nodeInfo.network_id !== manifest.chainId || apiInfo.network_id !== manifest.chainId) {
      throw new Error("the configured node and API do not match the sealed wallet chain ID");
    }
  }

  private assertTrustedManager(
    snapshot: SetupSnapshot,
    managerPrincipal: string,
    network: WalletTransactionNetworkBinding,
  ): void {
    const trustedTier =
      snapshot.manager.source.tier === "reference-built-in" ||
      snapshot.manager.source.tier === "reference-render";
    if (
      snapshot.manager.managerPrincipal !== managerPrincipal ||
      !snapshot.manager.attachAllowed ||
      !snapshot.manager.source.recognized ||
      !trustedTier ||
      !walletNetworkChecksPass(snapshot, network.chainId) ||
      snapshot.preflight.compatibility.status !== "matched" ||
      snapshot.manager.source.profileId !== snapshot.preflight.compatibility.managerProfileId ||
      snapshot.manager.source.sha256 !== snapshot.preflight.compatibility.managerSourceSha256
    ) {
      throw new OnboardingWalletIntentError(
        "wallet_execution_unavailable",
        "This operation requires a verified reference manager/profile on the matched live network",
      );
    }
  }

  private assertManagerActionTarget(
    snapshot: SetupSnapshot,
    managerPrincipal: string,
    network: WalletTransactionNetworkBinding,
  ): void {
    if (
      snapshot.manager.managerPrincipal !== managerPrincipal ||
      !snapshot.manager.attachAllowed ||
      !walletNetworkChecksPass(snapshot, network.chainId)
    ) {
      throw new OnboardingWalletIntentError(
        "wallet_execution_unavailable",
        "Wallet actions require the configured manager to expose the supported interface on the live network",
      );
    }
  }

  private async assertTrustedSavedManagerArtifact(
    state: WalletFreshState,
    config: SidekickConfig,
    preflight: PreflightResult,
    network: WalletTransactionNetworkBinding,
  ): Promise<ManagerDeploymentManifest> {
    if (!state.freshInput || !state.managerArtifact) {
      throw new OnboardingWalletIntentError(
        "wallet_intent_invalid",
        "The reviewed manager artifact is unavailable",
      );
    }
    const parsedManifest = managerDeploymentManifestSchema.safeParse(
      state.managerArtifact.manifest,
    );
    if (!parsedManifest.success) {
      throw new OnboardingWalletIntentError(
        "wallet_intent_conflict",
        "The saved manager deployment manifest failed strict validation",
      );
    }
    const manifest = parsedManifest.data;
    let canonicalSourceSha256: string;
    try {
      canonicalSourceSha256 = claritySourceSha256(
        canonicalizeClaritySource(state.managerArtifact.source),
      );
    } catch {
      throw new OnboardingWalletIntentError(
        "wallet_intent_conflict",
        "The saved manager source cannot be canonicalized safely",
      );
    }
    const sourceSha256 = claritySourceSha256(state.managerArtifact.source);
    if (
      sourceSha256 !== manifest.artifact.sourceSha256 ||
      canonicalSourceSha256 !== manifest.artifact.canonicalSourceSha256
    ) {
      throw new OnboardingWalletIntentError(
        "wallet_intent_conflict",
        "The saved manager source does not match its reviewed manifest hashes",
      );
    }
    if (
      preflight.compatibility.status !== "matched" ||
      preflight.node.networkId !== network.chainId
    ) {
      throw new OnboardingWalletIntentError(
        "wallet_execution_unavailable",
        "The live network no longer matches a supported compatibility profile",
      );
    }
    const compatibilityStore = await loadNetworkCompatibilityProfiles({
      ...(config.compatibilityProfilesDirectory
        ? { directory: config.compatibilityProfilesDirectory }
        : {}),
    });
    const loaded = compatibilityProfileByIdentity(
      compatibilityStore,
      preflight.compatibility.profileId,
      preflight.compatibility.profileRevision,
    );
    if (!loaded) {
      throw new OnboardingWalletIntentError(
        "wallet_execution_unavailable",
        "The currently matched network compatibility profile is unavailable",
      );
    }
    const profile = loaded.profile;
    const reviewed = managerArtifactFromNetworkProfile(profile);
    if (
      profile.network !== config.network ||
      profile.networkId !== network.chainId ||
      preflight.compatibility.managerProfileId !== reviewed.profile.id ||
      preflight.compatibility.managerSourceSha256 !== reviewed.sourceSha256 ||
      preflight.pox.pox5ContractId !== profile.pox5.contractId ||
      preflight.pox.sbtcTokenContract !== profile.sbtc.tokenContract
    ) {
      throw new OnboardingWalletIntentError(
        "wallet_execution_unavailable",
        "The live network facts do not match the selected compatibility profile",
      );
    }
    const contractName = manifest.transaction.contractName;
    const expectedBinding = {
      schemaVersion: 1,
      network: config.network,
      adminPrincipal: state.freshInput.adminPrincipal,
      managerPrincipal: state.managerPrincipal,
      profile: {
        id: reviewed.profile.id,
        upstreamTag: reviewed.profile.upstream.tag,
        upstreamCommit: reviewed.profile.upstream.commit,
        compatibilityProfileId: profile.id,
        compatibilityProfileRevision: profile.revision,
      },
      contracts: reviewed.profile.contracts,
      artifact: {
        sourceFile: `${contractName}.clar`,
        sourceSha256: reviewed.sourceSha256,
        canonicalSourceSha256: reviewed.canonicalSha256,
        replacements: reviewed.profile.expectedReplacements,
      },
      transaction: {
        type: "smart-contract-deploy",
        contractName,
        clarityVersion: 6,
        anchorMode: "any",
        postConditionMode: "deny",
        signingAuthority: "external-offline-admin",
      },
    };
    const actualBinding = {
      schemaVersion: manifest.schemaVersion,
      network: manifest.network,
      adminPrincipal: manifest.adminPrincipal,
      managerPrincipal: manifest.managerPrincipal,
      profile: manifest.profile,
      contracts: manifest.contracts,
      artifact: manifest.artifact,
      transaction: manifest.transaction,
    };
    if (
      manifest.managerPrincipal !== `${manifest.adminPrincipal}.${contractName}` ||
      canonicalJsonSha256(actualBinding) !== canonicalJsonSha256(expectedBinding)
    ) {
      throw new OnboardingWalletIntentError(
        "wallet_intent_conflict",
        "The saved manager artifact is not the exact artifact for the current compatibility profile",
      );
    }
    return manifest;
  }

  private assertActionPrincipal(principal: string, network: BrowserWalletIntentNetwork): void {
    if (!validatePrincipal(principal)) {
      throw new OnboardingWalletIntentError("wallet_intent_invalid", "Invalid Stacks principal");
    }
    const address = principal.split(".", 1)[0] ?? "";
    const isMainnet = address.startsWith("SP") || address.startsWith("SM");
    if (isMainnet !== (network === "mainnet")) {
      throw new OnboardingWalletIntentError(
        "wallet_intent_invalid",
        "The action principal does not match the configured network",
      );
    }
  }

  private async authoritativeFacts(
    request: BrowserWalletIntentRequest,
  ): Promise<AuthoritativeIntentFacts> {
    const action = request.action;
    const { config, node, api } = this.options.runtimeSettings.clients();
    const network = this.walletNetwork(config);
    const setupRequest = !("actorPrincipal" in request);
    const state = setupRequest ? this.readFreshState() : this.readWalletState();
    const stateSha256 = this.freshStateSha256(action, state);
    const assertStateUnchanged = () => {
      const latest = setupRequest ? this.readFreshState() : this.readWalletState();
      if (this.freshStateSha256(action, latest) !== stateSha256) {
        throw new OnboardingWalletIntentError(
          "wallet_intent_conflict",
          "Manager or signer-grant state changed while validating the wallet request",
        );
      }
    };

    if (action === "deploy-manager") {
      if (!state.freshInput || !state.managerArtifact) {
        throw new OnboardingWalletIntentError(
          "wallet_intent_invalid",
          "Prepare the fresh manager artifact before creating a deployment intent",
        );
      }
      const artifact = state.managerArtifact;
      const preflight = await runOperatorPreflight(config, node, api);
      const manifest = await this.assertTrustedSavedManagerArtifact(
        state,
        config,
        preflight,
        network,
      );
      try {
        await node.getContractSource(state.managerPrincipal);
      } catch (error) {
        if (!(error instanceof UpstreamHttpError) || error.status !== 404) throw error;
        assertStateUnchanged();
        return {
          scope: state.managerPrincipal,
          requiredSender: state.freshInput.adminPrincipal,
          network: network.network,
          chainId: network.chainId,
          facts: {
            schemaVersion: 2,
            request,
            managerPrincipal: state.managerPrincipal,
            profile: manifest.profile,
            sourceSha256: manifest.artifact.sourceSha256,
            canonicalSourceSha256: manifest.artifact.canonicalSourceSha256,
            transaction: manifest.transaction,
          },
          transaction: {
            method: "stx_deployContract",
            params: {
              name: manifest.transaction.contractName,
              clarityCode: artifact.source,
              clarityVersion: 6,
              network: network.network,
              address: state.freshInput.adminPrincipal,
              sponsored: false,
              postConditionMode: "deny",
              postConditions: [],
            },
          },
          review: {
            title: "Deploy the reviewed signer manager",
            summary: `Deploy ${state.managerPrincipal} using the exact reviewed Clarity 6 source.`,
            expectedPostState:
              "The exact reviewed manager source is canonical on the bound network.",
            fields: [
              { label: "Manager", value: state.managerPrincipal },
              { label: "Sender", value: state.freshInput.adminPrincipal },
              { label: "Network", value: network.network },
              { label: "Source SHA-256", value: manifest.artifact.sourceSha256 },
            ],
          },
        };
      }
      assertStateUnchanged();
      throw new OnboardingWalletIntentError(
        "wallet_intent_invalid",
        "The signer manager contract is already deployed",
      );
    }

    const managerPrincipal = state.managerPrincipal;
    const snapshot = await readSetupSnapshot({
      config,
      node,
      api,
      managerPrincipal,
      managerVerification: this.options.managerVerification,
      reportMissingManager: true,
    });
    if (snapshot.preflight.node.networkId !== network.chainId) {
      throw new OnboardingWalletIntentError(
        "wallet_execution_unavailable",
        "The live node chain ID does not match the wallet network",
      );
    }
    if (setupRequest && state.managerArtifact) {
      this.assertTrustedManager(snapshot, managerPrincipal, network);
      const manifest = await this.assertTrustedSavedManagerArtifact(
        state,
        config,
        snapshot.preflight,
        network,
      );
      if (
        !snapshot.manager.attachAllowed ||
        snapshot.manager.source.sha256 !== manifest.artifact.sourceSha256 ||
        snapshot.manager.source.canonicalSha256 !== manifest.artifact.canonicalSourceSha256
      ) {
        throw new OnboardingWalletIntentError(
          "wallet_intent_invalid",
          "The exact reviewed manager deployment must be canonical before registration",
        );
      }
    } else if (setupRequest || action === "claim-rewards") {
      this.assertTrustedManager(snapshot, managerPrincipal, network);
    } else {
      this.assertManagerActionTarget(snapshot, managerPrincipal, network);
    }
    if (action === "register-self") {
      const verified = state.signerGrant.verified;
      if (!verified) {
        throw new OnboardingWalletIntentError(
          "wallet_intent_invalid",
          "Prepare and verify a new signer grant before registration",
        );
      }
      if (
        snapshot.registration?.registered &&
        snapshot.registration.signerKeyHex === verified.signerKeyHex &&
        snapshot.registration.signerKeyGrantValid
      ) {
        throw new OnboardingWalletIntentError(
          "wallet_intent_invalid",
          "The exact signer key is already registered with a valid grant",
        );
      }
    }

    const actorPrincipal =
      "actorPrincipal" in request ? request.actorPrincipal : state.freshInput?.adminPrincipal;
    if (!actorPrincipal || !validateStacksAddress(actorPrincipal)) {
      throw new OnboardingWalletIntentError(
        "wallet_intent_invalid",
        "Wallet actions require a valid standard-principal actor",
      );
    }
    this.assertActionPrincipal(actorPrincipal, network.network);
    const readOptions = snapshot.chainAnchor?.indexBlockHash
      ? { tip: snapshot.chainAnchor.indexBlockHash }
      : undefined;
    if (action === "claim-rewards") {
      const profileId = snapshot.manager.source.profileId;
      if (!profileId) {
        throw new OnboardingWalletIntentError(
          "wallet_execution_unavailable",
          "The trusted manager profile is unavailable for this claim job",
        );
      }
      try {
        const observation = await this.options.observeManagerClaimWalletJob?.(request.jobId);
        if (!observation) {
          throw new ManagerClaimWalletIntentError(
            "unavailable",
            "The transaction engine cannot refresh this manager-claim job",
          );
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
        if (error instanceof OnboardingWalletIntentError) throw error;
        if (error instanceof ManagerClaimWalletIntentError) {
          throw new OnboardingWalletIntentError(
            error.code === "unavailable"
              ? "wallet_execution_unavailable"
              : "wallet_intent_conflict",
            error.message,
          );
        }
        const staleSelection =
          error instanceof Error &&
          error.message ===
            "The selected manager-claim job is not the current actionable observation";
        throw new OnboardingWalletIntentError(
          staleSelection ? "wallet_intent_conflict" : "wallet_execution_unavailable",
          staleSelection
            ? "The selected manager-claim job is no longer the current actionable observation"
            : "The transaction engine could not refresh current manager-claim eligibility",
        );
      }
    }
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
      throw new OnboardingWalletIntentError(
        "wallet_intent_invalid",
        "The selected wallet actor is not a current manager admin",
      );
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
        | "sweep-fee-refunds",
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
        throw new OnboardingWalletIntentError(
          "wallet_intent_invalid",
          "Prepare and verify a new signer grant before registration",
        );
      }
      if (snapshot.preflight.pox.pox5ContractId !== verified.pox5ContractId) {
        throw new OnboardingWalletIntentError(
          "wallet_intent_conflict",
          "The active PoX-5 contract changed; repeat the signer grant ceremony",
        );
      }
      if (
        snapshot.registration?.registered &&
        snapshot.registration.signerKeyHex === verified.signerKeyHex &&
        snapshot.registration.signerKeyGrantValid
      ) {
        throw new OnboardingWalletIntentError(
          "wallet_intent_invalid",
          "The exact signer key is already registered with a valid grant",
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
        throw new OnboardingWalletIntentError(
          "wallet_intent_invalid",
          "The verified signer grant has already been consumed; prepare a new grant",
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
        throw new OnboardingWalletIntentError(
          "wallet_intent_invalid",
          "Manager admins must be standard Stacks account principals",
        );
      }
      this.assertActionPrincipal(request.adminPrincipal, network.network);
      if (action === "remove-admin" && request.adminPrincipal === actorPrincipal) {
        throw new OnboardingWalletIntentError(
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
        throw new OnboardingWalletIntentError(
          "wallet_intent_invalid",
          enabled
            ? "The target principal is already an admin"
            : "The target principal is not an admin",
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
        throw new OnboardingWalletIntentError(
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
      throw new OnboardingWalletIntentError(
        "wallet_execution_unavailable",
        "The matched network does not expose the trusted sBTC token contract",
      );
    }
    if (!("recipient" in request)) {
      throw new OnboardingWalletIntentError(
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
        throw new OnboardingWalletIntentError(
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
      throw new OnboardingWalletIntentError(
        "wallet_intent_invalid",
        "There are no sweepable fee refunds at the current chain position",
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
  ): Promise<BrowserWalletIntent> {
    const decoded = this.verifyObserved(stored, manifest, indexed.transactionHex, observedAt);
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
            ? "The indexed transaction does not have an anchored block height"
            : "The node reports a noncanonical transaction inclusion",
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
      const [summary, block] = await Promise.all([
        api.getTransaction(stored.txid ?? ""),
        api.getBlock(blockHeight),
      ]);
      if (
        summary.tx_id !== stored.txid ||
        summary.block.height !== blockHeight ||
        summary.block.index_hash !== indexed.indexBlockHash ||
        !block.canonical ||
        block.index_block_hash !== indexed.indexBlockHash
      ) {
        const next =
          stored.state === "superseded" ? stored : this.transition(stored, "reobserve", observedAt);
        this.recordObservation(
          next,
          {
            outcome: "noncanonical",
            observedAt,
            canonical: false,
            blockHeight,
            indexBlockHash: indexed.indexBlockHash,
            detail: "Node and API do not agree on a canonical transaction inclusion",
          },
          decoded,
        );
        return this.publicIntent(next);
      }
      if (summary.status !== "success") {
        const next = stored.state === "superseded" ? stored : this.toFailed(stored, observedAt);
        this.recordObservation(
          next,
          {
            outcome: "abort",
            observedAt,
            canonical: true,
            blockHeight,
            indexBlockHash: indexed.indexBlockHash,
            detail: `Canonical transaction ${summary.status.replaceAll("_", " ")}`,
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
          throw new OnboardingWalletIntentError(
            "wallet_intent_invalid",
            "Deployment intent contains the wrong transaction method",
          );
        }
        if (decoded.payload.kind !== "deploy-contract") {
          throw new OnboardingWalletIntentError(
            "wallet_intent_invalid",
            "Deployment verification contains the wrong decoded payload",
          );
        }
        const managerPrincipal = `${manifest.requiredSender}.${manifest.transaction.params.name}`;
        const snapshot = await readSetupSnapshot({
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
          throw new OnboardingWalletIntentError(
            "wallet_intent_invalid",
            "Contract-call intent contains the wrong transaction method",
          );
        }
        if (decoded.payload.kind !== "call-contract") {
          throw new OnboardingWalletIntentError(
            "wallet_intent_invalid",
            "Contract-call verification contains the wrong decoded payload",
          );
        }
        const managerPrincipal = manifest.transaction.params.contract;
        const request = this.requestFromManifest(manifest);
        if (manifest.action === "claim-rewards") {
          if (!("jobId" in request) || !("actorPrincipal" in request)) {
            throw new OnboardingWalletIntentError(
              "wallet_intent_invalid",
              "Manager-claim intent is missing its exact job binding",
            );
          }
          const snapshot = await readSetupSnapshot({
            config,
            node,
            api,
            managerPrincipal,
            managerVerification: this.options.managerVerification,
            reportMissingManager: true,
          });
          const walletNetwork = this.walletNetwork(config);
          this.assertTrustedManager(snapshot, managerPrincipal, walletNetwork);
          const profileId = snapshot.manager.source.profileId;
          if (!profileId) {
            throw new OnboardingWalletIntentError(
              "wallet_execution_unavailable",
              "The trusted manager profile is unavailable for claim reconciliation",
            );
          }
          const bound = readManagerClaimWalletIntent({
            repository: this.options.store.transactionEngine,
            jobId: request.jobId,
            actorPrincipal: request.actorPrincipal,
            live: {
              requestedMode: this.options.transactionEngineRequestedMode ?? "assist",
              network: {
                name: walletNetwork.network,
                kind: config.network === "mainnet" ? "mainnet" : "testnet",
                chainId: walletNetwork.chainId,
              },
              manager: {
                principal: managerPrincipal,
                profileId,
                sourceSha256: snapshot.manager.source.sha256,
              },
            },
          });
          if (
            bound.scope !== stored.scope ||
            bound.requiredSender !== stored.requiredSender ||
            canonicalJsonSha256(bound.facts) !== stored.factsSha256 ||
            canonicalJsonSha256(bound.transaction) !== canonicalJsonSha256(manifest.transaction)
          ) {
            throw new OnboardingWalletIntentError(
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
                  "The exact wallet transaction is canonical, but its bound engine job was superseded",
              },
              decoded,
            );
            return this.publicIntent(next);
          }
          complete = jobStatus === "complete";
        } else if (manifest.action === "register-self") {
          const snapshot = await readSetupSnapshot({
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
            throw new OnboardingWalletIntentError(
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
            throw new OnboardingWalletIntentError(
              "wallet_intent_invalid",
              "Fee intent is missing its target rate",
            );
          }
          complete =
            decodeUInt(await node.getDataVar(managerPrincipal, "fees-bips"), "fees-bips") ===
            BigInt(request.feeBips);
        } else {
          const snapshot = await readSetupSnapshot({
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
          customAssetSemanticsUnattested = !verifiedReferenceManager;
          complete = decoded.postConditionCount === 1 && verifiedReferenceManager;
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
            ? "Canonical transaction and exact expected on-chain state are verified"
            : customAssetSemanticsUnattested && decoded.postConditionCount === 1
              ? "Canonical exact call and asset/amount postcondition are verified; custom manager recipient and state semantics are not attested"
              : "Canonical success is verified; the expected on-chain state is not yet visible",
        },
        decoded,
      );
      return this.publicIntent(next);
    } catch (error) {
      const current = this.requireStored(stored.id);
      this.recordUnavailable(
        current,
        observedAt,
        `Canonical verification is temporarily unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return this.publicIntent(current);
    }
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
            ? "Exact prepared transaction is pending in the node mempool"
            : "Exact prepared transaction is pending in a microblock",
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
    action: BrowserWalletIntentAction,
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
      const completedPriorAction =
        action !== "deploy-manager" && this.hasCanonicalExecution(candidate.id, action);
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
      detail: "Failed transaction retired before reviewing replacement work",
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
        detail: "An earlier equivalent transaction completed canonically",
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
      throw new OnboardingWalletIntentError(
        "wallet_intent_invalid",
        "Stored wallet intent failed its integrity check",
      );
    }
    return manifest.data;
  }

  private requireStored(id: string): StoredWalletIntent {
    const stored = this.options.store.walletIntents.get(z.uuid().parse(id));
    if (!stored) {
      throw new OnboardingWalletIntentError("wallet_intent_not_found", "Wallet intent not found");
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
