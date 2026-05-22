# Notion Enhanced Markdown Feature Matrix

Status: E2E research from 2026-05-22 against the requested shared parent page.

This matrix is based on real create/pull experiments with the official `ntn` CLI and the Notion enhanced Markdown endpoints. The token was fetched through `op-proxy` and passed as `NOTION_API_TOKEN`; no secret values were printed or stored in tracked files.

Official syntax reference used for the fixtures: <https://developers.notion.com/guides/data-apis/enhanced-markdown>.

## Method

Artifacts are under `tmp/notion-md-feature-matrix/`.

Tracked examples intentionally use placeholders for private Notion IDs and URLs. The ignored temp artifacts contain the exact page IDs, response JSON, pulled Markdown, failure stderr, and archive verification.

Command shape:

```bash
export NOTION_API_TOKEN="<token-from-secretspec-or-op-proxy>"

ntn pages create --json --parent page:<target-parent-page-id> < tmp/notion-md-feature-matrix/core.md > tmp/notion-md-feature-matrix/core.create.json
ntn pages get --json "$(cat tmp/notion-md-feature-matrix/core.id)" > tmp/notion-md-feature-matrix/core.get.json
jq -r '.markdown.markdown' tmp/notion-md-feature-matrix/core.get.json > tmp/notion-md-feature-matrix/core.pulled.md

ntn api /v1/pages/<temporary-page-id> -X PATCH -d '{"in_trash":true}'
```

Temporary pages were created for `core`, `structures`, `media`, `mentions-date`, `synced-block`, `page-link-block`, and one referenced child page. All were trashed at the end; see `tmp/notion-md-feature-matrix/archive-verification.tsv`.

## Summary

| Feature                      | Input artifact                        | Pulled artifact                | Fidelity                            | Recommendation                                                                                                                                                                             |
| ---------------------------- | ------------------------------------- | ------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Paragraphs                   | `core.md`                             | `core.pulled.md`               | Full, with blank-line normalization | Supported. Diff canonical pulled Markdown, not raw author input.                                                                                                                           |
| Headings 2-4                 | `core.md`                             | `core.pulled.md`               | Full                                | Supported. Heading 2 block color preserved as `{color="green"}`.                                                                                                                           |
| Bulleted lists               | `core.md`                             | `core.pulled.md`               | Full                                | Supported. Use tab indentation for children.                                                                                                                                               |
| Numbered lists               | `core.md`                             | `core.pulled.md`               | Normalized                          | Supported. Input `1.` sibling numbering pulled as `2.`. Treat numbering normalization as expected.                                                                                         |
| Nested lists                 | `core.md`                             | `core.pulled.md`               | Full                                | Supported when tabs are used for nesting.                                                                                                                                                  |
| To-dos                       | `core.md`                             | `core.pulled.md`               | Full                                | Supported, including nested to-do children.                                                                                                                                                |
| Quote                        | `core.md`                             | `core.pulled.md`               | Full                                | Supported. Quote color attribute round-tripped.                                                                                                                                            |
| Divider                      | `core.md`                             | `core.pulled.md`               | Full                                | Supported as `---`.                                                                                                                                                                        |
| Empty block                  | `core.md`                             | `core.pulled.md`               | Full                                | Supported as `<empty-block/>`.                                                                                                                                                             |
| Code block language          | `core.md`                             | `core.pulled.md`               | Normalized                          | Supported. Input fence language `ts` pulled as `typescript`. Canonicalize language aliases.                                                                                                |
| Block equation               | `core.md`                             | `core.pulled.md`               | Full                                | Supported.                                                                                                                                                                                 |
| Inline rich text             | `core.md`                             | `core.pulled.md`               | Mostly full                         | Bold, italic, strike, underline, inline code, inline colors, links, and `<br>` round-tripped.                                                                                              |
| Inline equation              | `core.md`                             | `core.pulled.md`               | Escaped on pull                     | Input `$E=mc^2$` became `\$E=mc\^2\$`; verify whether this renders as math in downstream Markdown tooling before claiming lossless inline equation sync.                                   |
| Callout                      | `structures.md`                       | `structures.pulled.md`         | Full                                | Supported with nested children, emoji icon, color, and inline rich text.                                                                                                                   |
| Toggle                       | `structures.md`                       | `structures.pulled.md`         | Full                                | Supported with `<details>` and nested children.                                                                                                                                            |
| Toggle heading               | `structures.md`                       | `structures.pulled.md`         | Full                                | Supported as heading attribute `{toggle="true"}` with indented children.                                                                                                                   |
| Columns                      | `structures.md`                       | `structures.pulled.md`         | Full                                | Supported. Indentation is preserved semantically.                                                                                                                                          |
| Table                        | `structures.md`                       | `structures.pulled.md`         | Full, formatting normalized         | Supported with enhanced `<table>` syntax, header flags, colgroup colors, row colors, and inline rich text in cells. Pull strips extra indentation around table tags.                       |
| Table of contents            | `structures.md`                       | `structures.pulled.md`         | Full                                | Supported as `<table_of_contents color="gray"/>`.                                                                                                                                          |
| Image                        | `media.md`                            | `media.pulled.md`              | Partial                             | External image URL and caption round-tripped, but block color was dropped. Track media color as lossy unless proven otherwise.                                                             |
| Audio                        | `media.md`                            | `media.pulled.md`              | Partial                             | External URL and caption round-tripped, color dropped.                                                                                                                                     |
| Video                        | `media.md`                            | `media.pulled.md`              | Partial                             | External URL and caption round-tripped, color dropped.                                                                                                                                     |
| File                         | `media.md`                            | `media.pulled.md`              | Partial                             | External URL and caption round-tripped, color dropped.                                                                                                                                     |
| PDF                          | `media.md`                            | `media.pulled.md`              | Partial                             | External URL and caption round-tripped, color dropped.                                                                                                                                     |
| Date mentions                | `mentions-date.md`                    | `mentions-date.pulled.md`      | Full                                | Supported inline with range and timezone/time attributes.                                                                                                                                  |
| Page reference Markdown      | `page-reference.md`                   | `page-reference.create.stderr` | Failed on write                     | `<page url="...">` plus inline `<mention-page>` failed with `validation_error: Failed to parse markdown content: Failed to create block`. Do not rely on Markdown write for page refs yet. |
| Page reference via block API | `page-link-block.append-request.json` | `page-link-block.pulled.md`    | Not lossless in Markdown            | Structured `link_to_page` pulled as `<unknown ... alt="alias"/>`; raw block API returned `type: "link_to_page"`. Use block API fallback and sidecar preservation.                          |
| Synced block source          | `synced-block.md`                     | `synced-block.pulled.md`       | Full for source creation            | Input `<synced_block>` without URL was accepted and pulled with a generated source URL. Treat edits/deletes as dangerous and read-only by default.                                         |
| Database references          | Not tested                            | Not tested                     | Gap                                 | Skipped to avoid creating schema/database state during this body-format pass. Expect block API/manifest handling similar to page references.                                               |
| User mentions                | Not tested                            | Not tested                     | Gap                                 | Date mentions were feasible; user mention URL/id selection was not exercised.                                                                                                              |

