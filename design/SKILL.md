<!-- Vendored verbatim from Claude Design project "Stacks Labs Design System" on 2026-07-14. See DESIGN.md for provenance and re-sync instructions. -->

# Stacks Labs Design System — SKILL.md

The visual language for **Stacks Labs** product UI (the team behind Stacks, the leading programmable layer for Bitcoin). Tuned for dense, observatory product surfaces — dashboards, transaction lists, block detail, settings, wallet UI, modals. Logged-out moments inside a product flow (connect-wallet, auth gate, 404) follow the same rules.

## When to invoke this skill

- Stacks, Stacks Labs, Hiro, the Stacks blockchain, sBTC, or Stacks Explorer
- A "Bitcoin L2" / "programmable Bitcoin" / "PoX stacking" product
- Block explorer UI, wallet UI, or DeFi-on-Bitcoin product UI in a warm sand-and-orange palette
- Anything pinned to brand colors `#FC6432` (Stacks orange), `#FF9835` (Bitcoin gold), or the Matter / Matter Mono / Instrument Sans type stack

## Structure

| Path | Purpose |
| --- | --- |
| `README.md` | Long-form context — voice, palette, type, spacing, iconography, behavior |
| `tokens/tokens.css` | All color, type, spacing, radius, elevation tokens. **Always link this.** |
| `fonts/` | Matter, Matter Mono, Open Sauce Sans webfonts |
| `assets/` | Brand SVGs, token marks, marker icons |
| `foundations/` | Tokens you don't invent — `colors.html`, `type.html`, `spacing.html`, `borders-radius.html`, `elevation.html`, `icons.html`, `grid-breakpoints.html`, `layout-surface.html` |
| `components/` | Primitives — `buttons.html`, `badges.html`, `inputs.html`, `cards.html`, `tables.html`, `navigation.html`, `modals.html`, `avatars.html`, `toasts-alerts.html`, `tooltips.html`, `progress.html` |
| `patterns/` | Composition recipes — `page-layouts.html`, `forms.html`, `dashboard.html`, `empty-states.html`. **Read the relevant pattern before composing a new surface.** |
| `brand/` | Brand expression — voice, lexicon, motifs, voice-in-context. Principles live in `guidelines/`, not here. |
| `guidelines/` | Non-visual rules — `principles.html`, `accessibility.html`, `motion.html` |
| `examples/` | Full-page reference screens. `examples/index.html` is the annotated gallery; `examples/product/` and `examples/marketing/` hold the source PNGs. **Always consult before designing a new surface.** |

## How to use

1. **Always link `tokens/tokens.css`** at the top of any new HTML. Use its CSS variables — never hard-code hex codes.
2. **Read `README.md`** for foundations (voice, palette philosophy, surface system, animation behavior, "do not do" patterns).
3. **Reference `components/*.html`** as canonical examples of every primitive (a button looks like _this_, a badge looks like _this_, a table row is _this_ tall).
4. **Reference `patterns/*.html`** for composition recipes — page shells, form composition, dashboard rhythm, empty/loading/error states. These show how primitives combine into screens.
5. **Reference `guidelines/*.html`** for non-visual rules — accessibility (WCAG 2.2 AA), motion (durations, easing, reduced motion), and the guiding principles. **Read principles 02 / 02a / 02b before composing any screen** — they're what keep dense surfaces from turning into a menu of equally-weighted modules.
6. **Reference `examples/`** for full-page composition patterns. The gallery (`examples/index.html`) covers six product surfaces (Explorer Home / Transactions / Mempool / Stacking, Dual Stacking app, sBTC Bridge) and five marketing pages (Bitcoin Staking landing / Institutions / Retail / Resources, Dual Stacking landing). Match their rhythm — density, hero shape, copy register — when building anything new in the same family.
5. **Copy icons from `assets/`**, do not redraw. For UI affordances use Phosphor via CDN — `https://unpkg.com/@phosphor-icons/web@2/src/regular/style.css`.
6. **New screens you produce go in their own folder** (e.g. `screens/`, `flows/`) — never inside `examples/`, which is reserved for the canonical reference set.

## Rules at a glance

| | |
|---|---|
| Screen has one job | Name the primary task/answer. Everything else is supporting context, visibly subordinate. Not a menu of equals. |
| Density vs. focus | Dense rows yes; module sprawl no. Cut a panel before you cut row height. If a module is there because the space was, remove it. |
| Type matches the column | Don't cram body copy into narrow cards (link out or cut). Don't put 32–48px display headlines in narrow panels — default to 20–24px in product chrome. |
| Page / nav / sidebar bg | `--surface-tertiary`, flat. No imagery behind content. |
| Default card | `--surface-secondary` + `--border-secondary`, radius `lg`. |
| Max width | 1440px, edge-to-edge nav, dense rows |
| Headings | `heading-xs` / `heading-sm` (20–24px) |
| Body | 12–14px |
| Section padding | tight (8/12/16/24) |
| Card radius | `md` (8) / `lg` (12) |
| Imagery | almost none — the occasional brand glyph |
| Copy register | declarative, observatory, Title Case for buttons & headers |
| Hit targets | ≥ 32px inline, ≥ 44px touch |

## Surface system (critical for layout)

The surface system is **closed** — these are the only legal moves. Pick a tier from the table; do not invent.

### App chrome (the shell)

| Element | Surface |
| --- | --- |
| Page bg, sidebar, top bar, footer chrome, main content area | `--surface-tertiary` (sand-50 / sand-1000) |

