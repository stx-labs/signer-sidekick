# Design system

This directory vendors the Stacks Labs product design system used by Signer Sidekick. It contains
tokens, fonts, assets, reference components, composition patterns, and full-page examples.

## Use

1. Use variables from [`tokens/tokens.css`](tokens/tokens.css); do not add duplicate color, type,
   spacing, radius, or elevation constants.
2. Start from the closest file under `components/` or `patterns/`.
3. Check full-page rhythm under `examples/` before introducing a new layout.
4. Use brand SVGs from `assets/` and Phosphor for ordinary interface icons.
5. Validate desktop, tablet, mobile, keyboard, dark mode, and reduced motion.

Reference HTML and tokens are more authoritative than prose. App-specific behavior belongs in
`apps/dashboard` and its browser tests.

## Local contract

- The app shell uses one continuous tertiary surface separated by borders.
- A quiet card uses the shell surface plus a border; a form/standout card uses the primary surface
  without a border.
- Generic cards do not use the raised input surface or shadows.
- Matter is for headings and quantities, Instrument Sans for prose, and Matter Mono for identifiers
  and tabular digits.
- Mainnet uses the Stacks accent; testnet uses the testnet accent and explicit text.
- Dense tables are expected, but every screen has one primary operator question.
- No gradients, glass effects, emoji, redrawn brand marks, or decorative dashboards.
- Product copy is factual and concise. No exclamation marks.

The implementation must meet WCAG 2.2 AA, preserve visible focus, provide 44px touch targets where
appropriate, and avoid encoding state by color alone. Detailed examples live under `guidelines/`.

## Provenance

Vendored on 2026-07-14 from the Stacks Labs Design System project maintained by Stacks Labs design.
Its seed sources were the Stacks Explorer Figma system and
[`hirosystems/explorer`](https://github.com/hirosystems/explorer). Matter and Matter Mono
redistribution for Signer Sidekick was confirmed by Stacks Labs; bundled license files remain under
`fonts/`.

Re-sync the export as a unit rather than copying isolated rules. Record the source/date, review
token and component changes, and run the dashboard browser suite afterward.
