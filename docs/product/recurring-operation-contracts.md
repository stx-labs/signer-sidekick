# Operator action contracts

Status: Implemented. Sidekick observes any compatible manager's baseline state. It constructs a new
transaction only when a code-backed adapter proves that exact capability. Capability loss blocks
new work but never erases submitted or canonical evidence.

## Common rules

- Inputs come from one current, stable chain anchor and are re-read before signing.
- Calls use deny mode and the narrowest exact asset postcondition available.
- Completion requires exact transaction binding and canonical successful execution, plus any
  adapter-specific checkpoint proof. Locally signed runs/sweeps bind the transaction through their
  revalidated sealed plan and saved signing-time txid; coherent configured-API execution may then
  suffice during node unavailability, but cannot override a positive node conflict. Browser-wallet
  actions use current node bytes or retained exact mempool verification of that same intent/txid.
  The calculation receipt must match the sealed cycle/checkpoint. Legacy manager-job and
  asset-semantic checks still apply; known
  canonical execution with an incomplete extra check is not Complete. Evidence provenance is retained; see
  [ADR 0008](../architecture/decisions/0008-chain-evidence-and-reconciliation.md).
  A later mutable setting or balance is not a historical receipt.
- Manager-admin and signer operations use the operator's browser wallet.
- Permissionless reward calls may use the browser wallet or one approved operator-run recipe.

## Action matrix

| Action | Authority | Required proof |
| --- | --- | --- |
| Register or rotate signer | Manager admin wallet plus unused signer grant | Exact sealed registration call and canonical success; fresh grant validity is a preparation check |
| Add/remove admin; update fee | Manager admin wallet | Exact sealed call and canonical success; later admin/fee changes do not undo execution |
| Withdraw fee; sweep refunds | Manager admin wallet | Exact allowed manager-to-recipient sBTC outflow |
| Calculate | Permissionless fee payer | Reviewed PoX-5 profile, complete bond set, canonical receipt matching the sealed cycle and calculation height |
| Collect | Permissionless fee payer | Reviewed manager adapter, fee snapshot inputs, exact PoX-5-to-manager sBTC transfer |
| Distribute | Permissionless fee payer | Exact staker/cycle/bucket entitlement and manager sBTC outflow; canonical success survives later accrual; BTC arrival remains separate |
| Retire accepted Bitcoin payout | Permissionless fee payer | Registry accepted; request removed; no asset transfer |
| Return rejected Bitcoin payout | Permissionless fee payer | Registry rejected; exact manager-to-staker refund including reserved fee |

Readiness combines current node evidence, manager attachment, signer registration, adapter
availability, and signing authority. Financial state remains visible when execution is unavailable.
