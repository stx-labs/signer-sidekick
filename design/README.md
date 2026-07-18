# Design system

This directory contains the vendored design tokens and licensed fonts used by the Signer Sidekick
dashboard. The React implementation and browser tests are the source of truth for components,
layouts, behavior, accessibility, and product copy.

## Use

1. Reuse variables from [`tokens/tokens.css`](tokens/tokens.css); do not duplicate color, type,
   spacing, radius, or elevation constants.
2. Implement product UI under `apps/dashboard` and use Phosphor for ordinary interface icons.
3. Validate desktop, tablet, mobile, keyboard, dark mode, and reduced motion with the dashboard
   browser suite.

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
appropriate, and avoid encoding state by color alone.

## Provenance

Vendored on 2026-07-14 from the Stacks Labs Design System, seeded by Stacks Explorer Figma and
[`hirosystems/explorer`](https://github.com/hirosystems/explorer). Instrument Sans and Open Sauce Sans
are covered by [`fonts/OFL-1.1.txt`](fonts/OFL-1.1.txt); Matter and Matter Mono redistribution for
Signer Sidekick was separately confirmed by Stacks Labs.

Review token and font changes deliberately and run the dashboard browser suite afterward.
