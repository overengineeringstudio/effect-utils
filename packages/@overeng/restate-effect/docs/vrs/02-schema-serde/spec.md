# Spec: 02-schema-serde

Specifies the Effect Schema ↔ Restate `Serde` bridge and the Schema annotation
namespace (incl. field redaction). Builds on
[../requirements.md](../requirements.md) + [./requirements.md](./requirements.md);
terms in [../glossary.md](../glossary.md); rationale in
[../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the index.

Traces: R07, R08, R16 (R16 classification is owned by
[04-error-boundary](../04-error-boundary/spec.md), implemented here).

## 1. Serde: Effect Schema ↔ Restate `Serde`

Traces: R07, R08, R16. POC reference: `Serde.ts` (proven, 6/6 tests).

`effectSerde(schema, slot)` bridges an Effect `Schema<A, I>` to a Restate
`Serde<A>`. `slot` is `'ingress'` for ingress/handler INPUT (a caller-facing
slot) or `'internal'` for a State value, `ctx.run` result, or awakeable /
durable-promise payload:

```ts
effectSerde(schema, slot) = {
  contentType: schema |> Restate.serde annotation ?? 'application/json',  // R08, 0011
  jsonSchema:  schema |> Restate.serde annotation ?? JSONSchema.make(schema),
  serialize:   (a) => encode(JSON.stringify(Schema.encodeSync(schema)(a))),
  deserialize: (b) => Schema.decodeUnknownSync(schema)(JSON.parse(decode(b))),
}
```

One `effectSerde` governs every Restate-managed slot of that type — handler I/O,
State, `ctx.run` results, awakeable payloads, durable promises, ingress (A03) —
but a `ParseError` is classified by SLOT (R16):

- `slot === 'ingress'` → `TerminalError(400)`: a malformed input is a
  deterministic bad request; retrying cannot help.
- `slot === 'internal'` → DEFECT / retry: a decode failure on an internal slot is
  corrupt-journal infrastructure (the bytes were written by a previous attempt or
  another handler), so a 400 to the current caller would be wrong. It propagates
  as a defect Restate retries (R13, see
  [04-error-boundary](../04-error-boundary/spec.md)).

An already-terminal nested error is not double-wrapped. Per-slot serdes are built
ONCE at contract/`materialize` time and memoized, not rebuilt per durable op.

The `Restate.serde` annotation (when present on the value schema) overrides the
default `application/json` content type and `JSONSchema.make` (see
[../.decisions/0011](../.decisions/0011-restate-schema-annotations.md)). A
`sensitive`/`redacted` annotation is applied here as a field-level Schema
TRANSFORM (encrypt-at-encode / decrypt-at-decode), read once on the pre-transform
property signatures — NOT a whole-value codec (which has no field structure).

The redaction cipher is threaded into the serde through the SHARED
contract-invocation policy (`clients/InvocationPolicy.ts`,
[../.decisions/0020](../.decisions/0020-contract-invocation-policy.md)), not
re-assembled per call site — so EVERY adapter (served handler, all ingress
clients, in-handler peer calls, the testing harness) encrypts a `sensitive` field
identically. A misplaced field annotation (`sensitive`/`idempotencyKey` applied to
the STRUCT instead of a FIELD, or two `idempotencyKey` fields) is otherwise a
SILENT no-op, so `materialize*` validates placement and FAILS LOUDLY with a clear
diagnostic.

> `serialize`/`deserialize` are synchronous, so the schema must produce a sync
> validate (true for non-effectful schemas). Effectful/async transforms break the
> sync serde contract and are unsupported.

A State field declared `Schema.optional(S)` is NORMALIZED to its inner present-value
schema `S` (`undefined` stripped) before the serde is built (`normalizeStateSchema`),
so the State serde only ever encodes/decodes a present `T`. The "unset" case is
NOT a present-but-`undefined` value — it is an ABSENT key: a `set(undefined)` /
`clear` REMOVES the key, and a read of an absent key returns `undefined` without
hitting the serde (see [01-authoring](../01-authoring/spec.md) for the K/V rule).
Keeping `undefined` in the value schema would also break `JSONSchema.make`, so the
strip is load-bearing for both the serde and the registration JSON schema.

`@restatedev/restate-sdk-core`'s `serde.schema(Schema.standardSchemaV1(...))`
(Standard Schema) is a viable alternative seam, but the custom serde is used for:
slot-aware error classification (400 only for ingress input, not internal slots);
content-type control via the `Restate.serde` annotation; and no async-validate
ambiguity (the sync contract is explicit). The 400 is not the only reason.

---

## 2. Schema annotation namespace

Traces: R12, R32, R35. See
[../.decisions/0011](../.decisions/0011-restate-schema-annotations.md).

`Symbol`-keyed Effect-Schema annotations carry Restate facts on the schema, read
via `SchemaAST.getAnnotation` at one site each (mirroring
`@overeng/notion-effect-client`'s `schema-helpers.ts`, which walks
`ast.propertySignatures` and reads off `prop.type`):

| Annotation                                 | On                   | Read at       | Drives                                              |
| ------------------------------------------ | -------------------- | ------------- | --------------------------------------------------- |
| `terminal` / `retryable({retryAfter})`     | `Schema.TaggedError` | `toTerminal`  | per-error errorCode vs retryable throw              |
| `retryable` `retryAfter: static \| (e)=>…` | `Schema.TaggedError` | `toTerminal`  | retry floor — static OR projected per instance (#3) |
| `serde({contentType, jsonSchema})`         | value schema         | `effectSerde` | overrides `application/json` / JSON Schema          |
| `retention({...})`                         | contract / construct | discovery     | journal/idempotency/workflow retention              |
| `idempotencyKey`                           | input struct field   | client        | the SINGLE idempotency-key source                   |
| `sensitive` / `redacted`                   | value field          | `effectSerde` | a TRANSFORM (encrypt/decrypt), not passive          |

`terminal`/`retryable` is read at `toTerminal` per UNION MEMBER (see
[04-error-boundary](../04-error-boundary/spec.md#error-boundary)); `idempotencyKey`
is read by the client (see [05-clients](../05-clients/spec.md)); `retention` is
read at discovery (see
[01-authoring](../01-authoring/spec.md#surfaced-servicehandler-options)).

`sensitive` / `redacted` is a Schema TRANSFORM applied by `effectSerde`
(encrypt-at-encode / decrypt-at-decode), read ONCE on pre-transform property
signatures — a whole-value `JournalValueCodec` cannot enforce FIELD redaction
(post-serde bytes have no field structure), so redaction needs no codec in v1 and
the codec stays deferred. `stateKey` is DROPPED (the contract's `state` block is
the SSOT for State keys, R06).

AST gotchas: the annotation lives on `prop.type`, NOT the `PropertySignature`;
`getAnnotation` returns `None` SILENTLY if placed on the wrong node; `sensitive`
must be read before the transform consumes it. The implementation needs unit
tests over read-back (see [09-testing](../09-testing/spec.md)).
