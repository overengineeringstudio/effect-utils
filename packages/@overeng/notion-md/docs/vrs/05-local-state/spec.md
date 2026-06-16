# Spec: 05-local-state

Specifies the durable local state layer: the strict versioned `.nmd` envelope,
the page-id-keyed sync sidecar, the frontmatter schema shape, and the
content-addressed `.notion-md/` object store. Builds on
[../requirements.md](../requirements.md) + [./requirements.md](./requirements.md);
terms in [../glossary.md](../glossary.md); rationale in
[../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the architecture
index.

Traces: R06, R07, R08, R10. The writable projection carried in the envelope
(properties, page metadata, `schema_snapshot`) is owned by
[06-data-source](../06-data-source/spec.md); the base snapshots stored here are
consumed by [03-sync-engine](../03-sync-engine/spec.md) (R09); hosted-media URL
canonicalization that keeps stored URLs stable is owned by
[04-fidelity](../04-fidelity/spec.md) (R36).

## Local Format

```
doc.nmd
  frontmatter: strict local sync envelope
  body: stock Notion enhanced Markdown

.notion-md/
  objects/sha256/<2>/<62>.json
  sync/<page-id>.json
```

### `.nmd` Envelope

The `.nmd` file is a versioned local wrapper around a Notion enhanced Markdown body.
Version 2 keeps human-editable state in the file and moves derived sync
bookkeeping into a page-id keyed sidecar:

```markdown
---
{
  'notion_md':
    {
      'version': 2,
      'api_version': '2026-03-11',
      'object': 'page',
      'page_id': '00000000-0000-4000-8000-000000000001',
      'parent': { '_tag': 'page', 'id': '00000000-0000-4000-8000-000000000000' },
      'page':
        {
          'title': 'Page title',
          'icon': null,
          'cover': null,
          'in_trash': false,
          'is_locked': false,
        },
      'properties': {},
    },
}
---

Enhanced Markdown body starts here.
```

Rules:

| Rule                | Specification                                                                          |
| ------------------- | -------------------------------------------------------------------------------------- |
| Body boundary       | Only bytes after frontmatter are sent to Notion Markdown endpoints.                    |
| Strict schema       | Unknown frontmatter keys are errors.                                                   |
| Body hash           | Hash canonical stripped body bytes, never frontmatter.                                 |
| API version         | `api_version` records the Notion API version used for the last clean pull.             |
| Local version       | `notion_md.version` is the local human-editable envelope version.                      |
| Sync sidecar        | Derived state lives in `.notion-md/sync/{page_id}.json`, keyed by immutable page id.   |
| Visible frontmatter | A page whose visible body starts with `---` must escape or precede that text.          |
| Review markup       | Roughdraft markers are local review state unless an explicit push mode says otherwise. |

Local experiments confirmed that frontmatter sent through the Markdown endpoint becomes literal body content. Push must strip it.

### Frontmatter Schema

The Effect Schema in `@overeng/notion-effect-client` is the source of truth. The
current local shape is split between human-editable V2 frontmatter and
machine-managed V1 sync state:

```ts
type NmdFrontmatterV2 = {
  readonly notion_md: {
    readonly version: 2
    readonly api_version: '2026-03-11'
    readonly object: 'page'
    readonly page_id: NotionId
    readonly url?: string
    readonly parent: ParentRef
    readonly page: PageState
    readonly properties: Record<string, WritablePropertyValue>
  }
}

type NmdSyncStateV1 = {
  readonly version: 1
  readonly page_id: NotionId
  readonly body: BodyState
  readonly storage: SelfContainedStorage | ObjectStoreStorage
  readonly read_only_properties: Record<string, ReadOnlyPropertyValue>
  readonly data_source: DataSourceBinding | null
}
```

Schemas use tagged unions for polymorphic values, branded strings for Notion IDs
and hashes, and exact decoding with excess-property rejection. The
`WritablePropertyValue` / `PageState` / `DataSourceBinding` shapes carried here
are specified by [06-data-source](../06-data-source/spec.md).

## Object Store

Requirement trace: R07-R10, R16.

Objects are immutable JSON payloads addressed by exact stored bytes:

```
.notion-md/objects/sha256/ab/cdef....json
```

| Role              | Payload                       | Required validation                                     |
| ----------------- | ----------------------------- | ------------------------------------------------------- |
| `base_snapshot`   | last clean body snapshot      | page id, body hash, object hash, schema version         |
| `storage_payload` | overflow storage payload      | page id, inventory equality with frontmatter, hash      |
| `file_payload`    | future file bytes or metadata | content hash, media type, local path or upload identity |
| `comment_payload` | future comment bridge state   | comment IDs, discussion IDs, anchor metadata            |
| `schema_snapshot` | data-source schema state      | schema hash, property IDs, data-source id               |

The `base_snapshot` role is the engine's optimistic-concurrency token
([03-sync-engine](../03-sync-engine/spec.md), R09); the `schema_snapshot` role
backs the schema-drift refusal ([06-data-source](../06-data-source/spec.md), R14).

Write order is object first, `.nmd` last. A failed `.nmd` write may leave orphan objects; a future `store gc` removes unreachable objects. Object paths in frontmatter are logical POSIX-style paths; the state store normalizes both expected and stored paths through the platform `Path` service before reading.

Storage policy:

| Case                                        | Storage form                             |
| ------------------------------------------- | ---------------------------------------- |
| Small stable unsupported/file/comment units | inline `storage._tag = "self_contained"` |
| Large storage payload                       | `storage._tag = "object_store"`          |
| Volatile signed Notion URLs                 | `object_store`                           |
| File bytes                                  | future content-addressed file payload    |
| Raw unsanitized API snapshots               | object store only                        |

The implementation currently supports self-contained storage and content-addressed `storage_payload` objects. It rejects legacy sidecar-shaped frontmatter instead of migrating it.
