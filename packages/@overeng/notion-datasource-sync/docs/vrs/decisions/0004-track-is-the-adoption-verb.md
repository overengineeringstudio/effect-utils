# Track is the adoption verb

Initial adoption of an existing Notion data source into a local SQLite workspace
uses `notion db track <data-source-id-or-database-url> <workspace-root>`.
Established reconciliation uses `notion db sync <workspace-root>`.

## Status

accepted

## Considered Options

- `sync --from-notion`: fewer top-level verbs, but makes `sync` accept both
  remote identities and established local workspace roots.
- `establish`: precise, but uncommon as a CLI verb and inconsistent with
  NotionMD.
- `track`: names the durable relationship, keeps adoption separate from
  established reconciliation, and aligns with NotionMD.

## Consequences

`track` is remote-to-local only and never mutates Notion. `sync` operates only on
established local workspaces and preserves the local-capture-first invariant.
