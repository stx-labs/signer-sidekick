import { cvToHex, noneCV, someCV, tupleCV, uintCV } from "@stacks/transactions";
import type {
  ManagerCapabilities,
  RewardRunOperation,
  RewardRunPrepareRequest,
} from "@stx-labs/signer-sidekick-api-contracts";
import {
  decodeEarnedStakerRewards,
  decodeOptionalPrincipal,
  decodeOptionalUInt,
  decodePoxAddressPreference,
  decodeUInt,
  encodeOptionalUIntHex,
  encodePrincipalHex,
  encodeUIntHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import { bondPeriodsForRewardCycle } from "@stx-labs/signer-sidekick-protocol/pox5-bonds";
import {
  planRewardOperation,
  type RewardOperationPlanInput,
} from "@stx-labs/signer-sidekick-protocol/reward-operation-plan";
import { proveCanonicalNodeBlock } from "../canonical-node-block.js";
import type { ChainAnchor } from "../chain-anchor.js";
import { captureNodeChainAnchor } from "../chain-clients.js";
import { managerActionCapability } from "../manager-capabilities.js";
import {
  Pox5CalculateRewardsError,
  readPox5CalculateRewardsObservation,
} from "../pox5-calculate-rewards.js";
import type { WithdrawalRegistryStatus } from "../reward-ledger.js";
import type { SidekickStore } from "../storage/store.js";
import {
  type FeeSelection,
  selectTransactionFee,
  type TransactionFeePolicy,
} from "./fee-policy.js";
import {
  type LiveObservation,
  LiveTransactionReader,
  type TransactionFeeObservation,
} from "./live-transaction-reader.js";
import type {
  RewardRunDraftFacts,
  RewardRunDriver,
  RewardRunMaterialization,
  RewardRunReconciliation,
} from "./reward-run-service.js";
import type {
  SidekickTransactionEngineRuntime,
  TransactionEngineRuntimeContext,
} from "./runtime.js";
import { NoRetryTransactionBroadcaster } from "./transaction-broadcaster.js";

const SBTC_WITHDRAWAL_DUST_LIMIT = 546n;
const MANAGER_OPERATIONS = new Set([
  "claim-rewards",
  "claim-staker-rewards",
  "settle-accepted-withdrawal",
  "reclaim-failed-withdrawal",
]);

export function reviewedRewardManagerAvailable(
  capabilities: ManagerCapabilities,
  sourceSha256: string,
): boolean {
  const capability = managerActionCapability(capabilities, "reference-reward-claims");
  return capability.executionAvailable && capability.adapter?.reviewedSourceSha256 === sourceSha256;
}

/** Fee for one reward-run child under the engine's fee policy; see `selectTransactionFee`. */
export function selectRewardRunFee(
  estimate: LiveObservation<TransactionFeeObservation> | null,
  policy: TransactionFeePolicy,
): FeeSelection {
  return selectTransactionFee(estimate, policy);
}

interface StakerClaimsPage {
  rewardCycle: number;
  page: { nextCursor: string | null; stakersTotal: number };
  candidates: Array<{
    stakerPrincipal: string;
    bondIndex: string | null;
    payout: { kind: "direct-sbtc" | "bitcoin-l1"; maxFeeSats: string | null };
    rewards: { earnedSats: string; feeSats: string; grossSats: string };
    claimable: boolean;
  }>;
}

export interface LiveRewardRunFactsOptions {
  engine: Pick<SidekickTransactionEngineRuntime, "readRewardRunObservation" | "gasPayerIdentity">;
  store: SidekickStore;
  managerPrincipal: string;
  runtimeContext: () => TransactionEngineRuntimeContext;
  stakerClaims(options: {
    offset?: number;
    limit?: number;
    rewardCycle: number;
    bondIndices: readonly bigint[];
    chainAnchor: ChainAnchor;
  }): Promise<StakerClaimsPage>;
  withdrawalRequestStatus(
    registryContract: string,
    requestId: string,
    tip: string,
  ): Promise<WithdrawalRegistryStatus>;
  maximumAccounts?: number;
  /** Receives each preparation stage's duration so slow reads are attributable in the logs. */
  onStage?: (stage: string, durationMs: number) => void;
}

/**
 * Which chain reads a prepare request needs. A collect-only run must not pay for the per-account
 * claim scan or the withdrawal registry; a payout run needs the bond periods the collect read
 * provides, but not the calculation target.
 */
export function factReadsForOperations(operations: readonly RewardRunOperation[] | undefined): {
  calculate: boolean;
  collect: boolean;
  accounts: boolean;
  withdrawals: boolean;
} {
  const selected = new Set(
    operations ?? [
      "calculate-rewards",
      "claim-rewards",
      "claim-staker-rewards",
      "settle-accepted-withdrawal",
      "reclaim-failed-withdrawal",
    ],
  );
  return {
    calculate: selected.has("calculate-rewards"),
    collect: selected.has("claim-rewards") || selected.has("claim-staker-rewards"),
    accounts: selected.has("claim-staker-rewards"),
    withdrawals:
      selected.has("settle-accepted-withdrawal") || selected.has("reclaim-failed-withdrawal"),
  };
}

function checkpointDistribution(checkpoint: "first-half" | "second-half"): 1 | 2 {
  return checkpoint === "first-half" ? 1 : 2;
}

const registryLookupConcurrency = 8;

async function managerCollectAtAnchor(input: {
  context: TransactionEngineRuntimeContext;
  pox5Contract: string;
  managerPrincipal: string;
  rewardCycle: number;
  chainAnchor: ChainAnchor;
}): Promise<{ bondPeriods: bigint[]; totalSats: bigint }> {
  const readOptions = { tip: input.chainAnchor.indexBlockHash };
  const firstBondCycle = decodeUInt(
    await input.context.node.callReadOnly(
      input.pox5Contract,
      "bond-period-to-reward-cycle",
      input.managerPrincipal,
      [encodeUIntHex(0n)],
      readOptions,
    ),
    "bond-period-to-reward-cycle",
  );
  const bondPeriods = bondPeriodsForRewardCycle(BigInt(input.rewardCycle), firstBondCycle);
  const earned = await Promise.all(
    [null, ...bondPeriods].map(async (bondIndex) =>
      decodeUInt(
        await input.context.node.callReadOnly(
          input.pox5Contract,
          "get-earned",
          input.managerPrincipal,
          [
            encodePrincipalHex(input.managerPrincipal),
            encodeUIntHex(BigInt(input.rewardCycle)),
            encodeOptionalUIntHex(bondIndex),
          ],
          readOptions,
        ),
        `get-earned(${bondIndex ?? "stx"})`,
      ),
    ),
  );
  return {
    // PoX-5 accepts up to six periods and ignores zero-earned candidates. Supplying the complete
    // deterministic overlap window prevents a later fee from being pinned for an omitted bucket.
    bondPeriods,
    totalSats: earned.reduce((total, value) => total + value, 0n),
  };
}

export function calculationResultMatchesTarget(
  resultRepr: string,
  targetRewardCycle: string,
  expectedLastRewardComputeBurnHeight: number,
): boolean {
  const cycle = resultRepr.match(/\(stx-cycle u(\d+)\)/)?.[1];
  const height = resultRepr.match(/\(calculation-height u(\d+)\)/)?.[1];
  return cycle === targetRewardCycle && height === String(expectedLastRewardComputeBurnHeight);
}

/** Build the exact account/request universe from current node-anchored facts, never request data. */
export function createLiveRewardRunFacts(options: LiveRewardRunFactsOptions) {
  return async (request: RewardRunPrepareRequest): Promise<RewardRunDraftFacts> => {
    const startedAt = Date.now();
    let stageStartedAt = startedAt;
    const stage = (name: string) => {
      const now = Date.now();
      options.onStage?.(name, now - stageStartedAt);
      stageStartedAt = now;
    };
    const reads = factReadsForOperations(request.operations);
    const observation = await options.engine.readRewardRunObservation();
    stage("observation");
    const { setup } = observation;
    const wallet = options.engine.gasPayerIdentity();
    if (!wallet) throw new Error("No active gas wallet identity");
    const pox5Contract = setup.preflight.pox.pox5ContractId;
    const sbtcTokenContract = setup.preflight.pox.sbtcTokenContract;
    const sbtcRegistryContract = setup.preflight.pox.sbtcRegistryContract;
    const pox5SourceFingerprint = setup.preflight.pox.sourceSha256;
    const managerSourceFingerprint = setup.manager.source.sha256;
    if (
      !pox5Contract ||
      !sbtcTokenContract ||
      !sbtcRegistryContract ||
      !pox5SourceFingerprint ||
      !managerSourceFingerprint
    ) {
      throw new Error("Reviewed PoX-5 and manager source bindings are required for operator-run");
    }
    const requestedOperations = request.operations ?? [
      "calculate-rewards",
      "claim-rewards",
      "claim-staker-rewards",
      "settle-accepted-withdrawal",
      "reclaim-failed-withdrawal",
    ];
    if (
      requestedOperations.some((operation) => MANAGER_OPERATIONS.has(operation)) &&
      !reviewedRewardManagerAvailable(setup.manager.capabilities, managerSourceFingerprint)
    ) {
      throw new Error("Manager reward execution requires a byte-exact reviewed adapter");
    }
    const context = options.runtimeContext();
    const chainAnchor = await captureNodeChainAnchor(context.node);
    stage("anchor");
    let calculateRequired = false;
    if (reads.calculate) {
      try {
        const calculation = await readPox5CalculateRewardsObservation({
          node: context.node,
          pox5ContractId: pox5Contract,
          sender: wallet.principal,
          chainAnchor,
          firstRewardCycleId: setup.preflight.pox.firstRewardCycleId,
        });
        calculateRequired =
          calculation.targetRewardCycle === request.cycle &&
          checkpointDistribution(calculation.targetCheckpoint) === request.distribution;
      } catch (error) {
        if (!(error instanceof Pox5CalculateRewardsError) || error.code !== "already-computed") {
          throw error;
        }
      }
      stage("calculation");
    }
    const collect = reads.collect
      ? await managerCollectAtAnchor({
          context,
          pox5Contract,
          managerPrincipal: options.managerPrincipal,
          rewardCycle: request.cycle,
          chainAnchor,
        })
      : { bondPeriods: [], totalSats: 0n };
    if (reads.collect) stage("collect");
    const collectRequired = collect.totalSats > 0n;
    const accounts: RewardRunDraftFacts["accounts"][number][] = [];
    let eligibleAccountCount = 0;
    let offset = 0;
    const maximumAccounts = options.maximumAccounts ?? 200;
    while (reads.accounts) {
      const page = await options.stakerClaims({
        offset,
        limit: 100,
        rewardCycle: request.cycle,
        bondIndices: collect.bondPeriods,
        chainAnchor,
      });
      if (page.rewardCycle !== request.cycle) {
        throw new Error("Reward claim discovery changed cycles while sealing the recipe");
      }
      for (const candidate of page.candidates) {
        // Before the manager collects, PoX-5 already proves the gross account entitlement but the
        // manager correctly labels it unclaimable until the fee snapshot and reserve are locked.
        // The recipe needs that gross ceiling now; last-moment materialization still requires the
        // fee snapshot and manager reserve before it can sign the payment.
        if (BigInt(candidate.rewards.grossSats) === 0n) continue;
        eligibleAccountCount += 1;
        if (accounts.length < maximumAccounts) {
          accounts.push({
            stakerPrincipal: candidate.stakerPrincipal,
            rewardCycle: page.rewardCycle,
            bondIndex: candidate.bondIndex,
            maximumGrossSats: candidate.rewards.grossSats,
            payoutRoute: candidate.payout.kind,
          });
        }
      }
      if (page.page.nextCursor === null) break;
      offset = Number(page.page.nextCursor);
    }
    if (reads.accounts) stage("accounts");
    const withdrawals: RewardRunDraftFacts["withdrawals"][number][] = [];
    const eligibleWithdrawalCounts = { accepted: 0, rejected: 0 };
    let withdrawalOffset = 0;
    while (reads.withdrawals) {
      const page = options.store.listManagerWithdrawals(
        setup.preflight.node.networkId,
        options.managerPrincipal,
        {
          limit: 200,
          offset: withdrawalOffset,
          state: "pending",
          sort: "request",
          direction: "asc",
        },
      );
      // Registry lookups are independent; bound the fan-out so a long pending queue stays quick.
      for (let index = 0; index < page.items.length; index += registryLookupConcurrency) {
        const batch = page.items.slice(index, index + registryLookupConcurrency);
        const states = await Promise.all(
          batch.map((withdrawal) =>
            options.withdrawalRequestStatus(
              sbtcRegistryContract,
              withdrawal.requestId,
              chainAnchor.indexBlockHash,
            ),
          ),
        );
        batch.forEach((withdrawal, offsetInBatch) => {
          const state = states[offsetInBatch];
          if (state !== "accepted" && state !== "rejected") return;
          eligibleWithdrawalCounts[state] += 1;
          if (withdrawals.length < maximumAccounts) {
            withdrawals.push({
              requestId: withdrawal.requestId,
              stakerPrincipal: withdrawal.stakerPrincipal,
              state,
              withdrawalAmountSats: withdrawal.amountSats,
              maxFeeSats: withdrawal.maxFeeSats,
              maximumAmountSats: (
                BigInt(withdrawal.amountSats) + BigInt(withdrawal.maxFeeSats)
              ).toString(),
            });
          }
        });
      }
      withdrawalOffset += page.items.length;
      if (withdrawalOffset >= page.total || page.items.length === 0) break;
    }
    if (reads.withdrawals) stage("withdrawals");
    options.onStage?.("total", Date.now() - startedAt);
    return {
      walletPrincipal: wallet.principal,
      managerPrincipal: options.managerPrincipal,
      pox5Contract,
      sbtcTokenContract,
      sbtcRegistryContract,
      network: setup.preflight.network === "mainnet" ? "mainnet" : "testnet",
      chainId: setup.preflight.node.networkId,
      cycle: request.cycle,
      distribution: request.distribution,
      preparedAnchor: {
        stacksBlockHeight: chainAnchor.stacksBlockHeight,
        burnBlockHeight: chainAnchor.burnBlockHeight,
        indexBlockHash: chainAnchor.indexBlockHash as `0x${string}`,
      },
      managerSourceFingerprint,
      pox5SourceFingerprint,
      calculateRequired,
      collectRequired,
      maximumCollectSats: collectRequired ? collect.totalSats.toString() : null,
      eligibleAccountCount,
      eligibleWithdrawalCounts,
      accounts,
      withdrawals,
    };
  };
}

export interface LiveRewardRunDriverOptions {
  engine: Pick<SidekickTransactionEngineRuntime, "readRewardRunObservation" | "gasPayerIdentity">;
  runtimeContext: () => TransactionEngineRuntimeContext;
  /** Live fee policy (Settings → Reward runs band under the deployment cap), read per child. */
  feePolicy: () => TransactionFeePolicy;
  withdrawalRequestStatus(
    registryContract: string,
    requestId: string,
    tip: string,
  ): Promise<WithdrawalRegistryStatus>;
  createReader?: (baseUrl: string) => LiveTransactionReader;
  createBroadcaster?: (baseUrl: string) => NoRetryTransactionBroadcaster;
}

/** Production S4 driver: every call is rebuilt from fresh anchored reads immediately before sign. */
export class LiveRewardRunDriver implements RewardRunDriver {
  constructor(private readonly options: LiveRewardRunDriverOptions) {}

  async materialize(
    input: Parameters<RewardRunDriver["materialize"]>[0],
  ): Promise<RewardRunMaterialization> {
    const context = this.options.runtimeContext();
    await proveCanonicalNodeBlock(context.node, {
      blockHeight: input.run.recipe.preparedAnchor.stacksBlockHeight,
      indexBlockHash: input.run.recipe.preparedAnchor.indexBlockHash as `0x${string}`,
    });
    const wallet = this.options.engine.gasPayerIdentity();
    if (!wallet || wallet.principal !== input.run.walletPrincipal) {
      return { status: "halt", reason: "The loaded gas wallet identity changed" };
    }
    const anchor = await captureNodeChainAnchor(context.node);
    const reader = (
      this.options.createReader ?? ((url) => new LiveTransactionReader({ baseUrl: url }))
    )(context.config.nodeRpcUrl);
    const account = await reader.readAnchoredAccount(wallet.principal, anchor.indexBlockHash);
    if (account.status !== "observed") {
      return { status: "halt", reason: `The gas wallet account read is ${account.status}` };
    }
    const common = {
      authorization: {
        schemaVersion: 2 as const,
        kind: "operator-run" as const,
        runId: input.run.runId,
        recipeSha256: input.run.recipeSha256,
      },
      network: { kind: input.run.recipe.network, chainId: input.run.recipe.chainId },
      chainAnchor: {
        stacksBlockHeight: anchor.stacksBlockHeight,
        burnBlockHeight: anchor.burnBlockHeight,
        indexBlockHash: anchor.indexBlockHash,
      },
      sender: wallet,
      managerSourceFingerprint: input.run.recipe.managerSourceFingerprint,
      nonce: account.value.nonce,
      feeUstx: this.options.feePolicy().maximumFeeUstx,
    } as const;
    const recipeChild = input.run.recipe.children[input.child.index];
    if (!recipeChild) return { status: "halt", reason: "Recipe child is missing" };
    let planInput: RewardOperationPlanInput;
    let amountSats: string | null = recipeChild.maximumAmountSats;
    switch (input.child.operation) {
      case "calculate-rewards": {
        try {
          const observation = await this.options.engine.readRewardRunObservation();
          const calculation = await readPox5CalculateRewardsObservation({
            node: context.node,
            pox5ContractId: input.run.recipe.pox5Contract,
            sender: wallet.principal,
            chainAnchor: anchor,
            firstRewardCycleId: observation.setup.preflight.pox.firstRewardCycleId,
          });
          if (
            calculation.targetRewardCycle !== input.run.recipe.cycle ||
            checkpointDistribution(calculation.targetCheckpoint) !== input.run.recipe.distribution
          ) {
            return { status: "halt", reason: "The reward-calculation target changed" };
          }
          planInput = {
            ...common,
            kind: "calculate-rewards",
            pox5Contract: input.run.recipe.pox5Contract,
            bondPeriods: calculation.activeBonds.map(({ bondIndex }) => BigInt(bondIndex)),
            targetRewardCycle: BigInt(calculation.targetRewardCycle),
            targetCheckpoint: calculation.targetCheckpoint,
            expectedLastRewardComputeBurnHeight: calculation.expectedLastRewardComputeBurnHeight,
          };
          amountSats = null;
        } catch (error) {
          if (error instanceof Pox5CalculateRewardsError && error.code === "already-computed") {
            return {
              status: "skip",
              reason: "Another caller completed the calculation",
              provenance: "another-caller",
            };
          }
          throw error;
        }
        break;
      }
      case "claim-rewards": {
        const claim = await managerCollectAtAnchor({
          context,
          pox5Contract: input.run.recipe.pox5Contract,
          managerPrincipal: input.run.recipe.managerPrincipal,
          rewardCycle: input.run.recipe.cycle,
          chainAnchor: anchor,
        });
        if (claim.totalSats === 0n) {
          return {
            status: "skip",
            reason: "Manager rewards are already collected or no longer claimable",
            provenance: "another-caller",
          };
        }
        planInput = {
          ...common,
          kind: "claim-rewards",
          managerContract: input.run.recipe.managerPrincipal,
          pox5Contract: input.run.recipe.pox5Contract,
          sbtcTokenContract: input.run.recipe.sbtcTokenContract,
          rewardCycle: BigInt(input.run.recipe.cycle),
          bondPeriods: claim.bondPeriods,
          expectedSbtcOutflow: claim.totalSats,
        };
        amountSats = claim.totalSats.toString();
        break;
      }
      case "claim-staker-rewards": {
        if (!recipeChild.stakerPrincipal || recipeChild.accountKey === null) {
          return { status: "halt", reason: "Payment recipe identity is missing" };
        }
        const accountBound = input.run.recipe.accounts.find(
          (candidate) => candidate.accountKey === recipeChild.accountKey,
        );
        if (!accountBound)
          return { status: "halt", reason: "Payment account is not in the recipe" };
        const bondIndex = accountBound.bondIndex === null ? null : BigInt(accountBound.bondIndex);
        const args = [
          encodePrincipalHex(accountBound.stakerPrincipal),
          encodeUIntHex(BigInt(accountBound.rewardCycle)),
          encodeOptionalUIntHex(bondIndex),
        ];
        const readOptions = { tip: anchor.indexBlockHash };
        const [earnedValue, payoutValue, feeValue, unclaimedValue] = await Promise.all([
          context.node.callReadOnly(
            input.run.recipe.managerPrincipal,
            "get-earned-staker-rewards",
            wallet.principal,
            args,
            readOptions,
          ),
          context.node.callReadOnly(
            input.run.recipe.managerPrincipal,
            "get-pox-addr",
            wallet.principal,
            [encodePrincipalHex(accountBound.stakerPrincipal)],
            readOptions,
          ),
          context.node.getMapEntry(
            input.run.recipe.managerPrincipal,
            "fee-bips-for-cycle",
            cvToHex(
              tupleCV({
                "reward-cycle": uintCV(BigInt(accountBound.rewardCycle)),
                "bond-index": bondIndex === null ? noneCV() : someCV(uintCV(bondIndex)),
              }),
            ),
            readOptions,
          ),
          context.node.callReadOnly(
            input.run.recipe.managerPrincipal,
            "get-unclaimed-staker-rewards",
            wallet.principal,
            [],
            readOptions,
          ),
        ]);
        const earned = decodeEarnedStakerRewards(earnedValue);
        if (earned.earned === 0n) {
          return {
            status: "skip",
            reason: "Another caller paid this reward account",
            provenance: "another-caller",
          };
        }
        const feeBips = decodeOptionalUInt(feeValue, "fee-bips-for-cycle");
        const unclaimed = decodeUInt(unclaimedValue, "get-unclaimed-staker-rewards");
        const payout = decodePoxAddressPreference(payoutValue);
        const payoutRoute = payout ? "bitcoin-l1" : "direct-sbtc";
        const gross = earned.earned + earned.fees;
        if (feeBips === null || unclaimed < gross) {
          return {
            status: "halt",
            reason: "The manager fee is not locked for this reward account",
          };
        }
        if (gross > BigInt(accountBound.maximumGrossSats)) {
          return {
            status: "halt",
            reason: "Current entitlement exceeds the approved recipe bound",
          };
        }
        if (payoutRoute !== accountBound.payoutRoute) {
          return { status: "halt", reason: "The approved staker payout route changed" };
        }
        if (
          payout &&
          (earned.earned < payout.maxFee ||
            earned.earned - payout.maxFee <= SBTC_WITHDRAWAL_DUST_LIMIT)
        ) {
          return {
            status: "skip",
            reason: "Bitcoin payout is below its configured fee budget",
            provenance: "policy-exception",
          };
        }
        planInput = {
          ...common,
          kind: "claim-staker-rewards",
          managerContract: input.run.recipe.managerPrincipal,
          sbtcTokenContract: input.run.recipe.sbtcTokenContract,
          stakerPrincipal: accountBound.stakerPrincipal,
          rewardCycle: BigInt(accountBound.rewardCycle),
          bondIndex,
          payoutRoute,
          grossSats: gross,
          feeSats: earned.fees,
          expectedNetSats: earned.earned,
        };
        amountSats = gross.toString();
        break;
      }
      case "settle-accepted-withdrawal":
      case "reclaim-failed-withdrawal": {
        if (!recipeChild.requestId || !recipeChild.stakerPrincipal) {
          return { status: "halt", reason: "Withdrawal recipe identity is missing" };
        }
        const mappedStaker = decodeOptionalPrincipal(
          await context.node.callReadOnly(
            input.run.recipe.managerPrincipal,
            "get-withdrawal-request-staker",
            wallet.principal,
            [encodeUIntHex(BigInt(recipeChild.requestId))],
            { tip: anchor.indexBlockHash },
          ),
          "get-withdrawal-request-staker",
        );
        if (mappedStaker === null) {
          return {
            status: "skip",
            reason: "Another caller already finished this Bitcoin withdrawal",
            provenance: "another-caller",
          };
        }
        if (mappedStaker !== recipeChild.stakerPrincipal) {
          return { status: "halt", reason: "Withdrawal recipient changed" };
        }
        const state = await this.options.withdrawalRequestStatus(
          input.run.recipe.sbtcRegistryContract,
          recipeChild.requestId,
          anchor.indexBlockHash,
        );
        if (
          (input.child.operation === "settle-accepted-withdrawal" && state !== "accepted") ||
          (input.child.operation === "reclaim-failed-withdrawal" && state !== "rejected")
        ) {
          return { status: "halt", reason: `Withdrawal registry state is ${state}` };
        }
        planInput =
          input.child.operation === "settle-accepted-withdrawal"
            ? {
                ...common,
                kind: "settle-accepted-withdrawal",
                managerContract: input.run.recipe.managerPrincipal,
                requestId: BigInt(recipeChild.requestId),
                stakerPrincipal: recipeChild.stakerPrincipal,
              }
            : {
                ...common,
                kind: "reclaim-failed-withdrawal",
                managerContract: input.run.recipe.managerPrincipal,
                sbtcTokenContract: input.run.recipe.sbtcTokenContract,
                requestId: BigInt(recipeChild.requestId),
                stakerPrincipal: recipeChild.stakerPrincipal,
                withdrawalAmountSats: BigInt(recipeChild.withdrawalAmountSats ?? "0"),
                maxFeeSats: BigInt(recipeChild.maxFeeSats ?? "0"),
              };
        amountSats = recipeChild.maximumAmountSats;
        break;
      }
    }
    const draft = await planRewardOperation(planInput);
    let estimate: LiveObservation<TransactionFeeObservation> | null = null;
    try {
      estimate = await reader.estimateUnsignedTransactionFee(draft.unsignedTransactionHex);
    } catch {
      estimate = null;
    }
    const feePolicy = this.options.feePolicy();
    const fee = selectRewardRunFee(estimate, feePolicy).feeUstx;
    if (account.value.balanceUstx < fee) {
      return { status: "halt", reason: "The gas wallet does not cover the next transaction fee" };
    }
    const plan =
      fee === feePolicy.maximumFeeUstx
        ? draft
        : await planRewardOperation({ ...planInput, feeUstx: fee });
    return { status: "plan", plan, amountSats };
  }

  async reconcile(
    input: Parameters<RewardRunDriver["reconcile"]>[0],
  ): Promise<RewardRunReconciliation> {
    const context = this.options.runtimeContext();
    try {
      await proveCanonicalNodeBlock(context.node, {
        blockHeight: input.run.recipe.preparedAnchor.stacksBlockHeight,
        indexBlockHash: input.run.recipe.preparedAnchor.indexBlockHash as `0x${string}`,
      });
    } catch {
      return { status: "halt", reason: "The reward run preparation anchor became noncanonical" };
    }
    const reader = (
      this.options.createReader ?? ((url) => new LiveTransactionReader({ baseUrl: url }))
    )(context.config.nodeRpcUrl);
    const indexed = await reader.lookupIndexedTransaction(input.txid);
    if (indexed.status === "observed") {
      if (!indexed.value.isCanonical)
        return { status: "halt", reason: "Transaction became noncanonical" };
      if (indexed.value.resultRepr.trim().startsWith("(ok")) {
        if (
          input.plan.material.kind === "calculate-rewards" &&
          !calculationResultMatchesTarget(
            indexed.value.resultRepr,
            input.plan.material.targetRewardCycle,
            input.plan.material.expectedLastRewardComputeBurnHeight,
          )
        ) {
          return {
            status: "halt",
            reason: "Confirmed reward calculation does not match the sealed cycle and checkpoint",
          };
        }
        return { status: "confirmed", blockHeight: Number(indexed.value.blockHeight ?? 0n) };
      }
      const completed = await this.#desiredState(input);
      return completed
        ? { status: "externally-completed", reason: "Another caller completed the same operation" }
        : { status: "halt", reason: `Transaction aborted: ${indexed.value.resultRepr}` };
    }
    const unconfirmed = await reader.lookupUnconfirmedTransaction(input.txid);
    if (unconfirmed.status === "observed") return { status: "pending" };
    return { status: "pending" };
  }

  async broadcast(signed: Parameters<RewardRunDriver["broadcast"]>[0]) {
    const context = this.options.runtimeContext();
    const broadcaster = (
      this.options.createBroadcaster ??
      ((url) => new NoRetryTransactionBroadcaster({ baseUrl: url }))
    )(context.config.nodeRpcUrl);
    return await broadcaster.broadcast(signed);
  }

  async #desiredState(input: Parameters<RewardRunDriver["reconcile"]>[0]): Promise<boolean> {
    const context = this.options.runtimeContext();
    const chainAnchor = await captureNodeChainAnchor(context.node);
    const readOptions = { tip: chainAnchor.indexBlockHash };
    const recipeChild = input.run.recipe.children[input.child.index];
    if (!recipeChild) return false;
    switch (input.child.operation) {
      case "calculate-rewards":
        try {
          const observation = await this.options.engine.readRewardRunObservation();
          await readPox5CalculateRewardsObservation({
            node: context.node,
            pox5ContractId: input.run.recipe.pox5Contract,
            sender: input.run.walletPrincipal,
            chainAnchor,
            firstRewardCycleId: observation.setup.preflight.pox.firstRewardCycleId,
          });
          return false;
        } catch (error) {
          return error instanceof Pox5CalculateRewardsError && error.code === "already-computed";
        }
      case "claim-rewards":
        return (
          (
            await managerCollectAtAnchor({
              context,
              pox5Contract: input.run.recipe.pox5Contract,
              managerPrincipal: input.run.recipe.managerPrincipal,
              rewardCycle: input.run.recipe.cycle,
              chainAnchor,
            })
          ).totalSats === 0n
        );
      case "claim-staker-rewards": {
        const account = input.run.recipe.accounts.find(
          (candidate) => candidate.accountKey === recipeChild.accountKey,
        );
        if (!account) return false;
        const settled = decodeEarnedStakerRewards(
          await context.node.callReadOnly(
            input.run.recipe.managerPrincipal,
            "get-earned-staker-rewards",
            input.run.walletPrincipal,
            [
              encodePrincipalHex(account.stakerPrincipal),
              encodeUIntHex(BigInt(account.rewardCycle)),
              encodeOptionalUIntHex(account.bondIndex === null ? null : BigInt(account.bondIndex)),
            ],
            readOptions,
          ),
        );
        return settled.earned === 0n;
      }
      case "settle-accepted-withdrawal":
      case "reclaim-failed-withdrawal":
        return (
          decodeOptionalPrincipal(
            await context.node.callReadOnly(
              input.run.recipe.managerPrincipal,
              "get-withdrawal-request-staker",
              input.run.walletPrincipal,
              [encodeUIntHex(BigInt(recipeChild.requestId ?? "0"))],
              readOptions,
            ),
          ) === null
        );
    }
  }
}
