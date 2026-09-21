import { useState } from "react";
import { activityHash, settingsHash } from "../../dashboard-route.js";
import { Badge, ErrorCallout } from "../../shared/dashboard-ui.js";
import { shortUtc } from "../../shared/format.js";
import { useRewardSchedule } from "../rewards/reward-schedule-api.js";
import { SettingsRow } from "./settings-ui.js";

export function RewardScheduleSettings({ token, readOnly }: { token: string; readOnly: boolean }) {
  const { status, error, saving, save } = useRewardSchedule(token);
  const [interval, setInterval] = useState<string | null>(null);
  const minutes = Number(interval ?? status?.intervalMinutes ?? 15);
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
  const toggle = () => {
    if (!status) return;
    if (
      !status.enabled &&
      !window.confirm(
        "Enable automatic reward runs for this pool? Sidekick will prepare and approve eligible calculate, collect, distribute and Finish Bitcoin payouts calls, including newly eligible stakers, using the current gas-wallet fee limits. Per-run limits are not a monthly spending cap. Review any stopped run before re-enabling.",
      )
    )
      return;
    void save({
      enabled: !status.enabled,
      intervalMinutes: status.enabled ? status.intervalMinutes : minutes,
      revision: status.revision,
    });
  };
  return (
    <div className="st-rows">
      <ErrorCallout error={error} />
      <SettingsRow
        name="Automatic reward runs"
        help="Checks for eligible reward work on this schedule and approves the same sealed recipes as the manual buttons. Stops for review if a run halts or expires. No admin actions or withdrawals of your fees."
        value={status?.detail ?? "Loading schedule"}
        detail="Disabling stops new approvals. An approval already in progress or an approved run may continue; use Force Observe to stop new signing."
        statusNode={
          <Badge
            state={
              status?.state === "needs-attention"
                ? "caution"
                : status?.enabled
                  ? "success"
                  : "neutral"
            }
          >
            {!status
              ? "Unknown"
              : status.enabled
                ? "On"
                : status?.state === "needs-attention"
                  ? "Needs attention"
                  : "Off"}
          </Badge>
        }
        actions={
          <button
            type="button"
            className="btn btn-tertiary sm"
            disabled={saving || !status || (!status.enabled && (readOnly || !valid))}
            onClick={toggle}
          >
            {saving ? "Saving" : status?.enabled ? "Disable schedule" : "Enable automatic runs"}
          </button>
        }
      />
      <SettingsRow
        name="Check interval"
        value={
          <label>
            Every{" "}
            <input
              aria-label="Reward check interval in minutes"
              type="number"
              className="st-fee-input"
              min={1}
              max={1440}
              value={interval ?? status?.intervalMinutes ?? 15}
              disabled={readOnly || saving}
              onChange={(event) => setInterval(event.target.value)}
            />{" "}
            minutes
          </label>
        }
        detail={
          status?.nextCheckAt
            ? `Next check ${shortUtc(status.nextCheckAt)} · last check ${shortUtc(status.lastCheckAt)}`
            : `Last check ${shortUtc(status?.lastCheckAt)}`
        }
        actions={
          !readOnly ? (
            <button
              type="button"
              className="btn btn-tertiary sm"
              disabled={
                readOnly || saving || !status || !valid || minutes === status.intervalMinutes
              }
              onClick={() => {
                if (status)
                  void save({
                    enabled: status.enabled,
                    intervalMinutes: minutes,
                    revision: status.revision,
                  });
              }}
            >
              Save interval
            </button>
          ) : null
        }
      />
      {status?.runId ? (
        <SettingsRow
          name="Scheduled run"
          value={
            <a href={activityHash(`reward-run:${status.runId}`)}>
              View run and transaction evidence
            </a>
          }
        />
      ) : null}
    </div>
  );
}

export function RewardScheduleIndicator({ token }: { token: string }) {
  const { status, error } = useRewardSchedule(token);
  return (
    <p className="hint">
      <a href={settingsHash("capabilities")}>
        {error
          ? "Reward schedule unavailable"
          : !status
            ? "Checking reward schedule"
            : status.state === "needs-attention"
              ? "Automatic rewards need attention"
              : status.enabled
                ? "Automatic rewards on"
                : "Automatic rewards off"}
      </a>
      {status?.enabled || status?.state === "needs-attention" ? ` · ${status.detail}` : null}
    </p>
  );
}
