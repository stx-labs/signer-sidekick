import { z } from "zod";

export const rewardScheduleSettingsSchema = z
  .object({
    enabled: z.boolean(),
    intervalMinutes: z.number().int().min(1).max(1440),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type RewardScheduleSettings = z.infer<typeof rewardScheduleSettingsSchema>;

export const rewardScheduleStatusSchema = rewardScheduleSettingsSchema.extend({
  state: z.enum(["off", "scheduled", "waiting", "preparing", "running", "needs-attention"]),
  detail: z.string(),
  nextCheckAt: z.iso.datetime().nullable(),
  lastCheckAt: z.iso.datetime().nullable(),
  runId: z.string().uuid().nullable(),
  preparationId: z.string().uuid().nullable(),
});
export type RewardScheduleStatus = z.infer<typeof rewardScheduleStatusSchema>;
