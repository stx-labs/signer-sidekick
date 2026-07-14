<!-- Vendored from Claude Design project "Stacks Labs Design System" on 2026-07-14. See DESIGN.md for local licensing status and re-sync instructions. -->

# Stacks Labs Design System

The visual language for **Stacks Labs** product UI — dashboards, transaction lists, block detail, settings, wallet UI, modals. Stacks Labs is a core contributor to **Stacks**, the leading programmable layer for Bitcoin.

This system is tuned for dense, observatory product surfaces. The same primitives are general enough that the occasional logged-out moment (connect-wallet entry, auth gate, 404) fits without special-casing — treat those as one more product screen.

## Structure

```
README.md                ← this file: voice, philosophy, do/don'ts
SKILL.md                 ← condensed manifest Claude reads first

tokens/
  tokens.css             ← color, type, spacing, radius, elevation, semantic tokens
fonts/                   ← Matter, Matter Mono, Instrument Sans, Open Sauce Sans webfonts (all self-hosted)
assets/                  ← brand SVGs, token marks, marker icons

foundations/             ← reference renders for tokens (you don't invent these)
  colors.html
  type.html
  spacing.html
  borders-radius.html
  elevation.html
  icons.html
  grid-breakpoints.html
  layout-surface.html
components/              ← reference renders for primitives (atoms with rules)
  buttons.html
  badges.html
  inputs.html
  cards.html
  tables.html
  navigation.html
  modals.html
  avatars.html
  toasts-alerts.html
  tooltips.html
  progress.html
patterns/                ← composition recipes (how primitives combine)
  page-layouts.html      ← dashboard / detail / marketing / auth shells
  forms.html             ← form-bearing card composition
  dashboard.html         ← KPI strips, position panels, charts
  empty-states.html      ← in-table, page-level, loading, error, 404
guidelines/              ← non-visual rules + voice
  principles.html        ← eight principles (canonical) — visual rules, voice, lexicon, image placeholders
  accessibility.html     ← WCAG 2.2 AA, contrast, focus, semantics
  motion.html            ← durations, easing, reduced motion
examples/                ← full-page reference screens (real product + marketing)
  index.html             ← annotated gallery view
  product/               ← Explorer, Bridge, Dual Stacking app
  marketing/             ← Bitcoin Staking + Dual Stacking landing pages
```

Five tiers:

1. **Foundations** — tokens you don't invent (color, type, spacing, radius, elevation, icons, grid, surface system).
2. **Components** — atoms with rules (buttons, inputs, badges, cards, tables, nav, modals, avatars, toasts, tooltips, progress).
3. **Patterns** — composition recipes (page layouts, forms, dashboards, empty states) — how primitives combine into screens.
4. **Guidelines** — non-visual rules: principles (canonical — covers visual rules, voice, lexicon, and the placeholder convention for imagery), accessibility, motion.
5. **Examples** — full-page reference screens at production scale.

**Note on imagery:** photography, illustration, and 3D are out of scope for this system — they belong to a separate visual language set by people, not by component rules. Prototypes that need an image render an explicit placeholder slot instead (see Principle 08).

When designing a new surface: read the relevant **pattern** first, then drop in **components**, validated against **foundations** and **guidelines**.

## Sources

