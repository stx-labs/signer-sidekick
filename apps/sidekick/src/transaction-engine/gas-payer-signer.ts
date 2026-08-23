import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  compressPublicKey,
  deserializeTransaction,
  getAddressFromPublicKey,
  privateKeyToPublic,
  TransactionSigner,
} from "@stacks/transactions";
import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
  type ManagerClaimRewardsPlan,
  planManagerClaimRewards,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import {
  type RewardOperationKind,
  type RewardOperationPlan,
  revalidateRewardOperationPlan,
} from "@stx-labs/signer-sidekick-protocol/reward-operation-plan";
import { type GasWalletSweepPlan, revalidateGasWalletSweepPlan } from "../gas-wallet-sweep.js";

export type GasPayerSignerErrorCode =
  | "invalid-configuration"
  | "secret-unavailable"
  | "secret-symlink"
  | "secret-not-regular-file"
  | "secret-insecure-permissions"
  | "secret-owner-mismatch"
  | "secret-changed-during-read"
  | "secret-invalid-format"
  | "identity-mismatch"
  | "signer-destroyed"
  | "sealed-plan-invalid"
  | "plan-signer-mismatch"
  | "signing-failed";

/** An intentionally redacted error: it never includes file contents or private-key material. */
export class GasPayerSignerError extends Error {
  constructor(
    readonly code: GasPayerSignerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GasPayerSignerError";
  }
}

export interface GasPayerSignerOptions {
  /** An explicit absolute path to a dedicated raw Stacks private-key secret. */
  secretFilePath: string;
  expectedPrincipal: string;
  network: "mainnet" | "testnet";
}

const signedTransactionCapability = Symbol("signed-manager-claim-rewards");
const signedSweepCapability = Symbol("signed-gas-wallet-sweep");
const signedRewardOperationCapability = Symbol("signed-reward-operation");

/**
 * Opaque signed output from {@link GasPayerSigner}. Its constructor cannot be used without the
 * module-local capability, while byte access returns a defensive copy for durable persistence.
 */
export class SignedManagerClaimRewardsTransaction {
  readonly kind = "signed-manager-claim-rewards" as const;

  #signedTransactionBytes: Uint8Array;

  constructor(
    capability: typeof signedTransactionCapability,
    signedTransactionBytes: Uint8Array,
    readonly intentHash: string,
    readonly unsignedTransactionSha256: string,
    readonly precomputedTxid: `0x${string}`,
    readonly nonce: string,
    readonly fee: string,
  ) {
    if (capability !== signedTransactionCapability) {
      throw new GasPayerSignerError("signing-failed", "Signed transaction construction is sealed");
    }
    this.#signedTransactionBytes = Uint8Array.from(signedTransactionBytes);
    Object.freeze(this);
  }

  get signedTransactionBytes(): Uint8Array {
    return Uint8Array.from(this.#signedTransactionBytes);
  }

  toJSON(): Record<string, string> {
    return {
      kind: this.kind,
      intentHash: this.intentHash,
      unsignedTransactionSha256: this.unsignedTransactionSha256,
      precomputedTxid: this.precomputedTxid,
      nonce: this.nonce,
      fee: this.fee,
    };
  }
}

/**
 * Opaque signed gas-wallet sweep (plan §7.6). Same sealing rules as the manager-claim output: the
 * constructor needs the module-local capability and bytes are returned as defensive copies.
 */
export class SignedGasWalletSweepTransaction {
  readonly kind = "signed-gas-wallet-sweep" as const;

  #signedTransactionBytes: Uint8Array;

  constructor(
    capability: typeof signedSweepCapability,
    signedTransactionBytes: Uint8Array,
    readonly planSha256: string,
    readonly unsignedTransactionSha256: string,
    readonly precomputedTxid: `0x${string}`,
    readonly nonce: string,
    readonly fee: string,
  ) {
    if (capability !== signedSweepCapability) {
      throw new GasPayerSignerError("signing-failed", "Signed sweep construction is sealed");
    }
    this.#signedTransactionBytes = Uint8Array.from(signedTransactionBytes);
    Object.freeze(this);
  }

