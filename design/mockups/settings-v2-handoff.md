# Settings v2 — implementation handoff

Target: rebuild `apps/dashboard/src/features/settings/` to match the v2 mockups. APIs are unchanged;
this is layout, grouping, and copy. Same principles as the Rewards v2 page: one row paradigm, the
UI shows state that changes, standing explanations live in ⓘ tooltips, actions only where they act.

## Mockups

- Screens: `design/mockups/pages/SettingsV2.html` (Observe · no gas wallet · one requirement open) and
  `SettingsV2Operator.html` (operator-run · gas wallet ready · a connection row being edited).
  Sources are the `design/mockups/src/partials/st-*.html` fragments; CSS is the `st-` block at the
  end of `design/mockups/src/mockup.css` (port it into `apps/dashboard/src/styles.css`; the
  `rw-eyebrow`, `rw-info`, `rw-wallet-address`, `badge`, `seg`, `field`, `input-group` primitives
  already exist). Rebuild the gallery with `node design/mockups/build.mjs`.
- Row paradigm (`.st-row`): grid `name ⓘ | value (+ `.st-cred` small line) | status badge | actions`.
  `.st-title` section titles carry a `.hint` and, when needed, one right-aligned action
  (`.st-title-actions`). Cards are `.st-card` with no padding; rows divide with hairlines.
- Status vocabulary: Connected / Not configured / Ready / Verified / Attention / Authenticated;
  engine: Observe / Operator-run / Forced Observe; wallet: Optional / Ready / Enabled / Disabled.

## Page structure (top to bottom) and where each row comes from

1. **Page head** — `Run checks` (POST `/api/v1/deployment-requirements/refresh`, the current
   "Refresh checks"), `Support bundle` (GET `/api/v1/support-bundle`, current download), `Operator
   guide ↗` (`DOCUMENT_LINKS.operatorGuide`). No lede. Then the **jump nav** (anchors to the section
   ids below; highlight the section in view or the one the route asked for).
2. **This deployment** (`#st-deployment`, `card-standout`) — manager principal (copyable), verdict
   badge + one-line reason (Ready / "N items need attention" from the deployment-requirements status
   plus the first failing check's summary), facts: Network (`data.network`, chain id, PoX-5
   contract `data.preflight.pox.pox5ContractId`), Engine (mode from `/api/v1/engine`; sub-line per
   mode), Sidekick (node version + `data.preflight.compatibility` profile/revision/origin; show the
   Sidekick release only if the snapshot exposes it), Last check (`deploymentRequirements.checkedAt`).
3. **Connections** (`#st-connections`) — the five `ConnectionRow`s as `.st-row`s: Stacks node, Node
   monitoring, Signer monitoring, Indexed chain API, Network comparison API. Value = URL (mono) with
   the credential line under the API rows ("key saved in Sidekick" / "provided by the environment" /
   "reusing the indexed API key"). Status from the existing `requirementStatus`/`testedSourceStatus`
   logic. `Edit`/`Add` opens the same inline editor (URL + key + Test + remove-key + advanced header)
   under the row (`.st-editor`); one `.st-foot` Save/Discard bar appears only while dirty. Keep the
   beforeunload guard, test-source handling, and read-only behaviour.
4. **Node & signer requirements** (`#st-requirements`) — the non-connection checks from
   `/api/v1/deployment-requirements` as rows: title + `REQUIRED/RECOMMENDED` (`importance`),
   value = `observed`, status from `check.status`; a failing row gets `Resolve`, which toggles the
   remediation (steps, config snippets, restart note, docs link). The old **Event observer** card
   folds into its requirement row: value "N events · latest block H" from
   `data.activity.eventCount` / `latestBlockHeight`, sub-line "callbacks from the node · polling
   covers gaps"; status Verified / Attention (observer alerts). Section hint shows the last-checked time.
5. **Manager** (`#st-manager`) — title hint "attached · published at block N" (`data.manager.attachAllowed`,
   `publishHeight`) with `Refresh attachment` (`onRefreshStatus`). Four rows:
   - Source: `data.manager.source.sha256` (copyable) · tier label (built-in reference / reviewed /
     recorded custom / custom) · profile id + revision; badge Verified when the trait check passes.
   - Reward calls: "N reviewed adapters" from `data.manager.capabilities.actions`; badge Available /
     Observe only from `automationEligible` (reason in the ⓘ when unavailable).
   - Signer key: `data.registration.signerKeyHex` (copyable) · "registered · grant valid for cycle C"
     (`registered`, `signerKeyGrantValid`, current cycle) → badge Registered / Missing; action
     `Rotate` → `actionHash("register-self")` (first-time setup link when no participation yet).
   - Admins: `data.activity.admins.principals` (copyable, wrap when several) · "N admins · synced";
     actions Add / Remove (`actionHash("add-admin"|"remove-admin")`); when `admins.status` is
     `sync-required` show `Sync admin history` instead of the list.
   Drop: Baseline capabilities card, Manager admins card, "Manager trust"/"Installed profile store"/
   "Reviewed reward calls" lines, both "Reviewed reward calls available" callouts.
