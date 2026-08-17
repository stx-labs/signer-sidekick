# Signer-manager census evidence

This directory contains reproducible mainnet research snapshots used to prioritize and verify
Signer Sidekick capability adapters. It is deliberately outside every application and protocol
package. Nothing here is a runtime attach allowlist or an authorization source.

## Evidence model

Each snapshot combines four kinds of evidence:

1. A stable local-node anchor from `/v2/info`, `/v3/tenures/info`, and tip-pinned `/v2/pox` reads.
2. Current and next signer sets enumerated from PoX-5's linked-list read-only functions at that
   exact index-block hash.
3. PoX-5 registration and activity candidates discovered from indexed print events, then verified
   against `get-signer-info` at the local-node anchor.
4. Canonical trait-matching deployments discovered through the public indexer, with exact source
   files stored by SHA-256 and ABI files stored by the runtime's canonical interface fingerprint.

The local node is authoritative for chain state. The public indexer only supplies bounded candidate
discovery and deployment material. A manager absent from indexed discovery must still remain usable
for universal PoX-5 observation.

Lifecycle values are evidence-based:

- `active`: present in the current and/or next signer set;
- `historical-registered`: still registered with PoX-5 but absent from both sets;
- `not-yet-registered`: trait deployment exists but the anchored node has no signer registration;
- `unknown`: observed through a node-authoritative source without matching registration or trait
  deployment evidence.

Names containing words such as `test`, `unused`, or `not-used` are retained only as a
non-authoritative review hint. A name cannot prove operational status.

## Reproduce a snapshot

Use a fully synced mainnet Stacks node under the operator's control:

```sh
pnpm census:managers -- \
  --node-url http://127.0.0.1:20443 \
  --output research/signer-manager-census/mainnet-YYYY-MM-DD.json
```

`HIRO_API_KEY` is optional. The command never writes credentials or the supplied node URL into the
artifact. It writes:

- the JSON census and a sibling `.sha256` checksum;
- each distinct exact source under `sources/<sha256>.clar`; and
- each distinct ABI under `interfaces/<sha256>.json`, keyed by the same sorted-functions + Clarity
  version + epoch fingerprint used at runtime.

The manifest also records a comment/format-insensitive Clarity token digest for research grouping,
plus every observed interface hash, Clarity version, and epoch for each exact source. Token
equivalence is never executable evidence: the same token stream can run under different Clarity
language versions.

Run `pnpm test:census:managers` before trusting collector changes.

## Refresh and review policy

Refresh the checked-in snapshot:

- before adding or changing an executable manager capability adapter;
- after a PoX contract or Stacks Core protocol upgrade;
- when registration/trait monitoring reports a previously unseen source or interface; and
- at least monthly while mainnet PoX-5 managers are changing.

The latest snapshot is the research baseline; older snapshots may be retained when needed to
explain a behavioral change. A refresh can reprioritize review work but cannot grant a transaction
capability; the admission gate is defined in
[Manager compatibility baseline](../../docs/product/manager-compatibility-baseline.md).