  get signedTransactionBytes(): Uint8Array {
    return Uint8Array.from(this.#signedTransactionBytes);
  }

  toJSON(): Record<string, string> {
    return {
      kind: this.kind,
      planSha256: this.planSha256,
      unsignedTransactionSha256: this.unsignedTransactionSha256,
      precomputedTxid: this.precomputedTxid,
      nonce: this.nonce,
      fee: this.fee,
    };
  }
}

/** Opaque output for the closed S4 reward adapter registry. */
export class SignedRewardOperationTransaction {
  readonly kind = "signed-reward-operation" as const;

  #signedTransactionBytes: Uint8Array;

  constructor(
    capability: typeof signedRewardOperationCapability,
    signedTransactionBytes: Uint8Array,
    readonly operationKind: RewardOperationKind,
    readonly planSha256: string,
    readonly unsignedTransactionSha256: string,
    readonly precomputedTxid: `0x${string}`,
    readonly nonce: string,
    readonly fee: string,
  ) {
    if (capability !== signedRewardOperationCapability) {
      throw new GasPayerSignerError("signing-failed", "Signed operation construction is sealed");
    }
    this.#signedTransactionBytes = Uint8Array.from(signedTransactionBytes);
    Object.freeze(this);
  }

  get signedTransactionBytes(): Uint8Array {
    return Uint8Array.from(this.#signedTransactionBytes);
  }

  toJSON(): Record<string, string> {
    return {
      kind: this.kind,
      operationKind: this.operationKind,
      planSha256: this.planSha256,
      unsignedTransactionSha256: this.unsignedTransactionSha256,
      precomputedTxid: this.precomputedTxid,
      nonce: this.nonce,
      fee: this.fee,
    };
  }
}

function signerError(code: GasPayerSignerErrorCode, message: string): GasPayerSignerError {
  return new GasPayerSignerError(code, message);
}

function hexNibble(value: number): number {
  if (value >= 0x30 && value <= 0x39) return value - 0x30;
  if (value >= 0x41 && value <= 0x46) return value - 0x41 + 10;
  if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10;
  return -1;
}

/** Decode 32 raw bytes (or Stacks' compressed 33-byte `...01` form) without retaining a string. */
function decodeRawPrivateKey(encoded: Uint8Array): Uint8Array {
  let length = encoded.length;
  if (length > 0 && encoded[length - 1] === 0x0a) length -= 1;
  if (length > 0 && encoded[length - 1] === 0x0d) length -= 1;
  if (length !== 64 && length !== 66) {
    throw signerError(
      "secret-invalid-format",
      "Gas-payer secret must contain exactly one raw private key",
    );
  }

  const decoded = new Uint8Array(33);
  for (let index = 0; index < length; index += 2) {
    const high = hexNibble(encoded[index] ?? -1);
    const low = hexNibble(encoded[index + 1] ?? -1);
    if (high < 0 || low < 0) {
      decoded.fill(0);
      throw signerError(
        "secret-invalid-format",
        "Gas-payer secret must contain exactly one raw private key",
      );
    }
    decoded[index / 2] = (high << 4) | low;
  }
  if (length === 66 && decoded[32] !== 1) {
    decoded.fill(0);
    throw signerError(
      "secret-invalid-format",
      "Gas-payer secret must contain a compressed Stacks private key",
    );
  }
  decoded[32] = 1;
  return decoded;
}

async function loadPrivateKey(options: GasPayerSignerOptions): Promise<Uint8Array> {
  if (!options.secretFilePath || !isAbsolute(options.secretFilePath)) {
    throw signerError(
      "invalid-configuration",
      "Gas-payer secret path must be an explicit absolute path",
    );
  }

  let pathStat: Stats;
  try {
    pathStat = await lstat(options.secretFilePath);
  } catch {
    throw signerError("secret-unavailable", "Gas-payer secret file is unavailable");
  }
  if (pathStat.isSymbolicLink()) {
    throw signerError("secret-symlink", "Gas-payer secret file must not be a symbolic link");
  }
  if (!pathStat.isFile()) {
    throw signerError("secret-not-regular-file", "Gas-payer secret must be a regular file");
  }

  let handle: FileHandle;
  try {
    handle = await open(options.secretFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw signerError("secret-unavailable", "Gas-payer secret file could not be opened safely");
  }

  let encoded: Buffer | undefined;
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw signerError("secret-not-regular-file", "Gas-payer secret must be a regular file");
    }
    if (fileStat.dev !== pathStat.dev || fileStat.ino !== pathStat.ino) {
      throw signerError(
        "secret-changed-during-read",
        "Gas-payer secret changed while it was being opened",
      );
    }
    const permissions = fileStat.mode & 0o777;
    if ((permissions & 0o077) !== 0 || (permissions & 0o400) === 0 || (permissions & 0o111) !== 0) {
      throw signerError(
        "secret-insecure-permissions",
        "Gas-payer secret permissions must allow owner-read only, with optional owner-write",
      );
    }
    if (typeof process.getuid === "function" && fileStat.uid !== process.getuid()) {
      throw signerError(
        "secret-owner-mismatch",
        "Gas-payer secret must be owned by the Sidekick process user",
      );
    }
    if (fileStat.size < 64 || fileStat.size > 68) {
      throw signerError(
        "secret-invalid-format",
        "Gas-payer secret must contain exactly one raw private key",
      );
    }

    encoded = await handle.readFile();
    const afterRead = await handle.stat();
    if (
      afterRead.size !== fileStat.size ||
      afterRead.mtimeMs !== fileStat.mtimeMs ||
      afterRead.ctimeMs !== fileStat.ctimeMs
    ) {
      throw signerError(
        "secret-changed-during-read",
        "Gas-payer secret changed while it was being read",
      );
    }
    return decodeRawPrivateKey(encoded);
  } finally {
    encoded?.fill(0);
    await handle.close();
  }
}

async function revalidateSealedPlan(
  plan: ManagerClaimRewardsPlan,
): Promise<ManagerClaimRewardsPlan> {
  try {
    if (
      plan.kind !== "manager-claim-rewards" ||
      plan.material.adapter.id !== MANAGER_CLAIM_REWARDS_ADAPTER_ID ||
      plan.material.adapter.revision !== MANAGER_CLAIM_REWARDS_ADAPTER_REVISION
    ) {
      throw new Error("adapter mismatch");
    }
    const [sbtcTokenContract, assetName, unexpectedAssetPart] =
      plan.material.expectedEffect.asset.split("::");
    if (!sbtcTokenContract || assetName !== "sbtc-token" || unexpectedAssetPart !== undefined) {
      throw new Error("asset mismatch");
    }
    const rebuilt = await planManagerClaimRewards({
      schemaVersion: plan.material.schemaVersion,
      adapterRevision: plan.material.adapter.revision,
      network: plan.material.network,
      managerContract: plan.material.call.contract,
      pox5Contract: plan.material.expectedEffect.sender,
      sbtcTokenContract,
      rewardCycle: BigInt(plan.material.call.rewardCycle),
      expectedSbtcOutflow: BigInt(plan.material.expectedEffect.amount),
      chainAnchor: {
        ...plan.material.chainAnchor,
        rewardCycle: BigInt(plan.material.chainAnchor.rewardCycle),
      },
      attestationDigest: plan.material.attestationDigest,
      managerSourceFingerprint: plan.material.managerSourceFingerprint,
      rewardObservation: {
        calculationCheckpoint: plan.material.rewardObservation.calculationCheckpoint,
        lastRewardComputeBurnHeight: plan.material.rewardObservation.lastRewardComputeBurnHeight,
        rewardsPerToken: BigInt(plan.material.rewardObservation.rewardsPerToken),
      },
      stxEarnedSats: BigInt(plan.material.stxEarnedSats),
      bondBuckets: plan.material.bondBuckets.map((bucket) => ({
        bondIndex: BigInt(bucket.bondIndex),
        managerSharesSats: BigInt(bucket.managerSharesSats),
        earnedSats: BigInt(bucket.earnedSats),
        feeSnapshot: {
          state: bucket.feeSnapshot.state,
          effectiveFeeBips: BigInt(bucket.feeSnapshot.effectiveFeeBips),
        },
      })),
      feeSnapshot: {
        state: plan.material.feeSnapshot.state,
        effectiveFeeBips: BigInt(plan.material.feeSnapshot.effectiveFeeBips),
      },
      sender: plan.material.sender,
      nonce: BigInt(plan.material.transaction.nonce),
      fee: BigInt(plan.material.transaction.fee),
    });
    if (!isDeepStrictEqual(plan, rebuilt)) throw new Error("sealed plan mismatch");
    return rebuilt;
  } catch {
    throw signerError(
      "sealed-plan-invalid",
      "Manager claim plan failed sealed adapter and vector revalidation",
    );
  }
}

/**
 * Isolated signer for the single reviewed reference-manager `claim-rewards` vector.
 *
 * It has no method for arbitrary bytes or arbitrary transactions. The private key is held only in
 * a private byte array and can be zeroed with {@link destroy}.
 */
export class GasPayerSigner {
  #privateKey: Uint8Array;
  #destroyed = false;

