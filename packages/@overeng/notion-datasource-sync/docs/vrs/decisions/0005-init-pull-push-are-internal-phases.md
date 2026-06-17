# Init, pull, and push are internal phases

Datasource sync exposes adoption (`track`), inspection (`status`), reconciliation
(`sync` / `sync --watch`), export, conflict resolution, forget, restore, and
doctor commands. Init, pull, and push remain implementation phases inside the
reconcile engine, not public commands.

## Status

accepted

## Considered Options

- Public `init`/`pull`/`push`: exposes mechanical phases, but asks users to pick
  a direction and makes partial bindings/product states easier to create.
- Public `sync` only for established reconciliation: keeps the normal workflow on
  the guarded local-capture-first loop.

## Consequences

Public writes flow through `sync`, `sync --watch`, conflict resolution, forget,
restore, or adoption. Phase-level behavior stays observable through progress,
structured output, spans, and dry-run plans.
