# Notion Markdown Sync WIP Spec

Status: WIP research note, not production spec.

This document sketches a two-way Notion <> local Markdown sync tool using Notion's official enhanced Markdown endpoints. The local file extension can be `.md` or `.nmd`; for now `.nmd` means "Notion enhanced Markdown wrapped with local sync metadata", not a replacement syntax.

## Goals

- Use Notion enhanced Markdown as the body content interchange format.
- Preserve user intent during conflicts instead of silently using last-writer-wins by default.
- Keep comments and suggestions portable using Roughdraft Flavored Markdown.
- Fall back to the block API for Notion features that enhanced Markdown cannot represent losslessly.
- Keep page body, page properties, data-source schema, comments, and attachments as separate sync surfaces.

## Current Notion Affordances

- `GET /v1/pages/{page_id}/markdown` retrieves page or block content as enhanced Markdown.
- `PATCH /v1/pages/{page_id}/markdown` updates content with `update_content` or `replace_content`.
- `POST /v1/pages` accepts `markdown` for initial page content.
- `data_sources` are the current schema/query surface for database-like content.
- File uploads are first-class and can be referenced by media blocks and file properties.
- Comments support Markdown strings for inline formatting, equations, links, and mentions, but not block-level Markdown.
- Webhooks can provide change notifications for page content and data-source schema updates.
- The official `ntn` CLI reads its API token from `NOTION_API_TOKEN`; this repo's libraries and tests use `NOTION_TOKEN`. Both should map to the same 1Password-backed secret for this project.

## Format Layers

The design has three layers. The tool must keep these boundaries explicit:

| Layer                          | Scope                                                              | Stored locally | Sent to Notion body Markdown | Notes                                                                     |
| ------------------------------ | ------------------------------------------------------------------ | -------------- | ---------------------------- | ------------------------------------------------------------------------- |
| Stock Notion enhanced Markdown | Page body blocks supported by Notion's Markdown endpoint           | Yes            | Yes                          | This is the canonical body interchange format.                            |
| Local sync frontmatter         | Page id, hashes, timestamps, properties, unknown block bookkeeping | Yes            | No                           | This is our wrapper. It is stripped before push and recreated after pull. |
| Local review markup            | Roughdraft comments, replies, suggestions, resolution state        | Yes            | Policy-dependent             | Notion has comments, but no native suggestion body semantics.             |

Any feature in the first layer should use Notion's stock enhanced Markdown syntax. Any feature in the second or third layer must be documented as a local extension and must not be confused with Notion's Markdown contract.

## Local File Shape

```markdown
---
notion:
  page_id: '<uuid>'
  api_version: '2026-03-11'
  last_pulled_time: '2026-05-22T00:00:00.000Z'
  remote_last_edited_time: '2026-05-22T00:00:00.000Z'
  body_hash: 'sha256:...'
  unknown_block_ids: []
  properties: {}
---

Enhanced Markdown body here.
```

The frontmatter is strict sync metadata. It is not part of Notion enhanced Markdown and must not be sent to `POST /pages` or `PATCH /pages/{page_id}/markdown` as body content.

The body remains stock Notion enhanced Markdown plus optional Roughdraft review spans. Compact local state should stay self-contained in frontmatter through a versioned tagged schema. A sidecar manifest is still useful for large pages, raw unsupported block snapshots, attachment bytes/mappings, volatile retrieval URLs, and per-block anchors.

### Frontmatter Contract

Frontmatter is a local wrapper around Notion enhanced Markdown.

Rules:

- Pull reads Notion Markdown, then writes local frontmatter plus the pulled body.
- Push parses local frontmatter, strips it, and sends only the body Markdown to Notion.
- The body hash must be computed over the canonical body, not over frontmatter.
- Unknown frontmatter keys are rejected. New metadata must be modeled as a versioned schema change or tagged extension.
- User-authored YAML frontmatter intended as visible page content needs escaping or an explicit body block because leading `---` is reserved by the local wrapper.

Validation:

- Sending YAML-like frontmatter through the Notion Markdown endpoint preserved it as literal page body text. This confirms frontmatter is viable as a local file wrapper, but not as a Notion-native metadata channel.
- Stripping frontmatter before `replace_content` produced clean Notion body Markdown on pull.

This makes `.nmd` a useful extension for "Notion enhanced Markdown with local metadata". A plain `.md` mode can still exist, but it should either omit metadata or store metadata in a sidecar file.

## Conflict Model

Default push must be guarded:

1. Pull stores `remote_last_edited_time` and normalized `body_hash`.
2. Before push, retrieve current page metadata and Markdown.
3. If the remote hash still matches the last pulled hash, use `replace_content` for a full-file push.
4. If the remote changed, compute a three-way diff: `base`, `local`, `remote`.
5. For isolated local edits, prefer `update_content` with exact `old_str` -> `new_str` edits.
6. If `old_str` is missing, duplicated, or overlaps a remote edit, surface a conflict.
7. Use Roughdraft suggestions/comments to represent unresolved merge decisions in the local file.

