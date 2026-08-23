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
  ACTIVE_RUN_STATUSES,
  approveRewardRun,
  cancelRewardRun,
  IN_PROGRESS_RUN_STATUSES,
  listRewardRuns,
  loadRewardRun,
  operationsForKind,
  pauseRewardRun,
  prepareRewardRun,
  RewardRunsUnavailableError,
  resumeRewardRun,
} from "./run-api.js";
import { RequestState, StakerSettlementPanel } from "./staker-settlement-panel.js";

type Snapshot = DashboardSnapshot;

const RUN_POLL_MS = 5_000;
const LEDGER_POLL_MS = 30_000;
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
  const [runControlBusy, setRunControlBusy] = useState<"pause" | "resume" | "cancel" | null>(null);
  const [runsUnavailable, setRunsUnavailable] = useState(false);
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
            activeRun:
              activeRun && IN_PROGRESS_RUN_STATUSES.has(activeRun.status) ? activeRun : null,
            nextCalculationIn,
          })
        : null,
    [ledger, payments, data, gasWallet, engineMode, activeRun, nextCalculationIn],
  );

  const openConfirm = useCallback(
    (action: RewardPrimaryAction) => {
      setConfirm({ action, state: { status: "drafting" } });
      const cycle = ledger?.current.cycle ?? null;
      const distribution = action.distribution ?? ledger?.current.distribution ?? null;
      if (cycle === null || distribution === null) {
        setConfirm({
          action,
          state: { status: "error", message: "The current distribution is not known yet." },
        });
        return;
      }
      const settle = (state: ConfirmState) =>
        setConfirm((current) => (current?.action === action ? { action, state } : current));
      listRewardRuns(token, 5)
        .then(async (runs) => {
          const draft = runs.find(
            (run) =>
              run.status === "awaiting-approval" &&
              run.recipe.cycle === cycle &&
              run.recipe.distribution === distribution,
          );
          if (draft) return { run: draft, reused: true };
          const run = await prepareRewardRun(token, {
            cycle,
            distribution,
            operations: action.operations,
          });
          return { run, reused: false };
        })
        .then(({ run, reused }) => settle({ status: "ready", run, reused }))
        .catch((cause: unknown) =>
          settle(
            cause instanceof RewardRunsUnavailableError
              ? {
                  status: "unavailable",
                  reason: "This Sidekick build does not include the run engine.",
                }
              : { status: "error", message: operatorErrorSentence(cause) },
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

  // Newer live cycles wait behind the current distribution (shown on the Now card as "up next");
  // only strictly older cycles are history.
  const currentCycleNumber = ledger?.current.cycle ?? null;
  const pastCycles =
    ledger && currentCycleNumber !== null
      ? ledger.cycles.filter((cycle) => cycle.cycle < currentCycleNumber)
      : (ledger?.cycles ?? []);
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
              operations: operationsForKind(secondary.kind),
              transactions: 1,
              distribution:
                model.previous?.kind === "prior-outstanding" ? model.previous.distribution : null,
            })
          }
          onViewCycle={viewCycle}
          onRunControl={runControl}
          runControlBusy={runControlBusy}
          busy={confirm !== null || runsUnavailable}
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
          onDiscard={discardDraft}
          onUseWallet={useWallet}
        />
      ) : null}
    </>
  );
}
