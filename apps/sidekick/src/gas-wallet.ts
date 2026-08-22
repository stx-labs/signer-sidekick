import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  compressPublicKey,
  getAddressFromPublicKey,
  privateKeyToPublic,
  randomPrivateKey,
} from "@stacks/transactions";
import type { GasWalletRefusal, GasWalletStatus } from "@stx-labs/signer-sidekick-api-contracts";
import {
  decodeBoolean,
  encodePrincipalHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import type { SidekickNetwork } from "./config.js";
import type { SidekickStore } from "./storage/store.js";
import { LiveTransactionReader } from "./transaction-engine/live-transaction-reader.js";
import type { TransactionEngineRuntimeContext } from "./transaction-engine/runtime.js";
import type { TransactionEngineMode } from "./transaction-engine/runtime-config.js";

/**
 * Gas wallet lifecycle for the operator-run execution envelope (ADR 0010, plan S2).
 *
 * The wallet is a dedicated STX key that only ever pays gas for permissionless PoX-5 / manager
 * calls. Sidekick generates it on request, writes the secret once to a 0600 file next to the
 * database, records the public identity, and activates it on the running engine when the operator
 * enables it. Key material never enters the database, the API, logs, or support bundles.
 */

export type GasWalletErrorCode =
  | "gas_wallet_engine_mode"
  | "gas_wallet_exists"
  | "gas_wallet_missing"
  | "gas_wallet_refused"
  | "gas_wallet_engine_unavailable"
  | "gas_wallet_secret_unreadable"
  | "invalid_gas_wallet_request";

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
}

export interface GasWalletServiceOptions {
  store: SidekickStore;
  engineMode: TransactionEngineMode;
  engine: GasWalletEngine | null;
  /** Connected runtime context; throws while the configured connection is not current. */
  runtimeContext: () => TransactionEngineRuntimeContext;
  managerPrincipal: string;
  network: SidekickNetwork;
  /** Where a generated secret is written (O_EXCL, 0600). */
  secretFilePath: string;
  /** Conservative per-transaction fee basis used for the "≈ N transactions" estimate. */
  maximumFeeUstx: bigint;
  /** The pool's registered signer key, used to refuse a wallet that is also the signer. */
  signerKeyHex: () => Promise<string | null> | string | null;
  now?: () => Date;
  logger?: { warn(message: string): void };
  /** Test seam; defaults to `@stacks/transactions` randomness. */
  generatePrivateKey?: () => string;
  /** Test seam; defaults to a `LiveTransactionReader` against the connected node. */
  createReader?: (baseUrl: string) => Pick<LiveTransactionReader, "readAnchoredAccount">;
}

const LOW_BALANCE_DISMISSAL_HOURS = 24;

function shortMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 197)}...` : message || "unknown error";
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
    this.#options.store.gasWallet.put({
      principal,
      publicKey,
      secretFilePath,
      source: "generated",
      createdAt,
    });
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
    const engine = this.#options.engine;
    if (engine === null) {
      throw new GasWalletError(
        "gas_wallet_engine_unavailable",
        "The transaction engine is unavailable; restart Sidekick and review the startup logs",
      );
    }
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
      const account = await reader.readAnchoredAccount(principal, tenure.tip_block_id);
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

function defaultReader(baseUrl: string): Pick<LiveTransactionReader, "readAnchoredAccount"> {
  return new LiveTransactionReader({ baseUrl });
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
