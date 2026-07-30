// These constants describe a stacks-core release tag. The reference
// signer-manager lineage is tracked independently of the PoX-5 tags, so its
// hashes live in the manager profiles and network compatibility profiles
// rather than here. See contracts/PROVENANCE.md.
export const STACKS_CORE_4_0_0 = {
  tag: "4.0.0",
  commit: "5595f08a244362cefc316f95b398510a2b8cb791",
  mainnetEpoch4ActivationBurnHeight: 960_230,
  pox5SourceSha256: "39c33b7e2cf9864e974e15b1d776045fcc46c583092330305293b97d2ae4135c",
} as const;

export const STACKS_CORE_4_0_1 = {
  tag: "4.0.1",
  commit: "62e03cc5551bfc574223c2b78ce04ceca30cec37",
  mainnetEpoch4ActivationBurnHeight: 960_230,
  pox5SourceSha256: "ffad35ad181d85832ebd7b998f445204c92d5cd19549166e644fb1f3988fa385",
} as const;

// PoX-5's SIGNER_SET_MIN_USTX constant. Keep this value pinned to the vendored
// stacks-core profile rather than deriving eligibility from the API's global
// stacking minimum, which represents a different protocol value.
export const POX5_SIGNER_SET_MIN_USTX = 50_000_000_000n;

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
