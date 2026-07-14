# PoX-5 Signer Sidekick v1 review questions

This document is the forwardable review questionnaire for the v1 plan. Reviewers should link
to source, code, or a reproducible observation where possible and identify whether an answer is
mainnet-specific.

## Stacks core and PoX-5

1. What is the earliest authoritative on-chain condition under which a signer-manager should
   call `claim-rewards` for a distribution checkpoint?
2. Which actor is expected to call `calculate-rewards` normally, and is a permissionless
   fallback after a short grace period the intended operational model?
3. Is the active bond-period input required in the exact ordering described in SIP-045 and the
   4.0.0 contract, including for an STX-only signer-manager?
4. Are there reorg, prepare-phase, or half-cycle boundary cases not represented in the v1 plan?

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

1. Please confirm the complete fresh-setup prerequisites and expected output of
   `stacks-signer generate-staking-signature` for a PoX-5 manager grant.
2. Which signer configuration values may be displayed or exported safely in an operator support
   bundle?
3. What is the recommended operator ceremony for broadcasting and verifying `register-self`
   without giving Sidekick the signer or manager-admin key?

## Security

1. Are the source-recognition, key-separation, post-condition, nonce, and circuit-breaker
   boundaries sufficient for a low-balance gas-payer automation service?
2. Which mainnet confirmation and fee-replacement defaults should apply to each permissionless
   operation?
3. Are any browser-visible transaction fields or support-bundle fields too sensitive to expose?

## Stacks design and open-source release

1. May Matter and Matter Mono be redistributed in this internal repository, a future public
   GPL-3.0 repository, and container images?
2. Which canonical Stacks, STX, and Bitcoin SVG assets should be used, and under what terms?
3. Does the documented mainnet/testnet accent treatment match the current product system?

## Pool operators

1. Does each screen answer the right primary operational question?
2. Which alerts must wake an operator versus remain dashboard-only?
3. Are the proposed direct-sBTC and L1 payout defaults understandable and safe?
4. What information do operators need to publish for official pool enrollment interfaces?
