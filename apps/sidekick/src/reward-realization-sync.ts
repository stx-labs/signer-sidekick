import { ClarityType, type ClarityValue } from "@stacks/transactions";
import { decodeClarityHex } from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import {
  Pox5RewardSimulationError,
  simulatePox5CalculateRewards,
} from "@stx-labs/signer-sidekick-protocol/pox5-calculate-rewards";
import {
  decodePox5CalculateRewardsEvent,
  type Pox5CalculateRewardsEvent,
} from "@stx-labs/signer-sidekick-protocol/pox5-events";
import { z } from "zod";
import {
  checkTransactionInCanonicalBlock,
  proveTransactionInCanonicalBlock,
} from "./canonical-node-block.js";
import { type ChainAnchor, deriveRewardCalculationTarget } from "./chain-anchor.js";
import {
  createChainAnchor,
  type NodeInfo,
  type PoxInfo,
  type SmartContractLogPage,
  type StacksBlockSummary,
  type TransactionSummary,
} from "./chain-clients.js";
import type { ManagerEventNodeBlocks } from "./manager-event-sync.js";
import {
  Pox5CalculateRewardsError,
  readPox5PoolSimulationSnapshot,
} from "./pox5-calculate-rewards.js";
import { evaluateRewardForecast, REWARD_FORECAST_MODEL_REVISION } from "./reward-calibration.js";
import type { RewardStatusNode } from "./reward-status.js";
import type { ChainStateRepository } from "./storage/chain-state-repository.js";
import type {
  ChainCursorInput,
  RewardCalculationRealizationInput,
  StoredRewardCalculationRealization,
  StoredRewardOutlookObservation,
} from "./storage/store.js";
import type {
  IndexedTransactionObservation,
  LiveLookup,
} from "./transaction-engine/live-transaction-reader.js";
import { transactionIndexCannotAnswer } from "./transaction-engine/live-transaction-reader.js";

const cursorStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    apiCursor: z.string().min(1),
    scanHighwaterStacksHeight: z.number().int().nonnegative().safe(),
    stopStacksHeight: z.number().int().nonnegative().safe().nullable(),
    floorBurnHeight: z.number().int().nonnegative().safe(),
  })
  .strict();

interface RewardRealizationApi {
  getSmartContractLogs(
    contractId: string,
    cursor?: string | null,
    limit?: number,
  ): Promise<SmartContractLogPage>;
  getTransaction(txId: string): Promise<TransactionSummary>;
  getBlock(heightOrHash: number | string): Promise<StacksBlockSummary>;
}

interface RewardRealizationNode extends Pick<RewardStatusNode, "callReadOnly"> {
  getInfo(options?: { signal?: AbortSignal }): Promise<NodeInfo>;
  getPoxInfo(options?: {
    tip?: ChainAnchor["indexBlockHash"];
    signal?: AbortSignal;
  }): Promise<PoxInfo>;
}

interface RewardRealizationNodeTransactions {
  lookupIndexedTransaction(txId: string): Promise<LiveLookup<IndexedTransactionObservation>>;
}

export interface RewardRealizationStore {
  chainState: Pick<ChainStateRepository, "getCursor">;
  putRewardCalculationRealizationPage(
    realizations: readonly RewardCalculationRealizationInput[],
    cursor: ChainCursorInput,
  ): void;
  putRewardCalculationRealization(realization: RewardCalculationRealizationInput): void;
  getRewardCalculationRealization(
    chainId: number,
    txId: string,
    eventIndex: number,
  ): StoredRewardCalculationRealization | null;
  listRewardCalculationRealizations(
    managerPrincipal: string,
    pox5ContractId: string,
    options?: { limit?: number; canonicalOnly?: boolean },
  ): StoredRewardCalculationRealization[];
  markRewardRealizationNoncanonical(input: {
    chainId: number;
    txId: string;
    eventIndex: number;
    updatedAt: string;
  }): boolean;
  getRewardEvaluationForecast(
    managerPrincipal: string,
    pox5ContractId: string,
    target: {
      rewardCycle: number;
      checkpoint: "first-half" | "second-half";
      calculationBurnHeight: number;
      modelRevision?: number;
    },
  ): StoredRewardOutlookObservation | null;
  rewardRealizationScanFloor(managerPrincipal: string, pox5ContractId: string): number | null;
}

