# PoX-5 Signer Sidekick v1 review questions

This document is the forwardable technical review questionnaire for the v1 plan. Operator/product
decisions are tracked separately in GitHub issue #2. These questions are intended for the CTO,
Stacks core, signer, reference-manager, and API developers. Reviewers should link to source, code,
or a reproducible observation where possible and identify whether an answer is mainnet-specific.

## Stacks core and PoX-5

1. Which public testnet endpoint/network is transitioning to PoX-5, what node build/commit will
   land, and what activation height/first reward cycle should its `/v2/pox` advertise?
2. Please confirm the stacks-core 4.0.1 mainnet PoX-5 source, activation configuration, sBTC
   principals, and `pox_5_sbtc_contract`/`pox_5_sbtc_registry_contract` response fields as the
   launch compatibility baseline.
3. What is the earliest authoritative on-chain condition under which a signer-manager should
   call `claim-rewards` for a distribution checkpoint?
4. Which actor is expected to call `calculate-rewards` normally, and is a permissionless
   fallback after a short grace period the intended operational model?
5. Is the active bond-period input required in the exact ordering described in SIP-045 and the
   4.0.0 contract, including for an STX-only signer-manager?
6. Are there reorg, prepare-phase, or half-cycle boundary cases not represented in the v1 plan?

## Reference signer-manager authors

1. Which PoX-5 and sBTC principals must be substituted for a production mainnet deployment?
2. Is there a canonical build or deployment manifest planned for the reference manager?
3. Are the documented fee snapshot, unclaimed reward, withdrawal liability, settlement, and
   reclaim interpretations correct?
4. Which source hash or deployed contract principals should Sidekick recognize automatically?

## Stacks API

1. Which v9 endpoints and event fields are authoritative for enumerating a manager's stakers,
   stake changes, reward claims, signer registrations, and deferred unlocks?
2. What cursor, canonicality, microblock, reorg, and historical-retention guarantees apply?
3. How should a client detect indexed-tip lag and a provider change safely?
4. Which features are available from a self-hosted API without Hiro-specific services?

## Signer tooling and operator documentation

1. Please confirm the complete fresh-setup prerequisites and that the Stacks 4.0.1
   `generate-staking-signature` command retains the pinned four-field JSON contract covered by the
   upstream cross-language fixture.
2. Which signer configuration values may be displayed or exported safely in an operator support
   bundle?
3. What is the recommended operator ceremony for broadcasting and verifying `register-self`
   without giving Sidekick the signer or manager-admin key?

Signer-host version/liveness and signing-health monitoring are deferred to V2 and are not v1
review blockers.

## Future-cycle forecast

1. Which PoX-5 per-cycle read-only functions are authoritative for current and future signer-set
   membership, delegated amount, pending STX, and eligible STX shares?
2. Which future-cycle values must remain explicitly labeled as local projections rather than
   authoritative contract state?

## Security

1. Are the source-recognition, key-separation, post-condition, nonce, and circuit-breaker
   boundaries sufficient for a low-balance gas-payer automation service?
2. Which mainnet confirmation and fee-replacement defaults should apply to each permissionless
   operation?
3. Are any browser-visible transaction fields or support-bundle fields too sensitive to expose?

The following compatibility-attestation questions are future Phase 4/6 work, not V1 read-only or
Fresh-setup blockers:

4. Can the official network/core release process publish an authenticated manifest containing the
   deployed PoX-5/sBTC principals, contract hashes, and manager provenance Sidekick needs? Which
   official signing key or artifact-attestation mechanism should clients trust?
5. If upstream cannot publish that manifest, who should hold a Stacks Labs compatibility key and
   what review, rotation, revocation, distribution, remote-cache, and rollback-protection process
   should be required before automation is enabled?

## Stacks design and open-source release

1. Which canonical Stacks, STX, and Bitcoin SVG assets should be used, and under what terms?
2. Does the documented mainnet/testnet accent treatment match the current product system?

## Pool operators

1. Does each screen answer the right primary operational question?
2. Which alerts must wake an operator versus remain dashboard-only?
3. Are the proposed direct-sBTC and L1 payout defaults understandable and safe?
4. What information do operators need to publish for official pool enrollment interfaces?
