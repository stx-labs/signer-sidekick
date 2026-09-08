import { Coins, Percent } from "@phosphor-icons/react";
import type {
  DashboardSnapshot,
  GasWalletStatus,
  RewardLedger,
  RewardLedgerPayment,
  RewardRun,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { actionHash, type DomainSection, settingsHash } from "../../dashboard-route.js";
import { PageHead } from "../../shared/dashboard-ui.js";
import { useDomainSection } from "../../shared/domain-section.js";
import { compactDuration } from "../../shared/format.js";
import { managerActionAvailability } from "../../shared/manager-action-availability.js";
import { operatorErrorDetail, operatorErrorSentence } from "../../shared/operator-error.js";
import { startVisibleRefresh } from "../../shared/visible-refresh.js";
import { loadEngineStatus } from "../operations/engine-api.js";
import {
  cachedGasWalletStatus,
  createGasWallet,
  dismissGasWalletBanner,
  loadGasWalletStatus,
} from "../settings/gas-wallet-api.js";
import { RewardFeeLedger } from "./reward-accounting.js";
import { rewardManagerCapabilityId } from "./reward-action-capabilities.js";
import { GasWalletBanners } from "./reward-banners.js";
import { type ConfirmState, RewardConfirmSheet } from "./reward-confirm-sheet.js";
import { CurrentDistributionDetails } from "./reward-current-distribution.js";
import { DistributionCard } from "./reward-distribution-card.js";
import { EarningCard } from "./reward-earning-card.js";
import { consumeRewardHandoff } from "./reward-handoff.js";
import {
  downloadRewardLedgerExport,
  loadRewardLedger,
  type RewardLedgerQuery,
} from "./reward-ledger-api.js";
import { PastCyclesLedger } from "./reward-past-cycles.js";
import { ProjectionDetails } from "./reward-projection-details.js";
import {
  deriveCycleGeometry,
  deriveDistributionCards,
  deriveEarning,
  distributionKey,
  distributionName,
  execution as executionAvailability,
  pastRewardCycles,
  pendingDistributions,
  type RewardPrimaryAction,
} from "./reward-state.js";
import {
  ACTIVE_RUN_STATUSES,
  approveRewardRun,
  cancelRewardRun,
  IN_PROGRESS_RUN_STATUSES,
  listRewardRuns,
  loadRewardRun,
  loadRewardRunPreparation,
  pauseRewardRun,
  prepareRewardRun,
  RewardRunsUnavailableError,
  resumeRewardRun,
} from "./run-api.js";
import { RequestState, StakerSettlementPanel } from "./staker-settlement-panel.js";

type Snapshot = DashboardSnapshot;

const RUN_POLL_MS = 5_000;
const LEDGER_POLL_MS = 30_000;
const PREPARATION_POLL_MS = 1_000;

function terminalRunNotice(run: RewardRun): string {
  switch (run.status) {
    case "completed":
      return "Run finished. The ledger below reflects what reached the chain.";
    case "cancelled":
      return "Run cancelled; the gas wallet is free again.";
    case "expired":
      return run.failureReason ? `Run expired: ${run.failureReason}` : "Run expired.";
    default:
      return `Run ${run.status}.`;
  }
}

type PaymentsCache = {
  byKey: Record<string, RewardLedgerPayment[]>;
  errors: Record<string, string>;
};

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, PREPARATION_POLL_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function Rewards({
  data,
  operatorStateStale,
  section,
  token,
}: {
  data: Snapshot;
  operatorStateStale: boolean;
  section: DomainSection | null;
  token: string;
}) {
  useDomainSection("rewards", section);
  const cacheScope = `${data.network}:${data.managerPrincipal}`;
  const [ledger, setLedger] = useState<RewardLedger | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const ledgerRefresh = useRef<ReturnType<typeof startVisibleRefresh> | null>(null);
  const [auxiliaryError, setAuxiliaryError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [gasWallet, setGasWallet] = useState<GasWalletStatus | null | undefined>(() =>
    cachedGasWalletStatus(token, cacheScope),
  );
  const [engineMode, setEngineMode] = useState<"observe" | "operator-run" | null>(null);
  const burnBlockTiming = ledger?.context?.burnBlockTiming ?? null;
  const realizations = ledger?.context?.rewardRealizations ?? [];
  const [activeRun, setActiveRun] = useState<RewardRun | null>(null);
  const [confirm, setConfirm] = useState<{
    action: RewardPrimaryAction;
    state: ConfirmState;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runControlBusy, setRunControlBusy] = useState<"pause" | "resume" | "cancel" | null>(null);
  const [runsUnavailable, setRunsUnavailable] = useState(false);
  const [walletPanelOpen, setWalletPanelOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [currentDistributionView, setCurrentDistributionView] = useState<1 | 2 | null>(null);
  const [cardPayments, setCardPayments] = useState<PaymentsCache>({ byKey: {}, errors: {} });
  const [requestedPayments, setRequestedPayments] = useState<ReadonlySet<string>>(new Set());
  const walletPanelRef = useRef<HTMLDivElement | null>(null);
  const rewards = data.rewards;
  const calculation = data.rewardOutlook?.calculation ?? rewards?.calculation ?? null;

  const refreshLedger = useCallback(async () => {
    await ledgerRefresh.current?.refresh(true);
  }, []);

  // Ledger: the page's single source for cycles, the pending distributions, their payments, fees.
  useEffect(() => {
    setLedgerLoading(true);
    setLedger(null);
    setLedgerError(null);
    const refresh = startVisibleRefresh(
      async (signal) => {
        const result = await loadRewardLedger(token, {}, signal);
        if (signal.aborted) return;
        if (`${result.network}:${result.managerPrincipal}` !== cacheScope) {
          throw new Error(
            "Reward ledger identity changed; waiting for the operator snapshot to refresh",
          );
        }
        setLedger(result);
        setLedgerError(null);
        setLedgerLoading(false);
      },
      (cause) => {
        setLedgerError(operatorErrorDetail(cause, "Sidekick returned no error detail"));
        setLedgerLoading(false);
      },
      LEDGER_POLL_MS,
    );
    ledgerRefresh.current = refresh;
    return () => {
      refresh.stop();
      ledgerRefresh.current = null;
    };
  }, [token, cacheScope]);

  // Execution availability: gas wallet + engine mode.
  useEffect(() => {
    const refresh = startVisibleRefresh(
      async (signal) => {
        const failures: string[] = [];
        await Promise.all([
          loadGasWalletStatus(token, signal, cacheScope)
            .then((status) => {
              if (!signal.aborted) setGasWallet(status);
            })
            .catch((cause: unknown) => {
              failures.push(`Gas wallet: ${operatorErrorSentence(cause)}`);
            }),
          loadEngineStatus(token, signal)
            .then((status) => {
              if (signal.aborted) return;
              setEngineMode(
                status ? (status.mode === "operator-run" ? "operator-run" : "observe") : "observe",
              );
            })
            .catch((cause: unknown) => {
              failures.push(operatorErrorSentence(cause));
              if (!signal.aborted) setEngineMode(null);
            }),
        ]);
        if (failures.length) throw new Error(failures.join("; "));
        if (!signal.aborted) setAuxiliaryError(null);
      },
      (cause) => setAuxiliaryError(operatorErrorSentence(cause)),
      LEDGER_POLL_MS,
    );
    return () => refresh.stop();
  }, [token, cacheScope]);

  // Active run discovery + polling (S3): a run started from Overview, another tab, or before a
  // restart shows its progress here; terminal states refresh the ledger and leave a notice.
  const activeRunRef = useRef<RewardRun | null>(null);
  activeRunRef.current = activeRun;
  const activeRunId = activeRun?.runId ?? null;
  useEffect(() => {
    const refresh = startVisibleRefresh(
      async (signal) => {
        const current = activeRunRef.current;
        const request = current
          ? loadRewardRun(token, current.runId, signal).then((run) => [run])
          : listRewardRuns(token, 5, signal);
        await request.then((runs) => {
          if (signal.aborted) return;
          setRunError(null);
          setRunsUnavailable(false);
          const inFlight = runs.find((run) => IN_PROGRESS_RUN_STATUSES.has(run.status)) ?? null;
          if (inFlight) {
            setActiveRun(inFlight);
            return;
          }
          if (current) {
            const finished = runs.find((run) => run.runId === current.runId) ?? null;
            if (finished && !ACTIVE_RUN_STATUSES.has(finished.status)) {
              setNotice(terminalRunNotice(finished));
              refreshLedger().catch(() => undefined);
            }
            setActiveRun(null);
          }
        });
      },
      (cause: unknown) => {
        if (cause instanceof RewardRunsUnavailableError) setRunsUnavailable(true);
        else setRunError(operatorErrorSentence(cause));
      },
      activeRunId ? RUN_POLL_MS : LEDGER_POLL_MS,
    );
    return () => refresh.stop();
  }, [token, refreshLedger, activeRunId]);

  const nextCalculationIn =
    calculation?.next?.state === "scheduled" && burnBlockTiming
      ? compactDuration(calculation.next.blocksRemaining * burnBlockTiming.averageSeconds)
      : null;
  const geometry = useMemo(() => deriveCycleGeometry(data), [data]);
  const earning = useMemo(
    () =>
      ledger
        ? deriveEarning({
            ledger,
            snapshot: data,
            burnBlockSeconds: burnBlockTiming?.averageSeconds ?? null,
          })
        : null,
    [ledger, data, burnBlockTiming],
  );
  const currentDistributionDetails = useMemo(() => {
    if (!ledger || !earning || currentDistributionView === null) return null;
    return (
      ledger.cycles
        .find((cycle) => cycle.cycle === earning.cycle)
        ?.distributions.find(
          (distribution) =>
            distribution.distribution === currentDistributionView &&
            distribution.status === "complete",
        ) ?? null
    );
  }, [ledger, earning, currentDistributionView]);
  useEffect(() => {
    if (currentDistributionView !== null && currentDistributionDetails === null) {
      setCurrentDistributionView(null);
    }
  }, [currentDistributionDetails, currentDistributionView]);
  const closeCurrentDistributionDetails = useCallback(() => {
    const distribution = currentDistributionView;
    setCurrentDistributionView(null);
    if (distribution !== null && earning) {
      window.requestAnimationFrame(() =>
        document
          .getElementById(`rewards-view-distribution-${earning.cycle}-${distribution}`)
          ?.focus(),
      );
    }
  }, [currentDistributionView, earning]);
  const paymentsByKey = useMemo(() => {
    const map = new Map<string, readonly RewardLedgerPayment[]>();
    for (const [key, rows] of Object.entries(cardPayments.byKey)) map.set(key, rows);
    return map;
  }, [cardPayments.byKey]);
  const inProgressRun =
    activeRun && IN_PROGRESS_RUN_STATUSES.has(activeRun.status) ? activeRun : null;
  const cards = useMemo(
    () =>
      ledger
        ? deriveDistributionCards({
            ledger,
            paymentsByKey,
            gasWallet,
            engineMode,
            activeRun: inProgressRun,
          })
        : [],
    [ledger, paymentsByKey, gasWallet, engineMode, inProgressRun],
  );

  // Load the actionable head and current cycle automatically. Older backlog details are opt-in,
  // and an uncalculated card has no payment table to fetch. Summaries stay visible for every card.
  const pendingTargets = useMemo(
    () =>
      ledger
        ? pendingDistributions(ledger)
            .filter(({ distribution }) => distribution.calculation.state === "done")
            .filter(
              ({ cycle, distribution }, index) =>
                index === 0 ||
                cycle.cycle === ledger.current.cycle ||
                requestedPayments.has(distributionKey(cycle.cycle, distribution.distribution)) ||
                (activeRun?.recipe.cycle === cycle.cycle &&
                  activeRun.recipe.distribution === distribution.distribution),
            )
            .map(({ cycle, distribution }) => ({
              key: distributionKey(cycle.cycle, distribution.distribution),
              cycle: cycle.cycle,
              distribution: distribution.distribution,
            }))
        : [],
    [ledger, requestedPayments, activeRun?.recipe.cycle, activeRun?.recipe.distribution],
  );
  const seededStamp = useRef<string | null>(null);
  const fetchedStamp = useRef<Record<string, string>>({});
  const preparationPollRef = useRef<AbortController | null>(null);
  const cardInputs = useRef({ ledger, pendingTargets });
  cardInputs.current = { ledger, pendingTargets };
  const cardRefresh = useRef<ReturnType<typeof startVisibleRefresh> | null>(null);
  useEffect(() => {
    seededStamp.current = null;
    fetchedStamp.current = {};
    setCardPayments({ byKey: {}, errors: {} });
    setRequestedPayments(new Set());
    const refresh = startVisibleRefresh(
      async (signal) => {
        const { ledger, pendingTargets } = cardInputs.current;
        if (!ledger || `${ledger.network}:${ledger.managerPrincipal}` !== cacheScope) return;
        if (seededStamp.current !== ledger.generatedAt) {
          seededStamp.current = ledger.generatedAt;
          const seeded: Record<string, RewardLedgerPayment[]> = {};
          if (ledger.query.scope === "selection" && ledger.query.cycle !== null) {
            const cycle = ledger.cycles.find((entry) => entry.cycle === ledger.query.cycle) ?? null;
            const covered = (cycle?.distributions ?? [])
              .map((d) => d.distribution)
              .filter((d) => ledger.query.distribution === null || ledger.query.distribution === d);
            for (const distribution of covered) {
              const key = distributionKey(ledger.query.cycle, distribution);
              seeded[key] = ledger.payments.filter(
                (row) => row.cycle === ledger.query.cycle && row.distribution === distribution,
              );
              fetchedStamp.current[key] = ledger.generatedAt;
            }
          }
          if (Object.keys(seeded).length > 0) {
            setCardPayments((current) => ({
              byKey: { ...current.byKey, ...seeded },
              errors: Object.fromEntries(
                Object.entries(current.errors).filter(([key]) => !(key in seeded)),
              ),
            }));
          }
        }
        await Promise.all(
          pendingTargets.map(async (target) => {
            if (fetchedStamp.current[target.key] === ledger.generatedAt) return;
            fetchedStamp.current[target.key] = ledger.generatedAt;
            await loadRewardLedger(
              token,
              { cycle: target.cycle, distribution: target.distribution },
              signal,
            )
              .then((result) => {
                if (signal.aborted) return;
                setCardPayments((current) => ({
                  byKey: { ...current.byKey, [target.key]: result.payments },
                  errors: Object.fromEntries(
                    Object.entries(current.errors).filter(([key]) => key !== target.key),
                  ),
                }));
              })
              .catch((cause: unknown) => {
                if (signal.aborted) return;
                delete fetchedStamp.current[target.key];
                setCardPayments((current) => ({
                  ...current,
                  errors: { ...current.errors, [target.key]: operatorErrorSentence(cause) },
                }));
              });
          }),
        );
      },
      (cause) => setAuxiliaryError(operatorErrorSentence(cause)),
    );
    cardRefresh.current = refresh;
    return () => {
      refresh.stop();
      cardRefresh.current = null;
    };
  }, [token, cacheScope]);
  useEffect(() => {
    if (ledger && pendingTargets.length > 0) void cardRefresh.current?.refresh(true);
  }, [ledger, pendingTargets]);

  const openConfirm = useCallback(
    (action: RewardPrimaryAction) => {
      preparationPollRef.current?.abort();
      const controller = new AbortController();
      preparationPollRef.current = controller;
      setConfirm({ action, state: { status: "drafting" } });
      const settle = (state: ConfirmState) =>
        setConfirm((current) =>
          !controller.signal.aborted && current?.action === action ? { action, state } : current,
        );
      listRewardRuns(token, 5, controller.signal)
        .then(async (runs) => {
          const draft = runs.find(
            (run) =>
              run.status === "awaiting-approval" &&
              run.recipe.cycle === action.cycle &&
              run.recipe.distribution === action.distribution,
          );
          if (draft) return { run: draft, reused: true };
          let preparation = await prepareRewardRun(
            token,
            {
              cycle: action.cycle,
              distribution: action.distribution,
              operations: action.operations,
            },
            controller.signal,
          );
          settle({ status: "preparing", preparation });
          while (preparation.status === "queued" || preparation.status === "preparing") {
            await waitForPoll(controller.signal);
            preparation = await loadRewardRunPreparation(
              token,
              preparation.preparationId,
              controller.signal,
            );
            settle({ status: "preparing", preparation });
          }
          if (preparation.status === "failed") {
            throw new Error(preparation.failureReason ?? "Reward-run preparation failed");
          }
          if (!preparation.runId) throw new Error("Prepared reward run has no run ID");
          const run = await loadRewardRun(token, preparation.runId, controller.signal);
          return { run, reused: false };
        })
        .then(({ run, reused }) => settle({ status: "ready", run, reused }))
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          settle(
            cause instanceof RewardRunsUnavailableError
              ? {
                  status: "unavailable",
                  reason: "This Sidekick build does not include the run engine.",
                }
              : { status: "error", message: operatorErrorSentence(cause) },
          );
        });
    },
    [token],
  );

  const closeConfirm = () => {
    preparationPollRef.current?.abort();
    preparationPollRef.current = null;
    setConfirm(null);
  };

  useEffect(
    () => () => {
      preparationPollRef.current?.abort();
    },
    [],
  );

  // Navigation selects the exact current action; preparation still rebuilds its recipe.
  useEffect(() => {
    if (!ledger || cards.length === 0) return;
    const match = consumeRewardHandoff(
      cards
        .flatMap((card) => [card.primary, card.secondary?.action ?? null])
        .filter((action): action is RewardPrimaryAction => action !== null),
      cacheScope,
    );
    if (match) openConfirm(match);
  }, [ledger, cards, openConfirm, cacheScope]);

  const go = (run: RewardRun) => {
    setConfirm((current) =>
      current ? { ...current, state: { status: "approving", run } } : current,
    );
    approveRewardRun(token, run.runId, run.recipeSha256)
      .then((started) => {
        setConfirm(null);
        setActiveRun(started);
        setNotice(null);
      })
      .catch((cause: unknown) =>
        setConfirm((current) =>
          current
            ? { ...current, state: { status: "error", message: operatorErrorSentence(cause) } }
            : current,
        ),
      );
  };

  const discardDraft = (run: RewardRun) => {
    const action = confirm?.action;
    cancelRewardRun(token, run.runId)
      .then(() => {
        if (action) openConfirm(action);
      })
      .catch((cause: unknown) =>
        setConfirm((current) =>
          current
            ? { ...current, state: { status: "error", message: operatorErrorSentence(cause) } }
            : current,
        ),
      );
  };

  const runControl = (runId: string, control: "pause" | "resume" | "cancel") => {
    setRunControlBusy(control);
    const operation =
      control === "pause"
        ? pauseRewardRun
        : control === "resume"
          ? resumeRewardRun
          : cancelRewardRun;
    operation(token, runId)
      .then((run) => {
        if (IN_PROGRESS_RUN_STATUSES.has(run.status)) setActiveRun(run);
        else {
          setActiveRun(null);
          setNotice(terminalRunNotice(run));
          refreshLedger().catch(() => undefined);
        }
      })
      .catch((cause: unknown) => setNotice(operatorErrorSentence(cause)))
      .finally(() => setRunControlBusy(null));
  };

  const dismissBanner = (kind: "setup" | "low-balance") => {
    dismissGasWalletBanner(token, kind)
      .then((status) => setGasWallet(status))
      .catch((cause: unknown) => setNotice(operatorErrorSentence(cause)));
  };
  const createWallet = () => {
    createGasWallet(token)
      .then((status) => {
        setGasWallet(status);
        location.hash = settingsHash("gas-wallet");
      })
      .catch((cause: unknown) => setNotice(operatorErrorSentence(cause)));
  };

  const useWallet = () => {
    preparationPollRef.current?.abort();
    preparationPollRef.current = null;
    setConfirm(null);
    setWalletPanelOpen(true);
    window.requestAnimationFrame(() =>
      walletPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  const loadDistributionPayments = useCallback(
    async (cycle: number, distributionIndex: 1 | 2, signal?: AbortSignal) =>
      (await loadRewardLedger(token, { cycle, distribution: distributionIndex }, signal)).payments,
    [token],
  );

  const exportPayments = (query: RewardLedgerQuery) => {
    setExportBusy(true);
    downloadRewardLedgerExport(token, "payments", "csv", query)
      .catch((cause: unknown) => setNotice(operatorErrorSentence(cause)))
      .finally(() => setExportBusy(false));
  };

  // Legacy manager fee actions (browser wallet) stay reachable from the fee ledger card.
  const updateFees = managerActionAvailability(
    data,
    rewardManagerCapabilityId("update-fees"),
    operatorStateStale,
  );
  const withdrawFees = managerActionAvailability(
    data,
    rewardManagerCapabilityId("withdraw-fees"),
    operatorStateStale,
  );
  const sweepRefunds = managerActionAvailability(
    data,
    rewardManagerCapabilityId("sweep-fee-refunds"),
    operatorStateStale,
  );
  const claimRewards = managerActionAvailability(
    data,
    rewardManagerCapabilityId("claim-rewards"),
    operatorStateStale,
  );
  const feeActions = (
    <>
      <button
        type="button"
        className="btn btn-secondary sm reward-admin-action-primary"
        disabled={!withdrawFees.available || BigInt(rewards?.manager.earnedFeesSats ?? 0) === 0n}
        title={withdrawFees.available ? undefined : withdrawFees.reason}
        onClick={() => {
          location.hash = actionHash("withdraw-fees");
        }}
      >
        <Coins /> Withdraw earned fees
      </button>
      <button
        type="button"
        className="btn btn-secondary sm reward-admin-action-secondary"
        disabled={!updateFees.available}
        title={updateFees.available ? undefined : updateFees.reason}
        onClick={() => {
          location.hash = actionHash("update-fees");
        }}
      >
        <Percent /> Update manager fee
      </button>
      <button
        type="button"
        className="btn btn-secondary sm reward-admin-action-secondary"
        disabled={!sweepRefunds.available}
        title={sweepRefunds.available ? undefined : sweepRefunds.reason}
        onClick={() => {
          location.hash = actionHash("sweep-fee-refunds");
        }}
      >
        Sweep fee refunds
      </button>
    </>
  );

  // Past cycles are calendar history. An older cycle remains visible here even when one of its
  // distributions also appears in Distribute because it still needs the operator.
  const accruingCycle = earning?.cycle ?? ledger?.current.cycle ?? null;
  const pastCycles = ledger ? pastRewardCycles(ledger, accruingCycle) : [];
  const currentCycleDistributions =
    ledger?.cycles.find((cycle) => cycle.cycle === accruingCycle)?.distributions ?? [];
  const completedCurrentDistributions = currentCycleDistributions.filter(
    (distribution) => distribution.status === "complete",
  );
  const quietDistributionCopy =
    completedCurrentDistributions.length > 0
      ? "All available distributions have been completed."
      : "Nothing to distribute right now — the next distribution appears here once the network calculates it.";
  const leadCard = cards.find((card) => card.primary !== null) ?? cards[0] ?? null;
  const anyAction = cards.some((card) => card.primary !== null || card.secondary !== null);
  const walletFallback = leadCard?.execution.walletFallback ?? engineMode !== "operator-run";
  const confirmCard = confirm
    ? (cards.find(
        (card) =>
          card.cycle === confirm.action.cycle && card.distribution === confirm.action.distribution,
      ) ?? null)
    : null;

  return (
    <>
      <PageHead title="Rewards" />
      {ledger && ledgerError ? (
        <div className="callout callout-caution content-notice" role="status">
          Showing the last reward ledger from {new Date(ledger.generatedAt).toLocaleString()}.
          Refresh failed: {ledgerError}{" "}
          <button
            className="btn btn-secondary sm"
            type="button"
            onClick={() => void refreshLedger()}
          >
            Retry reward ledger
          </button>
        </div>
      ) : null}
      {auxiliaryError || runError ? (
        <div className="callout callout-caution content-notice" role="status">
          Some reward status could not refresh; retained values may be stale.{" "}
          {[auxiliaryError, runError].filter(Boolean).join(" · ")}
        </div>
      ) : null}
      {data.freshness?.status === "stale" ? (
        <div className="callout callout-caution content-notice" role="status">
          Showing last known reward data while Sidekick refreshes chain data.
        </div>
      ) : null}
      {notice ? (
        <div className="callout callout-neutral content-notice" role="status">
          <div className="body">{notice}</div>
        </div>
      ) : null}
      <GasWalletBanners
        gasWallet={gasWallet}
        engineMode={engineMode}
        neededTransactions={leadCard?.primary?.transactions ?? 0}
        onCreate={createWallet}
        onDismiss={dismissBanner}
        onFundInstructions={() => {
          location.hash = settingsHash("gas-wallet");
        }}
      />
      {ledger && earning ? (
        <>
          <EarningCard
            model={earning}
            openDistribution={currentDistributionView}
            onViewDistribution={(distribution) =>
              setCurrentDistributionView((current) =>
                current === distribution ? null : distribution,
              )
            }
          />
          {currentDistributionDetails ? (
            <CurrentDistributionDetails
              cycle={earning.cycle}
              distribution={currentDistributionDetails}
              loadPayments={loadDistributionPayments}
              onExport={exportPayments}
              exportBusy={exportBusy}
              onClose={closeCurrentDistributionDetails}
            />
          ) : null}
        </>
      ) : (
        <RequestState
          label="the reward ledger"
          loading={ledgerLoading}
          error={ledgerError}
          retry={() => void refreshLedger()}
        />
      )}
      {walletFallback && anyAction ? (
        <div className="callout callout-neutral content-notice" role="status">
          <div className="body">
            <strong>Sign with your own wallet.</strong> {leadCard?.execution.reason}
            <div className="actions">
              {claimRewards.available &&
              BigInt(rewards?.global.signerEarnedAcrossBucketsSats ?? 0) > 0n ? (
                <a className="btn btn-secondary sm" href={actionHash("claim-rewards")}>
                  Review manager collect
                </a>
              ) : null}
              <button className="btn btn-secondary sm" type="button" onClick={useWallet}>
                Distribute with your wallet
              </button>
              {engineMode === "operator-run" ? (
                <a className="btn btn-tertiary sm" href={settingsHash("gas-wallet")}>
                  Gas wallet settings
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      <ProjectionDetails
        snapshot={data}
        realizations={realizations}
        nextCalculationIn={nextCalculationIn}
      />
      {ledger ? (
        <>
          <div className="section-title rw-pending-title domain-section-anchor" id="rewards-claims">
            Distribute{" "}
            <span className="hint">
              {cards.length === 0
                ? "nothing waiting"
                : `${cards.length} waiting${cards.length > 1 ? " · oldest first" : ""}`}
            </span>
          </div>
          {cards.length === 0 ? (
            <div className="card rw-quiet" role="status">
              {quietDistributionCopy}
            </div>
          ) : (
            cards.map((card) => (
              <DistributionCard
                key={card.key}
                model={card}
                payments={cardPayments.byKey[card.key] ?? null}
                paymentsError={cardPayments.errors[card.key] ?? null}
                onLoadPayments={
                  pendingTargets.some((target) => target.key === card.key)
                    ? undefined
                    : () => setRequestedPayments((current) => new Set([...current, card.key]))
                }
                onAction={openConfirm}
                onRunControl={runControl}
                runControlBusy={runControlBusy}
                busy={confirm !== null || runsUnavailable}
              />
            ))
          )}
          <div ref={walletPanelRef} id="rewards-withdrawals" className="domain-section-anchor">
            {walletPanelOpen || walletFallback ? (
              <details className="card rw-details" open={walletPanelOpen}>
                <summary>
                  Distribute with your wallet{" "}
                  <span className="hint">sign each staker payment yourself</span>
                </summary>
                <div style={{ padding: "0 20px 20px" }}>
                  <StakerSettlementPanel
                    calculationPending={calculation?.state === "pending"}
                    token={token}
                  />
                </div>
              </details>
            ) : null}
          </div>
          <PastCyclesLedger
            cycles={pastCycles}
            loadPayments={loadDistributionPayments}
            onExport={exportPayments}
            exportBusy={exportBusy}
            geometry={geometry}
            burnBlockSeconds={burnBlockTiming?.averageSeconds ?? null}
          />
          <RewardFeeLedger token={token} ledger={ledger} feeActions={feeActions} />
        </>
      ) : null}
      {confirm ? (
        <RewardConfirmSheet
          action={confirm.action}
          eyebrow={
            confirmCard?.eyebrow ??
            `Cycle ${confirm.action.cycle} · ${distributionName(confirm.action.distribution)}`
          }
          execution={
            confirmCard?.execution ??
            executionAvailability(gasWallet, engineMode, confirm.action.transactions)
          }
          state={confirm.state}
          onCancel={closeConfirm}
          onGo={go}
          onDiscard={discardDraft}
          onUseWallet={useWallet}
        />
      ) : null}
    </>
  );
}
