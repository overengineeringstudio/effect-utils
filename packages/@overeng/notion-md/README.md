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
```

The CLI reads `NOTION_TOKEN` first and `NOTION_API_TOKEN` second.

## Safety Model

- `pull` writes a strict `.nmd` envelope and computes the clean body hash over the stripped Markdown body.
- `status` compares local body hash, remote body hash, and remote `last_edited_time`.
- `push` refuses to overwrite remote body changes unless `--force` is explicit.
- Missing or malformed sidecars fail `status` and `push`.
- Unknown Notion blocks are fetched through the block API and stored as compact unsupported-block units.

## Sidecar Policy

Sidecars are not the normal format. They are overflow storage for state that does not belong in a human-editable Markdown header:

- storage payloads above the strict size budget,
- volatile signed Notion retrieval URLs,
- future binary/cache artifacts.

The frontmatter keeps a tagged pointer and stable ids when a sidecar is required.

## Current Limitations

- Page properties are currently preserved as read-only frontmatter values. Writable data-source property encoding should reuse the generated schema/write encoders from `@overeng/notion-cli`.
- Conflict handling is guarded replace only. Three-way merge and Roughdraft conflict output are the next step.
- File upload lifecycle metadata is modeled and tested through the gateway contract, but the live gateway does not yet upload or download attachment bytes.
