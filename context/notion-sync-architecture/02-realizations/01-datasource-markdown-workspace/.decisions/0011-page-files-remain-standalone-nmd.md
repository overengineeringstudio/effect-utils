# Datasource page files remain standalone NotionMD files

Status: accepted

`pages/v1/**/*.nmd` files in a datasource workspace should remain valid standalone
NotionMD page files. The datasource workspace may add hidden state for
property-ID mapping, local-surface convergence, relation safety, outbox,
conflicts, and watch behavior, but the visible page file must use the ordinary
`notion_md` envelope and stock Notion enhanced Markdown body.

## Consequences

Page-scoped NotionMD operations can operate on a datasource page file when the
NotionMD contract is sufficient. Operations that require datasource-wide context
must fail closed instead of silently bypassing datasource-sync guards. This
preserves composability without pretending a page-only CLI can prove
workspace-level invariants.