- **Figma:** "Stacks Explorer Design System [Redesign]" — authoritative source for color, semantic tokens, type, spacing, border-radius, elevation, and component specs.
- **Codebase:** [`hirosystems/explorer`](https://github.com/hirosystems/explorer) — production Next.js + Chakra UI app for Stacks Explorer. Source of truth for theme tokens (`src/ui/theme/*.ts`) and component implementations.

The Explorer codebase is **seed material** — concrete inspiration for what Stacks-flavored surfaces look like. New screens generalize on top of it rather than reproducing it.

## Quick start for new screens

1. Link `tokens/tokens.css` with a relative path. Never hard-code hex codes.
2. Apply the surface system (closed set — see **Surface system** below): the entire shell — page, sidebar, top bar, main view — is `--surface-tertiary`, separated by `--border-secondary` 1px lines, **not** by different fills. Cards are either Form A (transparent / `--surface-tertiary` + `--border-secondary`) or Form B (`--surface-primary`, no border) — never white, never anything else. Form-bearing cards (containing inputs/controls) are always Form B.
3. Use `--font-display` (Matter) for headings, `--font-mono` (Matter Mono) for numbers/hashes/timestamps only, `--font-body` (Instrument Sans) for body.
4. Reference `components/*.html` for primitive examples (`components/cards.html`, `components/layout-rules.html` for surface usage); reference `examples/` (start at `examples/index.html`) for full-page composition. **Always look at `examples/` before designing a new surface** — the references show how the system actually plays out at full page scale (rhythm, density, copy register), which is hard to read off of isolated component cards.
5. New screens you produce go in their own folder (e.g. `screens/`, `flows/`) — do not write into `examples/`, which is reserved for the canonical reference set.

---

## Content fundamentals

**Voice — pragmatic, observatory, slightly technical.** Stacks Labs writes for a developer-and-investor audience that knows what a block height is. Copy is precise, lowercase-where-possible, and prefers numbers and proper nouns over adjectives. Product copy is impersonal and declarative.

**Editorial discipline — one job per screen.** Before composing, name the primary task or answer the screen owes the user. Density is in service of that job, not a substitute for one. Supporting modules sit visibly subordinate; if a panel is there because the space was, cut it. Don't cram paragraphs into narrow cards (link out instead) and don't put 32–48px display headlines in narrow product columns (default to 20–24px in chrome). See `guidelines/principles.html` 02 / 02a / 02b.

- **Casing:** Title Case for buttons, page titles, table headers ("Block height", "Fee rate", "Mempool transactions"). Lowercase for token names within UI labels (`stacks-500`, `sand-150`, `border-radius: xs`). Mono caps for type-style names (`HEADING SM`, `TEXT-MONO-LG`).
- **Tone:** observational, factual ("There are no transactions in the mempool"). Empty states are dry, not chirpy. **No exclamation marks** in product UI.
- **Numbers:** Always rendered in **Matter Mono** so digits visually align in tables. Cryptocurrency values use mono with a 4-decimal max for STX/BTC, abbreviation in tables (`12.3M STX`, `1.2K BTC`). Block heights are unformatted full integers (`873,201`).
- **Emoji:** **Never** in product UI. Not used in the Figma file or codebase.
- **Filler:** Avoid. Tables show data; cards show one number + label + delta. No persuasive copy.

Examples (taken from the codebase):
- Empty state: "No transactions yet"
- Status badge: "Pending", "Confirmed", "Failed" (sentence case)
- Tab label: "Recent blocks" / "Mempool" / "Signers"
- Section header: "Block #873,201" with mono number, sans label

---

## Visual foundations

### Palette

The system runs on a **warm neutral** axis (Sand) plus a **Stacks orange** accent and a **Bitcoin gold** accent. Testnet swaps the orange for a violet to make environment confusion impossible. Light and dark modes are first-class — neutrals invert symmetrically (sand-50 ↔ sand-1000).

- **Primary brand:** `#FC6432` (stacks-500). Used for primary actions, brand expressions, and to mark Stacks-native content.
- **Bitcoin:** `#FF9835` (bitcoin-500). Marks Bitcoin-native content (BTC blocks, sBTC, anchored data). Always paired alongside Stacks orange — never replaces it.
- **Testnet violet:** `#765BFF` (testnet-500). Replaces Stacks orange entirely when in Testnet, including logo and primary actions.
- **Neutrals:** Sand scale (15 stops) for surfaces, text, and borders. Surfaces tier from sand-50 (page bg) → sand-100 → sand-150 → white (raised cards). In dark mode, sand-1000 → sand-950 → sand-900 → sand-800.
- **Feedback:** Green (success), Red (error/fail), Yellow (caution), Blue (info), Bronze (pending — _orange-tinted_ to fit the warm palette, not gray).
- **Secondary tags (tx-type only):** Moss, Lime, Pink, Peach, Butter, Blood-orange. Pastel tones used only on transaction-type badges to allow scanning.

For categorical 3+ color charts (donuts, stacked bars), the defensible triplet is **stacks-500 / bitcoin-500 / moss-400** — all real tokens, all clean against warm sand. Do not invent ad-hoc browns or olives.

### Type
- **Display:** `Matter` (`--font-display`). Geometric sans, slight square terminals. Used for all headings, never for body. Tight tracking: -0.01 → -0.03em as size goes up.
- **Body:** `Instrument Sans` (`--font-body`). Self-hosted webfont (`fonts/InstrumentSans-Regular.woff2`, italic also available). 400/500/600 in three sizes (xs, sm, md, lg, xl, 2xl).
- **Mono:** `Matter Mono` (`--font-mono`). Used **sparingly** — only for numbers, hashes, block heights, code, type-style names, and timestamps. Never for prose.

### Spacing
4-pt scale (4 → 384). Product surfaces live at 4/8/12/16/24. Section padding is tight; rows are dense.

### Border radius
6-step scale. Controls default to `md` (8px). Cards use `lg` (12px). Avoid larger radii in product chrome.

### Elevation
Three shadow tokens, all at `rgba(183, 180, 176, 0.2)` in light mode (warm gray cast — _not_ neutral black). In dark mode they switch to `rgba(0,0,0,0.2)`. Cards rarely use shadow at rest — borders carry the weight; shadows only on lifted surfaces (popovers, modals, dropdowns).

### Backgrounds & motifs
- **No gradients** in product UI. Only flat fills.
- **Iconography is line + filled glyph**, not photographic. No hero illustrations, no 3D renders, no stock imagery.
- **No "AI slop":** no gradient cards, no left-border-accent cards, no bluish-purple gradients, no emoji.

### Animation & states
- **Animation:** sparing. Where present: 150–200ms ease-out fades and small position shifts (no bounces). Number tickers and block counters animate increment-only.
- **Hover (light mode):** background shifts up one surface tier (sand-50 → sand-100), text color stays. Borders may darken one stop. No scale, no shadow change.
- **Hover (interactive accent):** text shifts to `--text-interactive-hover` (stacks-600).
- **Press:** background drops one tier further (or applies an alpha overlay). No scale-down.
- **Focus:** 2px outline in stacks-500 with 2px offset.

### Borders, transparency, blur
- **Borders are everywhere.** Card edges, table rows, input frames — all use sand-200/300 (light) or sand-700/600 (dark). Borders are a primary structuring tool.
- **Transparency:** alpha tokens exist (`sand-alpha-*`, `black-alpha-*`, `bitcoin-500-alpha-*`) for hover overlays and chart fills. Backdrop blur is **not** part of the system.
- **No glassmorphism, no frosted modals.** Modals use a solid surface with a 40% black overlay backdrop.

### Surface system

The surface system is a **closed set of moves**. The shell is one tone; cards have exactly two legal forms; nested groups have one canonical pattern. If a layout decision isn't covered by the rules below, the answer is one of the legal forms — not a new fill.

#### The shell — one continuous tone

Page background, sidebar, top bar, footer chrome, and the main content area **all share `--surface-tertiary`**. They are separated by 1px `--border-secondary` rules, not by different fills.

- ❌ Sidebar in `--surface-secondary` while the main view is `--surface-tertiary` — wrong. The shell breaks.
- ❌ Top bar in `--surface-primary` to "separate" it from content — wrong. Use a border.
- ✅ Sidebar, top bar, content area all `--surface-tertiary`; a single 1px `--border-secondary` divides them.

#### Cards — two legal forms

Every card on a page is exactly one of these. Pick one per card; do not mix fills and borders outside this set.

| Form | Use it for | Background | Border | Radius |
| --- | --- | --- | --- | --- |
| **A. Quiet card** | Default grouping. Cards that organize content but shouldn't compete with it. | `--surface-tertiary` (same as page) | 1px `--border-secondary` | `--radius-lg` (12px) |
| **B. Standout card** | Cards that need emphasis. **Mandatory** for any card containing form elements (inputs, selects, toggles, sliders, search). | `--surface-primary` | **none** | `--radius-lg` (12px) |

Neither form has a shadow at rest. Borders carry the weight.

**Why form-bearing cards must be Form B:** inputs default to `--surface-secondary` or `--surface-fourth`. They need to sit visibly on top of their container. On a Form A card (page-tone background), inputs blend in and the form reads flat. On a Form B card (`--surface-primary`), inputs pop. So: any card with controls inside → Form B.

#### Card groups — two legal patterns

When multiple small cards belong together, pick one of these patterns. Don't fall back to N separate bordered cards.

**Pattern 1 — Loose row.** Use for the horizontal hero KPI strip at the top of a page (3–4 tiles across). Each tile is a Form A or Form B card sitting directly on the page; they're spaced by `gap`, not contained.

**Pattern 2 — Grouped container.** Use for vertical stacks of related metrics inside page content, or any time the cells should read as one object instead of as separate cards.
- Outer container: `--surface-primary`, no border, radius `lg`, padding 16–24px.
- Inner cells: `--surface-secondary`, **no border**, radius `md` — separated by `gap` or by 1px `--border-tertiary` dividers between rows.
- This is the only place `--surface-secondary` is used as a card-shaped fill. Outside a Pattern 2 container, never use `--surface-secondary` for a top-level card.

#### Hard rules

- **Cards are never `--surface-fourth` (white / sand-800).** That tier is reserved for input fills, raised controls inside a form, and the rare hero KPI lift — not for generic content cards. **If a card looks white in light mode, it is wrong.**
- **No card uses any fill outside this table.** No off-white, no tinted card, no gradient, no left-border accent stripe.
- **The shell is one tone.** Sidebar, top bar, main view are all `--surface-tertiary`.
- **Borders, not shadows, carry the structural weight.** Shadows only on truly floating surfaces (popovers, modals, dropdowns).
- **Step exactly one tier when nesting.** From Form A (tertiary) you may nest a `--surface-secondary` cell. From Form B (primary) you may nest `--surface-secondary` cells or `--surface-fourth` inputs. Never skip a tier.

### Buttons
- **Primary:** background `--stacks-500`, **black text** (`--black`), specific drop shadow `box-shadow: 0 8px 16px 0 rgba(252, 100, 50, 0.40)` — orange-tinted glow that matches the brand fill. Hover deepens background to `--stacks-600`; text stays black; shadow stays. Disabled drops the shadow.
- **Secondary:** `--surface-fourth` fill, `--border-primary` 1px stroke, `--text-primary` label, no shadow.
- **Tertiary:** transparent fill, `--text-primary` label, hover lifts to `--surface-secondary`.
- **Ghost-orange:** transparent fill, `--stacks-500` 1px stroke + label, hover fills to `--stacks-100`.
- Sizes: sm 28 / md 36 / lg 44. Radius `md` (8px) at sm/md, 10px at lg.

### Cards

See **Surface system** above for the full set of legal card forms. In short:

- **Form A — Quiet card** — `--surface-tertiary` fill (same as the page) + 1px `--border-secondary`. The default. Use for cards that group content without needing to stand out.
- **Form B — Standout card** — `--surface-primary` fill, no border. Use when a card needs emphasis. **Required** for any card that contains form elements (inputs, selects, toggles, search) — the form fields, which sit at `--surface-secondary` / `--surface-fourth`, need to read as raised on top.
- Both: radius `--radius-lg` (12px), padding 16–24px, no shadow at rest.

**For groups of small cards** (vertical stacks of metrics, related rows): wrap them in a `--surface-primary` container with no border, and render the inner cells as `--surface-secondary`, **no border**, radius `md`, separated by gap or `--border-tertiary` dividers. Don't render them as N separate bordered cards.

**Cards are never white / `--surface-fourth`.** That tier is for input fills and raised controls, not for generic content cards. If a card looks white in light mode it is wrong — pick Form A or Form B.

### Layout rules
- Page max-width 1440px; responsive down to 768/375 breakpoints.
- Sticky top nav (64px tall, full-width). No floating fabs.
- Two-column patterns: 1/3 detail + 2/3 content for tx/block detail pages.
- Tables are dense; row height 48–56px; mono numbers right-aligned; sans labels left-aligned.
- Hit targets ≥ 32px inline, ≥ 44px touch.

---

## Iconography

**Primary system: [Phosphor Icons](https://phosphoricons.com/) (`@phosphor-icons/react`).** The Explorer codebase uses Phosphor's regular + bold weights for almost all UI affordances (search, copy, chevrons, settings). Stroke-style line icons at the default 1.25px weight.

**Custom brand icons** (in `assets/`, all SVG):
- `dual-stacks-logo.svg` — full Stacks wordmark + glyph
- `logo-stacks.svg` / `bitcoin-l2-labs.svg` — alternate locks
- `stx-circle.svg` / `stx-square.svg` / `stx-glyph.svg` — STX glyph in three crops
- `btc.svg` — Bitcoin glyph
- `sbtc-circle.svg` / `sbtc-glyph.svg` / `logo-sbtc-light.svg` — sBTC token mark in circle, glyph-only, and legacy lock-up
- `active-marker-icon-light.svg` / `default-marker-icon-light.svg` — block-row markers
- `no-txs.svg` — empty-state glyph

The Stacks glyph is a stylized "S" formed by two crossed lines. Always use the SVG/component — do not redraw.

**No icon font. No emoji. No Unicode glyphs as icons.** If a Phosphor icon doesn't exist for the concept, a custom SVG is added — never improvised inline.

For new HTML mocks: use Phosphor via CDN (`https://unpkg.com/@phosphor-icons/web@2/src/regular/style.css`) or copy needed SVGs from `assets/`. **Do not redraw icons.**

---

## Hard "do not" list

- No gradients in product UI — only flat fills.
- No emoji, no Unicode glyphs as icons.
- No glassmorphism, no backdrop blur, no frosted modals.
- No gradient cards, no left-border-accent cards, no bluish-purple accents.
- No "AI slop" generic data-stat strips with random numbers + icons.
- No hero illustrations, 3D renders, or stock imagery.
- Do not redraw the Stacks "S" glyph or any brand SVG — copy from `assets/`.

---

## Fonts

All three brand families are self-hosted from `/fonts` and registered via `@font-face` in `tokens/tokens.css`. No remote font fetches at runtime.

- **Matter** (`--font-display`) — `fonts/matter-regular.woff2` (with `.woff` fallback). Licensed font; `.woff2` copied from the open-source Explorer repo.
- **Matter Mono** (`--font-mono`) — `fonts/matter-mono-regular.woff2` regular, `fonts/MatterSQMono-Medium.woff` at weight 500.
- **Instrument Sans** (`--font-body`) — `fonts/InstrumentSans-Regular.woff2` + `InstrumentSans-Italic.woff2`.
- **Open Sauce Sans** — included as a secondary fallback in the Explorer codebase.

Matter and Matter Mono redistribution for Signer Sidekick has been confirmed by Stacks Labs. The vendored `.woff2` files render the real typeface.