export interface SyncRewardRealizationsOptions {
  store: RewardRealizationStore;
  api: RewardRealizationApi;
  node: RewardRealizationNode;
  nodeTransactions: RewardRealizationNodeTransactions;
  nodeBlocks: ManagerEventNodeBlocks;
  sourceId: string;
  chainId: number;
  managerPrincipal: string;
  pox5ContractId: string;
  observedAt: string;
  pageLimit?: number;
  maxPages?: number;
  signal?: AbortSignal;
}

export interface SyncRewardRealizationsResult {
  stream: string;
  pagesProcessed: number;
  logsInspected: number;
  calculationsFound: number;
  realizationsStored: number;
  evaluationsStored: number;
  noncanonicalRealizations: number;
  decodeFailures: number;
  caughtUp: boolean;
  skippedReason: "no-forecast-history" | null;
}

export function rewardRealizationStream(pox5ContractId: string): string {
  return `pox5-reward-realizations:v1:${pox5ContractId}`;
}

class RewardCalculationEventDecodeError extends Error {
  constructor(cause: unknown) {
    super("PoX-5 emitted a calculate-rewards print that Sidekick could not decode", { cause });
    this.name = "RewardCalculationEventDecodeError";
  }
}

function isCalculationTopic(value: ClarityValue): boolean {
  if (value.type !== ClarityType.Tuple) return false;
  const topic = value.value.topic;
  return (
    (topic?.type === ClarityType.StringASCII || topic?.type === ClarityType.StringUTF8) &&
    topic.value === "calculate-rewards"
  );
}

function parseCalculationEvent(hex: string): Pox5CalculateRewardsEvent | null {
  const value = decodeClarityHex(hex);
  try {
    return decodePox5CalculateRewardsEvent(value);
  } catch (error) {
    if (isCalculationTopic(value)) throw new RewardCalculationEventDecodeError(error);
    throw error;
  }
}

function targetApiStatus(block: StacksBlockSummary) {
  return {
    server_version: "sidekick-reward-realization-anchor",
    status: "ready",
    chain_tip: {
      block_height: block.height,
      block_hash: block.hash,
      index_block_hash: block.index_block_hash,
      burn_block_height: block.burn_block_height,
    },
  };
}

function assertSimulationMatchesEvent(
  event: Pox5CalculateRewardsEvent,
  simulation: ReturnType<typeof simulatePox5CalculateRewards>,
): void {
  const facts: Array<[string, bigint]> = [
    [event.grossAccruedRewardsSats, simulation.grossAccruedRewardsSats],
    [event.totalBondRewardsSats, simulation.totalBondRewardsSats],
    [event.reserveDepositSats, simulation.reserveDepositSats],
    [event.reserveBalanceSats, simulation.reserveBalanceSats],
    [event.totalStxStakerRewardsSats, simulation.totalStxStakerRewardsSats],
    [event.cycleStakedUstx, simulation.cycleStakedUstx],
    [event.accruedRewardsPerUstx, simulation.accruedRewardsPerUstx],
    [event.cumulativeRewardsPerUstx, simulation.cumulativeRewardsPerUstx],
  ];
  if (facts.some(([observed, calculated]) => BigInt(observed) !== calculated)) {
    throw new Pox5RewardSimulationError(
      "parent-anchored replay does not match the calculate-rewards event",
    );
  }
  if (
    event.bondPeriods.join(":") !==
    simulation.bonds.map(({ bondIndex }) => bondIndex.toString()).join(":")
  ) {
    throw new Pox5RewardSimulationError(
      "parent-anchored bond order does not match the calculate-rewards event",
    );
  }
}

