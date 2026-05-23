# @overeng/notion-md

Prototype CLI and library for syncing Notion pages with local `.nmd` files.

An `.nmd` file is:

- strict JSON-compatible frontmatter between Markdown `---` markers,
- stock Notion enhanced Markdown as the body,
- self-contained storage by default,
- sidecar storage only when metadata is too large or volatile for frontmatter.

## CLI

```sh
notion-md pull <page-id> --out page.nmd
notion-md status page.nmd
notion-md push page.nmd
notion-md push page.nmd --force
notion-md push page.nmd --allow-delete-unknown-blocks
notion-md push page.nmd --allow-review-markup
notion-md sync page.nmd
notion-md sync page.nmd --watch --poll-interval-ms 30000
```

The CLI reads `NOTION_TOKEN` first and `NOTION_API_TOKEN` second.

## Safety Model

- `pull` writes a strict `.nmd` envelope and computes the clean body hash over the stripped Markdown body.
- `pull` writes a strict `<file>.base.json` snapshot with the last clean body so guarded conflicts can show base/local/remote evidence.
- `status` compares local body hash, remote body hash, and remote `last_edited_time`.
- `push` refuses to overwrite remote body changes unless `--force` is explicit.
- `push` automatically merges simple non-overlapping line edits, insertions, and deletions using the base snapshot.
- `sync` runs one reconciliation pass: local changes use guarded `push`, remote-only changes use `pull`, and clean files are left untouched.
- `sync --watch` runs the same reconciliation pass after local file changes and on a remote polling interval.
- `push` refuses to update pages with unresolved unknown Notion blocks unless destructive deletion is explicit.
- `push` writes a Roughdraft conflict artifact next to the `.nmd` file when remote body content changed.
- `push` refuses unresolved Roughdraft review markup unless `--allow-review-markup` is explicit.
- Missing or malformed sidecars fail `status` and `push`.
- Unknown Notion blocks are fetched through the block API and stored as compact unsupported-block units.

## Sidecar Policy

Sidecars are not the normal format. They are overflow storage for state that does not belong in a human-editable Markdown header:

- storage payloads above the strict size budget,
- volatile signed Notion retrieval URLs,
- last-clean body snapshots used for conflict evidence,
- future binary/cache artifacts.

The frontmatter keeps a tagged pointer and stable ids when a sidecar is required.

## Current Limitations

- Page properties are currently preserved as read-only frontmatter values. Writable data-source property encoding should reuse the generated schema/write encoders from `@overeng/notion-cli`.
- Conflict handling is guarded replace only. Three-way merge and Roughdraft conflict output are the next step.
- File upload lifecycle metadata is modeled and tested through the gateway contract, but the live gateway does not yet upload or download attachment bytes.
