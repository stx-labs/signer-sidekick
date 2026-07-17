# Signer Sidekick design instructions

Use this reference for changes under `apps/dashboard`.

1. Read [`README.md`](README.md).
2. Reuse [`tokens/tokens.css`](tokens/tokens.css).
3. Start from the closest `components/` and `patterns/` examples.
4. Check `examples/` for page composition.
5. Use SVGs from `assets/` and Phosphor for normal icons.
6. Add product behavior and copy rules to code/tests, not this file.

Hard constraints:

- One primary question per screen.
- One continuous shell surface; use borders for structure.
- Only the documented quiet and standout card forms.
- Matter for headings/quantities, Instrument Sans for prose, Matter Mono for identifiers/tabular
  digits.
- Explicit mainnet/testnet text; testnet uses its own accent.
- No gradients, glass effects, emoji, decorative filler, or redrawn brand assets.
- Preserve keyboard access, visible focus, reduced motion, and responsive tables.

Reference HTML and browser tests override prose when they disagree.
