# ADR 0004: Stacks Labs design system

- Status: Accepted
- Date: 2026-07-14

## Decision

Use the vendored Stacks Labs semantic tokens and licensed fonts through a thin local React component
layer. The [design contract](../../../design/README.md), React implementation, and browser tests
define the maintained UI contract. Light/dark themes, explicit network labeling, testnet violet
mapping, and WCAG 2.2 AA are required.
