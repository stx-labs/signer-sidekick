# Deployed signer-manager baseline

- Status: Initial mainnet census; behavioral verification still required
- Snapshot date: 2026-08-13
- Purpose: Define contract-neutral Sidekick behavior and the evidence required for reusable manager
  interactions

## Conclusion

Sidekick should not use a signer-manager source hash, contract name, or release version as an
admission gate.

The mainnet signer-manager trait guarantees only this public function:

```clarity
(validate-stake!
  (principal uint uint uint uint bool (optional (buff 500)))
  (response bool uint))
```

It does not define manager administration, fees, claims, payouts, withdrawal accounting, or print
events. Those behaviors differ materially among deployed contracts. A trait-compliant manager can
therefore always receive Sidekick's PoX-5 baseline, but manager-specific reads and transactions need
runtime capability discovery plus a reviewed behavioral adapter. Executable use of an adapter
requires the deployed contract's byte-exact source to match an immutable source fingerprint reviewed
for that capability; that narrow gate never blocks attachment or baseline observation.

The compatibility rule is:

> Observe every trait-compliant manager through PoX-5; interact only with capabilities whose exact
> behavior Sidekick can prove and test.

## Method and limitations

The initial deployment supplement queried the canonical mainnet deployments returned by the Hiro Stacks API
`/extended/v1/contract/by_trait` endpoint using the PoX-5 signer-manager trait ABI. It collected the
deployed principal, source, ABI, deployment transaction, Clarity version, and block height, then
grouped exact sources by SHA-256 and compared public/read-only interfaces and source behavior. The
API schema is maintained in the official
[Stacks Blockchain API OpenAPI specification](https://github.com/hirosystems/stacks-blockchain-api/blob/master/openapi.yaml).

This found **47 canonical deployments**, **10 byte-distinct sources**, and approximately **six
meaningful behavior families**. Byte-distinct does not necessarily mean behavior-distinct: final
newlines, comments, and formatting account for several groups.

This is not the authoritative signer census. Names such as `not-used`, `signer-manager-test`, and
`test-mainnet01` demonstrate why deployment alone is insufficient. The primary population must be
derived from PoX-5 registration and current/next signer sets, then enriched with recent calls,
events, and trait-discovered historical or not-yet-registered contracts before prioritizing
adapters by real usage.

## Observed behavior families

| Behavior family | Deployments | Observed behavior | Compatibility consequence |
| --- | ---: | --- | --- |
| Current reference-like | 26 across four byte variants | Registration; multi-admin updates; fee updates; aggregate claim followed by per-staker claims; fee withdrawal/refunds; withdrawal-liability recovery | Good first reusable adapter, but the adapter should match exact callable/return behavior rather than the contract name or source hash |
| Legacy reference-like | 3 Xverse deployments | Nearly the reference flow, but `claim-staker-rewards` returns a `uint` rather than the newer `{ earned, withdrawal-request }` tuple | Requires a distinct response decoder and post-state behavior; a matching function name is not enough |
| Restricted-recipient / allowlist | 14 deployments: eight pool/operator and six bond-labeled contracts | External admin contract, allowed-staker map, one reward recipient, aggregate claimed rewards transferred to that recipient | Does not expose the reference per-staker fee/withdrawal model; Sidekick should present allowlist/recipient capabilities rather than reference claims |
| max500 advanced | 2 deployments | Five-percent fee cap, delayed fee increases, last-admin guard, payout configuration, minimum claims, pending payouts, per-cycle buckets, and staker refund accounting | Reusable advanced adapter candidate; several behaviors intentionally differ from the reference family |
| Native-pool | 1 deployment | Eligibility delegated to an external native-pool contract; stakers claim their own rewards; no common fee/admin surface beyond external admin | Pool membership and claim semantics depend on an external contract and need their own capability adapter |
| Juice Pool STX | 1 deployment | Custom STX-denominated redistribution, tranches, fee proposal/confirmation, pause and OG controls | Preserve generic source/ABI/events in core; specialized tranche and STX redistribution tooling stays custom unless separately standardized |

The current reference-like count includes 24 exact/reference-newline deployments, one Blockdaemon
variant whose substantive difference is header comments, and one reformatted `fastpool-1` source.
One of the reference deployments is
`SP2369QN53586176SYRF4XFGF4E84V0J0EWKRG0ZH.signer-manager`.

### Current reference-like surface

The common public functions observed in the current reference family are:

- `register-self`, `update-admin`, and `update-fees`;
- `claim-rewards`, `claim-staker-rewards`, and `withdraw-fees`;
- `sweep-fee-refunds`, `settle-accepted-withdrawal`, and
  `reclaim-failed-withdrawal`; and
- the required `validate-stake!`.

Its useful read-only surface includes admin status, cycle fees, earned/unclaimed staker rewards,
earned fees, payout address, withdrawal liabilities, and withdrawal-request ownership.

### Legacy reference difference

The three legacy Xverse deployments use the same broad claim flow but return only earned amount from
`claim-staker-rewards`. The newer reference behavior returns both earned amount and an optional
withdrawal request identifier. Sidekick must not decode the old and new functions as the same
capability solely because their names match.

### Restricted-recipient difference

The 14 restricted-recipient contracts expose `set-allowed-staker`, `set-rewards-recipient`,
`register-self`, `claim-rewards`, and `validate-stake!`. Their aggregate claim transfers to one
configured recipient. They do not implement the reference manager's per-staker fee, liability, or
claim surface.

### max500 difference

The two max500 deployments extend reference-style accounting with safety and payout policies:

- maximum fee of five percent;
- fee increases delayed by two cycles while decreases can take effect immediately;
- last-admin protection;
- per-staker maximum-fee and minimum-claim settings;
- reward settlement separated from payout so small balances can accumulate; and
- explicit pending payout and refund accounting.

These are valuable product capabilities but are not universal signer-manager behavior.

## Contract-neutral baseline

The universal product surface should be derived from the configured PoX-5 contract and keyed by the
attached manager principal. The vendored Stacks Core 4.0.1 PoX-5 contract exposes the necessary
read-only building blocks:

| Operator question | PoX-5 evidence | Manager adapter required? |
| --- | --- | --- |
| Is this a signer manager and what runtime contract is attached? | Trait check, deployed source/ABI, principal and deployment metadata | No |
| Is the signer registered with the expected public key? | `get-signer-info` and `verify-signer-key-grant` | No |
| Is it eligible/current/next and what is its weight? | `get-signer-set-item-for-cycle`, `get-signer-pending-staked-ustx-per-cycle`, and `get-signer-shares-staked-for-cycle` | No |
| How much STX is delegated to it? | `get-amount-delegated-for-signer` and cycle totals | No |
| Which STX-only participants belong to it? | Candidate discovery followed by `get-staker-info`, `get-signer-cycle-membership`, and manager-keyed PoX state | No manager adapter; indexed discovery may be required |
| Which bond participants contribute STX? | Candidate discovery followed by `get-bond-membership`, `get-signer-cycle-membership`, staker state, signer shares, and reward-cycle membership | No manager adapter; indexed discovery may be required |
| What has accrued and what is claimable? | `get-new-rewards`, `get-earned`, signer/staker reward-per-token and unclaimed-reward reads | No for PoX facts; yes for manager payout/fee accounting |
| What did the attached manager emit or call? | Generic ABI, source, contract-call, and print-event evidence | No for raw evidence; yes for normalized product semantics |
| Can Sidekick prepare a particular manager action? | Detected exact capability plus adapter invariants | Yes |

This means an unknown but trait-compliant contract is not “unsupported.” Sidekick can still explain
its registration, grant, signer-set state, weight, STX-only and bond participants, PoX rewards,
generic contract activity, node/signer health, and provenance. Only individual actions or
manager-derived accounting views may be unavailable.

## Capability model

### Level 0: universal PoX-5 observation

- Never gated by a known source or deployment profile.
- Anchored to the local node.
- Includes both STX-only and bond-derived STX positions.
- Degrades only the indexed discovery/history domains when the external API is stale.

### Level 1: runtime discovery

- Fetch ABI, source, deployment metadata, referenced contracts, and callable signatures.
- Display recognized capabilities and unknown/custom functions separately.
- Store source and structure hashes for support, drift comparison, and fixture selection.
- Do not infer authorization, recipients, accounting, or safe transaction construction from a
  function name alone.

### Level 2: reviewed behavioral adapters

One adapter should describe one reusable capability or tightly coupled behavior family, not bless a
whole contract. It must define:

- exact function, argument, response, and error shapes;
- authorization and referenced-contract assumptions;
- anchored reads and complete witness inputs;
- deterministic wallet-intent bytes and post-conditions;
- expected print events and post-state checks;
- stale/race/nonce/finality behavior; and
- contract, regtest, Devnet, and representative deployed-family fixtures.

A wallet-signed action can be offered only when these checks pass and the deployed byte-exact source
matches a fingerprint reviewed into that capability adapter. The fingerprint authorizes one
capability, not the whole manager or a product version. Assist requires the same adapter plus its
independent attestation, retry, revocation, finality, and security release gates.

### Level 3: custom extensions

Sidekick retains generic contract evidence and can identify that a custom function/event exists,
but it does not invent product semantics. An operator with a unique tranche, token, accounting, or
administration extension owns its specialized tooling until a reusable behavior is proposed and
reviewed for core.

## Source and hash policy

Keep source, ABI, source hash, normalized structure hash, deployment transaction, and Clarity
version in the support record. Use them to:

- reproduce exactly what code was deployed;
- detect a newly observed source or a changed adapter match;
- select known fixtures and explain family relationships; and
- give Stacks Labs enough evidence to triage a custom deployment.

Do not use them to:

- refuse attachment or hide PoX-5 baseline state;
- declare an entire manager trusted or untrusted;
- grant transaction capabilities from editable data; or
- require Zero to Signing and Sidekick to pin the same manager release.

## Work needed to complete the baseline

1. Generate the primary census from PoX-5 registration and current/next signer sets at a recorded
   local-node anchor.
2. Preserve the raw 2026-08-13 trait-discovery supplement as a generated test/research artifact with
   query parameters, response anchor, and checksums rather than committing an unexplained API dump;
   cross-reference its 47 deployments with the registration-derived population.
3. Produce semantic diffs for each family: authorization, external contracts, state maps, fee
   rules, claim recipients, withdrawal/payout behavior, event schema, and response/error values.
4. Collect representative successful and failed transactions/events for active families and
   compare observed post-state with source-derived expectations.
5. Turn the universal baseline and each approved reusable behavior into machine-readable
   capabilities backed by code and immutable reviewed source fingerprints, not an editable
   product-wide allowlist.
6. Add golden contract vectors and end-to-end attach/observe/action tests for each admitted
   capability family, including both STX-only and bond participation.
7. Detect new trait-matching mainnet deployments and open a review task without blocking their
   universal Sidekick baseline.

## Decisions this review does not make

- Which active family should receive the second adapter after the reference-like baseline.
- Who approves behavioral adapters and Assist eligibility.
- What evidence and cadence mark the deployed census complete and current.
- Which manager Zero to Signing recommends to a new operator. That choice may consider usability
  and safety, but it does not control whether Sidekick can attach.
