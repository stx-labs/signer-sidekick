# Network compatibility profiles

Place strict, data-only network compatibility profile JSON files in this directory. The production
container mounts it read-only and Sidekick loads it only at startup.

Profiles identify the network and live PoX-5/sBTC contracts; node version strings are diagnostic,
not compatibility gates. Invalid, ambiguous, duplicate, oversized, or symlinked profiles are
reported and ignored without replacing built-in data.

V1 profiles are operator configuration. They may guide read-only inspection and deterministic
setup artifacts, but cannot enable Assist. Assist separately requires a current signed
compatibility attestation that binds reviewed identities to the fixed code-backed adapter.

See [deployment](../docs/operator/deployment.md) and
[ADR 0007](../docs/architecture/decisions/0007-release-independent-network-compatibility.md).
