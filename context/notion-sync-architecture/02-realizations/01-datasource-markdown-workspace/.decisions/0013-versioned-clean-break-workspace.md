# Version the workspace namespace from v1

Status: accepted

The integrated Notion DB Markdown Sync workspace should be a clean break. It
should expose one v1 public surface rather than preserving alternate public
table names or unversioned workspace paths.

Durable local artifacts belong to an explicit namespace version. The v1
workspace uses path/file-name boundaries such as `notion.workspace.v1.json`,
`data/v1/<source>.sqlite`, `pages/v1/<source>/*.nmd`, and `.notion/v1/...`.
Individual file formats may also carry their own schema version, such as the
NotionMD frontmatter version or SQLite schema metadata, but the workspace path
namespace is the first guard a user and tool can see.

## Considered Options

| Option                                                                  | Result   | Reason                                                                                                                               |
| ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Keep simple unversioned paths and rely only on internal schema versions | Rejected | It keeps paths prettier but makes future layouts ambiguous and pushes reinterpretation risk into every command.                      |
| Expose both public `rows` and `pages`                                   | Rejected | Multiple public names expand the user surface and make it unclear which contract is authoritative.                                   |
| Version the workspace namespace from v1                                 | Accepted | Future designs can use a new namespace and unknown/mixed layouts can fail closed before local edits are interpreted as write intent. |

## Consequences

The public SQL table/view is `pages`, with no public `rows` table/view.
Any implementation-internal row terminology must remain private and must not be
a durable user API.

Commands that encounter unknown or mixed namespace versions fail closed. They
may explain how to track the workspace again, but they do not silently migrate,
rewrite, or reinterpret local artifacts.
