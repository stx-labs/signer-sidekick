# Epoch 4.0 regtest/devnet harness

This initial harness targets an externally provisioned environment and verifies the minimum
node/API surface Sidekick will rely on. Run it with `RUN_REGTEST=1`; without that flag the suite
is skipped in normal CI.

The self-contained environment still to be added must pin stacks-core 4.0.0, activate Epoch 4.0,
deploy the profile-specific sBTC and reference-manager contracts, run a signer, and expose a fully
indexed Stacks API v9 instance. It must not use a floating container tag.
