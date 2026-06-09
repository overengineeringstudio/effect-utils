import { Duration, Option, type Schema } from 'effect'
import * as SchemaAST from 'effect/SchemaAST'

/**
 * The `Restate` Schema-annotation namespace: Restate-specific facts carried on
 * Effect Schemas and read once at the site that owns the fact, via
 * `SchemaAST.getAnnotation`.
 *
 * Mirrors `@overeng/notion-effect-client`'s `schema-helpers.ts` field-walk
 * pattern: field annotations live on `prop.type` (NOT the `PropertySignature`),
 * read by walking `ast.propertySignatures`. See
 * [.decisions/0011](../../docs/vrs/.decisions/0011-restate-schema-annotations.md).
 *
 * Phase 1 implements `terminal` / `retryable` (on a `Schema.TaggedError`) and
 * `serde` (on a value schema). Phase 2 wires `idempotencyKey` (on an input struct
 * FIELD) — the SINGLE source of a call/send's idempotency key, read by walking the
 * input schema's `propertySignatures` (decision 0011). The final annotation set
 * adds `retention` (on a contract/handler — mapped to the SDK retention/timeout
 * options at `materialize`) and `sensitive`/`redacted` (on a struct FIELD —
 * consumed as a serde TRANSFORM by `effectSerde`, see `./Redaction.ts`).
 */

/* ── annotation payloads ────────────────────────────────────────────────── */

/**
 * The `retryAfter` floor for a `retryable` error — either a STATIC value (a
 * literal shorthand, e.g. `'30 seconds'`) OR an INSTANCE PROJECTION read from the
 * actual failing error at the boundary (e.g. a Notion 429's `e.retryAfterMillis`),
 * mirroring `idempotencyKey` (decision 0011, #3). The projection returns
 * `undefined` to fall back to Restate's default backoff for that instance.
 */
export type RetryAfter =
  | Duration.DurationInput
  | ((error: unknown) => Duration.DurationInput | undefined)

/**
 * The error-boundary classification for a domain `Schema.TaggedError`, read by
 * `toTerminal`. `terminal` (the default) maps to a non-retryable
 * `TerminalError` with the given `errorCode` (default 500); `retryable` maps to
 * a non-terminal throw so Restate retries, with an optional `retryAfter` floor
 * (a static value OR a projection from the error instance — #3).
 */
export type ErrorClass =
  | { readonly _tag: 'terminal'; readonly errorCode: number }
  | { readonly _tag: 'retryable'; readonly retryAfter?: RetryAfter }

/** Override the default `application/json` content type / `JSONSchema.make`. */
export interface SerdeOptions {
  readonly contentType?: string
  readonly jsonSchema?: object
}

/**
 * Retention/visibility facts carried on a contract or handler value schema and
 * mapped to the SDK service/handler options at `materialize` (decision 0011,
 * docs/vrs/01-authoring/spec.md §4.1). Durations are `Duration.DurationInput` (decoded to millis at the boundary).
 * `journal`/`idempotency` apply to any construct; `workflow` only to a Workflow
 * (it is dropped for Services/Objects).
 */
export interface RetentionOptions {
  readonly idempotency?: Duration.DurationInput
  readonly journal?: Duration.DurationInput
  readonly workflow?: Duration.DurationInput
}

/* ── symbol ids ─────────────────────────────────────────────────────────── */

const id = (name: string): symbol => Symbol.for(`@overeng/restate-effect/annotation/${name}`)

/** Error classification id (`terminal` / `retryable`), read at `toTerminal`. */
export const ErrorClassId: unique symbol = id('errorClass') as typeof ErrorClassId
/** Serde-options id (`contentType` / `jsonSchema`), read at `effectSerde`. */
export const SerdeId: unique symbol = id('serde') as typeof SerdeId

