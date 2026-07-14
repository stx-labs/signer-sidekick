# Design guide for Signer Sidekick

Signer Sidekick's UI follows the **Stacks Labs Design System** — the org-wide visual
language maintained by Fab (Fabricio Rosa Marques) as a Claude Design project named
"Stacks Labs Design System". It is tuned for exactly this kind of product: dense,
observatory dashboards with tables, block heights, hashes, and status badges.

## What's vendored here

| File | Purpose |
| --- | --- |
| `SKILL.md` | Condensed manifest — read this first before designing any screen |
| `README.md` | Long-form system doc: voice, palette, surface system, type, iconography, hard "do not" list |
| `tokens/tokens.css` | All color/type/spacing/radius/elevation tokens (light + dark via `[data-theme="dark"]`). Link it; never hard-code hex |
| `fonts/` | Vendored Matter, Matter Mono, Instrument Sans, and Open Sauce Sans webfont files referenced by the tokens |

`SKILL.md` is a verbatim copy from the Claude Design project (synced 2026-07-14).
`README.md` carries a local licensing-status update, and `tokens/tokens.css` has the same
vendored token content with local font-resolution and formatting adjustments. The project
remains the source of truth — re-sync before major design pushes and reapply these documented
local deltas.

## What's NOT vendored (pull on demand from the Claude Design project)

- `assets/` — brand SVGs (Stacks glyph, STX/sBTC/BTC token marks). Copy, never redraw.
- `components/`, `patterns/`, `foundations/`, `guidelines/`, `examples/` — reference
  renders for every primitive, composition recipes, and full-page example screens
  (Explorer, Bridge, Dual Stacking, Bitcoin Staking marketing pages).

Matter and Matter Mono redistribution for this project has been confirmed by Stacks Labs.
The optional `MatterSQMono-Medium.woff` file is not present, so `tokens.css` maps weights
400–500 to the vendored regular Matter Mono face instead of referencing a missing asset.

`SKILL.md` contains one contradictory shorthand row that calls the default card
`--surface-secondary`. Follow the detailed surface-system sections in `SKILL.md` and
`README.md`: the default quiet card is `--surface-tertiary` with a
`--border-secondary` border. Do not edit the vendored verbatim files to resolve this;
reconcile it at the upstream source on the next sync.

## Rules most relevant to Signer Sidekick

- **Shell is one tone:** page, sidebar, top bar all `--surface-tertiary`, separated by
  1px `--border-secondary` lines. Cards are Form A (page-tone + border) or Form B
  (`--surface-primary`, no border; mandatory for form-bearing cards). Never white cards.
- **Numbers:** identifiers (block heights, hashes, txids, timestamps) in Matter Mono;
  quantities that read as headings (pool total, gas balance) in Matter with
  `tabular-nums`. Mono numbers right-align in tables.
- **Color semantics:** Stacks orange `#FC6432` for primary actions and Stacks-native
  content; Bitcoin gold `#FF9835` for BTC/sBTC-native content (reward amounts,
  L1 withdrawals); **testnet swaps orange for violet `#765BFF` entirely** — a gift for
  Sidekick's "never confuse networks" requirement. Status badges: green/red/yellow/blue,
  bronze (orange-tinted) for pending.
- **Voice:** declarative, observatory, Title Case buttons/headers, no emoji, no
  exclamation marks, dry empty states ("No pending withdrawals").
- **Hard don'ts:** no gradients, no glassmorphism, no left-border-accent cards, no
  hero illustrations, don't redraw the Stacks "S" glyph.

## Re-syncing

The canonical project is reachable via the DesignSync tool / `/design-sync` skill in
Claude Code (project: "Stacks Labs Design System"). Diff `SKILL.md`, `README.md`, and
`tokens/tokens.css` against the remote copies and pull component/pattern references as
needed when building new screens.
