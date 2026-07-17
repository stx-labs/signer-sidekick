# Development

## Setup

Requires Node.js 24.18.0, pnpm 10.32.1, and Docker for container or Devnet tests.

```sh
pnpm install
pnpm check
pnpm test:coverage
pnpm test:regtest
pnpm build
```

Run `pnpm --filter @stx-labs/signer-sidekick cli help` after building for the current command
surface. Configuration is defined by the [mainnet](../../.env.mainnet.example) and
[PoX-5 Testnet](../../.env.pox5-testnet.example) examples.

## Test matrix

| Command | Purpose |
| --- | --- |
| `pnpm check` | Formatting and type checks |
| `pnpm test:coverage` | Backend and protocol tests with coverage floors |
| `pnpm test:regtest` | Deterministic PoX-5 and manager lifecycle |
| `pnpm test:e2e:dashboard` | Responsive fixture-backed browser suite |
| `pnpm protocol:verify` | Vendored source and generated-artifact hashes |
| `pnpm devnet:verify:offline` | Released-Devnet lock without network access |
| `pnpm test:regtest:external` | Read-only smoke against a supplied PoX-5 network |
| `pnpm test:container:external` | Production-container smoke against supplied endpoints |

Install Chromium once before browser tests:

```sh
pnpm exec playwright install chromium
```

The deterministic contract harness is documented in
[`test/integration/regtest`](../../test/integration/regtest/README.md).

## Released Devnet

The released-binary harness runs Bitcoin regtest, stacks-node, stacks-signer, Stacks API,
PostgreSQL, Sidekick, and browser scenarios. It is isolated from operator credentials.

```sh
pnpm e2e:devnet:doctor
pnpm e2e:devnet:up
pnpm e2e:devnet:scenario active-pool
pnpm e2e:devnet:status
pnpm e2e:devnet:down

# Disposable full acceptance run
pnpm e2e:devnet:test
```

Use `pnpm e2e:devnet:reset` after an interrupted run. Lock files under `test/e2e/devnet` define
the released artifacts; issue #3 tracks the harness and its remaining hosted-run follow-up.

## Local dashboard

Terminal 1:

```sh
SIDEKICK_NETWORK=mainnet \
STACKS_NODE_RPC_URL=http://127.0.0.1:20443 \
SIDEKICK_MANAGER_PRINCIPAL=SP_REPLACE.manager \
SIDEKICK_AUTH_TOKEN=replace-with-at-least-24-random-characters \
pnpm --filter @stx-labs/signer-sidekick dev
```

Terminal 2:

```sh
pnpm --filter @stx-labs/signer-sidekick-dashboard dev
```

Open `http://127.0.0.1:5173`. The Vite server proxies operator API requests to port 3998. UI work
must follow [the local design contract](../../design/README.md).

## Connected environments

Use the environment variables from the matching example. Private networks may also need
`SIDEKICK_NETWORK_ID`. Never put a signer key, admin key, mnemonic, or production credential in a
fixture, command transcript, screenshot, or support bundle.

For manual Attach or Fresh procedures, use the [operator deployment guide](deployment.md) or
[PoX-5 Testnet runbook](pox5-testnet-deployment.md) instead of duplicating them here.

## Upstream contracts

Pinned sources and hashes are recorded in [contract provenance](../../contracts/PROVENANCE.md).

```sh
pnpm protocol:vendor
pnpm protocol:verify
```

Do not replace a pinned source in place. A source, tag, commit, principal, or expected-hash change
requires explicit provenance and profile review.
