# Recursive Workspace Demo

This directory is the local shape for exercising multi-file and recursive
`notion-md` commands. It is intentionally a template workspace: the checked-in
files end in `.nmd.example`, so recursive commands do not contact placeholder
Notion page ids by accident.

Create a real workspace by pulling each Notion page into a matching `.nmd` path:

```sh
export NOTION_TOKEN="secret_..."

notion-md pull <overview-page-id> \
  --out packages/@overeng/notion-md/demo/workspace/project/overview.nmd

notion-md pull <weekly-notes-page-id> \
  --out packages/@overeng/notion-md/demo/workspace/project/weekly-notes/2026-05-23.nmd
```

Then run the batch and recursive flows against the directory:

```sh
notion-md status packages/@overeng/notion-md/demo/workspace --recursive
notion-md sync packages/@overeng/notion-md/demo/workspace --recursive --concurrency 4
notion-md sync packages/@overeng/notion-md/demo/workspace --recursive --watch --poll-interval-ms 30000
```

The committed examples are shaped like real pulled files, but they are not sync
state. Do not rename them to `.nmd` without replacing the placeholder page ids by
pulling real Notion pages first.
