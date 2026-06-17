# Spec - Realizations

This document specifies the concrete Notion sync product-shape layer. It builds
on [requirements.md](./requirements.md).

## Realization Map

- `01-datasource-markdown-workspace` composes datasource SQL files, `.nmd` page
  files, hidden control state, outbox, conflicts, and settlement.
- `02-react-owned-region` renders JSX into an owned Notion page region with a
  renderer cache and keyed block reconciliation.
