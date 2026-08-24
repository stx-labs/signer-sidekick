# Network compatibility profiles

Place strict, data-only network compatibility profile JSON files in this directory. The production
container mounts it read-only and Sidekick loads it only at startup.

Profiles identify the network and live PoX-5/sBTC contracts; node version strings are diagnostic,
not compatibility gates. Invalid, ambiguous, duplicate, oversized, or symlinked profiles are
reported and ignored without replacing built-in data.

V1 profiles are operator configuration. They may guide read-only inspection and deterministic
setup artifacts, but cannot enable executable behavior. Operator-run separately requires a
code-backed capability adapter and an exact-source-reviewed Sidekick release.

See [deployment](../docs/operator/deployment.md) and
[ADR 0007](../docs/architecture/decisions/0007-network-compatibility.md).