  private constructor(
    privateKey: Uint8Array,
    readonly principal: string,
    readonly publicKey: string,
    readonly network: "mainnet" | "testnet",
  ) {
    this.#privateKey = privateKey;
  }

  static async fromSecretFile(options: GasPayerSignerOptions): Promise<GasPayerSigner> {
    const privateKey = await loadPrivateKey(options);
    let publicKey: string;
    try {
      publicKey = compressPublicKey(privateKeyToPublic(privateKey)).toLowerCase();
    } catch {
      privateKey.fill(0);
      throw signerError("secret-invalid-format", "Gas-payer secret is not a valid private key");
    }
    const principal = getAddressFromPublicKey(publicKey, options.network);
    if (principal !== options.expectedPrincipal) {
      privateKey.fill(0);
      throw signerError(
        "identity-mismatch",
        "Gas-payer secret does not match the configured public principal",
      );
    }
    return new GasPayerSigner(privateKey, principal, publicKey, options.network);
  }

  async signManagerClaimRewardsPlan(
    plan: ManagerClaimRewardsPlan,
  ): Promise<SignedManagerClaimRewardsTransaction> {
    if (this.#destroyed) {
      throw signerError("signer-destroyed", "Gas-payer signer has been destroyed");
    }
    const validated = await revalidateSealedPlan(plan);
    if (
      validated.material.network.kind !== this.network ||
      validated.material.sender.principal !== this.principal ||
      validated.material.sender.publicKey !== this.publicKey
    ) {
      throw signerError(
        "plan-signer-mismatch",
        "Manager claim plan does not belong to the configured gas payer",
      );
    }

    try {
      const transaction = deserializeTransaction(validated.unsignedTransactionHex);
      const transactionSigner = new TransactionSigner(transaction);
      transactionSigner.signOrigin(this.#privateKey);
      const signedBytes = transaction.serializeBytes();
      return new SignedManagerClaimRewardsTransaction(
        signedTransactionCapability,
        signedBytes,
        validated.intentHash,
        validated.unsignedTransactionSha256,
        `0x${transaction.txid()}`,
        validated.material.transaction.nonce,
        validated.material.transaction.fee,
      );
    } catch {
      throw signerError("signing-failed", "Manager claim transaction could not be signed");
    }
  }

  /**
   * Signs one sealed gas-wallet sweep: an STX transfer of `balance - fee` to an operator-entered
   * address with an exact STX post-condition. The plan is rebuilt from its material first, so this
   * method still cannot sign arbitrary bytes or amounts.
   */
  async signGasWalletSweepPlan(plan: GasWalletSweepPlan): Promise<SignedGasWalletSweepTransaction> {
    if (this.#destroyed) {
      throw signerError("signer-destroyed", "Gas-payer signer has been destroyed");
    }
    let validated: GasWalletSweepPlan;
    try {
      validated = await revalidateGasWalletSweepPlan(plan);
    } catch {
      throw signerError("sealed-plan-invalid", "Gas wallet sweep plan failed sealed revalidation");
    }
    if (
      validated.material.network.kind !== this.network ||
      validated.material.sender.principal !== this.principal ||
      validated.material.sender.publicKey !== this.publicKey
    ) {
      throw signerError(
        "plan-signer-mismatch",
        "Gas wallet sweep plan does not belong to the loaded gas wallet",
      );
    }
    try {
      const transaction = deserializeTransaction(validated.unsignedTransactionHex);
      const transactionSigner = new TransactionSigner(transaction);
      transactionSigner.signOrigin(this.#privateKey);
      const signedBytes = transaction.serializeBytes();
      return new SignedGasWalletSweepTransaction(
        signedSweepCapability,
        signedBytes,
        validated.planSha256,
        validated.unsignedTransactionSha256,
        `0x${transaction.txid()}`,
        validated.material.nonce,
        validated.material.feeUstx,
      );
    } catch {
      throw signerError("signing-failed", "Gas wallet sweep transaction could not be signed");
    }
  }

  async #signRewardOperation(
    plan: RewardOperationPlan,
    expectedKind: RewardOperationKind,
  ): Promise<SignedRewardOperationTransaction> {
    if (this.#destroyed) {
      throw signerError("signer-destroyed", "Gas-payer signer has been destroyed");
    }
    let validated: RewardOperationPlan;
    try {
      validated = await revalidateRewardOperationPlan(plan);
    } catch {
      throw signerError(
        "sealed-plan-invalid",
        `${expectedKind} plan failed sealed adapter revalidation`,
      );
    }
    if (validated.material.kind !== expectedKind) {
      throw signerError("sealed-plan-invalid", `${expectedKind} signer received another adapter`);
    }
    if (
      validated.material.network.kind !== this.network ||
      validated.material.sender.principal !== this.principal ||
      validated.material.sender.publicKey !== this.publicKey
    ) {
      throw signerError(
        "plan-signer-mismatch",
        `${expectedKind} plan does not belong to the loaded gas wallet`,
      );
    }
    try {
      const transaction = deserializeTransaction(validated.unsignedTransactionHex);
      const transactionSigner = new TransactionSigner(transaction);
      transactionSigner.signOrigin(this.#privateKey);
      return new SignedRewardOperationTransaction(
        signedRewardOperationCapability,
        transaction.serializeBytes(),
        expectedKind,
        validated.planSha256,
        validated.unsignedTransactionSha256,
        `0x${transaction.txid()}`,
        validated.material.transaction.nonce,
        validated.material.transaction.feeUstx,
      );
    } catch {
      throw signerError("signing-failed", `${expectedKind} transaction could not be signed`);
    }
  }

  signPox5CalculateRewardsPlan(
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction> {
    return this.#signRewardOperation(plan, "calculate-rewards");
  }

  signManagerClaimRewardsRunPlan(
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction> {
    return this.#signRewardOperation(plan, "claim-rewards");
  }

  signClaimStakerRewardsPlan(plan: RewardOperationPlan): Promise<SignedRewardOperationTransaction> {
    return this.#signRewardOperation(plan, "claim-staker-rewards");
  }

  signSettleAcceptedWithdrawalPlan(
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction> {
    return this.#signRewardOperation(plan, "settle-accepted-withdrawal");
  }

  signReclaimFailedWithdrawalPlan(
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction> {
    return this.#signRewardOperation(plan, "reclaim-failed-withdrawal");
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#privateKey.fill(0);
    this.#destroyed = true;
  }

  toJSON(): Record<string, string> {
    return {
      kind: "gas-payer-signer",
      principal: this.principal,
      publicKey: this.publicKey,
      network: this.network,
    };
  }
}