6. **Reward runs** (`#st-runs`) —
   - Engine mode row: mode + sub-line (Observe: "set SIDEKICK_ENGINE_MODE=operator-run and restart…";
     operator-run: job counts "N runs active · N awaiting approval · N ambiguous"); badge Observe /
     Operator-run / Forced Observe (with reason + actor in the ⓘ); action `Force Observe` only when
     operator-run and not already forced (keep the confirm dialog).
   - Gas wallet: not set up → one row with `Create gas wallet` (badge Optional; sub-line explains it
     signs nothing until operator-run is on and it is enabled). Once created → the `.st-wallet` block:
     address (copy) · "balance · ≈ N transactions at the fee cap · created <date> on this machine" with
     the key-file facts in the ⓘ; rows Signing (Enabled/Disabled → Enable/Disable), Dedicated-key
     check (Passed / Could not verify / Refused + checked time), Sweep (amount after fee →
     `Sweep remaining STX`; the recipient field, approve/cancel callout and sweep history move under
     this row as a disclosure). In Observe mode with a created wallet show the same block with badge
     "Observe mode" and Enable disabled.
   - Operations row: the five adapters as chips (`calculate collect distribute settle reclaim`)
     coloured by availability; badge Available / Observe only / Disabled; `Manage` opens the per-adapter
     list with its Disable buttons (keep the confirm dialog); readiness blockers from
     `/api/v1/operations/readiness` show as one caution line under the row with the existing review
     links; `Activity` → `activityHash(null, "type=actions")`.
   Drop: the separate "Transaction capabilities" card and "Engine controls" block.
7. **Preferences** (`#st-preferences`) — Forecast horizon (number + `cycles`, inline `Save`
   enabled when dirty; same PUT as today) and Theme (System / Light / Dark seg → `setTheme` +
   `display.defaultTheme`).
8. **Access & audit** (`#st-access`) — Dashboard access ("bearer token · listener …" — whatever the
   server exposes; badge Authenticated), Keys held ("gas wallet only" with the no-signer/admin-key
   policy in the ⓘ), Settings revision (`settings.revision` + last audit entry summary; `History`
   toggles the audit list). Drop the security callouts.
9. Removed entirely: the Support section (its two actions are in the page head), all
   `settings-group-head` paragraphs and per-card `muted` intros.

## Routing

Keep `SettingsSection` and `settingsHash()` as they are (other pages link with `"gas-wallet"`,
`"attachment"`, `"sources"`); remap `settingsTargetBySection`: requirements → `st-requirements`,
attachment & capabilities → `st-manager`, sources → `st-connections`, gas-wallet → `st-runs`,
observer → `st-requirements`, auth → `st-access`, support → page top.

## States to keep

Read-only (deployment identity mismatch) disables every action and keeps the notice; per-section
loading/error (`ErrorCallout`) stays but inside the row/card; unsaved-changes guard; operator-run
vs Observe; gas wallet not created / created / enabled / refused / sweep in flight; requirement
pass / fail / unavailable; admins synced / sync-required. Mobile: rows collapse to name+actions on
the first line and value below (see the `@media (max-width: 900px)` rules in the mockup CSS).

## Tests to update

`test/e2e/dashboard/dashboard.spec.mts` touches Settings at ~168 (support bundle button name),
447–470 (responsive + `editConnection`), 751–845 (connection editing, section deep links
`?section=sources|attachment`), 1111 (Force Observe), 1242–1261 (support bundle), 1309–1342 (Save
connections), 1461, 1565–1574 (Refresh checks → now `Run checks`; "How to resolve" → `Resolve`),
1659, 1686 (Sync admin history), 1998–2158 (trust tiers / setup copy), 2393, 2591–2596 (gas wallet
section heading + Create). Keep the names in the mockup where they differ. Run `pnpm check`,
`pnpm --filter @stx-labs/signer-sidekick-dashboard test`, and `pnpm test:e2e:dashboard` (all three
projects) before handing back.
