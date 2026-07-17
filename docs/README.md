# Documentation

Choose the shortest path for your task.

| Audience | Start here | Use it for |
| --- | --- | --- |
| Mainnet operator | [Container deployment](operator/deployment.md) | Install, configure, upgrade, restore, diagnose |
| Testnet evaluator | [Public testnet runbook](operator/testnet-deployment.md) | Exercise Attach and Fresh setup against public testnet |
| Contributor | [Development](operator/development.md) | Build, test, and run locally |
| Product or security reviewer | [V1 scope](product/v1-plan.md) | Product boundary, trust model, architecture, acceptance |
| Protocol reviewer | [Open questions](reviews/team-questions.md) | Decisions still needed from core, signer, API, and security teams |

## Source of truth

- Runtime configuration: [`.env.example`](../.env.example) and `apps/sidekick/src/config.ts`.
- CLI commands: `node apps/sidekick/dist/main.js help` after building.
- HTTP behavior: route schemas and tests under `apps/sidekick/src`.
- Database structure: migrations and repositories under `apps/sidekick/src/storage`.
- Live implementation status: [GitHub issue #2](https://github.com/stx-labs/signer-sidekick/issues/2).
- Protocol inputs: [contract provenance](../contracts/PROVENANCE.md).

Documentation explains intent, safety boundaries, and operator procedures. It does not duplicate
code-level schemas, command inventories, or upstream node/signer setup.

## Architecture decisions

The ADRs under [`architecture/decisions`](architecture/decisions/) record decisions that are hard
to infer from code. The two longer notes cover only cross-cutting behavior:

- [Onboarding and settings](architecture/onboarding-and-settings.md)
- [Scaling and retained evidence](architecture/scaling.md)

## Historical material

Files under [`reviews`](reviews/) are dated review evidence, not current instructions. Resolved
findings may describe behavior that no longer exists. Use the review index before reading them.

The `design` directory is a vendored implementation reference. Its [README](../design/README.md)
defines the small local contract; component HTML and tokens are more authoritative than prose.
