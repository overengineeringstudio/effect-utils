# Notion Markdown Sync Sidecars And Files

Status: WIP research note.

This note covers unsupported block and file/media preservation for a Notion <> Markdown sync tool that uses Notion enhanced Markdown as the primary body format.

## E2E Findings

Experiments were run on May 22, 2026 against temporary child pages under the shared research parent page. The temporary pages were moved to trash afterward with `PATCH /v1/pages/{page_id}` and `in_trash: true`.

Artifacts are under `tmp/notion-md-sidecar-files/`.

### Unsupported Blocks

The block API can create bookmark and embed blocks as page children. Markdown pull does not serialize them losslessly:

```markdown
<unknown url="https://www.notion.so/...#..." alt="bookmark"/>
<unknown url="https://www.notion.so/...#..." alt="embed"/>
```

The page Markdown response had `truncated: true` and `unknown_block_ids` containing the bookmark and embed block IDs. Fetching each block ID through the Markdown endpoint still returned an `<unknown>` placeholder for that block. Fetching through the block API returned the typed payload with `type`, URL, caption rich text, timestamps, parent, and trash state.

`link_preview` was not feasible to create through `PATCH /v1/blocks/{block_id}/children` in this experiment. The API rejected the block because `link_preview` is not one of the accepted append-child request variants. A sync tool should still be prepared to see link-preview-like unsupported blocks on pull from pages authored in Notion UI, but it should not assume it can recreate them through the public append API.

### Files And Media

The workspace rejected the CLI's default multipart file upload path with:

```text
This workspace is on a free plan and does not support multipart uploads. Use `mode=single_part` to upload files up to 5 MB.
```

Single-part upload through the file upload API worked:

1. `POST /v1/file_uploads` with `mode: "single_part"`, `filename`, and `content_type`.
2. `POST /v1/file_uploads/{file_upload_id}/send` as multipart form data with the file bytes.
3. Use the uploaded `file_upload.id` in an image or file block.

Block API retrieval for file/image blocks returns Notion-hosted file URLs with `expiry_time`. Markdown pull behaves differently by media type:

- File block pulls as an enhanced `<file>` tag whose `src` is a Notion-local `file://` attachment reference encoded into the URL.
- Image block pulls as normal Markdown image syntax with a signed S3 URL that expires.

The signed URL and the block API `file.url` are retrieval URLs, not stable local source identifiers. The durable references are the block ID, file upload ID at creation time, filename, content type, content length, caption, and local content hash/path.

## Design Requirements

- Never drop unknown blocks during a normal push.
- Make unsupported blocks visible in Markdown without asking users to edit raw JSON in the body.
- Keep block API snapshots out of the Markdown body so the body remains stock Notion enhanced Markdown.
- Treat file bytes, file-upload objects, media blocks, and Markdown references as one lifecycle with explicit state transitions.
- Avoid using expiring Notion file URLs as stable local identifiers.
- Keep destructive operations explicit: deleting unknown blocks, removing attachments, or replacing media should require an intentional push mode.

## Storage Options

### Option 1: Frontmatter Only

Store unsupported block snapshots and file mappings in `.nmd` frontmatter next to page metadata.

Pros:

- Single file per page.
- Easy to inspect in text editors.
- Works for small pages with a few unknown blocks.

Cons:

- Frontmatter can become very large and noisy.
- Binary/file metadata and raw block snapshots do not belong in the editable document header.
- Merge conflicts in YAML can be harder to review than separate JSON files.
- Plain `.md` mode needs another place for metadata anyway.

Updated conclusion: this is the best default for compact, typed, stable units. It is not acceptable for raw file bytes, expiring Notion URLs, unsanitized full API snapshots, or attachment manifests that are large enough to make the Markdown file hard to review.

Use a strict tagged schema:

```yaml
storage:
  _tag: self_contained
  unsupported_blocks: []
  files: []
  comments: []
```

The implementation should classify the serialized storage payload before write:

- `small`: keep self-contained.
- `large`: keep only if the project or command explicitly allows large frontmatter.
- `too_large`: rewrite to sidecar form.

### Option 2: One JSON Manifest Per Page

Store a sibling manifest, for example:

```text
page.nmd
page.notion.json
```

The Markdown frontmatter keeps only stable pointers:

```yaml
notion_md:
  storage:
    _tag: sidecar
    path: 'page.notion.json'
    unsupported_block_ids:
      - '...'
    file_ids: []
    comment_ids: []
```

The manifest stores unsupported blocks, media mappings, and sync hashes.

Pros:

- Keeps the Markdown body readable.
- Works for both `.nmd` and plain `.md` body modes.
- Easier to evolve with a typed schema and migrations.
- Good fit for block API snapshots and file state.

Cons:

- Users can accidentally move or edit the Markdown file without the manifest.
- Rename/move handling needs stable relative paths and a doctor command.
- JSON is inspectable but not pleasant for manual conflict resolution.

