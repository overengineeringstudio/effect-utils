# Keep one control plane and two minimal user surfaces

Status: accepted

Datasource-sync should expose the smallest useful end-user surface: one SQLite
data file for tabular/scriptable workflows and one NotionMD `.nmd` page file
per Notion page for editor workflows. Hidden implementation state may use SQLite,
sidecars, object stores, leases, base hashes, and own-write tokens, but those
artifacts are not user API. Markdown page files should feed the same control
plane and planner as SQLite edits instead of becoming a second sync engine or a
NotionMD-owned tree feature.

## Considered Options

| Option                                           | Result           | Reason                                                                                                                  |
| ------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| LocalWorkspacePort backend                       | Rejected for now | The current port is body/materialization shaped, not data-source-page shaped.                                           |
| Projection/intent adapter over one control plane | Recommended      | Reuses the existing planner, guards, event store, outbox, and watch model while keeping user-visible artifacts minimal. |
| NotionMD tree feature                            | Rejected         | NotionMD owns page bodies, not data-source schema, page membership, lifecycle, or query completeness.                   |
| Separate package/CLI                             | Rejected for v1  | A separate user-facing entrypoint would expand the surface before the datasource-sync contract is stable.               |

## Consequences

The default workspace should not expose redundant body files, user-editable
sidecars, or visible machine metadata. If extra artifacts are needed for safety
or performance, they live under hidden implementation directories and must be
rebuildable or repairable from the control plane.
