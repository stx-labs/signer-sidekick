export const submittedObservationIntervalMs = 30_000;
const maximumRetryIntervalMs = 5 * 60_000;

/** Read pacing only: never expires work or supplies transaction/authorization evidence. */
export class SubmittedObservationCadence {
  private readonly items = new Map<string, { nextAt: number; retryDelayMs: number }>();

  isDue(id: string, now: number): boolean {
    return now >= (this.items.get(id)?.nextAt ?? 0);
  }

  record(id: string, retryLater: boolean, now: number): void {
    const retryDelayMs = retryLater
      ? Math.min(
          maximumRetryIntervalMs,
          Math.max(submittedObservationIntervalMs, (this.items.get(id)?.retryDelayMs ?? 0) * 2),
        )
      : 0;
    this.items.set(id, {
      nextAt: now + Math.max(submittedObservationIntervalMs, retryDelayMs),
      retryDelayMs,
    });
  }

  retain(ids: readonly string[]): void {
    const active = new Set(ids);
    for (const id of this.items.keys()) if (!active.has(id)) this.items.delete(id);
  }
}
