# File Format

`.nmd` is a local wrapper around stock Notion enhanced Markdown.

```text
---
strict JSON frontmatter validated with Effect Schema
---

stock Notion enhanced Markdown body
```

Only the body is sent to Notion Markdown endpoints. The frontmatter is local sync
state and is stripped before push.

## Frontmatter

The frontmatter is JSON between Markdown `---` markers. It is intentionally not
loose YAML:

- unknown keys are schema errors,
- polymorphic values use `_tag`,
- Notion IDs, hashes, object refs, and dates are validated,
- generated or unsupported state is explicit rather than hidden.

Conceptual shape:

```json
{
  "notion_md": {
    "version": 1,
    "api_version": "2026-03-11",
    "object": "page",
    "page_id": "00000000-0000-4000-8000-000000000001",
    "parent": { "_tag": "page", "id": "00000000-0000-4000-8000-000000000000" },
    "body": {
      "format": "notion-enhanced-markdown",
      "hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "base": {
        "_tag": "object_ref",
        "role": "base_snapshot",
        "hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "path": ".notion-md/objects/sha256/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json",
        "media_type": "application/json",
        "byte_length": 512
      },
      "last_pulled_at": "2026-05-22T14:50:00.000Z",
      "remote_last_edited_time": "2026-05-22T14:49:59.000Z",
      "truncated": false,
      "unknown_block_ids": []
    },
    "page": {
      "title": "Page title",
      "icon": null,
      "cover": null,
      "in_trash": false,
      "is_locked": false
    },
    "data_source": null,
    "properties": {},
    "storage": {
      "_tag": "self_contained",
      "unsupported_blocks": [],
      "files": [],
      "comments": []
    }
  }
}
```

The Effect Schema in `@overeng/notion-effect-client/src/nmd.ts` is the source of
truth for this shape.

## Body

The body is stock Notion enhanced Markdown as returned by Notion's Markdown
endpoint. `notion-md` does not invent a body-level dialect for sync metadata.

Notion may normalize Markdown on pull. A clean round trip means semantic
equivalence through Notion's Markdown endpoint, not byte-for-byte preservation of
local formatting.

## Writable Page Metadata

The `notion_md.page` object models page state that Notion does not expose in the
Markdown body.

| Field       | Local form                                | Push behavior                           |
| ----------- | ----------------------------------------- | --------------------------------------- |
| `title`     | string                                    | pushed via the page properties endpoint |
| `icon`      | `null`, emoji, native icon, external file | pushed with `PATCH /pages/{id}`         |
| `cover`     | `null`, external or Notion-hosted file    | external/null pushed; hosted read-only  |
| `in_trash`  | boolean                                   | pushed with `PATCH /pages/{id}`         |
| `is_locked` | boolean                                   | pushed with `PATCH /pages/{id}`         |

Notion-hosted files and custom emojis are strict schema-valid because they can
appear on pull, but they are not blindly written back as local edits until the
write API surface is proven for those shapes.

## Writable Properties

Modeled writable page properties can be edited in frontmatter:

| `_tag`         | `value` shape                      |
| -------------- | ---------------------------------- |
| `title`        | string                             |
| `rich_text`    | string or null                     |
| `number`       | number or null                     |
| `select`       | option name or null                |
| `multi_select` | array of option names              |
| `status`       | option name or null                |
| `date`         | `{ start, end, time_zone }` null   |
| `people`       | array of Notion user IDs           |
| `files`        | array of tagged file refs          |
| `checkbox`     | boolean                            |
| `url`          | string or null                     |
| `email`        | string or null                     |
| `phone_number` | string or null                     |
| `relation`     | array of Notion page IDs           |
| `place`        | `{ lat, lon, name, address, ... }` |
| `verification` | state `verified` or `unverified`   |
| `read_only`    | preserved, not pushed              |

Generated Notion properties remain visible as `read_only` values and are not
pushed.

## Object Store

`.notion-md/objects/sha256/...` stores immutable JSON payloads referenced from
frontmatter:

- `base_snapshot`: last clean body used for merge and conflict evidence.
- `storage_payload`: overflow unsupported-block, file, or comment metadata.
- `file_payload`: future file byte or upload metadata.
- `comment_payload`: future comment bridge metadata.

Object refs include role, hash, logical path, media type, and byte length. Reads
verify exact bytes and reject path traversal, stale hashes, role mismatches, and
inventory mismatches.

The object store is part of the sync state. It is content-addressed, but it is
not optional once referenced by frontmatter.
