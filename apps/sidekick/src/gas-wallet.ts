import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  compressPublicKey,
  getAddressFromPublicKey,
  privateKeyToPublic,
  randomPrivateKey,
} from "@stacks/transactions";
import type {
  GasWalletRefusal,
  GasWalletStatus,
  GasWalletSweep,
} from "@stx-labs/signer-sidekick-api-contracts";
import {
  decodeBoolean,
  encodePrincipalHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import type { SidekickNetwork } from "./config.js";
import {
  type GasWalletSweepPlan,
  GasWalletSweepPlanError,
  planGasWalletSweep,
} from "./gas-wallet-sweep.js";
import {
  GasWalletSweepRepositoryError,
  type StoredGasWalletSweep,
} from "./storage/gas-wallet-sweep-repository.js";
import type { SidekickStore } from "./storage/store.js";
import type { SignedGasWalletSweepTransaction } from "./transaction-engine/gas-payer-signer.js";
import { LiveTransactionReader } from "./transaction-engine/live-transaction-reader.js";
import type { TransactionEngineRuntimeContext } from "./transaction-engine/runtime.js";
import type { TransactionEngineMode } from "./transaction-engine/runtime-config.js";
import {
  NoRetryTransactionBroadcaster,
  type TransactionBroadcastResult,
} from "./transaction-engine/transaction-broadcaster.js";

/**
 * Gas wallet lifecycle for the operator-run execution envelope (ADR 0010, plan S2/S2b).
 *
 * The wallet is a dedicated STX key that only ever pays gas for permissionless PoX-5 / manager
 * calls. Sidekick generates it on request, writes the secret once to a 0600 file next to the
 * database, records the public identity, and activates it on the running engine when the operator
 * enables it. Key material never enters the database, the API, logs, or support bundles.
 *
 * Sweeps (plan §7.6) move `balance - fee` STX to an operator-entered address through a sealed plan
 * that the operator approves within a bounded window; the engine signs it under the same mutex
 * that serializes reward execution, so a sweep and a run never interleave.
 */

export type GasWalletErrorCode =
  | "gas_wallet_engine_mode"
  | "gas_wallet_exists"
  | "gas_wallet_missing"
  | "gas_wallet_refused"
  | "gas_wallet_engine_unavailable"
  | "gas_wallet_secret_unreadable"
  | "invalid_gas_wallet_request"
  | "gas_wallet_sweep_blocked"
  | "gas_wallet_sweep_not_found"
  | "gas_wallet_sweep_state"
  | "gas_wallet_sweep_expired"
  | "gas_wallet_sweep_stale"
  | "gas_wallet_sweep_empty"
  | "gas_wallet_sweep_failed"
  | "gas_wallet_sweep_unavailable"
  | "invalid_gas_wallet_sweep_recipient";

export class GasWalletError extends Error {
  constructor(
    readonly code: GasWalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GasWalletError";
  }
}

export interface GasWalletEngine {
  activateGasWallet(input: {
    principal: string;
    publicKey: string;
    secretFilePath: string;
    network: "mainnet" | "testnet";
  }): Promise<void>;
  deactivateGasWallet(): Promise<void>;
  gasWalletSignerReady(): boolean;
  gasPayerIdentity(): { principal: string; publicKey: string } | null;
  /** Signs a sealed sweep under the engine's execution mutex. */
  signGasWalletSweep(plan: GasWalletSweepPlan): Promise<SignedGasWalletSweepTransaction>;
  /** Legacy engine jobs currently executing or ambiguous; sweeps refuse while any exist. */
  activeJobCount(): number;
}

export type GasWalletReader = Pick<
  LiveTransactionReader,
  | "readAnchoredAccount"
  | "lookupIndexedTransaction"
  | "lookupUnconfirmedTransaction"
  | "estimateUnsignedTransactionFee"
>;
export type GasWalletBroadcaster = Pick<NoRetryTransactionBroadcaster, "broadcast">;

export interface GasWalletServiceOptions {
  store: SidekickStore;
  engineMode: TransactionEngineMode;
  engine: GasWalletEngine | null;
  /** Connected runtime context; throws while the configured connection is not current. */
  runtimeContext: () => TransactionEngineRuntimeContext;
  managerPrincipal: string;
  network: SidekickNetwork;
  /** Stacks chain id the node runs; sealed sweeps are bound to it. */
  chainId: number;
  /** Where a generated secret is written (O_EXCL, 0600). */
  secretFilePath: string;
  /** Conservative per-transaction fee basis and the sweep fee ceiling. */
  maximumFeeUstx: bigint;
  /** The pool's registered signer key, used to refuse a wallet that is also the signer. */
  signerKeyHex: () => Promise<string | null> | string | null;
  /** Sweep approval window; defaults to 30 minutes (plan §8.6). */
  sweepApprovalMinutes?: number;
  now?: () => Date;
  logger?: { warn(message: string): void };
  /** Test seam; defaults to `@stacks/transactions` randomness. */
  generatePrivateKey?: () => string;
  /** Test seam; defaults to a `LiveTransactionReader` against the connected node. */
  createReader?: (baseUrl: string) => GasWalletReader;
  /** Test seam; defaults to a `NoRetryTransactionBroadcaster` against the connected node. */
  createBroadcaster?: (baseUrl: string) => GasWalletBroadcaster;
}

const LOW_BALANCE_DISMISSAL_HOURS = 24;
const DEFAULT_SWEEP_APPROVAL_MINUTES = 30;
const SWEEP_LIST_LIMIT = 20;

function shortMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 197)}...` : message || "unknown error";
}

function defaultReader(baseUrl: string): GasWalletReader {
  return new LiveTransactionReader({ baseUrl });
}

function defaultBroadcaster(baseUrl: string): GasWalletBroadcaster {
  return new NoRetryTransactionBroadcaster({ baseUrl });
}

function toSweep(stored: StoredGasWalletSweep): GasWalletSweep {
  const { updatedAt: _updatedAt, ...rest } = stored;
  return rest;
}

export class GasWalletService {
  readonly #options: GasWalletServiceOptions;
  #lastActivationError: string | null = null;

  constructor(options: GasWalletServiceOptions) {
    this.#options = options;
  }

  /** Re-activates a previously enabled wallet after a restart. Never throws. */
  async startup(): Promise<void> {
    const stored = this.#options.store.gasWallet.get();
    if (!stored?.enabled) return;
    if (this.#options.engineMode !== "operator-run" || this.#options.engine === null) {
      this.#lastActivationError =
        "Gas wallet is enabled but the engine is not in operator-run mode";
      this.#options.logger?.warn(this.#lastActivationError);
      return;
    }
    try {
      await this.#options.engine.activateGasWallet({
        principal: stored.principal,
        publicKey: stored.publicKey,
        secretFilePath: stored.secretFilePath,
        network: this.#transactionNetwork(),
      });
      this.#lastActivationError = null;
    } catch (error) {
      this.#lastActivationError = shortMessage(error);
      this.#options.logger?.warn(`Gas wallet could not be activated: ${this.#lastActivationError}`);
    }
  }

  async status(): Promise<GasWalletStatus> {
    const now = this.#now();
    const stored = this.#options.store.gasWallet.get();
    const banners = this.#options.store.gasWallet.banners();
    const engine = this.#options.engine;
    const identity =
      stored === null
        ? (engine?.gasPayerIdentity() ?? null)
        : { principal: stored.principal, publicKey: stored.publicKey };
    const enabled = stored ? stored.enabled : Boolean(engine?.gasWalletSignerReady());
    const signer: GasWalletStatus["signer"] =
      engine === null
        ? "engine-unavailable"
        : identity === null
          ? "not-loaded"
          : !enabled
            ? "disabled"
            : engine.gasWalletSignerReady()
              ? "ready"
              : this.#lastActivationError
                ? "unreadable"
                : "not-loaded";
    const balance =
      identity === null
        ? { balanceUstx: null, observedAt: null, error: null }
        : await this.#balance(identity.principal, now);
    const refusal: GasWalletRefusal =
      identity === null
        ? {
            checkedAt: null,
            isManagerAdmin: null,
            isSignerKey: null,
            isContract: false,
            refusalReason: null,
          }
        : await this.refusalChecks(identity.principal, now);
    const feeBasis = this.#options.maximumFeeUstx;
    this.#expirePlannedSweeps(now);
    const sweeps = this.#options.store.gasWalletSweeps.list(SWEEP_LIST_LIMIT).map(toSweep);
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      network: this.#network(),
      engineMode: this.#options.engineMode,
      configured: identity !== null,
      enabled,
      source: stored ? stored.source : identity ? "configured" : null,
      principal: identity?.principal ?? null,
      publicKey: identity?.publicKey ?? null,
      secretFilePath: stored?.secretFilePath ?? null,
      createdAt: stored?.createdAt ?? null,
      enabledAt: stored?.enabledAt ?? null,
      signer,
      signerError: signer === "unreadable" ? this.#lastActivationError : null,
      balanceUstx: balance.balanceUstx,
      balanceObservedAt: balance.observedAt,
      balanceError: balance.error,
      feeBasisUstx: feeBasis.toString(),
      feeBasis: "fee-cap",
      estimatedTransactions:
        balance.balanceUstx === null || feeBasis <= 0n
          ? null
          : Number(BigInt(balance.balanceUstx) / feeBasis),
      refusal,
      banners,
      activeSweepId: this.#options.store.gasWalletSweeps.active()?.sweepId ?? null,
      sweeps,
    };
  }

  /** Generates a new wallet key, writes it once, and records the public identity (disabled). */
  async create(): Promise<GasWalletStatus> {
    const existing = this.#options.store.gasWallet.get();
    if (existing !== null) {
      throw new GasWalletError(
        "gas_wallet_exists",
        `A gas wallet (${existing.principal}) is already recorded for this deployment`,
      );
    }
    if (this.#options.engine?.gasPayerIdentity()) {
      throw new GasWalletError(
        "gas_wallet_exists",
        "A gas payer is configured through the environment; unset it before generating a wallet",
      );
    }
    const privateKey = (this.#options.generatePrivateKey ?? randomPrivateKey)();
    const publicKey = compressPublicKey(privateKeyToPublic(privateKey)).toLowerCase();
    const principal = getAddressFromPublicKey(publicKey, this.#transactionNetwork());
    const secretFilePath = this.#options.secretFilePath;
    await mkdir(dirname(secretFilePath), { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(secretFilePath, "wx", 0o600);
      await handle.writeFile(`${privateKey}\n`, { encoding: "utf8" });
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new GasWalletError(
          "gas_wallet_exists",
          `A gas wallet secret already exists at ${secretFilePath}; move it aside before generating a new wallet`,
        );
      }
      throw error;
    } finally {
      await handle?.close();
    }
    const createdAt = this.#now().toISOString();
    try {
      this.#options.store.gasWallet.put({
        principal,
        publicKey,
        secretFilePath,
        source: "generated",
        createdAt,
      });
    } catch (error) {
      // Never leave an orphaned secret behind a failed registration; the next create starts clean.
      await unlink(secretFilePath).catch(() => undefined);
      throw error;
    }
    return await this.status();
  }

  /** Runs the refusal checks, loads the secret into the engine, and records the wallet as enabled. */
  async enable(): Promise<GasWalletStatus> {
    if (this.#options.engineMode !== "operator-run") {
      throw new GasWalletError(
        "gas_wallet_engine_mode",
        "Enabling the gas wallet requires SIDEKICK_ENGINE_MODE=operator-run",
      );
    }
    const engine = this.#requireEngine();
    const stored = this.#options.store.gasWallet.get();
    if (stored === null) {
      throw new GasWalletError("gas_wallet_missing", "Generate the gas wallet before enabling it");
    }
    const refusal = await this.refusalChecks(stored.principal, this.#now());
    if (refusal.refusalReason !== null) {
      throw new GasWalletError("gas_wallet_refused", refusalMessage(refusal.refusalReason));
    }
    try {
      await engine.activateGasWallet({
        principal: stored.principal,
        publicKey: stored.publicKey,
        secretFilePath: stored.secretFilePath,
        network: this.#transactionNetwork(),
      });
      this.#lastActivationError = null;
    } catch (error) {
      this.#lastActivationError = shortMessage(error);
      throw new GasWalletError(
        "gas_wallet_secret_unreadable",
        `The gas wallet secret could not be loaded: ${this.#lastActivationError}`,
      );
    }
    this.#options.store.gasWallet.setEnabled(true, this.#now().toISOString());
    return await this.status();
  }

  async disable(): Promise<GasWalletStatus> {
    const stored = this.#options.store.gasWallet.get();
    if (stored === null) {
      throw new GasWalletError("gas_wallet_missing", "No gas wallet is recorded");
    }
    await this.#options.engine?.deactivateGasWallet();
    this.#lastActivationError = null;
    this.#options.store.gasWallet.setEnabled(false, this.#now().toISOString());
    return await this.status();
  }

  async dismissBanner(kind: "setup" | "low-balance"): Promise<GasWalletStatus> {
    const now = this.#now();
    if (kind === "setup") {
      this.#options.store.gasWallet.dismissSetupBanner(now.toISOString(), now.toISOString());
    } else {
      const until = new Date(now.getTime() + LOW_BALANCE_DISMISSAL_HOURS * 60 * 60 * 1000);
      this.#options.store.gasWallet.dismissLowBalance(until.toISOString(), now.toISOString());
    }
    return await this.status();
  }

  // ---------------------------------------------------------------------------------------------
  // Sweeps (plan §7.6)
  // ---------------------------------------------------------------------------------------------

  /**
   * Seals a sweep of `balance - fee` to `recipient` at the current anchor. The plan waits for an
   * explicit approval inside the approval window; nothing is signed here.
   */
  async prepareSweep(input: { recipient: string }): Promise<GasWalletSweep> {
    const now = this.#now();
    const wallet = this.#requireWallet();
    this.#requireNoActiveWork(now);
    const context = this.#connectedContext();
    const reader = (this.#options.createReader ?? defaultReader)(context.config.nodeRpcUrl);
    const tenure = await context.node.getTenureInfo();
    const tip = `0x${tenure.tip_block_id.replace(/^0x/, "")}` as `0x${string}`;
    const account = await reader.readAnchoredAccount(wallet.principal, tip);
    if (account.status !== "observed") {
      throw new GasWalletError(
        "gas_wallet_sweep_unavailable",
        `The gas wallet account could not be read (${account.status}); retry once the node is reachable`,
      );
    }
    const expiresAt = new Date(now.getTime() + this.#sweepApprovalMinutes() * 60 * 1000);
    const sender = { principal: wallet.principal, publicKey: wallet.publicKey };
    const network = this.#transactionNetwork();
    const cap = this.#options.maximumFeeUstx;
    let plan: GasWalletSweepPlan;
    try {
      // Estimate the fee against a draft plan at the cap, then seal with the bounded estimate.
      const draft = await planGasWalletSweep({
        network,
        chainId: this.#options.chainId,
        sender,
        recipient: input.recipient,
        balanceUstx: account.value.balanceUstx,
        feeUstx: cap,
        nonce: account.value.nonce,
        indexBlockHash: tip,
        createdAt: now,
        expiresAt,
      });
      const fee = await this.#estimateFee(reader, draft.unsignedTransactionHex, cap);
      plan =
        fee === cap
          ? draft
          : await planGasWalletSweep({
              network,
              chainId: this.#options.chainId,
              sender,
              recipient: input.recipient,
              balanceUstx: account.value.balanceUstx,
              feeUstx: fee,
              nonce: account.value.nonce,
              indexBlockHash: tip,
              createdAt: now,
              expiresAt,
            });
    } catch (error) {
      if (error instanceof GasWalletSweepPlanError) {
        if (error.code === "insufficient-balance") {
          throw new GasWalletError("gas_wallet_sweep_empty", error.message);
        }
        if (error.code === "invalid-recipient" || error.code === "recipient-is-wallet") {
          throw new GasWalletError("invalid_gas_wallet_sweep_recipient", error.message);
        }
      }
      throw error;
    }
    let stored: StoredGasWalletSweep;
    try {
      stored = this.#options.store.gasWalletSweeps.insert({
        sweepId: randomUUID(),
        walletPrincipal: wallet.principal,
        plan,
        createdAt: now.toISOString(),
      });
    } catch (error) {
      if (error instanceof GasWalletSweepRepositoryError) {
        throw new GasWalletError(
          "gas_wallet_sweep_blocked",
          "The gas wallet already has an active reward run or sweep",
        );
      }
      throw error;
    }
    return toSweep(stored);
  }

  /**
   * Approves and broadcasts a planned sweep. Re-reads the live account so a stale nonce or a
   * balance that no longer covers the sealed amount fails closed instead of signing.
   */
  async approveSweep(sweepId: string): Promise<GasWalletSweep> {
    const now = this.#now();
    const engine = this.#requireEngine();
    if (!engine.gasWalletSignerReady()) {
      throw new GasWalletError(
        "gas_wallet_engine_unavailable",
        "The gas wallet signer is not loaded; enable the wallet before approving a sweep",
      );
    }
    const sweep = this.#requireSweep(sweepId);
    if (sweep.status !== "planned") {
      throw new GasWalletError(
        "gas_wallet_sweep_state",
        `Sweep ${sweepId} is ${sweep.status}; only a planned sweep can be approved`,
      );
    }
    if (Date.parse(sweep.expiresAt) <= now.getTime()) {
      this.#resolveSweep(sweepId, "expired", now, "Approval window elapsed");
      throw new GasWalletError(
        "gas_wallet_sweep_expired",
        "The sweep approval window elapsed; prepare the sweep again",
      );
    }
    if (engine.activeJobCount() > 0) {
      throw new GasWalletError(
        "gas_wallet_sweep_blocked",
        "A reward run is still executing; wait for it to finish before sweeping",
      );
    }
    // Per-signature refusal (ADR 0010): the wallet must still be a dedicated non-admin, non-signer key.
    const refusal = await this.refusalChecks(sweep.walletPrincipal, now);
    if (refusal.refusalReason !== null) {
      throw new GasWalletError("gas_wallet_refused", refusalMessage(refusal.refusalReason));
    }
    const plan = this.#options.store.gasWalletSweeps.getPlan(sweepId);
    if (plan === null) throw new GasWalletError("gas_wallet_sweep_not_found", "Sweep plan missing");
    const context = this.#connectedContext();
    const reader = (this.#options.createReader ?? defaultReader)(context.config.nodeRpcUrl);
    const tenure = await context.node.getTenureInfo();
    const account = await reader.readAnchoredAccount(
      sweep.walletPrincipal,
      `0x${tenure.tip_block_id.replace(/^0x/, "")}`,
    );
    if (account.status !== "observed") {
      throw new GasWalletError(
        "gas_wallet_sweep_unavailable",
        `The gas wallet account could not be read (${account.status}); retry once the node is reachable`,
      );
    }
    if (
      account.value.nonce !== BigInt(plan.material.nonce) ||
      account.value.balanceUstx < BigInt(plan.material.amountUstx) + BigInt(plan.material.feeUstx)
    ) {
      this.#resolveSweep(
        sweepId,
        "expired",
        now,
        account.value.nonce !== BigInt(plan.material.nonce)
          ? "Wallet nonce changed after the sweep was planned"
          : "Wallet balance no longer covers the planned amount and fee",
      );
      throw new GasWalletError(
        "gas_wallet_sweep_stale",
        "The wallet changed after the sweep was planned; prepare the sweep again",
      );
    }
    let signed: SignedGasWalletSweepTransaction;
    try {
      signed = await engine.signGasWalletSweep(plan);
    } catch (error) {
      this.#resolveSweep(sweepId, "failed", now, `Signing failed: ${shortMessage(error)}`);
      throw new GasWalletError(
        "gas_wallet_sweep_failed",
        `The sweep could not be signed: ${shortMessage(error)}`,
      );
    }
    const approvedAt = now.toISOString();
    this.#options.store.gasWalletSweeps.update(sweepId, { approvedAt }, approvedAt);
    const broadcaster = (this.#options.createBroadcaster ?? defaultBroadcaster)(
      context.config.nodeRpcUrl,
    );
    let result: TransactionBroadcastResult;
    try {
      result = await broadcaster.broadcast(signed);
    } catch (error) {
      result = {
        status: "ambiguous",
        txid: signed.precomputedTxid,
        httpStatus: null,
        reason: "transport-error",
        nodeMessage: shortMessage(error),
      };
    }
    const at = this.#now().toISOString();
    if (result.status === "deterministic-rejection") {
      return toSweep(
        this.#options.store.gasWalletSweeps.update(
          sweepId,
          {
            status: "failed",
            txid: result.txid ?? signed.precomputedTxid,
            resolvedAt: at,
            failureReason: `Node rejected the sweep${result.nodeMessage ? `: ${result.nodeMessage}` : ""}`,
          },
          at,
        ),
      );
    }
    return toSweep(
      this.#options.store.gasWalletSweeps.update(
        sweepId,
        {
          status: "broadcast",
          txid: result.txid,
          broadcastAmbiguous: result.status === "ambiguous",
          broadcastAt: at,
        },
        at,
      ),
    );
  }

  async cancelSweep(sweepId: string): Promise<GasWalletSweep> {
    const sweep = this.#requireSweep(sweepId);
    if (sweep.status !== "planned") {
      throw new GasWalletError(
        "gas_wallet_sweep_state",
        `Sweep ${sweepId} is ${sweep.status}; only a planned sweep can be cancelled`,
      );
    }
    return toSweep(this.#resolveSweep(sweepId, "cancelled", this.#now(), null));
  }

  /** Re-reads the node for a broadcast sweep and settles it when the chain has decided. */
  async refreshSweep(sweepId: string): Promise<GasWalletSweep> {
    const now = this.#now();
    const sweep = this.#requireSweep(sweepId);
    if (sweep.status === "planned" && Date.parse(sweep.expiresAt) <= now.getTime()) {
      return toSweep(this.#resolveSweep(sweepId, "expired", now, "Approval window elapsed"));
    }
    if (sweep.status !== "broadcast" || sweep.txid === null) return toSweep(sweep);
    const context = this.#connectedContext();
    const reader = (this.#options.createReader ?? defaultReader)(context.config.nodeRpcUrl);
    const indexed = await reader.lookupIndexedTransaction(sweep.txid);
    if (indexed.status === "observed" && indexed.value.isCanonical) {
      const success = indexed.value.resultRepr.trim().startsWith("(ok");
      const at = now.toISOString();
      return toSweep(
        this.#options.store.gasWalletSweeps.update(
          sweepId,
          {
            status: success ? "confirmed" : "failed",
            resolvedAt: at,
            blockHeight:
              indexed.value.blockHeight === null ? null : Number(indexed.value.blockHeight),
            failureReason: success ? null : `Sweep aborted on chain: ${indexed.value.resultRepr}`,
          },
          at,
        ),
      );
    }
    const unconfirmed = await reader.lookupUnconfirmedTransaction(sweep.txid);
    if (unconfirmed.status === "observed") return toSweep(sweep);
    if (
      unconfirmed.status === "not-found" &&
      sweep.broadcastAmbiguous &&
      sweep.broadcastAt !== null &&
      now.getTime() - Date.parse(sweep.broadcastAt) > this.#sweepApprovalMinutes() * 60 * 1000
    ) {
      return toSweep(
        this.#resolveSweep(
          sweepId,
          "failed",
          now,
          "The node never saw the sweep after an ambiguous broadcast; prepare it again",
        ),
      );
    }
    return toSweep(sweep);
  }

  async listSweeps(limit = SWEEP_LIST_LIMIT): Promise<GasWalletSweep[]> {
    this.#expirePlannedSweeps(this.#now());
    return this.#options.store.gasWalletSweeps.list(limit).map(toSweep);
  }

  /**
   * Per-run refusal (ADR 0010 §4): the gas wallet must never be a manager admin, the registered
   * signer key, or a contract principal. Reads the live manager; unavailable reads refuse.
   */
  async refusalChecks(principal: string, now: Date): Promise<GasWalletRefusal> {
    const isContract = principal.includes(".");
    let isManagerAdmin: boolean | null = null;
    let isSignerKey: boolean | null = null;
    let unavailable = false;
    try {
      const context = this.#options.runtimeContext();
      const result = await context.node.callReadOnly(
        this.#options.managerPrincipal,
        "is-admin",
        principal,
        [encodePrincipalHex(principal)],
      );
      isManagerAdmin = decodeBoolean(result, "is-admin");
    } catch {
      unavailable = true;
    }
    try {
      const signerKeyHex = await this.#options.signerKeyHex();
      if (signerKeyHex === null) {
        isSignerKey = false;
      } else {
        const signerPrincipal = getAddressFromPublicKey(signerKeyHex, this.#transactionNetwork());
        isSignerKey = signerPrincipal === principal;
      }
    } catch {
      unavailable = true;
    }
    const refusalReason: GasWalletRefusal["refusalReason"] = isContract
      ? "contract-principal"
      : isManagerAdmin === true
        ? "manager-admin"
        : isSignerKey === true
          ? "signer-key"
          : unavailable
            ? "check-unavailable"
            : null;
    return { checkedAt: now.toISOString(), isManagerAdmin, isSignerKey, isContract, refusalReason };
  }

  async #balance(
    principal: string,
    now: Date,
  ): Promise<{ balanceUstx: string | null; observedAt: string | null; error: string | null }> {
    try {
      const context = this.#options.runtimeContext();
      const tenure = await context.node.getTenureInfo();
      const reader = (this.#options.createReader ?? defaultReader)(context.config.nodeRpcUrl);
      const account = await reader.readAnchoredAccount(
        principal,
        `0x${tenure.tip_block_id.replace(/^0x/, "")}`,
      );
      if (account.status !== "observed") {
        return {
          balanceUstx: null,
          observedAt: null,
          error: `Account read ${account.status} (${account.reason}, HTTP ${account.httpStatus ?? "n/a"})`,
        };
      }
      return {
        balanceUstx: account.value.balanceUstx.toString(),
        observedAt: now.toISOString(),
        error: null,
      };
    } catch (error) {
      return { balanceUstx: null, observedAt: null, error: shortMessage(error) };
    }
  }

  async #estimateFee(reader: GasWalletReader, unsignedHex: string, cap: bigint): Promise<bigint> {
    try {
      const estimate = await reader.estimateUnsignedTransactionFee(unsignedHex);
      if (estimate.status !== "observed") return cap;
      const middle = estimate.value.estimates.middle.feeUstx;
      if (middle <= 0n) return cap;
      return middle > cap ? cap : middle;
    } catch {
      return cap;
    }
  }

  #expirePlannedSweeps(now: Date): void {
    const active = this.#options.store.gasWalletSweeps.active();
    if (active?.status === "planned" && Date.parse(active.expiresAt) <= now.getTime()) {
      this.#resolveSweep(active.sweepId, "expired", now, "Approval window elapsed");
    }
  }

  #resolveSweep(
    sweepId: string,
    status: "expired" | "cancelled" | "failed",
    now: Date,
    failureReason: string | null,
  ): StoredGasWalletSweep {
    const at = now.toISOString();
    return this.#options.store.gasWalletSweeps.update(
      sweepId,
      { status, resolvedAt: at, failureReason },
      at,
    );
  }

  #requireNoActiveWork(now: Date): void {
    this.#expirePlannedSweeps(now);
    const active = this.#options.store.gasWalletSweeps.active();
    if (active !== null) {
      throw new GasWalletError(
        "gas_wallet_sweep_blocked",
        `Sweep ${active.sweepId} is still ${active.status}; finish or cancel it before preparing another`,
      );
    }
    if ((this.#options.engine?.activeJobCount() ?? 0) > 0) {
      throw new GasWalletError(
        "gas_wallet_sweep_blocked",
        "A reward run is still executing; wait for it to finish before sweeping",
      );
    }
  }

  #requireWallet() {
    const stored = this.#options.store.gasWallet.get();
    if (stored === null) {
      throw new GasWalletError("gas_wallet_missing", "No gas wallet is recorded");
    }
    return stored;
  }

  #requireSweep(sweepId: string): StoredGasWalletSweep {
    const sweep = this.#options.store.gasWalletSweeps.get(sweepId);
    if (sweep === null) {
      throw new GasWalletError("gas_wallet_sweep_not_found", `Sweep ${sweepId} does not exist`);
    }
    return sweep;
  }

  #requireEngine(): GasWalletEngine {
    const engine = this.#options.engine;
    if (engine === null) {
      throw new GasWalletError(
        "gas_wallet_engine_unavailable",
        "The transaction engine is unavailable; restart Sidekick and review the startup logs",
      );
    }
    return engine;
  }

  #connectedContext(): TransactionEngineRuntimeContext {
    try {
      return this.#options.runtimeContext();
    } catch (error) {
      throw new GasWalletError(
        "gas_wallet_sweep_unavailable",
        `The node connection is not current: ${shortMessage(error)}`,
      );
    }
  }

  #sweepApprovalMinutes(): number {
    return this.#options.sweepApprovalMinutes ?? DEFAULT_SWEEP_APPROVAL_MINUTES;
  }

  #network(): SidekickNetwork {
    return this.#options.network;
  }

  #transactionNetwork(): "mainnet" | "testnet" {
    return this.#network() === "mainnet" ? "mainnet" : "testnet";
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}

function refusalMessage(reason: NonNullable<GasWalletRefusal["refusalReason"]>): string {
  switch (reason) {
    case "manager-admin":
      return "The gas wallet is a manager admin; it must be a dedicated key that only pays gas";
    case "signer-key":
      return "The gas wallet is the pool's signer key; it must be a dedicated key that only pays gas";
    case "contract-principal":
      return "The gas wallet must be a standard principal, not a contract";
    case "check-unavailable":
      return "The manager could not be read to verify the gas wallet; reconnect and retry";
  }
}
