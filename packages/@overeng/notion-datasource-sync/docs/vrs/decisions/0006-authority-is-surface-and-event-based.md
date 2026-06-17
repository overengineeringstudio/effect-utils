# Authority is workspace-scoped and surface-executed

Datasource sync originally avoided NotionMD's `source: local | remote | shared`
model and described authority only through surfaces and events. The integrated
workspace replaces that exposed vocabulary: a workspace has one user-facing
authority mode (`local`, `remote`, or `shared`), while implementation authority
remains surface- and event-based inside that mode.

## Status

replaced by ../../../../../../context/notion-db-markdown-sync/decisions/0010-workspace-wide-authority-mode.md

## Considered Options

- Keep only datasource-specific authority vocabulary: matches the event log,
  outbox, guarded materialization, and no-silent-LWW requirements, but creates a
  second product model beside NotionMD.
- Expose one workspace authority mode and keep per-surface authority internal:
  consistent for users, while preserving the event-log/outbox mechanics needed
  for safe implementation.

## Consequences

The CLI and public docs use the integrated workspace authority mode. Internal
docs and code may still explain how individual surfaces are observed, captured,
planned, enqueued, and materialized, but those mechanics do not create extra
user-facing modes.