## Notable Pull Normalizations

Exact full inputs and pulls are in the artifacts named in the matrix. The excerpts below show the behavior that changed on pull.

````markdown
1. Number sibling

```ts
const value = '<escaped?>'
```

inline math $E=mc^2$
````

`core.pulled.md` summary:

````markdown
2. Number sibling

```typescript
const value = '<escaped?>'
```

inline math \$E=mc\^2\$
````

`structures.md` table input kept semantic attributes, but `structures.pulled.md` removed indentation inside `<table>`:

```markdown
<table fit-page-width="true" header-row="true" header-column="true">
<colgroup>
<col color="gray_bg">
<col color="blue_bg">
</colgroup>
...
</table>
```

`media.md` used `{color="..."}` attributes on every media block. `media.pulled.md` preserved URLs and captions but omitted all media color attributes.

`synced-block.md` input summary:

```markdown
<synced_block>
Synced block source content.
</synced_block>
```

`synced-block.pulled.md` summary:

```markdown
<synced_block url="https://www.notion.so/...#...">
Synced block source content.
</synced_block>
```

## Recommendations

- Treat enhanced Markdown pull output as the canonical body format. Normalize before diffing because Notion rewrites numbering, language aliases, table indentation, and some escaping.
- Support core body blocks now: paragraphs, headings, lists, nested lists, to-dos, quotes, dividers, code blocks, block equations, callouts, toggles, columns, tables, table of contents, date mentions, and synced block read/preserve.
- Mark media Markdown as partial until file-upload lifecycle and color preservation are designed. External URLs and captions work; colors did not round-trip.
- Keep page/database references on the block API fallback path. A `link_to_page` block is observable but pulls as unknown Markdown.
- Treat synced blocks as read-only by default. Even though a source synced block can round-trip, the generated URL means the sync tool must preserve identity carefully.
- Do not claim full inline equation fidelity until a focused render/API check explains why `$...$` pulled as escaped literal text in this run.

## Remaining Gaps

- Database reference creation and pull behavior.
- User, database, data-source, and agent mentions.
- File upload-backed media, Notion-hosted expiring file URLs, and garbage collection.
- Media block colors and captions with richer inline formatting.
- Page-reference Markdown parse failure root cause: whether syntax requires a different URL shape, only works for accessible public URLs, or is currently write-limited.
- Inline equation rendering semantics after escaped pull output.
