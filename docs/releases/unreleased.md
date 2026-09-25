# Unreleased

- **Automatic reward runs:** opt in under Settings → Reward runs to calculate, collect, distribute
  and finish Bitcoin payouts without reopening the browser. Off by default; uses the existing gas
  wallet, fee limits and recipe engine. Admin actions and withdrawals of your fees remain manual.
- **Stops remain stops:** automation never resumes or replaces stopped work. Unresolved attempts
  from expired or cancelled manual runs block new scheduled work, even after their lease is released.
- **Bitcoin payout status:** registry reads now follow the deployed PoX-5 contract's reported
  registry, including custom profiles and Devnet, instead of assuming a built-in network address.

Review [schedule controls and spending limits](../operator/operations.md#automatic-reward-runs)
before enabling. Schema 44 adds schedule persistence; back up the database and gas-wallet key using
the [upgrade procedure](../operator/operations.md#upgrade). Older images cannot open schema 44, and
restoring an old database must not discard newer transaction evidence.
