# Design deltas & new capabilities

**Purpose:** capture scope changes, new capabilities, and UI conventions that came out of the UI/UX design pass and are **not** (or not fully) in `pox5-operator-suite-spec.md`. This is the implementation hand-off so the agent building `apps/dashboard` and `apps/sidekick` knows what to add beyond the spec.

**Source of truth for visuals:** the static mockups in [`design/screens/`](screens/) (open [`screens/index.html`](screens/index.html)). They are reference for the React component layer, not the app itself.

**Status legend:** `DECIDED` = operator chose it this session · `ADOPTED` = built into mockups, recommend spec sign-off · `PROPOSED` = convention introduced here · `CONFIRM` = needs external confirmation before GA.

---

## 1. Scope changes (touch the spec's stated boundaries)

### 1.1 Live node version verification — `DECIDED`
Poll the node's `/v2/info` on an interval (not just at preflight) and verify `server_version` against the versions the pinned protocol profile supports.

- **Backend:** periodic `/v2/info` poll; surface `server_version`, `network_id`, epoch, burn/stacks tip. Compare version to a supported set on the profile → `Supported | Update available | Unsupported`.
- **Frontend:** Environment section on Operations ([`operations.html`](screens/operations.html)) — live indicator + version-support badge.
- **Spec:** in-scope already (§9 uses node RPC); this just makes it continuous + verified.

### 1.2 Live signer version + liveness probe — `DECIDED` (scope expansion) · endpoint `CONFIRM`
Poll the signer for basic **version + liveness** so it is verified, not operator-reported.

- **This contradicts the current v1 scope** and must be reflected in the spec:
  - §2.4 non-goals lists "Reading signer `/metrics`, `/info`, logs, host resources…" — carve out a narrow **version + liveness** exception.
  - §8.4 says Sidekick "does not talk to the signer process" — it now opens a **read-only** connection to a signer endpoint.
  - §14 trust model — add: Sidekick makes an unauthenticated read-only probe to the signer endpoint; still holds no signer key; still does not read signing performance, proposals, logs, or host state (those remain v2).
- **Backend:** periodic probe of a configured signer endpoint for version/build + reachability; verify version like the node. Fail → `signer endpoint unreachable` alert.
- **Frontend:** signer card in the Environment section, live indicator + `Supported` badge + "responding" liveness.
- **`CONFIRM` with signer tooling:** the node has a well-known `/v2/info` + version field; the signer's equivalent endpoint and version field are **not settled**. stacks-signer exposes a monitoring/metrics server — confirm the exact endpoint/path and the field to read. Add to §20 launch-blocker table (same tier as "API endpoint/event guarantees"). Mockup uses a placeholder `http://127.0.0.1:30000`.

### 1.3 Version-support verification as a first-class concept — `ADOPTED`
Node, signer, and API each get a support state (`Supported | Update available | Unsupported`) derived from the pinned profile. Drives new alerts (see §4).

### 1.4 Public pool page → embeddable artifact; app hosts nothing — `DECIDED`
Reframe §5.5: instead of Sidekick **serving** a public route, it **generates an embeddable card** the operator hosts on a site they already run. This removes the public HTTP surface from an app that holds a gas key — the operator's stated concern.