This is the right escalation shape once compact self-contained frontmatter is too large or too volatile.

### Option 3: Directory Bundle

Store each page as a directory bundle:

```text
page/
  body.nmd
  manifest.json
  blocks/
    <block-id>.json
  files/
    <sha256>-notion-md-sidecar.png
```

Pros:

- Scales to large pages and many files.
- Block snapshots and file bytes are naturally separated.
- Content-addressed files avoid duplicate attachment copies.

Cons:

- More filesystem structure for simple pages.
- Less convenient for users who expect one Markdown file per page.
- Requires robust import/export or archive support.

This is likely the right internal cache layout, but too heavy as the only user-facing format.

### Option 4: Global Cache Plus Small Per-Page Manifest

Store user-facing page files and small manifests together, while putting large immutable artifacts in a workspace cache:

```text
docs/page.nmd
docs/page.notion.json
.notion-md/
  files/sha256/<hash>
  blocks/<block-id>.json
```

Pros:

- Keeps page directories tidy.
- De-duplicates files across pages.
- Lets manifests reference content by hash.
- Supports garbage collection as a separate operation.

Cons:

- Requires cache lifecycle rules.
- A page is no longer fully portable unless exported with its cache entries.
- Needs careful public/private leak handling if the cache is inside a repo.

This is a good long-term shape once the core manifest contract is stable.

## Recommended Policy

Start self-contained, then escalate:

1. Keep page identity, body hash, typed properties, and compact `storage` units in frontmatter.
2. Reject unsanitized raw snapshots in frontmatter.
3. Reject file bytes in frontmatter except deliberately tiny test fixtures.
4. Warn when `storage` exceeds 8 KiB.
5. Require sidecar when `storage` exceeds 64 KiB or contains volatile retrieval URLs.
6. Use a content-addressed cache for durable file bytes.

This keeps the common case fully portable as one `.nmd` file while preserving a principled escape hatch for pages where self-contained metadata becomes counterproductive.

## Recommended Manifest Shape

Use a small frontmatter pointer plus a per-page JSON manifest when sidecar escalation is required. Keep large file bytes in a content-addressed cache later.

Sketch:

```json
{
  "schema_version": 1,
  "page": {
    "id": "<page-id>",
    "last_pulled_time": "2026-05-22T14:51:03.000Z",
    "remote_last_edited_time": "2026-05-22T14:51:00.000Z",
    "body_hash": "sha256:..."
  },
  "unknown_blocks": {
    "<bookmark-block-id>": {
      "type": "bookmark",
      "placeholder": "<unknown ... alt=\"bookmark\"/>",
      "block": {}
    }
  },
  "files": {
    "<file-block-id>": {
      "block_id": "<file-block-id>",
      "kind": "file",
      "filename": "notion-md-sidecar.txt",
      "content_type": "text/plain",
      "content_length": 36,
      "caption_plain_text": "temporary text file",
      "local_path": "attachments/notion-md-sidecar.txt",
      "content_hash": "sha256:...",
      "notion": {
        "file_upload_id": "<file-upload-id>",
        "last_seen_expiry_time": "2026-05-22T15:51:03.272Z"
      }
    }
  }
}
```

The `block` field should contain the sanitized block API response for unsupported blocks. It should not include expiring signed file URLs unless the tool explicitly marks them as volatile cache data.

## Push Policy

Default push should be conservative:

- If Markdown still contains an unknown placeholder and the manifest has a matching block snapshot, preserve the remote block.
- If a user deletes an unknown placeholder, report that this would delete an unsupported block and require an explicit delete mode.
- If a user edits an unknown placeholder, treat it as an unresolved conflict unless the edit maps to a known typed operation.
- If the manifest is missing for a page with unknown placeholders, refuse destructive push and ask for a fresh pull.
- For files, upload changed local bytes before updating Markdown/body blocks.
- Do not garbage-collect remote files or file blocks just because a local path disappeared; require explicit delete mode.

## Long-Term Approach

Use Notion enhanced Markdown as the editable body, typed frontmatter as the default durability layer for compact local metadata, and a typed sidecar manifest for everything too large or volatile for frontmatter.

The first implementation should support:

- Frontmatter fields for page ID, body hash, typed properties, and a strict `storage` tagged union.
- Self-contained storage for compact unsupported block, file, and comment units.
- Per-page JSON manifest with unsupported block snapshots and media mappings when escalation is required.
- Pull that writes unknown placeholders in the body and snapshots in the manifest.
- Push that refuses to drop unknown blocks or media unless explicitly requested.
- Single-part file upload for small local attachments, with multipart support added later only when needed.

After that contract is stable, add a `.notion-md/` content-addressed cache for file bytes and raw snapshots. The cache should be exportable so a page can be moved between repos or machines without depending on expiring Notion URLs.
