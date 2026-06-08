# Restate Schema annotation namespace (Restate facts carried on Effect Schemas)

A `Restate` annotation namespace lets a Schema carry the Restate-specific facts
that genuinely belong to it, read once at the site that owns the fact. The
annotations are `Symbol`-keyed Effect-Schema annotations read via
`SchemaAST.getAnnotation`, mirroring the proven in-repo pattern in
`@overeng/notion-effect-client`'s `schema-helpers.ts` (which reads field-level
annotations off `prop.type` by walking `ast.propertySignatures`).

Adopted annotations — each read at ONE site, each a fact that belongs to the
schema rather than the call site:

| Annotation                               | On                     | Read at site         | Effect                                                                                                                                                                    |
| ---------------------------------------- | ---------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal` / `retryable({ retryAfter })` | a `Schema.TaggedError` | `toTerminal`         | per-error classification → `TerminalError` errorCode vs a retryable throw (improves [0003](./0003-error-boundary-model.md): a retryable DOMAIN error becomes expressible) |
| `serde({ contentType, jsonSchema })`     | a value schema         | `effectSerde`        | overrides the hardcoded `application/json` / `JSONSchema.make`                                                                                                            |
| `retention({ … })`                       | a contract / construct | contract / discovery | maps to `journalRetention` / `idempotencyRetention` / `workflowRetention`                                                                                                 |
| `idempotencyKey`                         | an input struct FIELD  | client (input walk)  | the SINGLE source of the idempotency key                                                                                                                                  |

`idempotencyKey` is the SINGLE source: the client walks the input
`propertySignatures` to find the annotated field and uses its value as the
key, DROPPING the call-site `{ idempotencyKey }` send option. One place to
declare it, no drift between schema and call site.

`sensitive` / `redacted` is NOT a passive annotation — it is a Schema TRANSFORM
applied by `effectSerde` (encrypt-at-encode / decrypt-at-decode on the annotated
fields), read ONCE on the PRE-transform property signatures and then consumed.
Rationale: a whole-value `JournalValueCodec` CANNOT enforce FIELD redaction —
post-serde bytes have no field structure to selectively encrypt. Field redaction
needs the field-aware serde transform, so it needs NO codec in v1; the
`JournalValueCodec` stays fully DEFERRED (whole-value gzip / encrypt only).

DROPPED: `stateKey`. It is redundant with the contract's typed `state` block
(R06), which stays the single source of truth for State keys and value types.

AST gotchas (documented so the implementation reads annotations correctly):

- The annotation lives on `prop.type`, NOT on the `PropertySignature` node; read
  it by walking `ast.propertySignatures` and calling
  `SchemaAST.getAnnotation(prop.type, RestateAnnotationId)`.
- `getAnnotation` returns `Option.None` SILENTLY if the annotation was placed on
  the wrong node — so an annotation put on the struct instead of the field, or on
  the `PropertySignature` instead of `prop.type`, just disappears.
- `sensitive` must be read ONCE on the PRE-transform signatures, before the
  redaction transform consumes it; reading it post-transform sees nothing.

## Why

- A fact like "this error is retryable", "this value uses a custom content type",
  or "this field is the idempotency key" belongs to the Schema, not scattered
  across the error-boundary code, the serde, and the call site. Annotations keep
  one source of truth and let the boundary stay schema-driven.
- Field redaction is impossible at the whole-value codec layer; the serde
  transform is the only place with field structure.

## Consequences

- The boundary reads annotations at well-defined sites; an annotation on the
  wrong node fails silently, so the implementation needs unit tests over
  read-back.
- `idempotencyKey` as a schema field removes a call-site option (a small API
  simplification with a one-time migration cost).
- `JournalValueCodec` (whole-value) remains deferred; redaction does not depend
  on it.

Status: accepted
