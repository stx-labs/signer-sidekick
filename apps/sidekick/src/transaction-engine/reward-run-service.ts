import { createHash, randomUUID } from "node:crypto";
import type {
  GasWalletRefusal,
  RewardRun,
  RewardRunChild,
  RewardRunOperation,
  RewardRunPrepareRequest,
  RewardRunRecipe,
} from "@stx-labs/signer-sidekick-api-contracts";
import {
  REWARD_OPERATION_ADAPTER_REVISIONS,
  type RewardOperationPlan,
} from "@stx-labs/signer-sidekick-protocol/reward-operation-plan";
import type { RewardRunRepository } from "../storage/reward-run-repository.js";
import type { SignedRewardOperationTransaction } from "./gas-payer-signer.js";
import type { TransactionBroadcastResult } from "./transaction-broadcaster.js";

export type RewardRunErrorCode =
  | "reward_run_unavailable"
  | "reward_run_not_found"
  | "reward_run_invalid"
  | "reward_run_conflict"
  | "reward_run_expired"
  | "reward_run_refused";

export class RewardRunError extends Error {
  constructor(
    readonly code: RewardRunErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RewardRunError";
  }
}

export interface RewardRunDraftAccount {
  stakerPrincipal: string;
  rewardCycle: number;
  bondIndex: string | null;
  maximumGrossSats: string;
  payoutRoute: "direct-sbtc" | "bitcoin-l1";
}

export interface RewardRunDraftWithdrawal {
  requestId: string;
  stakerPrincipal: string;
  state: "accepted" | "rejected";
  maximumAmountSats: string;
  withdrawalAmountSats: string;
  maxFeeSats: string;
}

/** Current, anchor-fenced facts used to seal a recipe. UI input never supplies recipients/amounts. */
export interface RewardRunDraftFacts {
  walletPrincipal: string;
  managerPrincipal: string;
  pox5Contract: string;
  sbtcTokenContract: string;
  sbtcRegistryContract: string;
  network: "mainnet" | "testnet";
  chainId: number;
  cycle: number;
  distribution: 1 | 2;
  preparedAnchor: {
    stacksBlockHeight: number;
    burnBlockHeight: number;
    indexBlockHash: `0x${string}`;
  };
  managerSourceFingerprint: string;
  pox5SourceFingerprint: string;
  calculateRequired: boolean;
  collectRequired: boolean;
  /** Exact PoX-5 -> manager transfer proven at preparation, independent of the payment page cap. */
  maximumCollectSats: string | null;
  accounts: readonly RewardRunDraftAccount[];
  withdrawals: readonly RewardRunDraftWithdrawal[];
}

export type RewardRunMaterialization =
  | { status: "plan"; plan: RewardOperationPlan; amountSats: string | null }
  | {
      status: "skip";
      reason: string;
      provenance: "another-caller" | "policy-exception";
    }
  | { status: "halt"; reason: string };

export type RewardRunReconciliation =
  | { status: "pending" }
  | { status: "confirmed"; blockHeight: number }
  | { status: "externally-completed"; reason: string }
  | { status: "halt"; reason: string };

/** Live S4 adapter seam. Implementations read and prove state; the coordinator owns authority. */
export interface RewardRunDriver {
  materialize(input: { run: RewardRun; child: RewardRunChild }): Promise<RewardRunMaterialization>;
  reconcile(input: {
    run: RewardRun;
    child: RewardRunChild;
    plan: RewardOperationPlan;
    txid: `0x${string}`;
  }): Promise<RewardRunReconciliation>;
  broadcast(signed: SignedRewardOperationTransaction): Promise<TransactionBroadcastResult>;
}

