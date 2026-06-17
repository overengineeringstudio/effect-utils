# Datasource Markdown Workspace Vision

## The Problem

1. Notion data-source sync and NotionMD currently expose related local editing
   workflows through different mental models, which makes composition harder
   than it should be.
2. Local representations can become confusing when Markdown files, SQLite
   files, hidden sync state, and Notion properties are not clearly separated by
   authority and consequence.
3. Users want the workflow to feel like editing ordinary local Markdown and
   SQLite files, without giving up the safety needed for bidirectional sync.

## The Vision

- A Notion workspace can be edited through a small, coherent local surface:
  Markdown page files for editor workflows and SQLite data files for tabular or
  scripted workflows.
- NotionMD and datasource sync compose around shared property semantics instead
  of competing file formats, duplicate schemas, or tool-specific exceptions.
- Hidden implementation state stays hidden. The visible files remain the
  intended user surface, and every accepted edit has clear consequences.
- Progressive complexity is explicit: simple one-way mirrors stay lightweight,
  while shared bidirectional sync adds the control plane needed for safety.
- Standalone `.nmd` files remain portable and useful, while richer workspace
  guarantees are available when the workspace can prove them.

## What This Is Not

- Not a second Markdown dialect for data-source pages.
- Not a replacement for the datasource sync control plane.
- Not a promise that every visible field is writable in every context.
- Not a last-writer-wins sync model hidden behind friendly local files.

## Success Criteria

1. A user can understand the intended editable surface without reading private
   control-plane state.
2. The same Notion property semantics are used by standalone NotionMD and
   datasource-sync.
3. Unsafe or under-proven writes fail with specific guards rather than guessing.
4. Common local editing feels like editing ordinary `.nmd` and SQLite files.

