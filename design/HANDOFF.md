# Implementation hand-off — UI/UX pass

Start here. This note orients you; the detail lives in the linked files.

## What was produced

- **Screen mockups** — [`screens/`](screens/) (open [`screens/index.html`](screens/index.html)). Static HTML/CSS reference for the operator dashboard, built on the vendored Stacks Labs design system. These are the visual spec for the React component layer in `apps/dashboard` — reference, not the app itself.
- **Design deltas** — [`DESIGN-DELTAS.md`](DESIGN-DELTAS.md). Everything the mockups add or change vs. [`docs/product/v1-plan.md`](../docs/product/v1-plan.md), formerly circulated as `pox5-operator-suite-spec.md`, tagged `DECIDED` / `ADOPTED` / `PROPOSED` / `CONFIRM`. **Read this second.**
- **Design system** — [`DESIGN.md`](DESIGN.md), [`SKILL.md`](SKILL.md), [`README.md`](README.md), [`tokens/tokens.css`](tokens/tokens.css), [`fonts/`](fonts/). The vendored Stacks Labs system. Everything must use these tokens; never hard-code brand hex.

## Screens (each answers one operator question)

`overview` · `registration` · `pool` · `rewards` · `operations` · `setup` (Initial Setup wizard) · `settings` · `enrollment` (Public Pool Page = embed generator) + `pool-public` (embed preview). Shell + shared primitives live in [`screens/_app.css`](screens/_app.css) / [`screens/_app.js`](screens/_app.js).

`screens/_app.css` is also a production-owned stylesheet imported by `apps/dashboard`; changes to it require dashboard regression testing even though it remains beside the mockups.

## What to build beyond the base spec (from DESIGN-DELTAS.md)

1. **Settings screen** — ongoing config, separate from the Initial Setup wizard. New config fields: `pool.displayName`, `dataSources.signerEndpointUrl`, `display.timezone/timeFormat/numberFormat/defaultTheme`, `embed.type/publicApiUrl`. (§2, §3)
2. **Live node + signer version verification** — poll node `/v2/info` and a signer version/liveness endpoint; verify against the supported set. Signer probe is a **scope expansion** (narrow read-only version+liveness only — no health/logs/signing). New alerts for unsupported/unreachable. (§1, §4)
3. **Public Pool Page = embeddable artifact, app hosts nothing** — generate a live or static card the operator hosts on their own site, pulling public on-chain data client-side. Sidekick keeps **no public HTTP surface**. Drop the `/pool` + `/public/v1/pool` routes. (§1.4)
4. **UI conventions** — provenance dots (green contract-read-only / blue indexed / gray derived), freshness banner, Environment section. (§5)

## Ground rules (don't regress these)

- **Payout policy gates timing + gas only — never sBTC amount or recipient** (the contract fixes those). Enforce as pre-broadcast gates in the job planner / tx engine. (DESIGN-DELTAS §6.2)
- **Global reward-pause handling is out of scope by product-owner decision.** Do not add its former
  panel, alert, claim precondition, or special error path to v1. (§6.1)
- Gas payer signs only permissionless calls; admin/signer keys are never held or accepted as config.
- Admission is **open at the reference-manager level** — there is no operator "accept" and no whitelist in v1. Do not build an accept/approve/whitelist flow (PoX-5 stakers self-`stake`; the manager admits synchronously via `validate-stake!`).

## Confirm before GA (open questions)

- Exact **signer version/liveness endpoint** + field (signer tooling) — placeholder in mockups.
- **Roster enumeration** depends on the API v9 signer-stakers endpoint being live + indexed; per-staker reads work regardless.
- **Future-cycle forecast** is a projection — confirm which per-cycle read-onlys expose future cycles.

## Suggested pickup order

Tokens/component layer from the mockups → read-only screens (Overview/Registration/Pool/Rewards) wired to node read-onlys + API → Settings + Environment polling → Operations (jobs/modes/approvals) → Public Pool Page embed generator.

The accepted spec edits are applied in [`docs/product/v1-plan.md`](../docs/product/v1-plan.md). The signer endpoint contract and future-cycle read-only guarantees remain external-confirmation items.