function calculationSharesStable(
  beforeInput: Awaited<ReturnType<typeof readPox5PoolSimulationSnapshot>>["simulationInput"],
  afterInput: Awaited<ReturnType<typeof readPox5PoolSimulationSnapshot>>["simulationInput"],
): boolean {
  if (
    beforeInput.cycleStakedUstx !== afterInput.cycleStakedUstx ||
    beforeInput.managerStxSharesUstx !== afterInput.managerStxSharesUstx ||
    beforeInput.bonds.length !== afterInput.bonds.length
  ) {
    return false;
  }
  const afterBonds = new Map(afterInput.bonds.map((bond) => [bond.bondIndex.toString(), bond]));
  return beforeInput.bonds.every((bond) => {
    const after = afterBonds.get(bond.bondIndex.toString());
    return (
      after !== undefined &&
      after.targetRateBips === bond.targetRateBips &&
      after.stxValueRatio === bond.stxValueRatio &&
      after.totalSharesSats === bond.totalSharesSats &&
      after.managerSharesSats === bond.managerSharesSats
    );
  });
}

async function revalidateCalibrationWindow(
  options: SyncRewardRealizationsOptions,
): Promise<{ invalidated: number; canonical: StoredRewardCalculationRealization[] }> {
  let invalidated = 0;
  const canonical: StoredRewardCalculationRealization[] = [];
  const candidates = options.store.listRewardCalculationRealizations(
    options.managerPrincipal,
    options.pox5ContractId,
    { limit: 12, canonicalOnly: true },
  );
  for (const realization of candidates) {
    options.signal?.throwIfAborted();
    const lookup = await options.nodeTransactions.lookupIndexedTransaction(realization.txId);
    const stillCanonical =
      lookup.status === "observed" &&
      lookup.value.isCanonical &&
      lookup.value.blockHeight === BigInt(realization.blockHeight) &&
      lookup.value.indexBlockHash.toLowerCase() === realization.indexBlockHash.toLowerCase();
    if (stillCanonical) {
      canonical.push(realization);
      continue;
    }
    if (transactionIndexCannotAnswer(lookup)) {
      // The index cannot speak for this transaction — either it predates the index or the
      // node runs without `txindex`. Read the canonical block instead of assuming a reorg;
      // treating an unanswerable lookup as noncanonical would invalidate good realizations.
      const proof = await checkTransactionInCanonicalBlock(options.nodeBlocks, {
        blockHeight: realization.blockHeight,
        indexBlockHash: realization.indexBlockHash,
        txId: realization.txId,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (proof.status === "included") {
        canonical.push(realization);
        continue;
      }
    } else if (lookup.status !== "observed") {
      throw new Error(
        `Local node could not revalidate reward calculation ${realization.txId}: ${lookup.status}:${lookup.reason}`,
      );
    }
    if (
      options.store.markRewardRealizationNoncanonical({
        chainId: realization.chainId,
        txId: realization.txId,
        eventIndex: realization.eventIndex,
        updatedAt: options.observedAt,
      })
    ) {
      invalidated += 1;
    }
  }
  return { invalidated, canonical };
}

async function nodeTransaction(
  options: SyncRewardRealizationsOptions,
  transaction: TransactionSummary,
): Promise<{
  evidenceLevel: "node-index-verified" | "canonical-block-correlated";
  observation: IndexedTransactionObservation | null;
} | null> {
  const lookup = await options.nodeTransactions.lookupIndexedTransaction(transaction.tx_id);
  if (lookup.status === "observed") {
    if (!lookup.value.isCanonical) return null;
    if (
      lookup.value.blockHeight !== BigInt(transaction.block.height) ||
      lookup.value.indexBlockHash.toLowerCase() !== transaction.block.index_hash.toLowerCase()
    ) {
      throw new Error(
        `Local node and indexed API disagree on reward calculation ${transaction.tx_id}`,
      );
    }
    return { evidenceLevel: "node-index-verified", observation: lookup.value };
  }
  if (transactionIndexCannotAnswer(lookup)) {
    await proveTransactionInCanonicalBlock(options.nodeBlocks, {
      blockHeight: transaction.block.height,
      indexBlockHash: transaction.block.index_hash,
      txId: transaction.tx_id,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { evidenceLevel: "canonical-block-correlated", observation: null };
  }
  const reason = `${lookup.status}:${lookup.reason}`;
  throw new Error(`Local node could not verify reward calculation ${transaction.tx_id}: ${reason}`);
}

function inferHistoricalCheckpoint(
  eventRewardCycle: number,
  calculationBurnHeight: number,
  pox: PoxInfo,
): "first-half" | "second-half" | null {
  if (pox.first_burnchain_block_height === undefined || pox.reward_cycle_length % 2 !== 0) {
    return null;
  }
  const cycleStart = pox.first_burnchain_block_height + eventRewardCycle * pox.reward_cycle_length;
  if (!Number.isSafeInteger(cycleStart) || cycleStart < 0) return null;
  if (calculationBurnHeight === cycleStart + pox.reward_cycle_length / 2 - 1) {
    return "first-half";
  }
  if (calculationBurnHeight === cycleStart + pox.reward_cycle_length - 1) {
    return "second-half";
  }
  return null;
}

async function buildRealization(
  options: SyncRewardRealizationsOptions,
  eventIndex: number,
  event: Pox5CalculateRewardsEvent,
  transaction: TransactionSummary,
): Promise<RewardCalculationRealizationInput | null> {
  const local = await nodeTransaction(options, transaction);
  const existing = options.store.getRewardCalculationRealization(
    options.chainId,
    transaction.tx_id,
    eventIndex,
  );
  if (!local) {
    if (existing?.canonical) {
      options.store.markRewardRealizationNoncanonical({
        chainId: options.chainId,
        txId: transaction.tx_id,
        eventIndex,
        updatedAt: options.observedAt,
      });
    }
    return null;
  }
  if (transaction.status !== "success") {
    throw new Error(`Reward calculation ${transaction.tx_id} did not execute successfully`);
  }
  if (
    existing?.canonical &&
    (existing.poolEstimate !== null ||
      existing.poolEstimateUnavailableReason === "same-block-state-ambiguous" ||
      existing.poolEstimateUnavailableReason === "contract-simulation-failed")
  ) {
    return null;
  }

  const eventRewardCycle = Number(event.rewardCycle);
  const calculationBurnHeight = Number(event.calculationBurnHeight);
  if (!Number.isSafeInteger(eventRewardCycle) || !Number.isSafeInteger(calculationBurnHeight)) {
    throw new Error("PoX-5 calculation event exceeds Sidekick's safe height range");
  }
  let poolEstimate: RewardCalculationRealizationInput["poolEstimate"] = null;
  let poolEstimateUnavailableReason: RewardCalculationRealizationInput["poolEstimateUnavailableReason"] =
    "historical-anchor-unavailable";
  let targetCheckpoint: "first-half" | "second-half";

  const transactionBlock = await options.api.getBlock(transaction.block.index_hash);
  if (
    !transactionBlock.canonical ||
    transactionBlock.height !== transaction.block.height ||
    transactionBlock.index_block_hash !== transaction.block.index_hash
  ) {
    throw new Error(
      `Indexed API returned an inconsistent calculation block for ${transaction.tx_id}`,
    );
  }
  const parentBlock = await options.api.getBlock(transactionBlock.parent_index_block_hash);
  if (!parentBlock.canonical || parentBlock.height + 1 !== transactionBlock.height) {
    throw new Error(`Indexed API returned an inconsistent parent block for ${transaction.tx_id}`);
  }
  let parentAnchor: ReturnType<typeof createChainAnchor> | null = null;
  let transactionAnchor: ReturnType<typeof createChainAnchor> | null = null;
  try {
    const [nodeInfo, parentPoxInfo, transactionPoxInfo] = await Promise.all([
      options.node.getInfo(options.signal ? { signal: options.signal } : {}),
      options.node.getPoxInfo({
        tip: parentBlock.index_block_hash,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      options.node.getPoxInfo({
        tip: transactionBlock.index_block_hash,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    ]);
    parentAnchor = createChainAnchor(nodeInfo, targetApiStatus(parentBlock), parentPoxInfo);
    transactionAnchor = createChainAnchor(
      nodeInfo,
      targetApiStatus(transactionBlock),
      transactionPoxInfo,
    );
  } catch {
    parentAnchor = null;
    transactionAnchor = null;
  }
  if (parentAnchor && transactionAnchor) {
    const target = deriveRewardCalculationTarget(parentAnchor);
    if (
      target.status !== "ready" ||
      target.rewardCycle !== eventRewardCycle ||
      target.expectedLastRewardComputeBurnHeight !== calculationBurnHeight
    ) {
      throw new Error(`PoX-5 event target does not match its canonical parent anchor`);
    }
    targetCheckpoint = target.calculationCheckpoint;
  } else {
    const currentPox = await options.node.getPoxInfo(
      options.signal ? { signal: options.signal } : {},
    );
    const inferred = inferHistoricalCheckpoint(eventRewardCycle, calculationBurnHeight, currentPox);
    if (!inferred) {
      throw new Error(
        `PoX-5 historical calculation ${transaction.tx_id} cannot be placed at an exact checkpoint`,
      );
    }
    targetCheckpoint = inferred;
  }

  if (parentAnchor && transactionAnchor) {
    try {
      const snapshot = await readPox5PoolSimulationSnapshot({
        node: options.node,
        pox5ContractId: options.pox5ContractId,
        managerPrincipal: options.managerPrincipal,
        chainAnchor: parentAnchor,
        targetRewardCycle: eventRewardCycle,
        targetCheckpoint,
        calculationBurnHeight,
        grossAccruedRewardsSats: BigInt(event.grossAccruedRewardsSats),
      });
      const simulation = simulatePox5CalculateRewards({
        ...snapshot.simulationInput,
        grossAccruedRewardsSats: BigInt(event.grossAccruedRewardsSats),
      });
      assertSimulationMatchesEvent(event, simulation);
      const postSnapshot = await readPox5PoolSimulationSnapshot({
        node: options.node,
        pox5ContractId: options.pox5ContractId,
        managerPrincipal: options.managerPrincipal,
        chainAnchor: transactionAnchor,
        targetRewardCycle: eventRewardCycle,
        targetCheckpoint,
        calculationBurnHeight,
        grossAccruedRewardsSats: BigInt(event.grossAccruedRewardsSats),
      });
      if (calculationSharesStable(snapshot.simulationInput, postSnapshot.simulationInput)) {
        poolEstimate = snapshot.currentEstimate;
        poolEstimateUnavailableReason = null;
      } else {
        poolEstimateUnavailableReason = "same-block-state-ambiguous";
      }
    } catch (error) {
      poolEstimateUnavailableReason =
        error instanceof Pox5CalculateRewardsError
          ? "anchored-inputs-unavailable"
          : error instanceof Pox5RewardSimulationError
            ? "contract-simulation-failed"
            : "anchored-inputs-unavailable";
    }
  }

  const forecast = options.store.getRewardEvaluationForecast(
    options.managerPrincipal,
    options.pox5ContractId,
    {
      rewardCycle: eventRewardCycle,
      checkpoint: targetCheckpoint,
      calculationBurnHeight,
      modelRevision: REWARD_FORECAST_MODEL_REVISION,
    },
  );
  const evaluation =
    forecast?.forecast && poolEstimate
      ? evaluateRewardForecast({
          modelRevision: REWARD_FORECAST_MODEL_REVISION,
          forecastObservedBurnHeight: forecast.chainAnchor.burnBlockHeight,
          calculationBurnHeight,
          targetRewardCycle: eventRewardCycle,
          targetCheckpoint,
          globalSats: forecast.forecast.globalSats,
          poolSats: forecast.forecast.poolSats,
          actualPoolSats: poolEstimate.grossSats,
        })
      : null;
  return {
    chainId: options.chainId,
    txId: transaction.tx_id,
    eventIndex,
    sourceId: options.sourceId,
    managerPrincipal: options.managerPrincipal,
    pox5ContractId: options.pox5ContractId,
    canonical: true,
    evidenceLevel: local.evidenceLevel,
    blockHeight: transaction.block.height,
    indexBlockHash: transaction.block.index_hash,
    burnBlockHeight: transaction.bitcoin_block.height,
    targetRewardCycle: eventRewardCycle,
    targetCheckpoint,
    calculationBurnHeight,
    event,
    poolEstimate,
    poolEstimateUnavailableReason,
    modelRevision: REWARD_FORECAST_MODEL_REVISION,
    evaluation,
    observedAt: options.observedAt,
  };
}

async function retryUnresolvedRealizations(
  options: SyncRewardRealizationsOptions,
  candidates: readonly StoredRewardCalculationRealization[],
): Promise<{ stored: number; evaluated: number }> {
  let stored = 0;
  let evaluated = 0;
  for (const realization of candidates) {
    if (
      realization.poolEstimate !== null ||
      (realization.poolEstimateUnavailableReason !== "historical-anchor-unavailable" &&
        realization.poolEstimateUnavailableReason !== "anchored-inputs-unavailable")
    ) {
      continue;
    }
    options.signal?.throwIfAborted();
    const transaction = await options.api.getTransaction(realization.txId);
    const refreshed = await buildRealization(
      options,
      realization.eventIndex,
      realization.event,
      transaction,
    );
    if (!refreshed) continue;
    options.store.putRewardCalculationRealization(refreshed);
    stored += 1;
    if (refreshed.evaluation) evaluated += 1;
  }
  return { stored, evaluated };
}

export async function syncRewardRealizations(
  options: SyncRewardRealizationsOptions,
): Promise<SyncRewardRealizationsResult> {
  const pageLimit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.pageLimit ?? 100);
  const maxPages = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.maxPages ?? 10);
  const stream = rewardRealizationStream(options.pox5ContractId);
  let floor = options.store.rewardRealizationScanFloor(
    options.managerPrincipal,
    options.pox5ContractId,
  );
  const empty = {
    stream,
    pagesProcessed: 0,
    logsInspected: 0,
    calculationsFound: 0,
    realizationsStored: 0,
    evaluationsStored: 0,
    noncanonicalRealizations: 0,
    decodeFailures: 0,
    caughtUp: true,
  };
  if (floor === null) {
    const pox = await options.node.getPoxInfo(options.signal ? { signal: options.signal } : {});
    floor =
      pox.contract_versions.find(({ contract_id }) => contract_id === options.pox5ContractId)
        ?.activation_burnchain_block_height ?? null;
    if (floor === null) return { ...empty, skippedReason: "no-forecast-history" };
  }

  const revalidation = await revalidateCalibrationWindow(options);
  const retried = await retryUnresolvedRealizations(options, revalidation.canonical);

  const checkpoint = options.store.chainState.getCursor(options.sourceId, stream);
  const resumed = checkpoint?.cursor
    ? cursorStateSchema.parse(JSON.parse(checkpoint.cursor))
    : null;
  let apiCursor = resumed?.apiCursor ?? null;
  let scanHighwaterStacksHeight = resumed?.scanHighwaterStacksHeight ?? null;
  const stopStacksHeight = resumed?.stopStacksHeight ?? checkpoint?.lastBlockHeight ?? null;
  const floorBurnHeight = resumed?.floorBurnHeight ?? floor;
  let pagesProcessed = 0;
  let logsInspected = 0;
  let calculationsFound = 0;
  let realizationsStored = retried.stored;
  let evaluationsStored = retried.evaluated;
  let noncanonicalRealizations = revalidation.invalidated;
  let decodeFailures = 0;
  let caughtUp = false;
  const requestedCursors = new Set<string | null>();
  const transactionCache = new Map<string, TransactionSummary>();
  const getTransaction = async (txId: string) => {
    const cached = transactionCache.get(txId);
    if (cached) return cached;
    const transaction = await options.api.getTransaction(txId);
    transactionCache.set(txId, transaction);
    return transaction;
  };

  while (pagesProcessed < maxPages) {
    options.signal?.throwIfAborted();
    if (requestedCursors.has(apiCursor)) {
      throw new Error(`PoX-5 reward API repeated cursor ${apiCursor ?? "<initial>"}`);
    }
    requestedCursors.add(apiCursor);
    const page = await options.api.getSmartContractLogs(
      options.pox5ContractId,
      apiCursor,
      pageLimit,
    );
    if (page.prev_cursor !== null && page.prev_cursor === apiCursor) {
      throw new Error(`PoX-5 reward API did not advance cursor ${apiCursor}`);
    }
    const boundary = page.results.at(-1);
    const newest = page.results[0];
    const [boundaryTransaction, newestTransaction] = await Promise.all([
      boundary ? getTransaction(boundary.tx_id) : null,
      newest ? getTransaction(newest.tx_id) : null,
    ]);
    scanHighwaterStacksHeight ??=
      newestTransaction?.block.height ?? checkpoint?.lastBlockHeight ?? 0;
    const realizations: RewardCalculationRealizationInput[] = [];
    for (const log of page.results) {
      logsInspected += 1;
      if (
        log.contract_log.contract_id !== options.pox5ContractId ||
        log.contract_log.topic !== "print"
      ) {
        continue;
      }
      let event: Pox5CalculateRewardsEvent | null;
      try {
        event = parseCalculationEvent(log.contract_log.value.hex);
      } catch (error) {
        if (error instanceof RewardCalculationEventDecodeError) throw error;
        decodeFailures += 1;
        continue;
      }
      if (!event) continue;
      calculationsFound += 1;
      const transaction = await getTransaction(log.tx_id);
      const wasCanonical = options.store.getRewardCalculationRealization(
        options.chainId,
        log.tx_id,
        log.event_index,
      )?.canonical;
      const realization = await buildRealization(options, log.event_index, event, transaction);
      if (realization) {
        realizations.push(realization);
        realizationsStored += 1;
        if (realization.evaluation) evaluationsStored += 1;
      } else if (wasCanonical) {
        noncanonicalRealizations += 1;
      }
    }
    pagesProcessed += 1;
    const reachedBoundary =
      boundaryTransaction !== null &&
      ((stopStacksHeight !== null && boundaryTransaction.block.height <= stopStacksHeight) ||
        boundaryTransaction.bitcoin_block.height < floorBurnHeight);
    caughtUp = page.prev_cursor === null || page.results.length === 0 || reachedBoundary;
    const nextCursor = caughtUp
      ? null
      : JSON.stringify({
          schemaVersion: 1,
          apiCursor: page.prev_cursor,
          scanHighwaterStacksHeight,
          stopStacksHeight,
          floorBurnHeight,
        });
    if (!caughtUp && page.prev_cursor === null) {
      throw new Error("PoX-5 log pagination ended without a resumable cursor");
    }
    options.store.putRewardCalculationRealizationPage(realizations, {
      sourceId: options.sourceId,
      stream,
      cursor: nextCursor,
      lastBlockHeight: caughtUp ? scanHighwaterStacksHeight : (checkpoint?.lastBlockHeight ?? null),
      lastIndexBlockHash:
        newestTransaction?.block.index_hash ?? checkpoint?.lastIndexBlockHash ?? null,
      updatedAt: options.observedAt,
    });
    if (caughtUp) break;
    apiCursor = page.prev_cursor;
  }

  return {
    stream,
    pagesProcessed,
    logsInspected,
    calculationsFound,
    realizationsStored,
    evaluationsStored,
    noncanonicalRealizations,
    decodeFailures,
    caughtUp,
    skippedReason: null,
  };
}