`replace_content` remains available as `--force` or `--strategy theirs/local`, but it must be explicit because it overwrites remote body changes.

### Targeted Update Semantics

Experiments showed:

- `update_content` fails when `old_str` no longer exists. This is useful stale-base detection.
- `update_content` fails when `old_str` matches multiple places unless `replace_all_matches` is true. This is useful ambiguity detection.
- `replace_content` overwrites the whole page and behaves like last-writer-wins.
- Deleting child pages or child databases is blocked unless `allow_deleting_content` is true. The error includes affected child items and suggests preserving them with `<page>` or `<database>` tags.

## Roughdraft Review Layer

Use Roughdraft Flavored Markdown 0.1 for local comments and suggestions.

Examples:

```markdown
{==anchored text==}{>>Needs a source.<<}{id="c1" by="user" at="2026-05-22T12:00:00.000Z"}
{++inserted text++}{id="s1" by="AI" at="2026-05-22T12:01:00.000Z"}
{--deleted text--}{id="s2" by="user" at="2026-05-22T12:02:00.000Z"}
{~~old text~>new text~~}{id="s3" by="AI" at="2026-05-22T12:03:00.000Z"}
{>>Reply text.<<}{id="c2" by="AI" at="2026-05-22T12:04:00.000Z" re="c1"}
```

Policy:

- Roughdraft review spans are local review state, not stock Notion enhanced Markdown by default.
- When pushing to Notion, unresolved Roughdraft suggestions should either be rejected, rendered visibly, or stripped only under an explicit mode.
- Notion comments should be imported/exported separately from body Markdown. If comment permissions are unavailable, keep Roughdraft comments local.
- A future bridge can map Roughdraft comments to Notion comments where anchors can be resolved to a block or page.

## Feature Mapping

| Notion feature               | Enhanced Markdown representation               | Push path                           | Pull fidelity             | Notes                                                                                                      |
| ---------------------------- | ---------------------------------------------- | ----------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Page title                   | Frontmatter page property, not body Markdown   | `pages.update` properties/title     | Full via page metadata    | `GET /markdown` does not include the page title as body content.                                           |
| Page icon                    | Frontmatter                                    | `pages.update` icon                 | Full via page metadata    | Not body Markdown.                                                                                         |
| Page cover                   | Frontmatter                                    | `pages.update` cover                | Full via page metadata    | File upload/external cover needs manifest tracking.                                                        |
| Paragraph                    | Plain paragraph                                | Markdown endpoint                   | Full                      | Normalized spacing may change.                                                                             |
| Heading 1-3                  | `#`, `##`, `###`                               | Markdown endpoint                   | Full                      | Toggle headings need enhanced syntax if supported by Notion output.                                        |
| Bulleted list                | `- item`                                       | Markdown endpoint                   | Full for simple lists     | Nested list behavior needs E2E coverage.                                                                   |
| Numbered list                | `1. item`                                      | Markdown endpoint                   | Full for simple lists     | Number normalization expected.                                                                             |
| To-do                        | `- [ ]` / `- [x]`                              | Markdown endpoint                   | Expected full             | Needs E2E confirmation with nesting and children.                                                          |
| Quote                        | `> quote`                                      | Markdown endpoint                   | Expected full             | Needs E2E confirmation with rich text.                                                                     |
| Divider                      | `---`                                          | Markdown endpoint                   | Expected full             | Needs E2E confirmation.                                                                                    |
| Code block                   | Fenced code block                              | Markdown endpoint                   | Expected full             | Language normalization needs coverage.                                                                     |
| Inline rich text             | Markdown inline syntax                         | Markdown endpoint                   | Mostly full               | Colors and mentions may require enhanced tags.                                                             |
| Inline equation              | `$...$`                                        | Markdown endpoint/comments          | Full expected             | Comments support inline equations too.                                                                     |
| Block equation               | Enhanced Markdown math block                   | Markdown endpoint                   | Expected full             | Needs E2E confirmation.                                                                                    |
| Callout                      | `<callout icon="...">...</callout>`            | Markdown endpoint                   | Partial                   | Experiment: `color="blue_background"` was not preserved in pull output. Need confirm accepted color names. |
| Toggle                       | `<details><summary>...</summary>...</details>` | Markdown endpoint                   | Full for simple toggle    | Experiment confirmed simple toggle round-trip.                                                             |
| Table                        | `<table>...</table>`                           | Markdown endpoint                   | Full for simple table     | Experiment: GitHub table input pulled back as enhanced HTML-like table.                                    |
| Columns                      | Enhanced `<columns>/<column>` tags             | Markdown endpoint                   | Expected full             | Needs E2E confirmation.                                                                                    |
| Image                        | Markdown image or enhanced media tag           | Markdown endpoint + file upload     | Partial                   | Local file upload mapping requires manifest.                                                               |
| Video/audio/file/pdf         | Enhanced media tags                            | Markdown endpoint + file upload     | Partial                   | Need explicit file-upload lifecycle.                                                                       |
| Bookmark                     | `<unknown ... alt="bookmark"/>` on pull        | Block API fallback                  | Not lossless via Markdown | Experiment confirmed bookmark returns unknown and `unknown_block_ids`.                                     |
| Embed                        | `<unknown ... alt="embed"/>` likely            | Block API fallback                  | Not lossless via Markdown | Official docs list unsupported.                                                                            |
| Link preview                 | `<unknown ... alt="link_preview"/>` likely     | Block API fallback                  | Not lossless via Markdown | Official docs list unsupported.                                                                            |
| Breadcrumb                   | Unknown/unsupported                            | Block API fallback                  | Not lossless via Markdown | Must preserve via sidecar or exclude.                                                                      |
| Synced block                 | Enhanced synced-block syntax or block API      | Markdown endpoint/block fallback    | Needs E2E                 | Must avoid corrupting source synced content.                                                               |
| Child page                   | `<page url="...">` preservation tag            | Markdown endpoint + page API        | Partial                   | Deletion is guarded unless `allow_deleting_content` is true.                                               |
| Child database/data source   | `<database url="...">` preservation tag        | Markdown endpoint + data-source API | Partial                   | Body Markdown is not enough for schema/views.                                                              |
| Database row/page properties | Frontmatter property map                       | `pages.update`                      | Full if typed             | Requires schema-aware encoding from data source.                                                           |
| Data-source schema           | Separate schema file or manifest               | `data_sources.*`                    | Full if typed             | Not part of page body Markdown.                                                                            |
| Views/templates              | Separate manifest                              | views/templates endpoints           | Partial                   | Requires separate sync surface.                                                                            |
| Comments                     | Roughdraft local spans or Notion comments      | comments API                        | Separate from body        | Notion comment API needs comment capabilities; comments support inline Markdown only.                      |
| Suggestions                  | Roughdraft substitution/insertion/deletion     | Local review layer                  | Full local                | Not a native Notion body feature.                                                                          |
| Unknown blocks               | `<unknown>` plus sidecar block snapshot        | Block API fallback                  | Detectable                | Must not drop on push.                                                                                     |
| Meeting note transcript      | `include_transcript` option                    | Markdown endpoint                   | Configurable              | Default pull excludes full transcript.                                                                     |

