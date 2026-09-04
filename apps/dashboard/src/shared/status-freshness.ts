export const STATUS_STALE_AFTER_MS = 120_000;

export function operatorStateIsStale(input: {
  connectionUnavailable: boolean;
  serverStatus: "current" | "stale" | undefined;
  ageMs: number | null;
}): boolean {
  return (
    input.connectionUnavailable ||
    input.serverStatus === "stale" ||
    input.ageMs === null ||
    input.ageMs > STATUS_STALE_AFTER_MS
  );
}
