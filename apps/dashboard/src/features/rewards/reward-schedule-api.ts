import {
  type RewardScheduleSettings,
  type RewardScheduleStatus,
  rewardScheduleStatusSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useRef, useState } from "react";
import { apiJson } from "../../api-client.js";
import { operatorActionError } from "../../shared/operator-error.js";
import { startVisibleRefresh } from "../../shared/visible-refresh.js";

export function useRewardSchedule(token: string) {
  const [status, setStatus] = useState<RewardScheduleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const savingRef = useRef(false);
  useEffect(() => {
    setStatus(null);
    const refresh = startVisibleRefresh(
      async (signal) => {
        if (savingRef.current) return;
        const started = generation.current;
        const result = await apiJson(
          token,
          "/api/v1/rewards/schedule",
          rewardScheduleStatusSchema,
          { signal },
        );
        if (!signal.aborted && started === generation.current) {
          setStatus(result);
          setError(null);
        }
      },
      (cause) =>
        setError(
          operatorActionError(cause, "Could not load the reward schedule", "Retrying is safe"),
        ),
    );
    return () => refresh.stop();
  }, [token]);
  const save = async (settings: RewardScheduleSettings) => {
    if (savingRef.current) return;
    savingRef.current = true;
    generation.current++;
    setSaving(true);
    setError(null);
    try {
      const result = await apiJson(token, "/api/v1/rewards/schedule", rewardScheduleStatusSchema, {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      generation.current++;
      setStatus(result);
    } catch (cause) {
      setError(
        operatorActionError(cause, "Could not save the reward schedule", "Refresh before retrying"),
      );
    } finally {
      generation.current++;
      savingRef.current = false;
      setSaving(false);
    }
  };
  return { status, error, saving, save };
}
