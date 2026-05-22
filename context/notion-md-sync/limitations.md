# Notion Markdown Sync Limitations

Status: WIP research note.

This document tracks inherent Notion and Notion enhanced Markdown limitations that affect a principled two-way Notion <> Markdown sync tool, plus possible mitigations.

## Body Markdown Is Not A Complete Notion Document

Notion enhanced Markdown serializes page content, but a Notion page is more than body blocks.

Missing from body Markdown:

- Page title
- Page icon
- Page cover
- Page properties
- Lock/trash state
- Data-source schema
- Views and templates
- Comments
- Some file/upload metadata

Potential resolution:

- Treat page body Markdown as one sync surface.
- Store page metadata in frontmatter or a sidecar manifest.
- Sync data-source schema, views, and templates through separate typed API paths.
- Make the CLI explicit about which surfaces it is syncing: `body`, `properties`, `comments`, `schema`, `files`.

## Frontmatter Is Local, Not Notion-Native

Frontmatter is a good local mechanism for gaps in Notion enhanced Markdown, but Notion does not interpret it as metadata. If YAML-like frontmatter is sent through the Markdown endpoint, Notion preserves it as literal page body content.

Potential resolution:

- Embrace frontmatter as the `.nmd` local wrapper.
- Strip frontmatter before every body push to Notion.
- Recreate/update frontmatter after every pull.
- Compute body hashes over the stripped canonical body.
- Keep the spec explicit about which fields are stock Notion enhanced Markdown and which fields are local `.nmd` extensions.
- Validate the wrapper with a strict Effect schema. Reject excess keys unless a new versioned extension has been modeled.
- For plain `.md` mode, either omit frontmatter or keep metadata in a sidecar manifest.

Self-contained frontmatter has real limits. A naive raw snapshot can quickly become noisy and can include volatile signed Notion file URLs. File bytes are even worse: tiny fixtures look acceptable, but real attachments make the Markdown file hard to review and easy to leak. Keep compact typed units in frontmatter; escalate raw snapshots, bytes, and volatile retrieval URLs to a sidecar or content-addressed cache.

## Unsupported Blocks Become Unknown

Some Notion blocks are not represented losslessly by enhanced Markdown. In experiments, a bookmark block pulled back as:

```markdown
<unknown url="..." alt="bookmark"/>
```

The response also included `unknown_block_ids`, and fetching the bookmark block ID through the Markdown endpoint still returned an unknown block.

Likely affected block types include bookmarks, embeds, link previews, breadcrumbs, and deprecated template blocks.

Potential resolution:

- Use the block API as a mandatory fallback for unknown blocks.
- Preserve compact unsupported block units in frontmatter when small.
- Preserve raw or bulky unsupported block snapshots in a sidecar manifest keyed by block id.
- Refuse pushes that would drop unknown blocks unless the user passes an explicit delete/force flag.
- Render unknown blocks in local Markdown as stable placeholders that are easy to inspect.

## Whole-Page Replace Is Last-Writer-Wins

`replace_content` replaces the entire body. If remote content changed since the last pull, a blind replace overwrites it.

Potential resolution:

- Default push must be guarded by remote hash and `last_edited_time`.
- If remote changed, compute a three-way merge over `base`, `local`, and `remote`.
- Reserve `replace_content` for unchanged remote bases or explicit `--force`.
- Surface unresolved conflicts in the local file using Roughdraft suggestions/comments.

## Targeted Updates Are String-Match Based

`update_content` is safer than whole-page replacement because it fails when `old_str` is missing or ambiguous. But it is still based on exact string matching after Notion's Markdown normalization.

Limitations:

- Duplicated text can make updates ambiguous.
- Notion may normalize tables, whitespace, or tags between pull and push.
- Formatting-only edits can change strings enough to make anchors fail.
- Large generated updates may exceed API limits.

Potential resolution:

- Canonicalize Markdown before computing patches.
- Prefer small, unique hunks for `update_content`.
- Include enough surrounding context in `old_str` to avoid accidental matches.
- Fall back to a human-visible conflict when a hunk is missing, duplicated, or overlaps a remote edit.
- Consider block-level fallback for high-value edits where text anchors are too weak.

## Notion Normalizes Markdown

Notion may rewrite valid input Markdown when it is pulled back. In experiments:

- A GitHub-style table pulled back as enhanced `<table>` markup.
- The page title did not appear in pulled body Markdown.
- A simple callout round-tripped, but its color was not emitted on pull.

Potential resolution:

- Never diff raw local input against raw pulled output without normalization.
- Maintain a canonical formatting pass for local `.nmd` files.
- Run a feature matrix test before claiming support for a Notion construct.
- Document expected churn for constructs Notion rewrites.

## Comments Are Separate From Body Markdown

Notion comments are not part of `GET /markdown`. Comment API Markdown supports inline formatting, links, mentions, and inline equations, but not structured block-level Markdown.

Potential resolution:

- Use Roughdraft Flavored Markdown as the local durable review format.
- Treat Notion comments as a separate sync surface.
- Bridge Roughdraft comments to Notion comments only when anchors can be resolved clearly.
- If comment API permissions are unavailable, keep review data local and report that limitation.

## No Native Suggestion Semantics

Notion has comments, but it does not expose a Google Docs/GitHub-style suggestion model through enhanced Markdown.

Potential resolution:

- Use Roughdraft insertions, deletions, and substitutions for local suggestions.
- Require explicit modes for pushing unresolved suggestions:
  - reject push,
  - apply suggestions,
  - render suggestions visibly,
  - strip suggestions.
- Keep suggested edits inspectable in Markdown until accepted or rejected.

## Child Pages And Databases Are Protected But Out-Of-Band

Replacing page content that would delete child pages or databases fails unless `allow_deleting_content` is true. This is useful safety behavior, but child page/database content and schema are not captured by simple body Markdown.

Potential resolution:

- Preserve child pages/databases with Notion's `<page>` and `<database>` tags where possible.
- Represent child page/database ownership in the manifest.
- Require explicit confirmation before deleting or archiving child pages/databases.
- Sync child pages recursively only under an explicit include policy.

## Data Sources Are A Separate Model

Data-source schemas, row properties, views, and templates live outside page body Markdown. Treating a database row as "just Markdown" loses important typed data.

Potential resolution:

- Keep page body and row properties separate.
- Encode row properties in frontmatter using data-source schema-aware types.
- Generate typed schemas from data sources using existing `@overeng/notion-cli` patterns.
- Avoid syncing formulas, rollups, created/edited fields as writable state.

## Files Need A Lifecycle

Enhanced Markdown can reference media, but local files, Notion uploads, expiring Notion-hosted URLs, and removed attachments need lifecycle management.

Potential resolution:

- Store local path -> upload id -> Notion file reference mappings in a manifest.
- Keep compact file lifecycle units in strict frontmatter when they fit the storage budget.
- Upload local files before body push.
- Avoid treating expiring Notion file URLs as stable local source.
- Define garbage collection separately; do not delete remote files just because a local reference disappeared unless explicitly requested.

## Large Pages Can Be Truncated

`GET /markdown` can return `truncated: true` and up to 100 `unknown_block_ids`. The same field is also used for inaccessible or unsupported blocks, so the reason is not always obvious.

Potential resolution:

- Treat `truncated: true` as a non-clean pull.
- Attempt to retrieve every `unknown_block_id`.
- Distinguish unsupported, inaccessible, and too-large cases where possible by also querying the block API.
- Refuse destructive pushes while unresolved unknowns remain.

## Permissions Shape Behavior

The same operation can fail because the integration lacks page access, content capabilities, insert-comment capabilities, or access to nested child content. The Markdown response may show unknowns for permission-limited children.

One operational gotcha: the official `ntn` CLI reads `NOTION_API_TOKEN`, while the repo's Notion libraries/tests read `NOTION_TOKEN`. Supplying only `NOTION_TOKEN` can make `ntn` silently use its configured keychain/default token instead.

Potential resolution:

- Provide `notion-md doctor <page>` to check page access, read content, update content, comments, and child access.
- Keep failures actionable: tell the user which Notion connection/capability appears missing.
- Never silently interpret permission unknowns as deletable empty content.
- Declare both `NOTION_TOKEN` and `NOTION_API_TOKEN` in SecretSpec when the CLI and libraries are used together.

## Synced Blocks Are Dangerous

Synced blocks have source/copy semantics. A local sync tool can accidentally mutate or delete content that is shared elsewhere.

Potential resolution:

- Treat synced blocks as read-only by default.
- Require explicit opt-in to edit synced block sources.
- Preserve synced block identifiers in the manifest.
- Use block API fallback rather than relying only on Markdown.

## Webhooks Are Notifications, Not Merge Semantics

Notion webhooks can tell a tool that a page or data-source changed, but they do not solve conflict resolution or provide a full operation log.

Potential resolution:

- Use webhooks to trigger pull/status refresh.
- Still compute conflicts from current remote Markdown/properties and the local base.
- Do not assume webhook order or delivery replaces local conflict checks.