/** Idempotency-key field id (input struct field), read by the client (Phase 2). */
export const IdempotencyKeyId: unique symbol = id('idempotencyKey') as typeof IdempotencyKeyId
/** Retention id (contract / handler I/O schema), read at `materialize` → SDK options. */
export const RetentionId: unique symbol = id('retention') as typeof RetentionId
/** Sensitive/redacted field id, read (and consumed as a transform) by `effectSerde` / `./Redaction.ts`. */
export const SensitiveId: unique symbol = id('sensitive') as typeof SensitiveId

/* ── annotation appliers ────────────────────────────────────────────────── */

/** Generic `Schema.annotations` wrapper keyed by one of the Restate symbol ids. */
const annotate =
  <Value>(annotationId: symbol) =>
  <S extends Schema.Annotable.All>(self: S, value: Value): S =>
    self.annotations({ [annotationId]: value }) as S

/**
 * The `Restate` Schema-annotation namespace. Each applier attaches a
 * Restate fact to a schema; the corresponding `read*` helper recovers it.
 */
export const Restate = {
  /**
   * Mark a `Schema.TaggedError` terminal (non-retryable) with an explicit
   * `errorCode` (e.g. 404/409). Default classification — `toTerminal` falls
   * back to `terminal` + 500 when no annotation is present.
   */
  terminal: <S extends Schema.Annotable.All>(
    self: S,
    options?: { readonly errorCode?: number },
  ): S =>
    annotate<ErrorClass>(ErrorClassId)(self, {
      _tag: 'terminal',
      errorCode: options?.errorCode ?? 500,
    }),

  /**
   * Mark a `Schema.TaggedError` retryable: `toTerminal` throws it non-terminally
   * so Restate retries, honoring an optional `retryAfter` floor. `retryAfter` is
   * either a STATIC value (literal shorthand, e.g. `'30 seconds'`) or an INSTANCE
   * PROJECTION `(error) => DurationInput | undefined` read from the actual failing
   * error at the boundary (e.g. a 429's `e.retryAfterMillis`), mirroring
   * `idempotencyKey` (decision 0011, #3). The projection is typed against the
   * error's decoded type so the field access is checked.
   */
  retryable: <S extends Schema.Annotable.All>(
    self: S,
    options?: {
      readonly retryAfter?:
        | Duration.DurationInput
        | ((error: Schema.Schema.Type<S>) => Duration.DurationInput | undefined)
    },
  ): S =>
    annotate<ErrorClass>(ErrorClassId)(self, {
      _tag: 'retryable',
      ...(options?.retryAfter !== undefined
        ? { retryAfter: options.retryAfter as RetryAfter }
        : {}),
    }),

  /** Override the serde `contentType` / `jsonSchema` for a value schema. */
  serde: <S extends Schema.Annotable.All>(self: S, options: SerdeOptions): S =>
    annotate<SerdeOptions>(SerdeId)(self, options),

  /**
   * Mark an input-struct FIELD as the idempotency-key source (decision 0011). Its
   * value becomes the call/send idempotency key — the SINGLE source, dropping the
   * call-site `{ idempotencyKey }` option. MUST be applied to the FIELD's value
   * schema (e.g. `Restate.idempotencyKey(Schema.String)`), not the struct.
   */
  idempotencyKey: <S extends Schema.Annotable.All>(self: S): S =>
    annotate<true>(IdempotencyKeyId)(self, true),

  /**
   * Declare retention/timeout facts on a contract or handler I/O schema, mapped
   * to the SDK `idempotencyRetention` / `journalRetention` / `workflowRetention`
   * service/handler options at `materialize` (decision 0011, docs/vrs/01-authoring/spec.md §4.1). Equivalent
   * to setting the matching builder `options`, but kept WITH the schema so the
   * fact has one home. Builder `options` win when both are present.
   */
  retention: <S extends Schema.Annotable.All>(self: S, options: RetentionOptions): S =>
    annotate<RetentionOptions>(RetentionId)(self, options),

  /**
   * Mark a struct FIELD `sensitive` (alias `redacted`): `effectSerde` consumes it
   * as a TRANSFORM, encrypting the field at encode and decrypting at decode via
   * the pluggable `RestateRedaction` cipher (decision 0011, see `./Redaction.ts`).
   * MUST be applied to the FIELD's value schema (e.g.
   * `Restate.sensitive(Schema.String)`), not the struct — an annotation on the
   * wrong node disappears silently.
   */
  sensitive: <S extends Schema.Annotable.All>(self: S): S =>
    annotate<true>(SensitiveId)(self, true),

  /** Alias of {@link Restate.sensitive}. */
  redacted: <S extends Schema.Annotable.All>(self: S): S => annotate<true>(SensitiveId)(self, true),
} as const

