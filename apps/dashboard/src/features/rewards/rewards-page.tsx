import { Coins, Percent } from "@phosphor-icons/react";
import {
  type DashboardSnapshot,
  type GasWalletStatus,
  type HealthSnapshot,
  healthSnapshotSchema,
  type RewardCalculationRealization,
  type RewardLedger,
  type RewardLedgerPayment,
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
  createGasWallet,
  dismissGasWalletBanner,
  loadGasWalletStatus,
} from "../settings/gas-wallet-api.js";
import { RewardAccounting } from "./reward-accounting.js";
import { rewardManagerCapabilityId } from "./reward-action-capabilities.js";
import { GasWalletBanners } from "./reward-banners.js";
import { type ConfirmState, RewardConfirmSheet } from "./reward-confirm-sheet.js";
import { loadRewardLedger } from "./reward-ledger-api.js";
import { RewardNowCard } from "./reward-now-card.js";
import { PastCycles } from "./reward-past-cycles.js";
import { PaymentsTable, paymentsHint } from "./reward-payments.js";
import { ProjectionDetails } from "./reward-projection-details.js";
import { currentDistribution, deriveRewardNow, type RewardPrimaryAction } from "./reward-state.js";
import {
  approveRewardRun,
  draftRewardRun,
  loadRewardRun,
  pauseRewardRun,
  type RewardRun,
  RewardRunsUnavailableError,
} from "./run-api.js";
import { RequestState, StakerSettlementPanel } from "./staker-settlement-panel.js";

type Snapshot = DashboardSnapshot;

const RUN_POLL_MS = 5_000;
const LEDGER_POLL_MS = 30_000;
/** Overview's "Collect & distribute" hands the same confirm sheet over through this key. */
export const PENDING_RUN_STORAGE_KEY = "sidekick-rewards-pending-run";

