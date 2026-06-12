# @overeng/notion-md

CLI and library for syncing Notion pages with local `.nmd` files.

## Docs

- [Getting Started](./docs/getting-started.md)
- [CLI Reference](./docs/cli.md)
- [File Format](./docs/file-format.md)
- [Sync Safety](./docs/sync-safety.md)
- [Demo Fixture](./docs/demo.md)
- [Testing](./docs/testing.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [VRS](./docs/vrs/README.md)

An `.nmd` file is:

- strict JSON-compatible frontmatter between Markdown `---` markers,
- stock Notion enhanced Markdown as the body,
- self-contained storage by default,
- content-addressed `.notion-md` object storage when metadata is too large,
  volatile, or needed as immutable merge evidence.

## CLI

```sh
notion-md track <page-id-or-url> page.nmd
notion-md status page.nmd
notion-md status docs --recursive
notion-md sync page.nmd
notion-md sync docs --recursive --concurrency 4
notion-md sync page.nmd --dry-run
notion-md sync page.nmd --watch --poll-interval-ms 30000
notion-md sync docs --recursive --watch --poll-interval-ms 30000
```

The CLI reads `NOTION_API_TOKEN`.

## Safety Model

- `track <page> <file.nmd>` writes a strict `.nmd` envelope for an existing Notion page and records explicit `source`.
- `status <path...>` is read-only and reports `in-sync`, `local-ahead`, `remote-ahead`, `diverged`, or `unbound`.
- `sync <path...>` dispatches per file from frontmatter `source`, not flags or argument shape.
- `source: local` mirrors local state to Notion; `source: remote` mirrors Notion state to the local file; `source: shared` uses the guarded base/merge path.
- Unbound `source: local` files with `page_id: null` create new Notion pages on `sync`.
- Every write command supports `--dry-run`.
- `sync <dir> --recursive` is flat batch mode for existing `.nmd` files only; it does not imply hierarchy, moves, trashing, or remote materialization.
- `sync --watch` runs the same frontmatter-dispatched reconcile path after local file changes and on a remote polling interval.
- Multi-file and recursive folder sync are orchestration only: each `.nmd` still maps to one Notion page and duplicate page ids are rejected before mutation.
- Sync refuses to update pages with unresolved unknown Notion blocks unless destructive deletion is explicit.
- Shared sync writes a Roughdraft conflict artifact next to the `.nmd` file when local and remote body edits diverge.
- Sync refuses unresolved Roughdraft review markup unless `--allow-review-markup` is explicit.
- Missing or malformed object-store references fail `status` and `sync`.
- Unknown Notion blocks are fetched through the block API and stored as compact unsupported-block units.

## Object Store Policy

Object-store refs are the overflow path for state that does not belong in a human-editable Markdown header:

- storage payloads above the strict size budget,
- volatile signed Notion retrieval URLs,
- last-clean body snapshots used for conflict evidence,
- future binary/cache artifacts.

The frontmatter keeps tagged content-addressed object refs and stable ids when object storage is required.

## Current Limitations

- Page properties are preserved as read-only frontmatter values unless edited into one of the modeled writable property forms.
- Body pushes use Notion `update_content` when a unique targeted patch can be proven and fall back to guarded `replace_content`.
- File upload lifecycle metadata is modeled and tested through the gateway contract, but the live gateway does not yet upload or download attachment bytes.
