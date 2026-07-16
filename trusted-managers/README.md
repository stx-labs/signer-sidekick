# Operator-installed manager profiles

Signer Sidekick loads `*.json` files from this directory at startup when using the supplied
Compose deployment. The directory is mounted read-only; restart Sidekick after adding or removing
a profile.

Generate a profile with `sidekick manager trust <manager-principal> --output <file>`. A generated
reference-render profile is only a claim: Sidekick independently fetches the deployed source from
the configured node and reproduces the pinned reference render before granting eligibility. A
custom `--observe-only` profile can identify a manager for attach and monitoring but can never
enable reference-manager transaction automation.

Profile JSON files are operator-specific and ignored by Git. Back them up with deployment
configuration, review permissions carefully, and do not place secrets in this directory.
