import { Coins, Percent } from "@phosphor-icons/react";
import {
  type DashboardSnapshot,
  type GasWalletStatus,
  type HealthSnapshot,
  healthSnapshotSchema,
  type RewardCalculationRealization,
  type RewardLedger,
  type RewardLedgerPayment,
  type RewardRun,
  rewardsPageResponseSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "../../api-client.js";
import { actionHash, type DomainSection, settingsHash } from "../../dashboard-route.js";
import { PageHead } from "../../shared/dashboard-ui.js";
import { useDomainSection } from "../../shared/domain-section.js";
import { compactDuration } from "../../shared/format.js";
import { managerActionAvailability } from "../../shared/manager-action-availability.js";
import { operatorErrorDetail, operatorErrorSentence } from "../../shared/operator-error.js";
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
import { DistributionCard } from "./reward-distribution-card.js";
import { EarningCard } from "./reward-earning-card.js";
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
/** Overview's "Collect & distribute" hands the same confirm sheet over through this key. */
export const PENDING_RUN_STORAGE_KEY = "sidekick-rewards-pending-run";

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
  const [ledger, setLedger] = useState<RewardLedger | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [ledgerRetry, setLedgerRetry] = useState(0);
  const [gasWallet, setGasWallet] = useState<GasWalletStatus | null | undefined>(() =>
    cachedGasWalletStatus(),
  );
  const [engineMode, setEngineMode] = useState<"observe" | "operator-run" | null>(null);
  const [burnBlockTiming, setBurnBlockTiming] = useState<HealthSnapshot["burnBlockTiming"]>(null);
  const [realizations, setRealizations] = useState<RewardCalculationRealization[]>([]);
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
  const [cardPayments, setCardPayments] = useState<PaymentsCache>({ byKey: {}, errors: {} });
  const walletPanelRef = useRef<HTMLDivElement | null>(null);
  const rewards = data.rewards;
  const calculation = data.rewardOutlook?.calculation ?? rewards?.calculation ?? null;

  const refreshLedger = useCallback(
    async (signal?: AbortSignal) => {
      const result = await loadRewardLedger(token, {}, signal);
      if (signal?.aborted) return;
      setLedger(result);
      setLedgerError(null);
    },
    [token],
  );

  // Ledger: the page's single source for cycles, the pending distributions, their payments, fees.
  useEffect(() => {
    void ledgerRetry;
    void data.generatedAt;
    const controller = new AbortController();
    setLedgerLoading(true);
    refreshLedger(controller.signal)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setLedgerError(operatorErrorDetail(cause, "Sidekick returned no error detail"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLedgerLoading(false);
      });
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        refreshLedger(controller.signal).catch(() => undefined);
      }
    }, LEDGER_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [data.generatedAt, ledgerRetry, refreshLedger]);

  // Execution availability: gas wallet + engine mode.
  useEffect(() => {
    void data.generatedAt;
    const controller = new AbortController();
    void loadGasWalletStatus(token, controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) setGasWallet(status);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          // Keep verified cache data; without any cache, preserve the existing fallback behavior.
          setGasWallet((current) => (current === undefined ? null : current));
        }
      });
    void loadEngineStatus(token, controller.signal)
      .then((status) => {
        if (controller.signal.aborted) return;
        setEngineMode(
          status ? (status.mode === "operator-run" ? "operator-run" : "observe") : "observe",
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setEngineMode(null);
      });
    return () => controller.abort();
  }, [token, data.generatedAt]);

  // Projection accuracy + Bitcoin block timing for "left" / "in about …".
  useEffect(() => {
    void data.generatedAt;
    const controller = new AbortController();
    void apiJson(token, "/api/v1/health", healthSnapshotSchema, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setBurnBlockTiming(result.burnBlockTiming);
      })
      .catch(() => {
        if (!controller.signal.aborted) setBurnBlockTiming(null);
      });
    void apiJson(token, "/api/v1/rewards?limit=1&offset=0", rewardsPageResponseSchema, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setRealizations(result.rewardRealizations ?? []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRealizations([]);
      });
    return () => controller.abort();
  }, [token, data.generatedAt]);

  // Active run discovery + polling (S3): a run started from Overview, another tab, or before a
  // restart shows its progress here; terminal states refresh the ledger and leave a notice.
  const activeRunRef = useRef<RewardRun | null>(null);
  activeRunRef.current = activeRun;
  const activeRunId = activeRun?.runId ?? null;
  useEffect(() => {
    const controller = new AbortController();
    const tick = () => {
      const current = activeRunRef.current;
      const request = current
        ? loadRewardRun(token, current.runId, controller.signal).then((run) => [run])
        : listRewardRuns(token, 5, controller.signal);
      request
        .then((runs) => {
          if (controller.signal.aborted) return;
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
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          if (cause instanceof RewardRunsUnavailableError) setRunsUnavailable(true);
        });
    };
    tick();
    const interval = window.setInterval(
      () => {
        if (document.visibilityState === "visible") tick();
      },
      activeRunId ? RUN_POLL_MS : LEDGER_POLL_MS,
    );
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
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

  // Payments per Distribute card. The ledger read carries the selected cycle's rows; every other
  // card fetches its own distribution and refreshes whenever the ledger does. Targets come from the
  // ledger alone so this effect never depends on the payments it stores.
  const pendingTargets = useMemo(
    () =>
      ledger
        ? pendingDistributions(ledger).map(({ cycle, distribution }) => ({
            key: distributionKey(cycle.cycle, distribution.distribution),
            cycle: cycle.cycle,
            distribution: distribution.distribution,
          }))
        : [],
    [ledger],
  );
  const seededStamp = useRef<string | null>(null);
  const fetchedStamp = useRef<Record<string, string>>({});
  const preparationPollRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!ledger) return;
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
        setCardPayments((current) => ({ ...current, byKey: { ...current.byKey, ...seeded } }));
      }
    }
    const controller = new AbortController();
    for (const target of pendingTargets) {
      if (fetchedStamp.current[target.key] === ledger.generatedAt) continue;
      fetchedStamp.current[target.key] = ledger.generatedAt;
      loadRewardLedger(
        token,
        { cycle: target.cycle, distribution: target.distribution },
        controller.signal,
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setCardPayments((current) => ({
            byKey: { ...current.byKey, [target.key]: result.payments },
            errors: Object.fromEntries(
              Object.entries(current.errors).filter(([key]) => key !== target.key),
            ),
          }));
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          delete fetchedStamp.current[target.key];
          setCardPayments((current) => ({
            ...current,
            errors: { ...current.errors, [target.key]: operatorErrorSentence(cause) },
          }));
        });
    }
    return () => controller.abort();
  }, [ledger, pendingTargets, token]);

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

  // Overview hands over a pending run kind; open the same sheet once the ledger is here.
  useEffect(() => {
    if (!ledger || cards.length === 0) return;
    const pending = sessionStorage.getItem(PENDING_RUN_STORAGE_KEY);
    if (!pending) return;
    sessionStorage.removeItem(PENDING_RUN_STORAGE_KEY);
    const match =
      cards.find((card) => card.primary?.kind === pending)?.primary ??
      cards.find((card) => card.secondary?.action.kind === pending)?.secondary?.action ??
      null;
    if (match) openConfirm(match);
  }, [ledger, cards, openConfirm]);

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
    async (cycle: number, distributionIndex: 1 | 2) =>
      (await loadRewardLedger(token, { cycle, distribution: distributionIndex })).payments,
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
        className="btn btn-secondary sm"
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
        className="btn btn-secondary sm"
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
        className="btn btn-secondary sm"
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

  // Past cycles: strictly older than the accruing cycle, and not still in Distribute. A cycle with
  // a distribution that needs the operator is listed there until it is finished.
  const accruingCycle = earning?.cycle ?? ledger?.current.cycle ?? null;
  const pendingCycles = new Set(cards.map((card) => card.cycle));
  const pastCycles = (ledger?.cycles ?? []).filter(
    (cycle) =>
      (accruingCycle === null || cycle.cycle < accruingCycle) && !pendingCycles.has(cycle.cycle),
  );
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
        <EarningCard model={earning} />
      ) : (
        <RequestState
          label="the reward ledger"
          loading={ledgerLoading}
          error={ledgerError}
          retry={() => setLedgerRetry((value) => value + 1)}
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
              Nothing to distribute right now — the next distribution appears here once the network
              calculates it.
            </div>
          ) : (
            cards.map((card) => (
              <DistributionCard
                key={card.key}
                model={card}
                payments={cardPayments.byKey[card.key] ?? null}
                paymentsError={cardPayments.errors[card.key] ?? null}
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
