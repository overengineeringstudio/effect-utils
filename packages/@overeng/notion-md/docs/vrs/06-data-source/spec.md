# Spec: 06-data-source

Specifies the typed property / page-metadata surface and its data-source binding:
the writable property-value forms, writable page metadata, the `data_source`
binding, and the `schema_snapshot`-based schema-drift refusal that guards a
property write. Builds on [../requirements.md](../requirements.md) +
[./requirements.md](./requirements.md); terms in [../glossary.md](../glossary.md);
rationale in [../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the
architecture index.

Traces: R04, R14. These values are projected into the `.nmd` envelope stored by
[05-local-state](../05-local-state/spec.md); the drift refusal is exercised by the
engine ([03-sync-engine](../03-sync-engine/spec.md)) before a property write and
reached interactively through `edit --frontmatter` ([01-editor](../01-editor/spec.md)).
Full data-source schema/view sync is owned by the standalone
[Notion datasource sync spec](../../../../notion-datasource-sync/docs/vrs/spec.md).

## Writable Property Values

Property frontmatter is human-editable only for modeled writable forms. Unknown or generated properties remain visible as read-only values.

| Notion property type | Local form                 | Push encoding                 |
| -------------------- | -------------------------- | ----------------------------- |
| `title`              | string                     | rich-text title from string   |
| `rich_text`          | string or null             | rich text from string         |
| `number`             | number or null             | number                        |
| `select`             | option name or null        | select by name                |
| `multi_select`       | option names               | multi-select by names         |
| `status`             | option name or null        | status by name                |
| `date`               | Notion date object or null | date object                   |
| `people`             | user IDs                   | people IDs                    |
| `checkbox`           | boolean                    | checkbox                      |
| `url`                | string or null             | url                           |
| `email`              | string or null             | email                         |
| `phone_number`       | string or null             | phone number                  |
| `relation`           | page IDs                   | relation IDs                  |
| `files`              | file refs                  | future file-upload resolution |
| `place`              | place object or null       | place object                  |
| `verification`       | verification state object  | verification object           |
| generated properties | read-only wrapper          | not pushed                    |

Property IDs must be preserved when available. Display names are for readability; IDs win on rename or schema drift.

The writable vs read-only/computed split is `propertyWriteClassFromType` /
`PROPERTY_WRITE_CLASSES` (`@overeng/notion-core`), the single source of truth, the
same predicate the editor's `--frontmatter` projection uses
([01-editor](../01-editor/spec.md#guard-plumbing)).

## Writable Page Metadata

The page metadata surface covers page state that is not part of the Markdown
body and is not a data-source property.

| Field       | Local form                              | Push encoding       |
| ----------- | --------------------------------------- | ------------------- |
| `title`     | string                                  | page title property |
| `icon`      | null, emoji, native icon, external file | page `icon`         |
| `cover`     | null, external or Notion-hosted file    | external/null cover |
| `in_trash`  | boolean                                 | page `in_trash`     |
| `is_locked` | boolean                                 | page `is_locked`    |

Strict frontmatter accepts the read shapes Notion can return. The write planner
only emits page metadata patches for shapes Notion's page update API accepts:
page titles, null/external covers, null/emoji/native/external icons,
`in_trash`, and `is_locked`. Notion-hosted file URLs and custom emojis are
preserved as pulled state until their write behavior is verified.

Both properties and page metadata sync through the typed `PATCH /pages/{id}` page
API (R04), never through body Markdown; a body conflict does not block a
property-only push ([02-file-sync](../02-file-sync/spec.md#push-flow)).

## Data-Source Binding and Schema Drift

Requirement trace: R14. Decision [0013](../.decisions/0013-in-buffer-schema-fingerprint.md) (the stateless in-buffer fingerprint) is
superseded by decision [0017](../.decisions/0017-edit-is-an-ephemeral-file-engine-session.md): drift is detected from a base snapshot, not a
re-derived stateless fingerprint.

For a data-source-backed page, `pullPage` retrieves the parent data source
(`GET /v1/data_sources/{id}` via `page.parent.data_source_id`) and captures the
**writable** property schema into the sidecar `data_source` binding as a
`schema_snapshot` object ([05-local-state](../05-local-state/spec.md)): a canonical
projection of `{ name, type, sorted option names }` sorted by property name,
options only for `select`/`multi_select`/`status`, **hashing names not ids** (a
rename is id-preserving), excluding ids/colors/descriptions/status-groups/
timestamps/computed properties.

Before any property write the engine re-retrieves the live schema, recomputes the
hash, and on drift refuses with `NmdSchemaDriftError` (exit 6,
[01-editor](../01-editor/spec.md#exit-codes-and-error-model)) rather than risk
Notion silently auto-creating a `select` option for an unknown value name. This
refusal is on its own axis from the exit-7 value/body conflict and is **not**
`--force`-able; resolve by re-pulling. A benign color-only schema change does not
trip; the five structural mutations (add/remove/rename/retype property, add option)
do.

This is the file-engine path that `edit --frontmatter` reuses — there is no
stateless in-buffer fingerprint and no `put --frontmatter`
([01-editor](../01-editor/spec.md), decision 0017). Standalone (non-data-source)
pages have no snapshot and skip the check.
