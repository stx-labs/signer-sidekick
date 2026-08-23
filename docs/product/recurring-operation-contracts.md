# Operator action contracts

Status: Implemented. Sidekick observes any compatible manager's baseline state. It constructs a new
transaction only when a code-backed adapter proves that exact capability. Capability loss blocks
new work but never erases submitted or canonical evidence.

## Common rules

- Inputs come from one current, stable chain anchor and are re-read before signing.
- Calls use deny mode and the narrowest exact asset postcondition available.
- Completion requires canonical transaction bytes and the adapter's expected poststate.
- Manager-admin and signer operations use the operator's browser wallet.
- Permissionless reward calls may use the browser wallet or one approved operator-run recipe.

## Action matrix

| Action | Authority | Required proof |
| --- | --- | --- |
| Register or rotate signer | Manager admin wallet plus unused signer grant | Exact signer key registered; grant still valid |
| Add/remove admin; update fee | Manager admin wallet | Exact anchored admin/fee transition; no asset transfer |
| Withdraw fee; sweep refunds | Manager admin wallet | Exact allowed manager-to-recipient sBTC outflow |
| Calculate | Permissionless fee payer | Reviewed PoX-5 profile, complete bond set, exact calculation poststate |
| Collect | Permissionless fee payer | Reviewed manager adapter, fee snapshot inputs, exact PoX-5-to-manager sBTC transfer |
| Distribute | Permissionless fee payer | Exact staker/cycle/bucket entitlement and manager sBTC outflow |
| Retire accepted Bitcoin payout | Permissionless fee payer | Registry accepted; request removed; no asset transfer |
| Return rejected Bitcoin payout | Permissionless fee payer | Registry rejected; exact manager-to-staker refund including reserved fee |

Readiness combines current node evidence, manager attachment, signer registration, adapter
availability, and signing authority. Financial state remains visible when execution is unavailable.
