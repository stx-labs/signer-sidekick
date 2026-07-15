# V1 follow-ups

This is the running list of inputs that require operator or upstream confirmation. None should stop read-only attach/setup work.

## Protocol and upstream

- Confirm the exact stacks-signer version/liveness endpoint and response field before enabling the optional v1 probe. Until then the UI reports it as not configured and does not guess.
- Confirm the first production-safe manager-claim condition and the normal/fallback global reward-calculation caller policy with the core team.
- Confirm the final production mainnet reference-manager profile/principal substitutions and move it from reviewed-but-unapproved to production-approved only after independent review.
- Exercise the Stacks API v9 signer-stakers and contract-log cursor behavior against a fully indexed PoX-5 environment.
- Obtain an external Epoch 4.0 regtest/devnet endpoint or compose environment for the full reward and L1 withdrawal lifecycle.
- Confirm the sBTC registry read-only schema used to distinguish pending, accepted, and rejected withdrawal requests before enabling the withdrawal janitor.

## Operator decisions

- Choose the pool display name, website, support contact, and official enrollment links used by generated pool artifacts.
- Choose the public unauthenticated API URL used by a live pool card. It must not require or embed an API key.
- Provide the initial gas-payer, fee caps, rolling budget, payout cadence, and alert destinations before Assist or Automate mode is enabled.

## Release and repository

- Sign and publish the accumulated changes with the configured YubiKey-backed SSH signing key.
- Build and probe the OCI image on a host with a running Docker daemon; the local daemon was not
  available during the packaging pass, although `docker compose config` validated successfully.
- Run the final container/SBOM/release-signing lane under the organization release policy.