- **Two modes:** **live** — a self-contained snippet that fetches public on-chain data client-side at view time, keyed by the manager principal; **static** — a versioned JSON + HTML fragment with values baked in at generation time.
- **Data split:** baked-in operator-maintained facts (name, website, support, official links, manager principal, signer **public** key) + live public-API data (cycle & prepare-phase window, pool STX + 50k margin, eligibility, grant validity, fee, source hash). **Never** includes the gas payer, any key, job/transaction internals, alerts, or anything from Sidekick's DB.
- **Security win:** Sidekick keeps **no public HTTP surface** and stays loopback-bound. Eliminates the public-route concern and the reverse-proxy/TLS-for-public-page requirement.
- **Backend:** an authenticated "generate embed" action that emits the snippet / JSON / static HTML. The live widget must use **unauthenticated public endpoints only** — never embed the operator's API key in client-side code. Default to the public Hiro API or the operator's own public node.
- **Frontend:** [`enrollment.html`](screens/enrollment.html) is now a generator + preview; [`pool-public.html`](screens/pool-public.html) is the card preview.
- **Spec:** rewrite §5.5 (generate, don't host); drop `/pool` and `/public/v1/pool` from §13.2; remove the public-page reverse-proxy note from §14.4. Aligns with §2.2 ("generate values a pool publishes elsewhere") and supersedes §19's "public pool metadata endpoint."

---

## 2. New screen: Settings (running-deployment config)

`ADOPTED`. The spec (§12.9) folds ongoing configuration into the **Setup** tab. The mockups split them:

- **Setup** = one-time guided onboarding **wizard** (attach / fresh). [`setup.html`](screens/setup.html)
- **Settings** = ongoing configuration editor for a running deployment. [`settings.html`](screens/settings.html)

- **Frontend:** add **Settings** to the nav (§12.2) under "Configure" (Setup → Settings → Pool page). Already reflected in [`_app.js`](screens/_app.js).
- **Spec:** update §12.2 (nav) and §12.9 (separate the wizard from the settings editor). If you prefer keeping one tab, implement Setup with `Wizard` / `Settings` modes instead — but the split is the recommendation.

Settings sections: Pool identity · Display preferences · Data sources · Payout policy · Automation & alerts · Access & security · About & maintenance.

---

## 3. New / clarified configuration fields

Extends §13.3. All non-secret unless noted.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `pool.displayName` | string | — | **New.** Pool name shown in dashboard chrome, alerts, and the public pool page. Purely a label — no on-chain identity. §13.3 only had it under the public pool profile; it's now also used across the operator UI. |
| `pool.website`, `pool.supportContact` | string | — | Already implied by §13.3 public profile; confirm they exist in config schema. |
| `dataSources.signerEndpointUrl` | string (optional) | — | **New.** Endpoint for the read-only signer version/liveness probe (see §1.2). |
| `dataSources.versionPollIntervalSecs` | int | — | **New.** Interval for node + signer version/liveness polling. |
| `display.timezone` | IANA tz | `UTC` | **New.** Affects **absolute** timestamps only. |
| `display.timeFormat` | `relative` \| `absolute` \| `both` | `relative` | **New.** |
| `display.numberFormat` | enum/locale | `1,234.5678` | **New.** |
| `display.defaultTheme` | `light` \| `dark` \| `system` | `system` | **New.** Token file already supports `[data-theme]`; this just selects the default. |
| `embed.type` | `live` \| `static` | `live` | **New.** Embeddable pool-card mode (see §1.4). |
| `embed.publicApiUrl` | string | public Hiro | **New.** Public, **unauthenticated** endpoint the live card queries client-side. Must never carry the operator's API key. |

Note: the old §13.3 "serve public page at `/pool`" toggle is **removed** — the app hosts nothing (see §1.4). `pool.*` identity fields now feed the embed generator.

**Invariant to preserve:** display preferences govern only how **secondary** time/number values render. Block heights always lead, and all scheduling/reconciliation stays burn-height-driven (§11.6). Timezone must never feed scheduling.

Unchanged rule (keep enforcing): manager admin key and signer private key are **rejected** as config (§13.3/§14).

---

## 4. New alert types

Extends the §6.5 alert list:

- Node version unsupported / below minimum for the active profile.
- Signer version unsupported / below minimum.
- Signer endpoint unreachable (liveness probe failed).

(These join the existing node/API disagreement and ingestion-lag alerts.)

---

## 5. UI conventions to implement (frontend)

### 5.1 Provenance indicator — `PROPOSED`
Concrete rendering of §12.10 ("mark API-estimated, locally derived, and contract-authoritative values distinctly"). Every meaningful value carries a small source dot:

- **green** — contract/node read-only (authoritative, works even if the API is down)
- **blue** — indexed / estimated (Stacks API; degrades if the API lags)
- **gray** — locally derived / projection (e.g., the future-cycle forecast)

Implemented as `.src.src-chain|src-api|src-local` in [`_app.css`](screens/_app.css). Legend sits in the data-freshness banner.

### 5.2 Data-freshness banner — `PROPOSED`
Live vs. stale states tied to the source tiers: when the API cursor lags policy, flip to the stale treatment and suppress green on API-derived values (§9.2, §12.8 "never show green from stale data").

### 5.3 Environment section on Operations — `ADOPTED`
Node · signer · connected API · Sidekick versions, with GitHub release links. See §1.

---

## 6. Contract-operation constraints

### 6.1 Reward pause handling — `REJECTED` (product-owner override)
Global `pause-rewards` handling is intentionally outside the product scope. Do not add the former
panel, alert, manager-claim precondition, or special retry classification to v1. This decision
supersedes finding F1 from the round-2 review and the earlier version of this design delta.

### 6.2 Payout policy gates timing and gas — never amounts or recipients — `CLARIFICATION`
The gas payer spends only STX (transaction fees); it never holds or moves sBTC. sBTC moves solely because a permissionless contract call executes, and the **contract** fixes the amount (net = gross − fee snapshot) and recipient (staker principal for direct sBTC; the staker's stored `pox-addr` for L1). So every payout-policy setting answers only **"broadcast now?"** or **"how much STX gas?"** — never "how much sBTC / to whom." Enforce them as pre-broadcast gates in the job planner / tx engine; they must be structurally incapable of altering a constructed call's recipient or amount.

- **Minimum direct-sBTC payout:** defer a direct payout until claimable ≥ threshold (batch dust, save gas). Does not change the eventual amount.
- **L1 rule (net ≥ max-fee):** skip an L1 claim until the staker's net ≥ the `max-fee` they set on-chain, else the withdrawal is uneconomic / fails (`ERR_INSUFFICIENT_FEES` u1007). The max-fee is the staker's, not the operator's.
- **Gas budget (rolling window) + max fee per tx:** throttle/cap STX spend; when hit, pause new broadcasts (in-flight continue). Delays movement, never redirects it.
- **Cadence:** when the payout job evaluates candidates.
- **Mode gates all of it:** Observe never broadcasts; Assist makes jobs eligible + simulated for per-broadcast approval; Automate broadcasts within the gas caps + circuit breaker.

---

## 7. Data-availability items to confirm before wiring screens

Not new scope, but the mockups assume data the backend must actually source (from the "will we have the data" review). Confirm with the API/core teams — these overlap §20 blockers:

- **Pool roster enumeration** (Pool, per-staker Rewards rows) hard-depends on the API v9 signer-stakers endpoint (PR #2602) being live and fully indexed. Clarity maps aren't enumerable, so this cannot come from read-onlys. If the API is down, roster/history go stale while per-staker read-onlys still work (§9.2).
- **Future-cycle forecast** (Pool chart, cycle-144 threshold warning) is a **projection** from currently-known positions, not authoritative — confirm which per-cycle membership read-onlys expose future cycles vs. what Sidekick must compute. Always label it locally-derived.
- **Signer-set weight %** (Registration) needs network-wide total stacked, not just this manager.

---

## 8. Spec sections to update (documentation follow-through)

If/when these deltas are accepted, update: §2.4 (signer version/liveness carve-out), §5.5 (public page → generated embeddable artifact, app hosts nothing), §8.4 (signer endpoint connection), §12.2 (Settings nav), §12.9 (Setup wizard vs Settings editor), §13.2 (remove `/pool` and `/public/v1/pool` routes), §13.3 (new config fields in §3 above; remove the serve-public-page toggle), §14 (read-only signer connection in the trust model), §14.4 (drop the public-page reverse-proxy/TLS exposure), §20 (signer version/liveness endpoint as a launch-blocker to confirm), plus a matching ADR if the signer-connection change or the no-public-surface decision warrants one.
