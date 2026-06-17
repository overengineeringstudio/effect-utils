# Datasource Markdown Workspace Intuition

*For: Notion sync maintainers · Assumes: stack-wide Notion sync architecture ·
Covers: the datasource plus `.nmd` local workspace realization*

This realization is the migrated Notion DB Markdown Sync contract. Its problem
space is composition: Notion data-source sync and NotionMD expose related local
editing workflows through different mental models, and local representations
become confusing when Markdown files, SQLite files, hidden sync state, and
Notion properties are not clearly separated by authority and consequence.

It describes one local workspace where datasource rows are visible through SQL
files and Notion pages are visible through `.nmd` files. Hidden state owns the
sync-control facts needed to safely compose those user surfaces.

The intended local surface stays small: SQLite data files for tabular or
scripted workflows, `.nmd` page files for editor workflows, and hidden
implementation state for bases, outbox, conflicts, leases, object state, and
settlement evidence.

The point is not a second Markdown dialect, a replacement control plane, or a
last-writer-wins sync model. It is composition: standalone NotionMD files remain
portable, datasource sync keeps the control plane, and writes fail closed when
the workspace cannot prove they are safe.
