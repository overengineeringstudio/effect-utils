# Requirements: 06-data-source

**Role.** The typed property / page-metadata surface and its data-source binding:
the writable property-value forms, writable page metadata (title/icon/cover/
lock/trash), the `data_source` binding, and the `schema_snapshot`-based
schema-drift refusal that guards a property write. Properties and page metadata
sync through the typed page/data-source APIs, never through body Markdown.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved. The
`schema_snapshot` object role and the envelope these values are projected into
are stored by [05-local-state](../05-local-state/requirements.md); the drift
refusal is exercised by the engine
([03-sync-engine](../03-sync-engine/requirements.md)) before a property write and
reached interactively through `edit --frontmatter`
([01-editor](../01-editor/requirements.md)). Full data-source schema/view sync is
owned by the standalone [Notion datasource sync spec](../../../../notion-datasource-sync/docs/vrs/spec.md).

## Requirements

### Must Preserve Surface Boundaries

- **R04 Property boundary:** Page and row properties must sync through typed page/data-source APIs, not through body Markdown.

### Must Prevent Data Loss

- **R14 Schema drift safety:** Property writes must refuse or require explicit acceptance when the data-source schema has changed since the last clean pull. The drift is detected by comparing the live schema against a pull-time `schema_snapshot` (decision [0013](../.decisions/0013-in-buffer-schema-fingerprint.md) superseded by [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md)) and refuses with a distinct exit code that is **not** `--force`-able; resolve by re-pulling.