/** Explicit signer methods are intentional: no arbitrary plan/byte signing surface exists. */
export interface RewardRunSigner {
  gasWalletSignerReady(): boolean;
  signPox5CalculateRewardsPlan(
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction>;
  signManagerClaimRewardsRunPlan(
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction>;
  signClaimStakerRewardsPlan(plan: RewardOperationPlan): Promise<SignedRewardOperationTransaction>;
  signSettleAcceptedWithdrawalPlan(
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction>;
  signReclaimFailedWithdrawalPlan(
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction>;
}

export interface RewardRunServiceOptions {
  repository: RewardRunRepository;
  signer: RewardRunSigner;
  driver: RewardRunDriver;
  facts(request: RewardRunPrepareRequest): Promise<RewardRunDraftFacts>;
  refusalChecks(principal: string, now: Date): Promise<GasWalletRefusal>;
  maximumFeeUstx: bigint;
  maximumTransactions?: number;
  approvalStartMinutes?: number;
  maximumRunHours?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  logger?: { warn(message: string): void };
}

const operationOrder: readonly RewardRunOperation[] = [
  "calculate-rewards",
  "claim-rewards",
  "claim-staker-rewards",
  "settle-accepted-withdrawal",
  "reclaim-failed-withdrawal",
];
const defaultOperations = new Set<RewardRunOperation>(operationOrder);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Recipe is not canonical JSON");
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function rewardRunRecipeSha256(recipe: RewardRunRecipe): string {
  return createHash("sha256")
    .update(`signer-sidekick:reward-run-recipe:v1\0${canonicalJson(recipe)}`)
    .digest("hex");
}

export function rewardRunPrepareRequestSha256(request: RewardRunPrepareRequest): string {
  return createHash("sha256")
    .update(
      `signer-sidekick:reward-run-prepare:v1\0${canonicalJson({
        cycle: request.cycle,
        distribution: request.distribution,
        maxTransactions: request.maxTransactions ?? null,
        operations: request.operations ?? null,
      })}`,
    )
    .digest("hex");
}

function accountKey(account: RewardRunDraftAccount): string {
  return `${account.stakerPrincipal}:${account.rewardCycle}:${account.bondIndex ?? "stx"}`;
}

function uniqueOperations(
  requested: readonly RewardRunOperation[] | undefined,
): Set<RewardRunOperation> {
  const operations = new Set(requested ?? defaultOperations);
  if (operations.size !== (requested?.length ?? operations.size)) {
    throw new RewardRunError("reward_run_invalid", "A reward operation may appear only once");
  }
  return operations;
}

export function buildRewardRunRecipe(input: {
  runId: string;
  facts: RewardRunDraftFacts;
  request: RewardRunPrepareRequest;
  feeCapUstx: bigint;
  maximumTransactions: number;
}): RewardRunRecipe {
  if (
    input.request.cycle !== input.facts.cycle ||
    input.request.distribution !== input.facts.distribution
  ) {
    throw new RewardRunError(
      "reward_run_conflict",
      "The selected distribution changed while the run was being prepared",
    );
  }
  const selected = uniqueOperations(input.request.operations);
  const maxTransactions = Math.min(
    input.request.maxTransactions ?? input.maximumTransactions,
    input.maximumTransactions,
  );
  const children: RewardRunRecipe["children"] = [];
  const add = (
    operation: RewardRunOperation,
    detail: Omit<
      RewardRunRecipe["children"][number],
      "index" | "operation" | "adapterId" | "adapterRevision"
    >,
  ) => {
    if (children.length >= maxTransactions) return;
    const adapterId =
      operation === "calculate-rewards"
        ? "pox5-calculate-rewards"
        : operation === "claim-rewards"
          ? "reference-manager-claim-rewards"
          : operation === "claim-staker-rewards"
            ? "reference-manager-claim-staker-rewards"
            : operation === "settle-accepted-withdrawal"
              ? "reference-manager-settle-accepted-withdrawal"
              : "reference-manager-reclaim-failed-withdrawal";
    children.push({
      index: children.length,
      operation,
      adapterId,
      adapterRevision: REWARD_OPERATION_ADAPTER_REVISIONS[adapterId],
      ...detail,
    });
  };
  if (selected.has("calculate-rewards") && input.facts.calculateRequired) {
    add("calculate-rewards", {
      accountKey: null,
      requestId: null,
      stakerPrincipal: null,
      maximumAmountSats: null,
      withdrawalAmountSats: null,
      maxFeeSats: null,
    });
  }
  if (selected.has("claim-rewards") && input.facts.collectRequired) {
    if (input.facts.maximumCollectSats === null || BigInt(input.facts.maximumCollectSats) <= 0n) {
      throw new RewardRunError(
        "reward_run_invalid",
        "The manager collect amount is not proven at the preparation anchor",
      );
    }
    add("claim-rewards", {
      accountKey: null,
      requestId: null,
      stakerPrincipal: null,
      maximumAmountSats: input.facts.maximumCollectSats,
      withdrawalAmountSats: null,
      maxFeeSats: null,
    });
  }
  const sortedAccounts = [...input.facts.accounts].sort((left, right) =>
    accountKey(left).localeCompare(accountKey(right)),
  );
  if (selected.has("claim-staker-rewards")) {
    for (const account of sortedAccounts) {
      if (BigInt(account.maximumGrossSats) === 0n) continue;
      add("claim-staker-rewards", {
        accountKey: accountKey(account),
        requestId: null,
        stakerPrincipal: account.stakerPrincipal,
        maximumAmountSats: account.maximumGrossSats,
        withdrawalAmountSats: null,
        maxFeeSats: null,
      });
    }
  }
  const withdrawals = [...input.facts.withdrawals].sort((left, right) =>
    BigInt(left.requestId) < BigInt(right.requestId) ? -1 : 1,
  );
  for (const withdrawal of withdrawals) {
    const operation: RewardRunOperation =
      withdrawal.state === "accepted" ? "settle-accepted-withdrawal" : "reclaim-failed-withdrawal";
    if (!selected.has(operation)) continue;
    add(operation, {
      accountKey: null,
      requestId: withdrawal.requestId,
      stakerPrincipal: withdrawal.stakerPrincipal,
      maximumAmountSats:
        operation === "reclaim-failed-withdrawal" ? withdrawal.maximumAmountSats : null,
      withdrawalAmountSats: withdrawal.withdrawalAmountSats,
      maxFeeSats: withdrawal.maxFeeSats,
    });
  }
  if (children.length === 0) {
    throw new RewardRunError("reward_run_invalid", "There is no current reward work to run");
  }
  const accountKeys = new Set<string>();
  const accounts = sortedAccounts
    .filter((account) => {
      const key = accountKey(account);
      if (accountKeys.has(key)) {
        throw new RewardRunError("reward_run_invalid", `Duplicate reward account ${key}`);
      }
      accountKeys.add(key);
      return children.some((child) => child.accountKey === key);
    })
    .map((account) => ({ ...account, accountKey: accountKey(account) }));
  const orderedOperations = operationOrder.filter((operation) =>
    children.some((child) => child.operation === operation),
  );
  const adapterRevisions = Object.fromEntries(
    children.map((child) => [child.adapterId, child.adapterRevision]),
  );
  return {
    schemaVersion: 1,
    runId: input.runId,
    prepareRequestSha256: rewardRunPrepareRequestSha256(input.request),
    walletPrincipal: input.facts.walletPrincipal,
    managerPrincipal: input.facts.managerPrincipal,
    pox5Contract: input.facts.pox5Contract,
    sbtcTokenContract: input.facts.sbtcTokenContract,
    sbtcRegistryContract: input.facts.sbtcRegistryContract,
    network: input.facts.network,
    chainId: input.facts.chainId,
    cycle: input.facts.cycle,
    distribution: input.facts.distribution,
    orderedOperations,
    accounts,
    reviewedTotalSats: accounts
      .reduce((total, account) => total + BigInt(account.maximumGrossSats), 0n)
      .toString(),
    reviewedPaymentCount: accounts.length,
    maxTransactions,
    feeCapUstx: input.feeCapUstx.toString(),
    gasBudgetUstx: (input.feeCapUstx * BigInt(children.length)).toString(),
    managerSourceFingerprint: input.facts.managerSourceFingerprint,
    pox5SourceFingerprint: input.facts.pox5SourceFingerprint,
    adapterRevisions,
    children,
    preparedAnchor: input.facts.preparedAnchor,
  };
}

export class RewardRunService {
  readonly #options: RewardRunServiceOptions;
  #tail: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(options: RewardRunServiceOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#closed || this.#timer) return;
    await this.recover();
    this.#timer = setInterval(() => {
      void this.recover().catch((error) =>
        this.#options.logger?.warn(`Reward-run recovery tick failed: ${String(error)}`),
      );
    }, this.#options.pollIntervalMs ?? 5_000);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async prepare(request: RewardRunPrepareRequest): Promise<RewardRun> {
    const runId = request.requestId ?? randomUUID();
    const requestSha256 = rewardRunPrepareRequestSha256(request);
    const existing = this.#options.repository.get(runId);
    if (existing) {
      this.#assertSealedRun(existing);
      if (existing.recipe.prepareRequestSha256 !== requestSha256) {
        throw new RewardRunError(
          "reward_run_conflict",
          "This reward-run request ID was already used with different preparation inputs",
        );
      }
      return existing;
    }
    if (!this.#options.signer.gasWalletSignerReady()) {
      throw new RewardRunError(
        "reward_run_unavailable",
        "Enable and fund the gas wallet before preparing a reward run",
      );
    }
    const facts = await this.#options.facts(request);
    const recipe = buildRewardRunRecipe({
      runId,
      facts,
      request,
      feeCapUstx: this.#options.maximumFeeUstx,
      maximumTransactions: this.#options.maximumTransactions ?? 200,
    });
    const recipeSha256 = rewardRunRecipeSha256(recipe);
    const now = this.#now();
    const approvalExpiresAt = new Date(
      now.getTime() + (this.#options.approvalStartMinutes ?? 30) * 60_000,
    ).toISOString();
    try {
      return this.#options.repository.insert({
        runId,
        walletPrincipal: facts.walletPrincipal,
        recipeSha256,
        recipe,
        approvalExpiresAt,
        children: recipe.children.map((child) => ({
          operation: child.operation,
          adapterId: child.adapterId,
          adapterRevision: child.adapterRevision,
          accountKey: child.accountKey,
          maximumAmountSats: child.maximumAmountSats,
        })),
        now: now.toISOString(),
      });
    } catch (error) {
      const raced = this.#options.repository.get(runId);
      if (raced?.recipe.prepareRequestSha256 === requestSha256) return raced;
      throw new RewardRunError("reward_run_conflict", String(error));
    }
  }

  get(runId: string): RewardRun {
    const run = this.#options.repository.get(runId);
    if (!run) throw new RewardRunError("reward_run_not_found", "Reward run does not exist");
    this.#assertSealedRun(run);
    return run;
  }

  list(limit = 20): RewardRun[] {
    const runs = this.#options.repository.list(limit);
    for (const run of runs) this.#assertSealedRun(run);
    return runs;
  }

  async approve(runId: string, recipeSha256: string): Promise<RewardRun> {
    const now = this.#now();
    const run = this.get(runId);
    if (run.recipeSha256 !== recipeSha256) {
      throw new RewardRunError(
        "reward_run_invalid",
        "Run approval does not match the sealed recipe",
      );
    }
    if (run.status !== "awaiting-approval") {
      if (run.status === "expired") {
        throw new RewardRunError("reward_run_expired", "The run approval window elapsed");
      }
      return run;
    }
    if (Date.parse(run.approvalExpiresAt) <= now.getTime()) {
      this.#options.repository.transition({
        runId,
        from: ["awaiting-approval"],
        to: "expired",
        now: now.toISOString(),
        completedAt: now.toISOString(),
        failureReason: "Approval start window elapsed",
      });
      throw new RewardRunError("reward_run_expired", "The run approval window elapsed");
    }
    await this.#assertDedicatedWallet(run.walletPrincipal, now);
    let approved: RewardRun;
    try {
      approved = this.#options.repository.transition({
        runId,
        from: ["awaiting-approval"],
        to: "approved",
        now: now.toISOString(),
        approvedAt: now.toISOString(),
      });
    } catch (error) {
      const raced = this.get(runId);
      if (raced.status === "expired") {
        throw new RewardRunError("reward_run_expired", "The run approval window elapsed");
      }
      if (raced.recipeSha256 === recipeSha256 && raced.status !== "awaiting-approval") {
        return raced;
      }
      throw new RewardRunError("reward_run_conflict", String(error));
    }
    void this.#queue(() => this.#guardedTick(runId));
    return approved;
  }

  pause(runId: string): RewardRun {
    const now = this.#now().toISOString();
    const run = this.get(runId);
    if (run.progress.inFlight > 0) {
      throw new RewardRunError(
        "reward_run_conflict",
        "A broadcast transaction must resolve before this run can pause",
      );
    }
    return this.#options.repository.transition({
      runId,
      from: ["running"],
      to: "paused",
      now,
    });
  }

  resume(runId: string): RewardRun {
    const now = this.#now();
    const run = this.get(runId);
    if (run.runtimeExpiresAt && Date.parse(run.runtimeExpiresAt) <= now.getTime()) {
      this.#options.repository.transition({
        runId,
        from: ["paused", "halted"],
        to: "expired",
        now: now.toISOString(),
        completedAt: now.toISOString(),
        failureReason: "Maximum run time elapsed",
      });
      throw new RewardRunError("reward_run_expired", "The maximum run time elapsed");
    }
    const child = run.children[run.cursor];
    if (run.status === "halted" && child?.status === "halted") {
      // A deterministic node rejection proves no transaction was accepted. Retrying is therefore
      // permitted only after this explicit operator action, never from the background loop.
      this.#options.repository.resetRejectedChild(runId, child.index, now.toISOString());
    }
    const resumed = this.#options.repository.transition({
      runId,
      from: ["paused", "halted"],
      to: "running",
      now: now.toISOString(),
    });
    void this.#queue(() => this.#guardedTick(runId));
    return resumed;
  }

  cancel(runId: string): RewardRun {
    const run = this.get(runId);
    if (run.progress.inFlight > 0) {
      throw new RewardRunError(
        "reward_run_conflict",
        "A broadcast transaction must resolve before this run can be cancelled",
      );
    }
    const now = this.#now().toISOString();
    return this.#options.repository.transition({
      runId,
      from: ["awaiting-approval", "approved", "paused", "halted"],
      to: "cancelled",
      now,
      completedAt: now,
    });
  }

  async recover(): Promise<void> {
    for (const run of this.#options.repository.list(200).reverse()) {
      const now = this.#now();
      if (
        ["paused", "halted"].includes(run.status) &&
        run.runtimeExpiresAt &&
        Date.parse(run.runtimeExpiresAt) <= now.getTime()
      ) {
        this.#options.repository.transition({
          runId: run.runId,
          from: [run.status],
          to: "expired",
          now: now.toISOString(),
          completedAt: now.toISOString(),
          failureReason: "Maximum run time elapsed",
        });
        continue;
      }
      if (["approved", "running"].includes(run.status)) {
        await this.#queue(() => this.#guardedTick(run.runId));
      }
      if (
        run.status === "awaiting-approval" &&
        Date.parse(run.approvalExpiresAt) <= now.getTime()
      ) {
        const expiredAt = now.toISOString();
        this.#options.repository.transition({
          runId: run.runId,
          from: ["awaiting-approval"],
          to: "expired",
          now: expiredAt,
          completedAt: expiredAt,
          failureReason: "Approval start window elapsed",
        });
      }
    }
  }

  async #tick(runId: string): Promise<void> {
    let run = this.get(runId);
    const now = this.#now();
    if (run.status === "approved") {
      const runtimeExpiresAt = new Date(
        now.getTime() + (this.#options.maximumRunHours ?? 6) * 60 * 60_000,
      ).toISOString();
      run = this.#options.repository.transition({
        runId,
        from: ["approved"],
        to: "running",
        now: now.toISOString(),
        startedAt: now.toISOString(),
        runtimeExpiresAt,
      });
    }
    if (run.status !== "running") return;
    if (run.runtimeExpiresAt && Date.parse(run.runtimeExpiresAt) <= now.getTime()) {
      this.#options.repository.transition({
        runId,
        from: ["running"],
        to: "expired",
        now: now.toISOString(),
        completedAt: now.toISOString(),
        failureReason: "Maximum run time elapsed",
      });
      return;
    }
    const child = run.children[run.cursor];
    if (!child) {
      this.#options.repository.transition({
        runId,
        from: ["running"],
        to: "completed",
        now: now.toISOString(),
        completedAt: now.toISOString(),
      });
      return;
    }
    if (child.status === "materialized") {
      const attempts = this.#options.repository.attempts(runId, child.index);
      if (attempts.length > 0) {
        const attempt = attempts.at(-1) as (typeof attempts)[number];
        this.#options.repository.updateChild({
          runId,
          childIndex: child.index,
          from: ["materialized"],
          to: "broadcast",
          now: now.toISOString(),
          txid: attempt.precomputedTxid,
          provenance: "you",
          failureReason: "Submission may have started before Sidekick restarted",
        });
        this.#halt(
          run,
          "Sidekick restarted after signing began; resume to reconcile the saved transaction ID",
        );
        return;
      }
      // No signed attempt exists, so discarding stale bytes and rebuilding from current facts is safe.
      this.#options.repository.resetUnattemptedMaterializedChild(
        runId,
        child.index,
        now.toISOString(),
      );
      return;
    }
    if (child.status === "broadcast" && child.txid) {
      const plan = this.#options.repository.childPlan(runId, child.index);
      if (!plan) {
        this.#halt(run, "Broadcast child is missing its sealed plan");
        return;
      }
      const reconciliation = await this.#options.driver.reconcile({
        run,
        child,
        plan,
        txid: child.txid as `0x${string}`,
      });
      if (reconciliation.status === "pending") return;
      if (reconciliation.status === "halt") {
        this.#halt(run, reconciliation.reason);
        return;
      }
      const status = reconciliation.status === "confirmed" ? "confirmed" : "externally-completed";
      this.#options.repository.updateChild({
        runId,
        childIndex: child.index,
        from: ["broadcast"],
        to: status,
        now: now.toISOString(),
        provenance: status === "confirmed" ? "you" : "another-caller",
      });
      const attempts = this.#options.repository.attempts(runId, child.index);
      const attempt = attempts.at(-1);
      if (attempt && status === "confirmed") {
        this.#options.repository.updateAttempt({
          runId,
          childIndex: child.index,
          attemptIndex: attempt.attemptIndex,
          state: "confirmed",
          now: now.toISOString(),
        });
      }
      const paidFee = attempt ? BigInt(attempt.feeUstx) : 0n;
      this.#options.repository.advanceCursor(
        runId,
        run.cursor,
        (BigInt(run.gasSpentUstx) + paidFee).toString(),
        now.toISOString(),
      );
      return;
    }
    if (["confirmed", "externally-completed", "skipped"].includes(child.status)) {
      this.#options.repository.advanceCursor(
        runId,
        run.cursor,
        run.gasSpentUstx,
        now.toISOString(),
      );
      return;
    }
    await this.#assertDedicatedWallet(run.walletPrincipal, now);
    const materialized = await this.#options.driver.materialize({ run, child });
    if (materialized.status === "skip") {
      this.#options.repository.updateChild({
        runId,
        childIndex: child.index,
        from: ["pending"],
        to: "skipped",
        now: now.toISOString(),
        provenance: materialized.provenance,
        failureReason: materialized.reason,
      });
      this.#options.repository.advanceCursor(
        runId,
        run.cursor,
        run.gasSpentUstx,
        now.toISOString(),
      );
      return;
    }
    if (materialized.status === "halt") {
      this.#halt(run, materialized.reason);
      return;
    }
    this.#assertPlan(run, child, materialized.plan, materialized.amountSats);
    const plannedFee = BigInt(materialized.plan.material.transaction.feeUstx);
    if (BigInt(run.gasSpentUstx) + plannedFee > BigInt(run.recipe.gasBudgetUstx)) {
      this.#halt(run, "The approved gas budget would be exceeded");
      return;
    }
    const storedChild = this.#options.repository.materializeChild({
      runId,
      childIndex: child.index,
      plan: materialized.plan,
      amountSats: materialized.amountSats,
      now: now.toISOString(),
    });
    // Adapter reads and fee estimation may take long enough for this role to change, so repeat the
    // dedicated-key refusal check at the actual signature boundary.
    await this.#assertDedicatedWallet(run.walletPrincipal, this.#now());
    const signed = await this.#sign(storedChild.operation, materialized.plan);
    const fee = BigInt(signed.fee);
    if (fee !== plannedFee) {
      throw new RewardRunError(
        "reward_run_invalid",
        "Signed child fee differs from its sealed plan",
      );
    }
    const attempt = this.#options.repository.insertAttempt({
      runId,
      childIndex: child.index,
      precomputedTxid: signed.precomputedTxid,
      nonce: signed.nonce,
      feeUstx: signed.fee,
      state: "signed",
      now: now.toISOString(),
    });
    const result = await this.#options.driver.broadcast(signed);
    const at = this.#now().toISOString();
    if (result.status === "deterministic-rejection") {
      this.#options.repository.updateAttempt({
        runId,
        childIndex: child.index,
        attemptIndex: attempt.attemptIndex,
        state: "rejected",
        broadcastResult: result,
        now: at,
      });
      this.#options.repository.updateChild({
        runId,
        childIndex: child.index,
        from: ["materialized"],
        to: "halted",
        now: at,
        txid: result.txid ?? signed.precomputedTxid,
        failureReason: result.nodeMessage ?? "The node rejected the transaction",
      });
      this.#halt(run, result.nodeMessage ?? "The node rejected the transaction");
      return;
    }
    this.#options.repository.updateAttempt({
      runId,
      childIndex: child.index,
      attemptIndex: attempt.attemptIndex,
      state: result.status === "accepted" ? "accepted" : "ambiguous",
      broadcastResult: result,
      now: at,
    });
    this.#options.repository.updateChild({
      runId,
      childIndex: child.index,
      from: ["materialized"],
      to: "broadcast",
      now: at,
      txid: result.txid,
      provenance: "you",
    });
    // Ambiguous submission is never retried. The operator can resume only after reconciliation.
    if (result.status === "ambiguous")
      this.#halt(this.get(runId), "Broadcast outcome is ambiguous");
  }

  #assertPlan(
    run: RewardRun,
    child: RewardRunChild,
    plan: RewardOperationPlan,
    amountSats: string | null,
  ): void {
    const material = plan.material;
    if (
      material.authorization.kind !== "operator-run" ||
      material.authorization.runId !== run.runId ||
      material.authorization.recipeSha256 !== run.recipeSha256 ||
      material.kind !== child.operation ||
      material.adapter.id !== run.recipe.children[child.index]?.adapterId ||
      material.adapter.revision !== run.recipe.children[child.index]?.adapterRevision ||
      material.network.kind !== run.recipe.network ||
      material.network.chainId !== run.recipe.chainId ||
      material.sender.principal !== run.walletPrincipal ||
      material.managerSourceFingerprint !== run.recipe.managerSourceFingerprint ||
      material.chainAnchor.stacksBlockHeight < run.recipe.preparedAnchor.stacksBlockHeight ||
      material.chainAnchor.burnBlockHeight < run.recipe.preparedAnchor.burnBlockHeight ||
      BigInt(material.transaction.feeUstx) > BigInt(run.recipe.feeCapUstx)
    ) {
      throw new RewardRunError("reward_run_invalid", "Materialized child is outside its recipe");
    }
    const recipeChild = run.recipe.children[child.index];
    if (!recipeChild) throw new RewardRunError("reward_run_invalid", "Recipe child is missing");
    if ((recipeChild.maximumAmountSats === null) !== (amountSats === null)) {
      throw new RewardRunError(
        "reward_run_invalid",
        "Materialized child amount does not match its recipe shape",
      );
    }
    if (
      recipeChild.maximumAmountSats !== null &&
      amountSats !== null &&
      BigInt(amountSats) > BigInt(recipeChild.maximumAmountSats)
    ) {
      throw new RewardRunError(
        "reward_run_invalid",
        "Materialized child exceeds the approved account amount",
      );
    }
    switch (material.kind) {
      case "calculate-rewards":
        if (
          material.pox5Contract !== run.recipe.pox5Contract ||
          material.targetRewardCycle !== String(run.recipe.cycle) ||
          material.targetCheckpoint !==
            (run.recipe.distribution === 1 ? "first-half" : "second-half")
        ) {
          throw new RewardRunError("reward_run_invalid", "Calculation target is not in the recipe");
        }
        break;
      case "claim-rewards":
        if (
          material.managerContract !== run.recipe.managerPrincipal ||
          material.pox5Contract !== run.recipe.pox5Contract ||
          material.sbtcTokenContract !== run.recipe.sbtcTokenContract ||
          material.rewardCycle !== String(run.recipe.cycle) ||
          material.expectedEffect.amountSats !== amountSats
        ) {
          throw new RewardRunError("reward_run_invalid", "Manager collect is not in the recipe");
        }
        break;
      case "claim-staker-rewards": {
        const account = run.recipe.accounts.find(
          (candidate) => candidate.accountKey === recipeChild.accountKey,
        );
        if (
          !account ||
          material.managerContract !== run.recipe.managerPrincipal ||
          material.sbtcTokenContract !== run.recipe.sbtcTokenContract ||
          recipeChild.stakerPrincipal !== material.stakerPrincipal ||
          recipeChild.accountKey !==
            `${material.stakerPrincipal}:${material.rewardCycle}:${material.bondIndex ?? "stx"}` ||
          material.rewardCycle !== String(account.rewardCycle) ||
          material.bondIndex !== account.bondIndex ||
          material.payoutRoute !== account.payoutRoute ||
          material.grossSats !== amountSats
        ) {
          throw new RewardRunError("reward_run_invalid", "Staker payment is not in the recipe");
        }
        break;
      }
      case "settle-accepted-withdrawal":
        if (
          material.managerContract !== run.recipe.managerPrincipal ||
          recipeChild.requestId !== material.requestId ||
          recipeChild.stakerPrincipal !== material.stakerPrincipal
        ) {
          throw new RewardRunError(
            "reward_run_invalid",
            "Withdrawal settlement is not in the recipe",
          );
        }
        break;
      case "reclaim-failed-withdrawal":
        if (
          material.managerContract !== run.recipe.managerPrincipal ||
          material.sbtcTokenContract !== run.recipe.sbtcTokenContract ||
          recipeChild.requestId !== material.requestId ||
          recipeChild.stakerPrincipal !== material.stakerPrincipal ||
          recipeChild.withdrawalAmountSats !== material.withdrawalAmountSats ||
          recipeChild.maxFeeSats !== material.maxFeeSats ||
          amountSats !==
            (BigInt(material.withdrawalAmountSats) + BigInt(material.maxFeeSats)).toString()
        ) {
          throw new RewardRunError("reward_run_invalid", "Withdrawal reclaim is not in the recipe");
        }
        break;
    }
  }

  async #sign(
    operation: RewardRunOperation,
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction> {
    switch (operation) {
      case "calculate-rewards":
        return await this.#options.signer.signPox5CalculateRewardsPlan(plan);
      case "claim-rewards":
        return await this.#options.signer.signManagerClaimRewardsRunPlan(plan);
      case "claim-staker-rewards":
        return await this.#options.signer.signClaimStakerRewardsPlan(plan);
      case "settle-accepted-withdrawal":
        return await this.#options.signer.signSettleAcceptedWithdrawalPlan(plan);
      case "reclaim-failed-withdrawal":
        return await this.#options.signer.signReclaimFailedWithdrawalPlan(plan);
    }
  }

  async #assertDedicatedWallet(principal: string, now: Date): Promise<void> {
    const refusal = await this.#options.refusalChecks(principal, now);
    if (refusal.refusalReason !== null) {
      throw new RewardRunError(
        "reward_run_refused",
        `The gas wallet failed its per-transaction refusal check (${refusal.refusalReason})`,
      );
    }
  }

  #assertSealedRun(run: RewardRun): void {
    const recipeChildrenMatch =
      run.recipe.children.length === run.children.length &&
      run.recipe.children.every((recipeChild, index) => {
        const child = run.children[index];
        return (
          child?.index === recipeChild.index &&
          child.operation === recipeChild.operation &&
          child.accountKey === recipeChild.accountKey &&
          child.maximumAmountSats === recipeChild.maximumAmountSats
        );
      });
    if (
      run.recipe.runId !== run.runId ||
      run.recipe.walletPrincipal !== run.walletPrincipal ||
      rewardRunRecipeSha256(run.recipe) !== run.recipeSha256 ||
      !recipeChildrenMatch
    ) {
      throw new RewardRunError(
        "reward_run_invalid",
        "Stored reward run failed its integrity check",
      );
    }
  }

  #halt(run: RewardRun, reason: string): void {
    const now = this.#now().toISOString();
    this.#options.repository.transition({
      runId: run.runId,
      from: ["running"],
      to: "halted",
      now,
      failureReason: reason,
    });
  }

  async #guardedTick(runId: string): Promise<void> {
    try {
      await this.#tick(runId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const current = this.#options.repository.get(runId);
      if (current?.status === "running") this.#halt(current, reason);
      this.#options.logger?.warn(`Reward run ${runId} halted: ${reason}`);
    }
  }

  async #queue(operation: () => Promise<void>): Promise<void> {
    if (this.#closed) return;
    const previous = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (!this.#closed) await operation();
    } finally {
      release?.();
    }
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}
