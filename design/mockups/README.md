# Reward operations mockups

Hi-fi mockups for the Rewards page, Overview card, Settings gas-wallet panel, confirm sheet, and
mobile layout described in `docs/product/reward-operations-plan.md` (§6).

- `src/` — the only hand-edited files: one HTML fragment per screen, shared `partials/`,
  `mockup.css` (new `rw-` classes; candidates for `apps/dashboard/src/styles.css`),
  `screens.json` (artboard list + canvas layout), `annotations.json` (canvas sticky notes).
- `pages/` — generated standalone pages that link the **real** dashboard stylesheet, tokens, and
  fonts, so they render as the app would. Open `index.html` for the gallery (theme toggle included).
- `canvas/` — generated Claude Design canvas artboards (`*.dc.html`, `canvas.json`) with the CSS
  inlined; the brand fonts cannot load there, so headings and figures use the fallback stack.

The v2 screens (`EarningQuiet`, `EarningPending`, `EarningPendingTwo`, `PastExpanded`) are the
shipped Rewards layout: an Earning card for the accruing cycle (identity, three facts, the two
halves with each distribution's status), one Distribute card per distribution that still needs the
operator (dense, ten-per-page payments with the ₿ marker and its copyable L1 address), a
past-cycles ledger (one line per cycle; a cycle opens into distribution tabs, paged payments,
rolled-forward reasons on hover, and exports next to the data), and one fee-ledger card with the
export of the whole history. Wording rule used throughout: the UI shows state that changes;
standing rules live in tooltips and docs.

Rebuild after editing `src/`:

```bash
node design/mockups/build.mjs
```

Sample figures follow the agreed amount rule: below 100,000 sats as sats; otherwise 3
significant figures with the unit word always shown — sBTC for amounts held or moved on Stacks,
BTC for payouts that went out over Bitcoin. Sorting and filtering use integer sats, never the
rendered string.
