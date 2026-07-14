export const STACKS_CORE_4_0_0 = {
  tag: "4.0.0",
  commit: "5595f08a244362cefc316f95b398510a2b8cb791",
  pox5SourceSha256: "39c33b7e2cf9864e974e15b1d776045fcc46c583092330305293b97d2ae4135c",
  referenceManagerSourceSha256: "f86819132e5c4e6f00d491b27f32ded4c3342c2be875ff90d1eba70fd5f0a5cf",
} as const;

export const REFERENCE_MANAGER_PUBLIC_FUNCTIONS = [
  "validate-stake!",
  "claim-rewards",
  "claim-staker-rewards",
  "reclaim-failed-withdrawal",
  "settle-accepted-withdrawal",
  "update-admin",
  "update-fees",
  "withdraw-fees",
  "sweep-fee-refunds",
  "register-self",
] as const;

export const REFERENCE_MANAGER_READ_ONLY_FUNCTIONS = [
  "get-earned-staker-rewards",
  "is-admin",
  "get-fee-bips-for-cycle",
  "get-earned-fees",
  "get-withdrawal-liability",
  "get-unclaimed-staker-rewards",
  "get-pox-addr",
  "get-withdrawal-request-staker",
  "check-pox-addr",
] as const;

export type ReferenceManagerPublicFunction = (typeof REFERENCE_MANAGER_PUBLIC_FUNCTIONS)[number];
export type ReferenceManagerReadOnlyFunction =
  (typeof REFERENCE_MANAGER_READ_ONLY_FUNCTIONS)[number];
