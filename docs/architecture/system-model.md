# System model

Signer Sidekick is one local service and one operator dashboard for a single network,
signer-manager, and signer. The service owns collection, reconciliation, persistence, diagnosis,
and transaction verification. The browser is a view and wallet handoff, not a scheduler or source
of truth.

## Components

| Component | Responsibility |
| --- | --- |
| Sidekick API | Serves typed operator pages, coordinates refreshes, prepares wallet intents, and verifies submitted transactions. |
| Observer listener | Accepts bounded Stacks event callbacks on a private endpoint and durably queues them before acknowledgement. |
| Reconciliation workers | Verify callback claims, refresh affected domains, backfill current-member history, and run periodic anti-entropy. |
| Health monitor | Samples the local node and signer, compares optional independent references, and records durable finding episodes. |
| SQLite store | Keeps raw evidence, canonical anchors, projections, operation state, settings, and audit history behind typed repositories. |
| Dashboard | Reads page-specific API contracts, hands sealed intents to a browser wallet, and approves bounded reward runs. |

The default deployment packages these components in one container. The observer listener may bind a
separate private port, but it shares the service lifecycle and database.

## Authority

| Question | Authority |
| --- | --- |
| Current chain, PoX-5, account, and manager-readable state | Configured local Stacks node at a stable canonical anchor |
| Roster discovery and historical enumeration | Indexed API, followed by local-node verification wherever a proof exists |
| Local signer behavior | Signer monitoring metrics correlated with local node state |
| Network comparison | Multiple independent references used only to classify a local symptom |
| Operation completion | Canonical transaction bytes plus the operation's expected poststate |
| Durable history | SQLite record carrying its source, anchor, verification strength, and observation time |

No optional API can override a node-proved fact. Missing API or signer-monitoring data degrades only
the domain that requires it.

## Reconciliation flow

```text
Stacks callback -> durable inbox -> local-node verification -> focused refresh
                                                       |
Periodic anti-entropy -> indexed discovery ------------+
                                                       v
                                      anchored reads and canonical evidence
                                                       v
                                      durable domain records and projections
                                                       v
                                           page APIs and support bundle
```

Callbacks provide latency, not authority. Every worker is restart-safe, idempotent, single-flight
per domain, and bounded by persisted cursors or retry state. The service refreshes the current
operator snapshot without an open browser.

## Operator action flow

```text
anchored state -> reviewed capability adapter -> sealed plan
      browser-wallet action -> txid only -----------------------+
      approved reward recipe -> dedicated gas wallet -> one tx -+-> canonical evidence -> Activity
```

An unknown manager remains observable through the PoX-5 baseline. Sidekick enables an action only
when a code-backed adapter proves the exact behavior needed to construct and verify it. Observe
never signs. Operator-run signs only permissionless reward calls from one operator-approved recipe
with a dedicated, low-balance gas wallet. See the [engine contract](transaction-engine.md).
