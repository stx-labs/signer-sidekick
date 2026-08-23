# Mainnet operator-run review

Mainnet operator-run is fail-closed at release and startup. Observe and non-mainnet evaluation do
not require this approval.

## Review scope

Review the exact fingerprint for:

- gas-wallet generation, storage, activation, refusal checks, and sweep;
- recipe bounds, approval expiry, transaction/gas caps, and one-active-run exclusion;
- every adapter's anchored inputs, exact signer method, postconditions, and completion proof;
- one-in-flight nonce handling, external completion, ambiguous broadcast, restart, and resume;
- CSRF/auth boundaries and exclusion of keys or signed bytes from APIs, logs, Activity, and support
  exports; and
- regtest/Devnet coverage for calculate, collect, distribute, settle, reclaim, pause, and recovery.

## Approval

1. Finish and commit all in-scope changes.
2. Run `pnpm security:operator-run:fingerprint` and put the result in
   `security/operator-run-mainnet-review.json` with `status: "pending"`.
3. An independent reviewer audits that fingerprint and runs the normal release checks.
4. The reviewer changes the record to `approved` and supplies the last in-scope commit, review time,
   reviewer identity, and durable review URL.
5. Run `pnpm security:operator-run:verify`. Tag only while it passes.

The review record itself is excluded from the fingerprint so approval can be recorded afterward.
Runtime, dependencies, build inputs, and the release gate are included. Any later in-scope change
changes the fingerprint and makes the approval stale.
