# Notion Markdown Sync Experiments

This document preserves non-normative evidence for [spec.md](./spec.md). It records tested Notion behavior and design consequences; the spec remains the source of truth.

## Enhanced Markdown Feature Matrix

**Hypothesis:** Notion enhanced Markdown can serve as the page body interchange format for most common authoring features.

**Method:** Created temporary child pages under a shared parent with the official `ntn` CLI, pulled each page as Markdown, compared input to output, and trashed all temporary pages.

**Results:**

- Paragraphs, headings, bulleted lists, numbered lists, nested lists, to-dos, quotes, dividers, empty blocks, block equations, callouts, toggles, toggle headings, columns, tables, table of contents, date mentions, and synced block sources round-tripped well enough for first-class support.
- Notion normalized some output: numbered list counters, code language aliases, table indentation, and some escaping.
- External image/audio/video/file/pdf URLs and captions round-tripped, but media block colors were dropped.
- Inline `$...$` equation input pulled back escaped.
- Markdown page-reference syntax failed on write in the tested fixture.
- A structured `link_to_page` block appended through the block API pulled as `<unknown ... alt="alias"/>`, while the raw block API preserved the typed reference.

**Conclusion:** The body surface can be built on enhanced Markdown, but support levels must be feature-gated by E2E evidence. Page/database references and unsupported blocks require block API fallback and local preservation.

Artifacts: `tmp/notion-md-feature-matrix/`.

## Frontmatter Boundary

**Hypothesis:** Local metadata can safely live in `.nmd` frontmatter if stripped before push.

**Method:** Sent YAML-like frontmatter through the Markdown endpoint, then repeated with frontmatter stripped.

**Results:**

- Frontmatter sent to Notion became literal page body text.
- Stripping frontmatter before `replace_content` produced clean pulled Markdown.

**Conclusion:** Frontmatter is a local wrapper only. It must be validated locally and never sent as body content.

## Conflict Semantics

**Hypothesis:** Notion Markdown update APIs can support guarded sync without default last-writer-wins behavior.

**Method:** Exercised `replace_content`, `update_content`, duplicate matches, stale matches, child-page deletion, comments, and Roughdraft markers against temporary pages.

**Results:**

- `replace_content` overwrote simulated remote edits.
- `update_content` failed for stale single matches and duplicated matches unless `replace_all_matches` was true.
- Multi-update behavior was not uniformly fail-fast; a missing hunk could be skipped while another hunk applied.
- Replacing content that would delete a child page failed unless `allow_deleting_content` was true.
- Notion comments are separate from body Markdown and support inline Markdown, not block Markdown.
- Roughdraft markers sent as body content pulled back as visible escaped text.

**Conclusion:** Default push must be guarded. `update_content` is a verified transport optimization, not the merge engine. Roughdraft review state must stay local unless explicitly bridged.

Artifacts: `tmp/notion-md-conflicts/`.

## Object Store And Files

**Hypothesis:** Unsupported blocks and files can be preserved locally without polluting editable Markdown.

**Method:** Created unsupported blocks and file/image blocks, pulled Markdown, fetched block API payloads, tested single-part file upload, and archived temporary pages.

**Results:**

- Bookmark and embed blocks pulled as `<unknown>` placeholders with `unknown_block_ids`.
- Fetching unknown IDs through the Markdown endpoint still returned unknown placeholders.
- Fetching unknown IDs through the block API returned typed payloads.
- `link_preview` was not accepted by the append-child request shape in the tested path.
- The workspace rejected multipart file upload, but single-part upload worked.
- File/image retrieval returned volatile Notion-hosted URLs and expiry times.

**Conclusion:** Unsupported blocks need block API snapshots. File bytes and durable media identity belong in the content-addressed object store; expiring Notion URLs are cache data only.

Artifacts: `tmp/notion-md-sidecar-files/`.

## Data Sources And Properties

**Hypothesis:** Data-source rows require property sync outside body Markdown.

**Method:** Created a disposable database/data source, created a row with typed title/select/multi-select/checkbox/date/url/number properties plus Markdown body, queried the data source, updated properties, read row Markdown, and archived the test database.

**Results:**

- Row properties lived on the page object and data-source schema.
- `GET /markdown` returned body content only.
- Property writes required matching the parent data-source schema.

**Conclusion:** Body-only sync is not acceptable for database rows. Property state needs typed schemas and schema-drift detection.

## Local Storage Size

**Hypothesis:** Compact state can stay in frontmatter, but raw snapshots and file data need escalation.

**Method:** Compared compact typed storage units against raw page/block snapshots and tiny embedded file bytes.

**Results:**

- Compact typed state stayed readable for small fixtures.
- Raw snapshots quickly became noisy and included volatile/private retrieval data.
- Tiny bytes were only acceptable because the fixture was artificially small.

**Conclusion:** the launch format should use strict frontmatter for compact metadata plus a content-addressed object store for base snapshots and bulky or volatile payloads. A separate per-page state file is not needed until property/comment/file surfaces outgrow frontmatter.
