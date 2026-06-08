import type { Option, Schema } from 'effect'
import { type Duration } from 'effect'
import * as SchemaAST from 'effect/SchemaAST'

/**
 * The `Restate` Schema-annotation namespace: Restate-specific facts carried on
 * Effect Schemas and read once at the site that owns the fact, via
 * `SchemaAST.getAnnotation`.
 *
 * Mirrors `@overeng/notion-effect-client`'s `schema-helpers.ts` field-walk
 * pattern: field annotations live on `prop.type` (NOT the `PropertySignature`),
 * read by walking `ast.propertySignatures`. See
 * [decisions/0011](../docs/decisions/0011-restate-schema-annotations.md).
 *
 * Phase 1 implements `terminal` / `retryable` (on a `Schema.TaggedError`) and
 * `serde` (on a value schema). `idempotencyKey` / `retention` / `sensitive` are
 * namespace STUBS — their ids exist so Phase 2 can read them, but no read site
 * is wired and the `sensitive` transform is not yet applied.
 */

/* ── annotation payloads ────────────────────────────────────────────────── */

/**
 * The error-boundary classification for a domain `Schema.TaggedError`, read by
 * `toTerminal`. `terminal` (the default) maps to a non-retryable
 * `TerminalError` with the given `errorCode` (default 500); `retryable` maps to
 * a non-terminal throw so Restate retries, with an optional `retryAfter` floor.
 */
export type ErrorClass =
  | { readonly _tag: 'terminal'; readonly errorCode: number }
  | { readonly _tag: 'retryable'; readonly retryAfter?: Duration.DurationInput }

/** Override the default `application/json` content type / `JSONSchema.make`. */
export interface SerdeOptions {
  readonly contentType?: string
  readonly jsonSchema?: object
}

/* ── symbol ids ─────────────────────────────────────────────────────────── */

const id = (name: string): symbol => Symbol.for(`@overeng/restate-effect/annotation/${name}`)

/** Error classification id (`terminal` / `retryable`), read at `toTerminal`. */
export const ErrorClassId: unique symbol = id('errorClass') as typeof ErrorClassId
/** Serde-options id (`contentType` / `jsonSchema`), read at `effectSerde`. */
export const SerdeId: unique symbol = id('serde') as typeof SerdeId

/* TODO(Phase 2): no read site yet — ids reserved so Phase 2 can wire them. */
/** Idempotency-key field id (input struct field), read by the client. */
export const IdempotencyKeyId: unique symbol = id('idempotencyKey') as typeof IdempotencyKeyId
/** Retention id (contract/construct), read at discovery. */
export const RetentionId: unique symbol = id('retention') as typeof RetentionId
/** Sensitive/redacted field id, read (and consumed as a transform) by `effectSerde`. */
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
   * so Restate retries, honoring an optional `retryAfter` floor.
   */
  retryable: <S extends Schema.Annotable.All>(
    self: S,
    options?: { readonly retryAfter?: Duration.DurationInput },
  ): S =>
    annotate<ErrorClass>(ErrorClassId)(self, {
      _tag: 'retryable',
      ...(options?.retryAfter !== undefined ? { retryAfter: options.retryAfter } : {}),
    }),

  /** Override the serde `contentType` / `jsonSchema` for a value schema. */
  serde: <S extends Schema.Annotable.All>(self: S, options: SerdeOptions): S =>
    annotate<SerdeOptions>(SerdeId)(self, options),
} as const

/* ── annotation readers ─────────────────────────────────────────────────── */

/** Read the error classification from a schema's AST (`None` if unannotated). */
export const readErrorClass = (ast: SchemaAST.AST): Option.Option<ErrorClass> =>
  SchemaAST.getAnnotation<ErrorClass>(ErrorClassId)(ast)

/** Read the serde options from a schema's AST (`None` if unannotated). */
export const readSerdeOptions = (ast: SchemaAST.AST): Option.Option<SerdeOptions> =>
  SchemaAST.getAnnotation<SerdeOptions>(SerdeId)(ast)
