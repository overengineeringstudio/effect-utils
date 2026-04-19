# Gaps and recommendations

## Must-have before v0.1 release

1. **Nested `children` for list-ish blocks** (`bulleted_list_item`, `numbered_list_item`, `to_do`, `toggle`, `quote`, `callout`). Today the host reconciler hard-codes `children → rich_text` for everything in `TEXT_LEAF`, so authors cannot write real Notion list trees from JSX. Without this, the library can't express idiomatic Notion content and users will hit a wall on day one.
2. **`table` / `table_row` first-class shape.** `table_row` currently goes through the `TEXT_LEAF` path (rich_text only) instead of Notion's `cells: rich_text[][]`; `table` is missing `table_width`, `has_column_header`, `has_row_header`. A round-trip through the library today yields a malformed table on the Notion side. No E2E either.
3. **Media `caption` + `file_upload` support on the host.** Media components (`Image`, `Video`, `Audio`, `File`, `Pdf`) only project `{ url }` as `external`. Missing `caption` means lossy round-trips for any imported page. `file_upload` is the 2026 successor to internal `file` uploads and should be plumbed through before v0.1.

## v0.2 (ergonomic + completeness)

4. **`synced_block`** — today it only goes through `Raw`. Add a first-class component supporting `synced_from` (original vs reference) and nested `children`.
5. **`callout` icon envelope** — accept `{type: 'external', external: {url}}` / `{type: 'custom_emoji', …}` in addition to the current emoji-string convenience.
6. **`column.width_ratio`** — new Notion API field; without it v0.1 users can't author the common two-column layout with non-default widths.
7. **`code.caption`** — trivial to add; required for faithful round-trip.
8. **`bookmark` / `embed` captions** — same rationale.
9. **`table_of_contents.color`** and **list-item `color`** — add color prop plumbing consistently.
10. **`link_to_page` database/comment targets** — host currently emits `page_id` only.
11. **`breadcrumb`, `child_database`** first-class components (currently `Raw`).
12. **`heading_4` E2E coverage** — component exists, tests don't exercise it.
13. **Media E2E coverage** — currently only `Image` is tested. Add `Video`, `Audio`, `File`, `Pdf`.
14. **Table E2E coverage** — contingent on (2).

## Permanent skip (or handle via `Raw` only)

- **`tab`, `meeting_notes`** — newer server-only block types; no documented append path today. Keep the `BlockType` literal in schema, surface via `Raw` for readers, do not ship ergonomic components until the API opens up.
- **`template`** — creation deprecated in March 2023. Read-only `Raw` is sufficient.
- **`link_preview`** — not creatable via API. Read-only `Raw` is sufficient.
- **`unsupported`** — server-side opaque. Read-only `Raw` is the correct handling.
- **`child_page` / `child_database`** creation — intentionally out of scope; handled by `pages.create` / `databases.create`.

## Structural observations

- **Schema does not model block bodies.** `Block = BlockBase ∪ Record<string, unknown>` — the block `type` field is enumerated as a literal union but every per-type payload (`block.paragraph`, `block.image`, …) is `unknown`. This is fine for a v0.1 release (consumers use the polymorphic `Block`), but it means the client cannot narrow by type and all renderer code operates on `Record<string, unknown>` casts. A follow-up VRS entry should decide whether `notion-effect-schema` grows tagged union variants.
- **Client is fully generic.** `notion-effect-client/src/blocks.ts` exposes `retrieve`, `listChildren`, `append`, `update`, `delete` and a `buildTree` helper — all operating on the shared `BlockSchema`. No per-type blockers to land before v0.1; the type-level narrowing issue is owned by the schema.
- **`web/` mirror is slightly ahead of host.** E.g. `Image` in the web mirror renders `caption`, but the host component's prop type does not expose one. Drift is low-risk because props are shared via `components/props.ts`, but it should be reconciled by (3).

## Filing

`TaskCreate` tool schema was not available in this session's tool surface, so the items were filed as GitHub issues against `overengineeringstudio/effect-utils`:

- #585 — nested children on list-ish blocks (must-have)
- #586 — table / table_row (must-have)
- #587 — media caption + file_upload (must-have)
- #588 — v0.2 tracking epic (synced_block, callout icon envelope, width_ratio, code/bookmark/embed captions, color plumbing, link_to_page targets, breadcrumb/child_database components, heading_4 + media + table E2E)