The shell is **one continuous tone**. The sidebar, top bar, and main view all share `--surface-tertiary`. They are separated by 1px `--border-secondary` lines, never by a different fill. **Never** make the sidebar or top bar a different color from the page background.

### Cards & panels (the contents)

A card has exactly **two** legal forms. Pick one — do not mix:

| Form | When to use | Background | Border |
| --- | --- | --- | --- |
| **A. Quiet card** | Default. Card whose role is grouping, not standing out. | `--surface-tertiary` (same as page) | 1px `--border-secondary` |
| **B. Standout card** | Card that needs to pop — input/control panels, settings forms, anything with form fields. | `--surface-primary` (sand-150 / sand-900) | **none** |

Both use radius `--radius-lg` (12px). No shadow at rest.

**Form-bearing cards always use Form B (`--surface-primary`, no border).** A panel containing inputs, selects, toggles, or other controls must be `--surface-primary` so the inputs (which sit at `--surface-secondary` or `--surface-fourth`) read as raised on top of it. A bordered card with form elements inside is wrong.

### Card groups (multi-card containers)

When you'd otherwise lay out a row or column of small same-shape cards (KPI tiles, stat cells, metric strips), you have two patterns:

| Pattern | When to use | Outer | Inner cells |
| --- | --- | --- | --- |
| **1. Loose row** | Horizontal strip of 3–4 hero KPIs across the top of a page. | none — cells sit directly on the page | each cell is Form A or Form B per rules above |
| **2. Grouped container** | Vertical stacks of related cells, or any time the cells should read as one object. | `--surface-primary` container, no border, radius `lg` | `--surface-secondary` cells, **no border**, radius `md`, separated by gap or 1px `--border-tertiary` divider |

Pattern 2 is the right call for vertical lists of metrics inside page content (e.g. a "Position" panel with stacked rows). Don't render those as N separate bordered cards.

### Hard rules

- **Cards are never `--surface-fourth` (white / sand-800) by default.** `--surface-fourth` is reserved for inputs, raised controls, and the rare hero KPI exception — not generic content cards. If a card looks white in light mode, it's wrong.
- **Never use a fill the table doesn't authorize.** No off-white, no tinted card, no gradient, no left-border accent.
- **Borders, not shadows, carry structural weight.** Shadows only on truly floating surfaces (popovers, modals, dropdowns).
- **Inside a card, nest down or up by exactly one tier.** From Form A (tertiary) → secondary cell. From Form B (primary) → secondary cell or fourth (input). Never skip a tier.

## Type rules

- **Headings:** Matter (`var(--font-display)`), 500 weight, tight tracking (-0.01 → -0.03em as size goes up).
- **Body:** Instrument Sans (`var(--font-body)`), 400/500.
- **Mono:** Matter Mono (`var(--font-mono)`) — for **identifiers** (hashes, addresses, block heights, timestamps, code, type-style names) and for **tabular columns of digits**. Not for prose, not for status badges, not for hero/balance numbers.
- **Quantities that read as headings** (balance on a card, total stacked, hero KPI) are typeset in Matter like any other heading, with `font-variant-numeric: tabular-nums` for digit alignment. Ask what the number *is* (identifier vs. quantity), not how big it is.
- Numbers in tables right-align, mono. Labels left-align, sans.
- **Labels.** Card titles, panel titles, and stat labels are small headings — Title Case, body family, medium weight (500), `--text-secondary`. Reserve `UPPERCASE + letter-spacing` for table column headers and marketing eyebrows above hero headlines. If a person reads the label as words, it's a heading; if they parse it as a tag, it's an eyebrow.

## Color rules

- Primary actions, brand expressions, Stacks-native content → `--stacks-500` (`#FC6432`).
- Bitcoin-native content (BTC blocks, sBTC, anchored data) → `--bitcoin-500` (`#FF9835`). Always paired alongside Stacks orange — never replaces it.
- Testnet swaps Stacks orange entirely for `--testnet-500` (`#765BFF`).
- Categorical 3-color charts (donuts, stacked bars, tx-type dots): use the triplet **`--stacks-500` / `--bitcoin-500` / `--moss-400`**. Do not invent ad-hoc browns or olives — and never reference `--bronze-500` or `--moss-500` (they don't exist; valid stops are `bronze-200/600/900` and `moss-200/400`).
- Status badges: green (success), red (fail), yellow (caution), blue (info), bronze (pending — orange-tinted, not gray).
- Tx-type badges only use the pastel "secondary tags" (moss, lime, pink, peach, butter, blood-orange) for at-a-glance scannability.

## Voice

Pragmatic, observatory, slightly technical. Title Case for buttons/headers. Lowercase for token names within UI labels. Mono caps for type-style names. **No emoji. No exclamation marks in product UI.** Empty states are dry, not chirpy. No persuasive copy.

## Hard "do not" list

- No gradients in product UI — only flat fills.
- No emoji, no Unicode glyphs as icons.
- No glassmorphism, no backdrop blur, no frosted modals.
- No gradient cards, no left-border-accent cards, no bluish-purple accents.
- No "AI slop" generic data-stat strips with random numbers + icons.
- No hero illustrations, 3D renders, or stock imagery.
- Do not redraw the Stacks "S" glyph or any brand SVG — copy from `assets/`.

## Output expectations

When producing new screens: link `tokens/tokens.css`, prefer existing variables over inventing new colors, lean on `components/` for primitives and `examples/` for composition. Output goes in a fresh folder (e.g. `screens/`); leave `examples/` untouched.