## E2E Findings

The requested experiment page is accessible when the provided token is passed to `ntn` as `NOTION_API_TOKEN`. Earlier `object_not_found` results were caused by using `NOTION_TOKEN`, which this `ntn` binary ignores in favor of its keychain/default token.

Findings:

- Workspace-level private page creation is blocked for internal integrations; experiments need a shared parent page. The requested experiment page works as that parent with the correct token.
- Initial Markdown creation normalized the body on pull:
  - page title was excluded from body Markdown,
  - simple callout round-tripped but color was not emitted on pull,
  - GitHub table syntax pulled back as enhanced `<table>` tags,
  - simple toggle pulled back as `<details>/<summary>`.
- `update_content` gives useful non-LWW behavior:
  - stale old text returns `validation_error`,
  - ambiguous old text returns `validation_error`,
  - `replace_all_matches` explicitly opts into broad replacement.
- `replace_content` is last-writer-wins and overwrote a simulated remote edit.
- Unsupported bookmark blocks pull as `<unknown>` with `unknown_block_ids`; fetching that block ID through the Markdown endpoint still returned unknown, so block API fallback is mandatory.
- Replacing content that would delete child pages is blocked unless `allow_deleting_content` is true.
- Comment create/list works with the provided token, including Markdown comments with inline bold formatting. Roughdraft-to-Notion-comment bridging is feasible at page-comment level; precise anchoring still needs design.
- Sending frontmatter to Notion preserves it as literal body Markdown. Therefore frontmatter must be stripped before push.
- Stripped-frontmatter push/pull produced clean stock enhanced Markdown body output.

## Open Questions

- What exact enhanced Markdown syntax preserves callout and block colors across push/pull?
- How should local Roughdraft comments map to Notion comments when the anchor is a text span rather than a block?
- Should `.nmd` files include review spans in the body, or should review mode maintain a sibling `.roughdraft.md` layer?
- How aggressively should the CLI generate `update_content` edits versus falling back to a three-way merge conflict?
- Which sidecar escalation policy should be user-configurable versus fixed by the strict storage classifier?
- How should file uploads be garbage-collected when local file references are removed?

## Proposed CLI

```bash
notion-md pull <page-url-or-id> --out doc.nmd
notion-md status doc.nmd
notion-md diff doc.nmd
notion-md push doc.nmd
notion-md push doc.nmd --force
notion-md comments pull doc.nmd
notion-md comments push doc.nmd
notion-md doctor <page-url-or-id>
```

Default `push` is guarded. `--force` is required for whole-page last-writer-wins replacement when remote content changed since the last pull.
