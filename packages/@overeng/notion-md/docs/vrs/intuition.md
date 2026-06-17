# Intuition - @overeng/notion-md VRS

*For: NotionMD maintainers · Assumes: Notion page bodies, Markdown, and Effect ·
Covers: the product mental model behind the formal VRS*

`@overeng/notion-md` treats a Notion page as a local `.nmd` document with a
typed envelope and a Markdown body. The file is not a loose export format; it is
the durable surface the sync engine can reason about.

The package keeps three ideas separate. The editor surface gives people
`cat`/`put`/`edit` workflows. The file-sync surface owns pull, status, push,
watch, and batch behavior. The sync engine enforces guarded writes, merges,
settlement checks, local state, fidelity gates, and datasource property safety.

Lossy pages are refused instead of silently rewritten. Hosted media references
are canonicalized so expiring URLs do not create fake edits. Property writes use
typed datasource evidence when the page belongs to a data source, and fail
closed when the package cannot prove the same safety invariants expected by the
wider Notion sync stack.
