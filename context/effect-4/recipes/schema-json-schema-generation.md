# Pattern: schema-json-schema-generation

**Area:** Schema / JSON Schema **Kind:** semantic

## Shape change

Effect 3 generated a JSON Schema object with `JSONSchema.make(schema)`. Effect 4 removes that
function. `Schema.toJsonSchemaDocument(schema)` generates a canonical
`JsonSchema.Document<"draft-2020-12">`; conversion to another dialect is explicit.

## v3 compatibility finding

The v3 default was internally inconsistent. It declared Draft-07:

```json
{ "$schema": "http://json-schema.org/draft-07/schema#" }
```

but named definitions with `$defs` and referenced them through `#/$defs/...`, which are Draft
2020-12 vocabulary. A byte-preserving compatibility normalizer would preserve a specification
violation and must not be introduced.

## Mapping

First trace the consumer and select the dialect it requires. When canonical Draft 2020-12 is
accepted, serialize the generated document as:

```ts
const document = Schema.toJsonSchemaDocument(schema)
const jsonSchema = {
  $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
  ...document.schema,
  ...(Object.keys(document.definitions).length > 0
    ? { $defs: document.definitions }
    : {}),
}
```

For a real Draft-07 consumer, convert with `JsonSchema.toDocumentDraft07(document)` and emit its
definitions using the Draft-07 `definitions` keyword. Do not mix the two dialects.

## Verification

Checked against `effect@3.21.4` and `effect@4.0.0-beta.102`. Representative struct and identified
definition outputs proved:

- v3 used a Draft-07 URI with 2020-12 `$defs` references.
- v4 canonical generation uses Draft 2020-12 definitions.
- v4 Draft-07 conversion correctly uses `definitions` and `#/definitions/...`.

`@overeng/restate-effect` publishes the object in the external Restate endpoint discovery manifest.
The pinned SDK types it as `unknown`, copies it unchanged, and does not negotiate or validate a JSON
Schema dialect. Its canonical 2020-12 port still requires a real Restate deployment-registration
test.

## Intended differences

- The declared dialect changes from v3's incorrect Draft-07 label to Draft 2020-12.
- Generated object key order can change. JSON object ordering is semantically irrelevant unless a
  consumer hashes or snapshots serialized bytes; audit for those consumers before accepting it.

## Gotchas

- No single v4 draft conversion is byte-equivalent to v3's non-conformant output.
- Do not choose a draft from the nearest-looking function name. Trace the external consumer first.
- Attach the separated `definitions` map to the emitted root; returning only `document.schema`
  leaves identified `$ref`s unresolved.
