# Network compatibility profiles

Place strict, data-only network compatibility profile JSON files in this directory. The production
container mounts it read-only and Sidekick loads it only at startup.

Sidekick never treats a node version string as a compatibility gate. A profile identifies the
network and live PoX-5/sBTC contracts and can be installed independently of a Sidekick image.
Invalid, ambiguous, duplicate, oversized, or symlinked profiles are ignored and reported without
silently replacing built-in data.

V1 profiles are operator configuration. They may guide read-only inspection and deterministic
setup artifacts, but cannot enable transaction automation. Review every generated artifact and
sign or broadcast it outside Sidekick. Authenticated compatibility attestations are deferred until
automation creates an authorization boundary.

See `docs/operator/deployment.md` for the operational procedure.