function activeRunState(state: string): boolean {
  return [
    "planned",
    "approved",
    "running",
    "started",
    "collecting",
    "distributing",
    "calculating",
    "paused",
  ].includes(state);
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
  const [gasWallet, setGasWallet] = useState<GasWalletStatus | null>(null);
  const [engineMode, setEngineMode] = useState<"observe" | "operator-run" | null>(null);
  const [burnBlockTiming, setBurnBlockTiming] = useState<HealthSnapshot["burnBlockTiming"]>(null);
  const [realizations, setRealizations] = useState<RewardCalculationRealization[]>([]);
  const [activeRun, setActiveRun] = useState<RewardRun | null>(null);
  const [confirm, setConfirm] = useState<{
    action: RewardPrimaryAction;
    state: ConfirmState;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [walletPanelOpen, setWalletPanelOpen] = useState(false);
  const walletPanelRef = useRef<HTMLDivElement | null>(null);
  const rewards = data.rewards;
  const calculation = data.rewardOutlook?.calculation ?? rewards?.calculation ?? null;
  const calculationGrace = calculation?.next?.grace ?? null;
  const calculationActionAvailable =
    calculationGrace?.state === "action-required" && !operatorStateStale;

  const refreshLedger = useCallback(
    async (signal?: AbortSignal) => {
      const result = await loadRewardLedger(token, {}, signal);
      if (signal?.aborted) return;
      setLedger(result);
      setLedgerError(null);
    },
    [token],
  );

  // Ledger: the page's single source for cycles, the current distribution, its payments, fees.
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
        if (!controller.signal.aborted) setGasWallet(null);
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

  // Projection accuracy + Bitcoin block timing for "expected in about …".
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

  // Active run polling (S3): keep the progress line live while a run is in flight.
  useEffect(() => {
    if (!activeRun || !activeRunState(activeRun.state)) return;
    const controller = new AbortController();
    const tick = () => {
      loadRewardRun(token, activeRun.runId, controller.signal)
        .then((run) => {
          if (controller.signal.aborted) return;
          setActiveRun(run);
          if (!activeRunState(run.state)) {
            setNotice(
              run.state === "complete" || run.state === "done" || run.state === "finished"
                ? "Run finished. The ledger below reflects what reached the chain."
                : run.haltReason
                  ? `Run halted: ${run.haltReason}`
                  : `Run ${run.state}.`,
            );
            refreshLedger().catch(() => undefined);
          }
        })
        .catch(() => undefined);
    };
    const interval = window.setInterval(tick, RUN_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [activeRun, refreshLedger, token]);

  const nextCalculationIn =
    calculation?.next?.state === "scheduled" && burnBlockTiming
      ? compactDuration(calculation.next.blocksRemaining * burnBlockTiming.averageSeconds)
      : null;
  const distribution = ledger ? currentDistribution(ledger) : null;
  const payments: RewardLedgerPayment[] = ledger?.payments ?? [];
  const model = useMemo(
    () =>
      ledger
        ? deriveRewardNow({
            ledger,
            payments,
            snapshot: data,
            gasWallet,
            engineMode,
            activeRun: activeRun && activeRunState(activeRun.state) ? activeRun : null,
            nextCalculationIn,
          })
        : null,
    [ledger, payments, data, gasWallet, engineMode, activeRun, nextCalculationIn],
  );

  const openConfirm = useCallback(
    (action: RewardPrimaryAction) => {
      setConfirm({ action, state: { status: "drafting" } });
      draftRewardRun(token, {
        kind: action.kind,
        cycle: ledger?.current.cycle ?? null,
        distribution: action.distribution ?? ledger?.current.distribution ?? null,
      })
        .then((run) =>
          setConfirm((current) =>
            current?.action === action ? { action, state: { status: "ready", run } } : current,
          ),
        )
        .catch((cause: unknown) =>
          setConfirm((current) =>
            current?.action === action
              ? {
                  action,
                  state:
                    cause instanceof RewardRunsUnavailableError
                      ? {
                          status: "unavailable",
                          reason:
                            "The engine update that runs calls from here has not shipped in this build.",
                        }
                      : { status: "error", message: operatorErrorSentence(cause) },
                }
              : current,
          ),
        );
    },
    [ledger, token],
  );

  // Overview hands over a pending run kind; open the same sheet once the ledger is here.
  useEffect(() => {
    if (!model || !ledger) return;
    const pending = sessionStorage.getItem(PENDING_RUN_STORAGE_KEY);
    if (!pending) return;
    sessionStorage.removeItem(PENDING_RUN_STORAGE_KEY);
    if (model.primary && model.primary.kind === pending) openConfirm(model.primary);
  }, [ledger, model, openConfirm]);

  const go = (run: RewardRun) => {
    setConfirm((current) =>
      current ? { ...current, state: { status: "approving", run } } : current,
    );
    approveRewardRun(token, run.runId)
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

  const pause = () => {
    if (!activeRun) return;
    setPausing(true);
    pauseRewardRun(token, activeRun.runId)
      .then((run) => setActiveRun(run))
      .catch((cause: unknown) => setNotice(operatorErrorSentence(cause)))
      .finally(() => setPausing(false));
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

  const viewCycle = (cycle: number) => {
    document
      .getElementById(`rewards-cycle-${cycle}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
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

  const pastCycles = ledger
    ? ledger.cycles.filter((cycle) => cycle.cycle !== ledger.current.cycle)
    : [];
  const paymentsForTable =
    ledger && distribution && ledger.query.cycle === null ? payments : payments;
  const walletFallback = model?.execution.walletFallback ?? engineMode !== "operator-run";

  return (
    <>
      <PageHead
        title="Rewards"
        lede="What the network calculated, what you collected, and what reached your stakers — for this distribution and every cycle before it."
      />
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
        neededTransactions={model?.primary?.transactions ?? 0}
        onCreate={createWallet}
        onDismiss={dismissBanner}
        onFundInstructions={() => {
          location.hash = settingsHash("gas-wallet");
        }}
      />
      {ledger && model ? (
        <RewardNowCard
          model={model}
          onPrimary={openConfirm}
          onSecondary={(secondary) =>
            openConfirm({
              kind: secondary.kind,
              label: secondary.label,
              transactions: 1,
              distribution:
                model.previous?.kind === "prior-outstanding" ? model.previous.distribution : null,
            })
          }
          onViewCycle={viewCycle}
          onPause={activeRun ? pause : undefined}
          pausing={pausing}
          busy={confirm !== null}
        />
      ) : (
        <RequestState
          label="the reward ledger"
          loading={ledgerLoading}
          error={ledgerError}
          retry={() => setLedgerRetry((value) => value + 1)}
        />
      )}
      {calculationActionAvailable ? (
        <div className="callout callout-caution content-notice" role="status">
          <div className="body">
            <strong>Global reward calculation needs an operator.</strong> PoX-5 credits nothing for
            cycle {calculation?.targetRewardCycle ?? "—"} until someone calls{" "}
            <code>calculate-rewards</code>. Anyone can; it moves no funds.
            <div className="actions">
              <a className="btn btn-primary sm" href={actionHash("calculate-rewards")}>
                Review calculation
              </a>
            </div>
          </div>
        </div>
      ) : null}
      {model && walletFallback && (model.primary || model.secondary) ? (
        <div className="callout callout-neutral content-notice" role="status">
          <div className="body">
            <strong>Sign with your own wallet.</strong> {model.execution.reason}
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
          <div className="section-title domain-section-anchor" id="rewards-claims">
            Payments <span className="hint">{paymentsHint(distribution)}</span>
          </div>
          <PaymentsTable
            payments={paymentsForTable}
            emptyText={
              distribution && distribution.calculation.state !== "done"
                ? "No payments yet for this distribution. They appear as soon as the network calculates it."
                : "No payments recorded for this distribution."
            }
          />
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
          <PastCycles cycles={pastCycles} loadPayments={loadDistributionPayments} />
          <RewardAccounting
            token={token}
            ledger={ledger}
            selectedCycle={ledger.current.cycle}
            selectedDistribution={ledger.current.distribution}
            feeActions={feeActions}
          />
        </>
      ) : null}
      {confirm && model ? (
        <RewardConfirmSheet
          action={confirm.action}
          eyebrow={model.eyebrow}
          execution={model.execution}
          state={confirm.state}
          onCancel={() => setConfirm(null)}
          onGo={go}
          onUseWallet={useWallet}
        />
      ) : null}
    </>
  );
}
