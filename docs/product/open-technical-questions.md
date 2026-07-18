# Open technical questions

These questions require Stacks core, signer, API, reference-manager, security, or release expertise;
the durable engine contract is [Transaction Engine V1](transaction-engine-v1.md). Answers must cite
source, code, or a reproducible network observation, state network-specific assumptions, and name
the accepting owner.

## Needed for public-testnet validation

1. Which PoX-5 Testnet endpoint, network ID, activation height, first reward cycle, PoX-5 source,
   sBTC principals, and node build are approved for release validation?
2. Does the released signer retain the tested four-field JSON output for
   `generate-staking-signature`?
3. What external ceremony should operators use to broadcast and verify `register-self` without
   sharing the signer consensus private key or manager-admin private key with Sidekick?
4. Which API endpoint(s) enumerate a manager's stakers after `stake-update` changes the latest
   signer while the current-cycle membership remains with the prior signer?
5. What pagination, canonicality, reorg, retention, and provider-change guarantees apply to roster,
   event, and transaction endpoints?

## Needed before the first manager claim in Assist

1. How does Sidekick positively prove that the V1 STX-staking-only manager has no sBTC bond
   participation and that an empty `bond-periods` list is exact for its `claim-rewards` call?
2. What confirmation/finality threshold applies, and what dropped-transaction, prepare-phase,
   half-cycle, and reorg behavior is protocol-specific?
3. Does an official mechanism faithfully simulate a public state-changing Clarity call against an
   exact live chain tip? If not, is anchored preflight plus deterministic unsigned transaction and
   postcondition preview the accepted Assist assurance model?
4. Who owns the compatibility-attestation issuer key, trust roots, release availability, rotation,
   revocation, expiry, clock policy, downgrade protection, and emergency response?

## Needed before the global calculator adapter

1. Who normally calls `calculate-rewards`, and what fallback delay/jitter should another
   permissionless caller use?
2. Which authoritative source enumerates the complete ordered chain-wide active-bond list required
   by `assert-all-active-bonds-included` at the target checkpoint?
3. How should Sidekick reconcile a lost calculator race, malformed/incomplete bond input, and a
   later calculation in the same reward cycle?

## Needed before staker payouts and withdrawals

1. What are the authoritative manager request-map and sBTC registry transitions for pending,
   accepted, rejected, settled, reclaimable, and reclaimed withdrawals?
2. Which race/error outcomes prove another caller completed the intended effect, and which require
   operator investigation?
3. Which current/future-cycle read-only values are authoritative for direct-sBTC and Bitcoin-L1
   payout planning, and which remain projections?

## Needed for production confidence

1. Which API v9 endpoints and fields are authoritative for stake changes, claims, registration, and
   deferred unlock history?
2. Which independent reviewer owns approval of attestation verification, gas-key handling,
   transaction vectors, nonce recovery, artifact redaction, and the first mainnet Assist canary?
