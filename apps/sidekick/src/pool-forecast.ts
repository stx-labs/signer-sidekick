import { POX5_SIGNER_SET_MIN_USTX } from "@stx-labs/signer-sidekick-protocol";
import {
  type ClarityValue,
  decodeBoolean,
  decodeUInt,
  encodeOptionalUIntHex,
  encodePrincipalHex,
  encodeUIntHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import type {
  PoolCycleSnapshotInput,
  SignerStakerRun,
  StoredCycleMembership,
  StoredSignerStaker,
} from "./storage/store.js";

export interface PoolForecastNode {
  callReadOnly(
    principal: string,
    functionName: string,
    sender: string,
    args: readonly string[],
  ): Promise<ClarityValue>;
}

export interface PoolForecastStore {
  getLatestCompletedSignerStakerRun(
    sourceId: string,
    managerPrincipal: string,
  ): SignerStakerRun | null;
  listSignerStakers(
    managerPrincipal: string,
    activeOnly?: boolean,
    sourceId?: string | null,
  ): StoredSignerStaker[];
  listCycleMemberships(
    managerPrincipal: string,
    activeOnly?: boolean,
    sourceId?: string | null,
  ): StoredCycleMembership[];
  putPoolCycleSnapshots?(input: PoolCycleSnapshotInput): void;
}

export interface PoolForecastOptions {
  store: PoolForecastStore;
  node: PoolForecastNode;
  sourceId: string;
  managerPrincipal: string;
  pox5ContractId: string;
  currentRewardCycle: number;
  horizonCycles?: number;
  observedAt: string;
  burnBlockHeight: number;
  stacksTipHeight: number;
}

export interface PoolCycleForecast {
  cycleId: number;
  status: "ready" | "attention";
  provenance: {
    classification: "authoritative" | "projected";
    contractSource: "pox5-read-only";
    localRosterSource: "api-indexed-node-verified" | "unavailable";
  };
  local: {
    rosterAvailable: boolean;
    stakerCount: number | null;
    enumeratedStxUstx: string | null;
    enumerationDeltaUstx: string | null;
    matchesContractPending: boolean | null;
  };
  contract: {
    pendingStxUstx: string;
    eligibleStxSharesUstx: string;
    totalDelegatedUstx: string;
    nonStxDelegatedUstx: string | null;
    inSignerSet: boolean;
  };
  threshold: {
    thresholdUstx: string;
    marginUstx: string;
    meetsThreshold: boolean;
  };
  consistency: {
    delegatedCoversPendingStx: boolean;
    thresholdAndSignerSetAgree: boolean;
    eligibleSharesAgree: boolean;
  };
  changesFromPrevious: null | {
    joiningStakers: number;
    leavingStakers: number;
    changedAmountStakers: number;
    netEnumeratedStxDeltaUstx: string;
  };
}

export interface PoolForecast {
  status: "ready" | "attention";
  managerPrincipal: string;
  pox5ContractId: string;
  observedAt: {
    timestamp: string;
    burnBlockHeight: number;
    stacksTipHeight: number;
  };
  ingestion: null | {
    runId: string;
    sourceId: string;
    completedAt: string;
    pagesProcessed: number;
    itemsProcessed: number;
    activeDiscoveredStakers: number;
    stxDiscoveries: number;
    bondDiscoveries: number;
    unverifiedStxDiscoveries: number;
  };
  cycles: PoolCycleForecast[];
}

interface ContractCycleState {
  pendingStx: bigint;
  eligibleStxShares: bigint;
  totalDelegated: bigint;
  inSignerSet: boolean;
}

async function readContractCycleState(
  node: PoolForecastNode,
  pox5ContractId: string,
  managerPrincipal: string,
  cycleId: number,
): Promise<ContractCycleState> {
  const commonArgs = [encodePrincipalHex(managerPrincipal), encodeUIntHex(BigInt(cycleId))];
  const [pendingStx, eligibleStxShares, totalDelegated, signerSetMembership] = await Promise.all([
    node.callReadOnly(
      pox5ContractId,
      "get-signer-pending-staked-ustx-per-cycle",
      managerPrincipal,
      commonArgs,
    ),
    node.callReadOnly(pox5ContractId, "get-signer-shares-staked-for-cycle", managerPrincipal, [
      ...commonArgs,
      encodeOptionalUIntHex(null),
    ]),
    node.callReadOnly(
      pox5ContractId,
      "get-amount-delegated-for-signer",
      managerPrincipal,
      commonArgs,
    ),
    node.callReadOnly(
      pox5ContractId,
      "signer-set-contains-for-cycle",
      managerPrincipal,
      commonArgs,
    ),
  ]);
  return {
    pendingStx: decodeUInt(pendingStx, "get-signer-pending-staked-ustx-per-cycle"),
    eligibleStxShares: decodeUInt(eligibleStxShares, "get-signer-shares-staked-for-cycle"),
    totalDelegated: decodeUInt(totalDelegated, "get-amount-delegated-for-signer"),
    inSignerSet: decodeBoolean(signerSetMembership, "signer-set-contains-for-cycle"),
  };
}

function membershipsByCycle(
  memberships: readonly StoredCycleMembership[],
): Map<number, Map<string, bigint>> {
  const byCycle = new Map<number, Map<string, bigint>>();
  for (const membership of memberships) {
    const cycle = Number(membership.rewardCycle);
    let cycleMemberships = byCycle.get(cycle);
    if (!cycleMemberships) {
      cycleMemberships = new Map();
      byCycle.set(cycle, cycleMemberships);
    }
    cycleMemberships.set(membership.stakerPrincipal, membership.amountUstx);
  }
  return byCycle;
}

function sumMemberships(memberships: ReadonlyMap<string, bigint>): bigint {
  let total = 0n;
  for (const amount of memberships.values()) total += amount;
  return total;
}

function changesBetween(
  previous: ReadonlyMap<string, bigint>,
  current: ReadonlyMap<string, bigint>,
): NonNullable<PoolCycleForecast["changesFromPrevious"]> {
  let joiningStakers = 0;
  let leavingStakers = 0;
  let changedAmountStakers = 0;
  for (const [principal, amount] of current) {
    const previousAmount = previous.get(principal);
    if (previousAmount === undefined) joiningStakers += 1;
    else if (previousAmount !== amount) changedAmountStakers += 1;
  }
  for (const principal of previous.keys()) {
    if (!current.has(principal)) leavingStakers += 1;
  }
  return {
    joiningStakers,
    leavingStakers,
    changedAmountStakers,
    netEnumeratedStxDeltaUstx: (sumMemberships(current) - sumMemberships(previous)).toString(),
  };
}

export async function readPoolForecast(options: PoolForecastOptions): Promise<PoolForecast> {
  if (!Number.isSafeInteger(options.currentRewardCycle) || options.currentRewardCycle < 0) {
    throw new Error("currentRewardCycle must be a non-negative safe integer");
  }
  const horizonCycles = options.horizonCycles ?? 6;
  if (!Number.isSafeInteger(horizonCycles) || horizonCycles < 1 || horizonCycles > 96) {
    throw new Error("horizonCycles must be an integer from 1 through 96");
  }

  const run = options.store.getLatestCompletedSignerStakerRun(
    options.sourceId,
    options.managerPrincipal,
  );
  const stakers = run
    ? options.store.listSignerStakers(options.managerPrincipal, true, options.sourceId)
    : [];
  const memberships = run
    ? options.store.listCycleMemberships(options.managerPrincipal, true, options.sourceId)
    : [];
  const cycleIds = Array.from(
    { length: horizonCycles },
    (_, index) => options.currentRewardCycle + index,
  );
  const cycles: PoolCycleForecast[] = [];
  let previousMemberships: Map<string, bigint> | null = null;
  const localByCycle = membershipsByCycle(memberships);
  const contractByCycle = new Map<number, ContractCycleState>();
  for (let index = 0; index < cycleIds.length; index += 8) {
    const states = await Promise.all(
      cycleIds.slice(index, index + 8).map(async (cycleId) => ({
        cycleId,
        state: await readContractCycleState(
          options.node,
          options.pox5ContractId,
          options.managerPrincipal,
          cycleId,
        ),
      })),
    );
    for (const { cycleId, state } of states) contractByCycle.set(cycleId, state);
  }

  for (const cycleId of cycleIds) {
    const contract = contractByCycle.get(cycleId);
    if (!contract) throw new Error(`Missing contract forecast state for cycle ${cycleId}`);
    const localMemberships = localByCycle.get(cycleId) ?? new Map();
    const localTotal = run ? sumMemberships(localMemberships) : null;
    const delegatedCoversPendingStx = contract.totalDelegated >= contract.pendingStx;
    const meetsThreshold = contract.totalDelegated >= POX5_SIGNER_SET_MIN_USTX;
    const thresholdAndSignerSetAgree = meetsThreshold === contract.inSignerSet;
    const expectedEligibleShares = contract.inSignerSet ? contract.pendingStx : 0n;
    const eligibleSharesAgree = contract.eligibleStxShares === expectedEligibleShares;
    const matchesContractPending = localTotal === null ? null : localTotal === contract.pendingStx;
    const status =
      matchesContractPending !== false &&
      delegatedCoversPendingStx &&
      meetsThreshold &&
      thresholdAndSignerSetAgree &&
      eligibleSharesAgree
        ? "ready"
        : "attention";

    cycles.push({
      cycleId,
      status,
      provenance: {
        classification: cycleId === options.currentRewardCycle ? "authoritative" : "projected",
        contractSource: "pox5-read-only",
        localRosterSource: run ? "api-indexed-node-verified" : "unavailable",
      },
      local: {
        rosterAvailable: run !== null,
        stakerCount: run ? localMemberships.size : null,
        enumeratedStxUstx: localTotal?.toString() ?? null,
        enumerationDeltaUstx:
          localTotal === null ? null : (localTotal - contract.pendingStx).toString(),
        matchesContractPending,
      },
      contract: {
        pendingStxUstx: contract.pendingStx.toString(),
        eligibleStxSharesUstx: contract.eligibleStxShares.toString(),
        totalDelegatedUstx: contract.totalDelegated.toString(),
        nonStxDelegatedUstx: delegatedCoversPendingStx
          ? (contract.totalDelegated - contract.pendingStx).toString()
          : null,
        inSignerSet: contract.inSignerSet,
      },
      threshold: {
        thresholdUstx: POX5_SIGNER_SET_MIN_USTX.toString(),
        marginUstx: (contract.totalDelegated - POX5_SIGNER_SET_MIN_USTX).toString(),
        meetsThreshold,
      },
      consistency: {
        delegatedCoversPendingStx,
        thresholdAndSignerSetAgree,
        eligibleSharesAgree,
      },
      changesFromPrevious:
        run && previousMemberships ? changesBetween(previousMemberships, localMemberships) : null,
    });
    previousMemberships = run ? localMemberships : null;
  }

  const forecast: PoolForecast = {
    status: run && cycles.every(({ status }) => status === "ready") ? "ready" : "attention",
    managerPrincipal: options.managerPrincipal,
    pox5ContractId: options.pox5ContractId,
    observedAt: {
      timestamp: options.observedAt,
      burnBlockHeight: options.burnBlockHeight,
      stacksTipHeight: options.stacksTipHeight,
    },
    ingestion: run
      ? {
          runId: run.runId,
          sourceId: run.sourceId,
          completedAt: run.completedAt ?? run.updatedAt,
          pagesProcessed: run.pagesProcessed,
          itemsProcessed: run.itemsProcessed,
          activeDiscoveredStakers: stakers.length,
          stxDiscoveries: stakers.filter(({ hasStx }) => hasStx).length,
          bondDiscoveries: stakers.filter(({ hasBtc }) => hasBtc).length,
          unverifiedStxDiscoveries: stakers.filter(
            ({ hasStx, stxNodeVerified }) => hasStx && stxNodeVerified === false,
          ).length,
        }
      : null,
    cycles,
  };
  options.store.putPoolCycleSnapshots?.({
    managerPrincipal: options.managerPrincipal,
    observedAt: options.observedAt,
    burnBlockHeight: options.burnBlockHeight,
    stacksTipHeight: options.stacksTipHeight,
    cycles: cycles.map((cycle) => ({
      cycleId: cycle.cycleId,
      status: cycle.status,
      rosterAvailable: cycle.local.rosterAvailable,
      stakerCount: cycle.local.stakerCount,
      enumeratedStxUstx: cycle.local.enumeratedStxUstx,
      enumerationDeltaUstx: cycle.local.enumerationDeltaUstx,
      pendingStxUstx: cycle.contract.pendingStxUstx,
      eligibleStxSharesUstx: cycle.contract.eligibleStxSharesUstx,
      totalDelegatedUstx: cycle.contract.totalDelegatedUstx,
      nonStxDelegatedUstx: cycle.contract.nonStxDelegatedUstx,
      inSignerSet: cycle.contract.inSignerSet,
      thresholdUstx: cycle.threshold.thresholdUstx,
      thresholdMarginUstx: cycle.threshold.marginUstx,
      provenance: cycle.provenance,
    })),
  });
  return forecast;
}
