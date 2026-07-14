# ADR 0004: Stacks Labs design system

- Status: Accepted with release condition
- Date: 2026-07-14

## Decision

Use the vendored Stacks Labs semantic tokens through a thin local React component layer. The
detailed surface-system rules are authoritative. Light/dark themes, explicit network labeling,
testnet violet remapping, and WCAG 2.2 AA are required.

## Release condition

Confirm Matter and Matter Mono redistribution rights and obtain canonical brand SVGs before the
UI is included in a public release. Otherwise replace the licensed fonts with approved open
alternatives while preserving the semantic type roles.
