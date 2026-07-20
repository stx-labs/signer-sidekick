# Documentation

Choose the shortest path for your task.

| Audience | Start here | Use it for |
| --- | --- | --- |
| Mainnet operator | [Container deployment](operator/deployment.md) | Install, configure, upgrade, restore, diagnose |
| PoX-5 Testnet evaluator | [PoX-5 Testnet runbook](operator/pox5-testnet-deployment.md) | Exercise Attach and Fresh setup against the dedicated PoX-5 network |
| Contributor | [Development](operator/development.md) | Build, test, and run locally |
| Product reviewer | [V1 scope](product/v1-scope.md) | Product boundary and acceptance |
| Security or engine reviewer | [Transaction engine](product/transaction-engine-v1.md) | Authority, key custody, admission, recovery, and rollout gates |
| Signer-health reviewer | [Signer Health](product/signer-health.md) | Monitoring sources, behavior, and scope |
| Protocol reviewer | [Open questions](product/open-technical-questions.md) | Decisions still needed from core, signer, API, security, and release teams |

## Source of truth

- Runtime configuration: [mainnet](../.env.mainnet.example),
  [PoX-5 Testnet](../.env.pox5-testnet.example), `apps/sidekick/src/config.ts`, and
  `apps/sidekick/src/transaction-engine/runtime-config.ts`.
- CLI commands: `node apps/sidekick/dist/main.js help` after building.
- HTTP behavior: route schemas and tests under `apps/sidekick/src`.
- Database structure: migrations and repositories under `apps/sidekick/src/storage`.
- Protocol inputs: [contract provenance](../contracts/PROVENANCE.md).
- Configuration examples: [operator record metadata](examples/operator-record-metadata.example.json)
  and [public pool enrollment](examples/pool-enrollment-config.example.json).

Documentation explains intent, safety boundaries, and operator procedures. It does not duplicate
code-level schemas, command inventories, or upstream node/signer setup.

## Architecture and design

The [architecture index](architecture/README.md) covers cross-cutting decisions that are hard to
infer from code. The [design contract](../design/README.md) defines local UI rules; React code and
browser tests define component behavior.
