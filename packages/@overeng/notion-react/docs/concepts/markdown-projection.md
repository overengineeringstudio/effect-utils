# Markdown projection

`@overeng/notion-react/markdown` turns the same JSX you sync into a readable
Notion-enhanced-Markdown body — no network, no Notion mutations, no cache.
Use it for review artifacts, CLI previews, snapshot diffs, and documentation
generated from the same content source that feeds production pages.

```tsx
import { renderToNotionMarkdown } from '@overeng/notion-react/markdown'

const { body, diagnostics } = renderToNotionMarkdown(<Instructions />)
```

> **Experimental.** Spellings and the diagnostics contract may change until
> a real consumer has proven the output. The body is a review artifact, not
> a canonical round-trip representation of Notion content.

## How it relates to sync

Both paths start from the same render pass: your JSX becomes a normalized
candidate tree, and each consumer reads that tree.

```
JSX ──► candidate tree ─┬─ diff vs cache ──► ops ──► Notion   (sync: mutating)
                        └─ projector ──► body + diagnostics  (projection: read-only)
```

The projection never scrapes HTML and never reconstructs content from sync
operations. Because it shares the tree, what you preview is what sync would
write — but a matching body does **not** imply cache identity or sync
safety.

## Diagnostics, not silence

Constructs that cannot survive Markdown losslessly are dropped from the body
_and reported_. Nothing disappears silently; nothing fails hard — the body is
always produced.

| Diagnostic          | When                                                                               | Body treatment                   |
| ------------------- | ---------------------------------------------------------------------------------- | -------------------------------- |
| `color-dropped`     | Non-default text/heading/callout colors                                            | Color omitted, text kept         |
| `media-without-url` | Media referencing a `fileUploadId` (no offline-resolvable URL)                     | HTML-comment placeholder         |
| `flattened`         | Column layouts, child-page boundaries, toggleable headings, external callout icons | Sequential/bold-label flattening |
| `unsupported-block` | `<Raw>` passthrough types with no Markdown spelling                                | HTML-comment placeholder         |

## Fidelity matrix

| Construct                           | Spelling                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Headings, paragraphs                | `#`–`####`, plain paragraphs                                                                                                     |
| Bold / italic / code / strike       | `**` / `*` / backticks / `~~`                                                                                                    |
| Underline                           | `<u>` (no native Markdown)                                                                                                       |
| Links, inline equations             | `[text](url)`, `$expr$`                                                                                                          |
| Mentions                            | `@name`, dates as `start → end`; href-less mentions degrade to plain text; annotations wrapping a mention/equation are preserved |
| Bulleted / numbered / to-do lists   | `- `, per-run `1.` counters, `- [x]`                                                                                             |
| Toggles                             | `<details><summary>` (CommonMark-safe blank lines)                                                                               |
| Quotes / callouts                   | Blockquotes; emoji icon prefix kept                                                                                              |
| Code                                | Fenced, fence lengthened past embedded backtick runs                                                                             |
| Tables                              | GFM with header separator row                                                                                                    |
| Images / media / bookmarks / embeds | `![caption](url)` / `[label](url)`                                                                                               |
| Equations, dividers, TOC            | `$$ … $$`, `---`, `[TOC]`                                                                                                        |
| Literal Markdown syntax in text     | Escaped (`\#`, `\*`, `\_`, …) so authored text survives verbatim; `$` stays bare (renders literally in stock Markdown)           |
| `blockKey`                          | Absent — renderer identity, not content                                                                                          |
| Root `<Page>` title/icon/cover      | Omitted from the body (belongs in the `.nmd` envelope or page properties) with a diagnostic                                      |

## Composing an `.nmd` file

The body is a plain string. Wrap it in a NotionMD envelope at your own
boundary:

```ts
import { renderNmdFile } from '@overeng/notion-md'

const file = renderNmdFile({ frontmatter, body })
```

`@overeng/notion-react` holds only a dev dependency on `@overeng/notion-md`
for its composition test — production code never imports it, and the reverse
dependency does not exist.
