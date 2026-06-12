# Authority is surface and event based

Datasource sync does not use NotionMD's `source: local | remote | shared`
frontmatter model. Its authority model is per surface and event based: Notion is
fresh observed remote state, the SQLite event log is durable local authority for
accepted intents/outbox/conflicts/tombstones, and public replica tables are
intent-entry and projection surfaces.

## Status

accepted

## Considered Options

- Import NotionMD Mirror/Shared terminology: consistent naming across packages,
  but incorrectly suggests single-source overwrite modes for a bidirectional
  SQLite control plane.
- Keep datasource-specific authority vocabulary: matches the event log, outbox,
  guarded materialization, and no-silent-LWW requirements.

## Consequences

The CLI can share verbs such as `track`, `status`, `sync`, and `sync --watch`
with NotionMD, but datasource-sync keeps its own authority vocabulary. Public
docs must explain authority through surfaces, observations, intents, events,
outbox commands, and guarded materialization rather than source modes.
