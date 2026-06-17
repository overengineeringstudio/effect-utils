# Track is the bootstrap verb

Bootstrapping an existing Notion page into the local workspace uses a separate
`track <page-id|url> [path]` verb. It is not a `sync` flag because bootstrap
starts from a remote page reference and creates a local tracked file, while
steady-state `sync` operates only on self-describing local paths.

## Status

accepted

## Considered Options

- `clone`: familiar from git, but suggests duplicating a Notion page rather than
  establishing an ongoing binding.
- `sync --track`: fewer verbs, but makes `sync` accept both local paths and
  remote page references.
- `track`: names the durable relationship and preserves the target grammar.

## Consequences

`track` is the only command that accepts Notion page ids or URLs. After tracking,
ongoing work is `status` and `sync` over local paths.

`track` is only for existing Notion pages. Local-first creation is expressed by
syncing an unbound `source: local` file with `page_id: null`; the successful
create writes the returned Notion page id back to frontmatter.
