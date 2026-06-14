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
    "version": 2,
    "api_version": "2026-03-11",
    "object": "page",
    "source": "remote",
    "page_id": "00000000-0000-4000-8000-000000000001",
    "parent": { "_tag": "page", "id": "00000000-0000-4000-8000-000000000000" },
    "page": {
      "title": "Page title",
      "icon": null,
      "cover": null,
      "in_trash": false,
      "is_locked": false
    },
    "properties": {}
  }
}
```

Machine-managed sync state lives outside the Markdown file at
`.notion-md/sync/<page_id>.json` for pages that need it:

```json
{
  "version": 1,
  "page_id": "00000000-0000-4000-8000-000000000001",
  "body": {
    "format": "notion-enhanced-markdown",
    "hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "base": null,
    "last_pulled_at": "2026-05-22T14:50:00.000Z",
    "remote_last_edited_time": "2026-05-22T14:49:59.000Z",
    "truncated": false,
    "unknown_block_ids": []
  },
  "storage": {
    "_tag": "self_contained",
    "unsupported_blocks": [],
    "files": [],
    "comments": []
  },
  "read_only_properties": {},
  "data_source": null
}
```

The Effect Schema in `@overeng/notion-effect-client/src/nmd.ts` is the source of
truth for both shapes.

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

## Property Descriptors

Datasource page files may carry an optional `property_descriptors` map inside
`notion_md`. Each entry is keyed by the visible property name and carries
compact, non-authoritative identity hints:

```json
{
  "notion_md": {
    "property_descriptors": {
      "Status": {
        "property_id": "prop_status_abc",
        "property_name": "Status",
        "property_type": "select",
        "data_source_id": "00000000-0000-4000-8000-000000000010",
        "config_hash": "sha256:<hex64>"
      }
    }
  }
}
```

Descriptors prove only which Notion property a field claims to edit. They do not
prove that the write is safe, that the schema is current, or that property-level
convergence holds. Current schema freshness, outbox state, and settlement
evidence remain live or hidden workspace proof (R10).

Descriptors are decoded strictly: unknown fields inside a descriptor are rejected
so a descriptor with extra proof-shaped keys fails closed (R13). A file without
`property_descriptors` decodes identically — the field is always optional.

`notion-md` CLI operations do not require descriptors and do not emit them for
standalone non-datasource pages. Datasource-sync layers emit descriptors from
live schema evidence; the CLI treats them as read-only identity hints when
present.

## Object Store

`.notion-md/objects/sha256/...` stores immutable JSON payloads referenced from
frontmatter or sync state:

- `base_snapshot`: last clean body used for merge and conflict evidence.
- `storage_payload`: overflow unsupported-block, file, or comment metadata.
- `file_payload`: file byte or upload metadata.
- `comment_payload`: comment bridge metadata.

Object refs include role, hash, logical path, media type, and byte length. Reads
verify exact bytes and reject path traversal, stale hashes, role mismatches, and
inventory mismatches.

The object store is part of the sync state. It is content-addressed, but it is
not optional once referenced by frontmatter.
