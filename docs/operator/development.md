# Development setup

## Requirements

- Node.js 24.18.0
- pnpm 10.32.1
- Git
- Docker for the future self-contained integration environment

The repository deliberately pins the current LTS runtime instead of using whichever Node.js
release happens to be installed globally.

## Install and validate

```sh
pnpm install
pnpm protocol:verify
pnpm check
pnpm test
pnpm build
```

## Upstream contract sources

The committed PoX-5 and signer-manager sources are pinned to stacks-core 4.0.0. To re-fetch
the files from their canonical URLs and verify their hashes:

```sh
pnpm protocol:vendor
pnpm protocol:verify
```

Changing a tag, commit, URL, expected hash, or contract principal requires a new protocol
profile and an architecture review. Do not update a pinned source in place.

## Generate the mainnet manager artifact

```sh
pnpm protocol:generate:mainnet
```

The generator verifies the upstream source hash, replaces exactly the expected principal
occurrences, rejects any remaining upstream placeholders, and writes source/output hashes to
the adjacent metadata file. The generated artifact is not approved for production deployment
until the manager authors independently confirm all production principals.

## External regtest/devnet smoke harness

The initial harness connects to an already-running Epoch 4.0 regtest/devnet. It does not yet
provision Bitcoin Core, stacks-core, the Stacks API, sBTC contracts, or a signer.

```sh
RUN_REGTEST=1 \
STACKS_NODE_RPC=http://127.0.0.1:20443 \
STACKS_API_URL=http://127.0.0.1:3999 \
pnpm test:regtest
```

The smoke test verifies node/API reachability, chain identity, and PoX endpoint availability.
Self-contained lifecycle provisioning is the next harness increment in Milestone 1.