/* ── annotation readers ─────────────────────────────────────────────────── */

/** Read the error classification from a schema's AST (`None` if unannotated). */
export const readErrorClass = (ast: SchemaAST.AST): Option.Option<ErrorClass> =>
  SchemaAST.getAnnotation<ErrorClass>(ErrorClassId)(ast)

/**
 * Resolve a `retryable` classification's `retryAfter` floor against the ACTUAL
 * failing error instance → millis, or `undefined` (default backoff). A static
 * value is decoded as-is; a projection is applied to the error (e.g. a 429's
 * `e.retryAfterMillis`) and its result decoded — `undefined` from the projection
 * means "no floor for this instance" (#3, mirrors `readIdempotencyKey`). Defensive
 * around a throwing/invalid projection: a bad projection yields `undefined` rather
 * than corrupting the retry path.
 */
export const readRetryAfterMillis = (
  retryAfter: RetryAfter | undefined,
  error: unknown,
): number | undefined => {
  if (retryAfter === undefined) return undefined
  const value = typeof retryAfter === 'function' ? safeProject(retryAfter, error) : retryAfter
  if (value === undefined) return undefined
  try {
    return Duration.toMillis(Duration.decode(value))
  } catch {
    return undefined
  }
}

const safeProject = (
  project: (error: unknown) => Duration.DurationInput | undefined,
  error: unknown,
): Duration.DurationInput | undefined => {
  try {
    return project(error)
  } catch {
    return undefined
  }
}

/** Read the serde options from a schema's AST (`None` if unannotated). */
export const readSerdeOptions = (ast: SchemaAST.AST): Option.Option<SerdeOptions> =>
  SchemaAST.getAnnotation<SerdeOptions>(SerdeId)(ast)

/** Read the retention options from a schema's AST (`None` if unannotated). */
export const readRetention = (ast: SchemaAST.AST): Option.Option<RetentionOptions> =>
  SchemaAST.getAnnotation<RetentionOptions>(RetentionId)(ast)

/**
 * Find the name of the input-struct field carrying the `idempotencyKey`
 * annotation, by walking `ast.propertySignatures` and reading the annotation off
 * each `prop.type` (decision 0011 — the annotation lives on the field's value
 * schema, NOT the `PropertySignature`). `None` if the input is not a struct or no
 * field is annotated. Cached at contract time, not re-walked per call.
 */
export const findIdempotencyKeyField = (ast: SchemaAST.AST): Option.Option<string> => {
  if (ast._tag !== 'TypeLiteral') return Option.none()
  for (const prop of ast.propertySignatures) {
    if (typeof prop.name !== 'string') continue
    if (Option.isSome(SchemaAST.getAnnotation<true>(IdempotencyKeyId)(prop.type)) === true) {
      return Option.some(prop.name)
    }
  }
  return Option.none()
}

/**
 * Extract the idempotency-key VALUE from a decoded input by reading the annotated
 * field (decision 0011 — the SINGLE source). `None` if the input declares no
 * idempotency-key field, or the field's value is absent/non-string.
 */
export const readIdempotencyKey = (ast: SchemaAST.AST, input: unknown): Option.Option<string> =>
  findIdempotencyKeyField(ast).pipe(
    Option.flatMap((field) =>
      typeof input === 'object' && input !== null && field in input
        ? Option.fromNullable((input as Record<string, unknown>)[field])
        : Option.none(),
    ),
    Option.filter((value): value is string => typeof value === 'string'),
  )
