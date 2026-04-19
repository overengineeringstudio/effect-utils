# Coverage matrix

Surfaces audited:

- **schema** — `packages/@overeng/notion-effect-schema/src/objects.ts` (`BlockType` literal enumeration). Block bodies are an untyped `Record<string, unknown>` catch-all, so this column only reflects whether the `type` string is listed as valid.
- **client** — `packages/@overeng/notion-effect-client/src/blocks.ts`. Client is generic over the `Block` schema (`retrieve`, `listChildren`, `append`, `update`, `delete`). Column marks ✅ for every type the shared `BlockSchema` parses; there are no per-type helpers.
- **react host** — `packages/@overeng/notion-react/src/components/blocks.tsx` (JSX components that project to Notion payloads via `host-config.ts`).
- **react web** — `packages/@overeng/notion-react/src/web/blocks.tsx` (DOM-rendered mirrors).
- **css** — `packages/@overeng/notion-react/src/web/styles.css` (`.notion-*` classes scoped under `.notion-page`).
- **e2e** — `packages/@overeng/notion-react/src/test/integration/blocks.integration.test.tsx` (live Notion round-trip).

Legend: ✅ = first-class coverage. ❌(Raw) = generic `Raw` passthrough covers it (renders a `<div class="notion-raw">` debug box; round-trips unchanged via the renderer's raw escape hatch). ❌ = missing entirely.

| block_type             | schema | client | react host   | react web    | css          | e2e |
|------------------------|--------|--------|--------------|--------------|--------------|-----|
| paragraph              | ✅     | ✅     | ✅           | ✅           | ✅ (.notion-text) | ✅  |
| heading_1              | ✅     | ✅     | ✅           | ✅           | ✅           | ✅  |
| heading_2              | ✅     | ✅     | ✅           | ✅           | ✅           | ✅  |
| heading_3              | ✅     | ✅     | ✅           | ✅           | ✅           | ✅  |
| heading_4              | ✅     | ✅     | ✅           | ✅           | ✅           | ❌  |
| quote                  | ✅     | ✅     | ✅           | ✅           | ✅           | ✅  |
| callout                | ✅     | ✅     | ✅ (icon string only; no external/custom_emoji icons) | ✅ | ✅ | ✅ |
| code                   | ✅     | ✅     | ✅ (no caption) | ✅ (no caption) | ✅       | ✅  |
| bulleted_list_item     | ✅     | ✅     | ✅ (no nested children; no color) | ✅ | ✅       | ✅  |
| numbered_list_item     | ✅     | ✅     | ✅ (no nested children; no color) | ✅ | ✅       | ✅  |
| to_do                  | ✅     | ✅     | ✅ (no nested children; no color) | ✅ | ✅       | ✅  |
| toggle                 | ✅     | ✅     | ✅ (title-only; nested children not reconciled — see host-config comment) | ✅ | ✅ | ✅ |
| image                  | ✅     | ✅     | ✅ (external only; no file_upload; no caption in host) | ✅ (caption supported in web) | ✅ | ✅ |
| video                  | ✅     | ✅     | ✅ (external only) | ✅      | ✅           | ❌  |
| audio                  | ✅     | ✅     | ✅ (external only) | ✅      | ✅           | ❌  |
| file                   | ✅     | ✅     | ✅ (external only) | ✅      | ✅           | ❌  |
| pdf                    | ✅     | ✅     | ✅ (external only) | ✅      | ✅           | ❌  |
| embed                  | ✅     | ✅     | ✅ (no caption) | ✅          | ✅           | ✅  |
| bookmark               | ✅     | ✅     | ✅ (no caption) | ✅          | ✅           | ✅  |
| table                  | ✅     | ✅     | ✅ (no table_width / has_*_header props) | ✅ | ✅        | ❌  |
| table_row              | ✅     | ✅     | ✅ (rich_text treated as children, not `cells: rich_text[][]`) | ✅ | ✅ | ❌ |
| column_list            | ✅     | ✅     | ✅           | ✅           | ✅           | ✅  |
| column                 | ✅     | ✅     | ✅ (no width_ratio) | ✅      | ✅           | ✅  |
| divider                | ✅     | ✅     | ✅           | ✅           | ✅           | ✅  |
| table_of_contents      | ✅     | ✅     | ✅ (no color) | ✅           | ✅ (.notion-toc) | ✅  |
| breadcrumb             | ✅     | ✅     | ❌(Raw)       | ❌(Raw)       | ❌(Raw)       | ❌  |
| tab                    | ✅     | ✅     | ❌           | ❌           | ❌           | ❌  |
| synced_block           | ✅     | ✅     | ❌(Raw)       | ❌(Raw)       | ❌(Raw)       | ❌  |
| child_page             | ✅     | ✅     | ✅ (read-only; creation via pages.create) | ✅ | ✅       | ❌  |
| child_database         | ✅     | ✅     | ❌(Raw)       | ❌(Raw)       | ❌(Raw)       | ❌  |
| equation               | ✅     | ✅     | ✅           | ✅           | ✅ (.notion-equation-block) | ✅ |
| template               | ✅     | ✅     | ❌(Raw, read-only) | ❌(Raw) | ❌(Raw)       | ❌  |
| link_preview           | ✅     | ✅     | ❌(Raw, read-only) | ❌(Raw) | ❌(Raw)       | ❌  |
| link_to_page           | ✅     | ✅     | ✅ (page_id only; no database_id/comment_id) | ✅ | ✅     | ✅  |
| meeting_notes          | ✅     | ✅     | ❌           | ❌           | ❌           | ❌  |
| unsupported            | ✅     | ✅     | ❌(Raw, read-only) | ❌(Raw) | ❌(Raw)       | ❌  |

## Rich-text / nesting caveats

The host reconciler (`renderer/host-config.ts`) restricts `children` to rich text for every block in `TEXT_LEAF` (`paragraph`, all headings, `quote`, `callout`, `code`, `bulleted_list_item`, `numbered_list_item`, `to_do`, `table_row`). Nested block children inside list-ish containers are not reconciled in v0 — this is an explicit TODO. `toggle` children are similarly not supported.
