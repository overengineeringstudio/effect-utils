# Annotations and redaction

[← Handbook index](./README.md)

Restate-specific facts are carried on the schema and read once at the site that
owns the fact. Each `Restate.*` annotation returns the same schema with the fact
attached. The full file is [`examples/08-annotations.ts`](../../examples/08-annotations.ts).

| Annotation                   | On                   | Drives                                     |
| ---------------------------- | -------------------- | ------------------------------------------ |
| `terminal({ errorCode })`    | `Schema.TaggedError` | per-error status code (non-retryable)      |
| `retryable({ retryAfter? })` | `Schema.TaggedError` | Restate retries instead of propagating     |
| `serde({ contentType, … })`  | value schema         | overrides `application/json` / JSON Schema |
| `retention({ journal, … })`  | contract / I/O       | journal/idempotency/workflow retention     |
| `idempotencyKey`             | input struct field   | the single idempotency-key source          |
| `sensitive` / `redacted`     | value field          | encrypt the field on the wire/journal      |

```ts
import { Restate, aesGcmRedactionLayer } from '@overeng/restate-effect'

class NotFound extends Schema.TaggedError<NotFound>('example/NotFound')('NotFound', {
  id: Schema.String,
}) {}
const NotFoundTerminal = Restate.terminal(NotFound, { errorCode: 404 }) // status 404, no retry

const LookupInput = Restate.retention(Schema.Struct({ id: Schema.String }), {
  idempotency: '5 minutes',
  journal: '1 hour',
})

const StoreSecret = Schema.Struct({
  account: Schema.String,
  pin: Restate.sensitive(Schema.String), // ciphertext on the wire/journal
})
```

## Retry and timeout knobs

Per-handler/service retry and timeout knobs live in the builder `options`, not on
the schema. Durable retries are Restate's — never re-implement them with Effect
schedules.

```ts
const Vault = RestateService.contract('vault', {
  lookup: {
    input: LookupInput,
    success: Schema.String,
    error: NotFoundTerminal,
    options: {
      retryPolicy: {
        maxAttempts: 5,
        initialIntervalMillis: 100,
        maxIntervalMillis: 5_000,
        exponentiationFactor: 2,
        onMaxAttempts: 'pause', // resumable from the CLI/UI on giving up
      },
      inactivityTimeoutMillis: 30_000,
    },
  },
})
```

Other typed options surfaced on the contract/builder: `enableLazyState`,
`journalRetention`, `idempotencyRetention`, `inactivityTimeout`, `abortTimeout`,
`ingressPrivate`, `workflowRetention`, and `explicitCancellation`. The retention
ones may also derive from a `Restate.retention` annotation.

## Retryable errors and `retryAfter`

A domain error can be marked **retryable** so the boundary throws it non-terminally
and Restate retries (instead of failing the caller). `retryAfter` sets a floor
before the next attempt — either a **static** `Duration` shorthand or an **instance
projection** read off the actual failing error (mirroring `idempotencyKey` — the
fact lives on the schema, read once at the boundary). Both forms are verified in
[`src/error-transport.test.ts`](../../src/error-transport.test.ts).

```ts
// static floor
const Throttled = Restate.retryable(
  Schema.asSchema(class extends Schema.TaggedError<any>()('Throttled', {}) {}),
  { retryAfter: '30 seconds' },
)

// projection: read the floor off THIS error instance (e.g. a 429's header)
class RateLimited extends Schema.TaggedError<RateLimited>()('RateLimited', {
  retryAfterMillis: Schema.Number,
}) {}
const RateLimitedSchema = Restate.retryable(Schema.asSchema(RateLimited), {
  retryAfter: (e) => e.retryAfterMillis, // typed against the error; undefined → default backoff
})
```

The projection is applied to the very error that failed, so a Notion 429's
`e.retryAfterMillis` becomes the retry floor without threading it through a
call-site option. A projection returning `undefined` falls back to Restate's
default backoff for that instance.

## Field-level redaction

`sensitive` / `redacted` is a Schema **transform** applied by the serde — encrypt at
encode, decrypt at decode — read once on the field's property signature. It is field
structure-aware (a whole-value codec could not enforce field redaction, since
post-serde bytes have no field structure).

Provide a `RestateRedaction` cipher in the application Layer whenever any served
schema marks a field sensitive — otherwise encode/decode **fails** with a clear
`RedactionCipherMissingError` (never silently plaintext). `aesGcmRedactionLayer(key)`
is a ready AES-256-GCM reference; the 32-byte key is your secret.

```ts
import { aesGcmRedactionLayer } from '@overeng/restate-effect'

const RedactionLayer = aesGcmRedactionLayer(new Uint8Array(32).fill(7))
```

| Symbol                        | What                                               |
| ----------------------------- | -------------------------------------------------- |
| `RestateRedaction`            | the pluggable cipher Tag the consumer provides     |
| `aesGcmRedactionLayer(key)`   | a ready AES-256-GCM reference Layer                |
| `aesGcmCipher(key)`           | the bare cipher (for a custom Layer)               |
| `RedactionCipherMissingError` | raised on encode/decode when no cipher is provided |

> **Redaction is serde-only.** Never stamp a sensitive value onto a span attribute
> (via `Restate.annotateSpan` or otherwise). Redaction encrypts the value _on the
> wire/journal_; a span attribute bypasses the serde entirely and would leak the
> plaintext into your traces. Stamp a non-sensitive identifier instead. See
> [Observability](./observability.md).

## See also

- [Schema I/O and the typed error boundary](./schema-and-errors.md) — how errors cross the wire.
- [Authoring](./authoring.md) — `idempotencyKey` and the typed clients.
- [Observability](./observability.md) — span attributes and the redaction rule.
