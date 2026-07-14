export type AutomationMode = "observe" | "assist" | "automate";

export type DataAuthority = "node" | "api" | "derived";

export interface ChainObservation<T> {
  value: T;
  authority: DataAuthority;
  observedAtBurnHeight: number;
  observedAt: string;
}
