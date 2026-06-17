# Keep authority mode workspace-wide

Status: accepted

The datasource workspace has one authority mode: `local`, `remote`, or
`shared`. That mode applies to every tracked data source and to both exposed
local surfaces. Per-source and per-surface authority overrides are not part of
the default design.

The mode is established when the workspace is tracked and stored in
`notion.workspace.v1.json`. Established `sync` and `sync --watch` do not accept a
per-run mode override.

## Consequences

This avoids incoherent projects where one source is bidirectional while another
is a remote mirror but both share one visible workspace and hidden control
plane. Projects that genuinely need different authority contracts should use
separate workspaces, keeping status, dry-run, watch, and conflict semantics easy
to explain.
