import { DateTime, Duration, Effect, Either, Option, Redacted, Schema } from 'effect'
import * as AST from 'effect/SchemaAST'

type OtelPrimitive = string | number | boolean

/** Attribute value shape accepted by Effect's span annotation API and otelite flat rows. */
export type OtelAttributeValue = OtelPrimitive

/** Encoded OTEL attributes ready to pass to `Effect.withSpan` or `Effect.annotateCurrentSpan`. */
export type OtelAttributeMap = Readonly<Record<string, OtelAttributeValue>>

/** Explicit encoding policy for fields that cannot be safely derived from Schema AST alone. */
export type OtelAttrEncodePolicy =
  | 'auto'
  | 'string'
  | 'number'
  | 'boolean'
  | 'json'
  | 'drop'
  | 'redacted'

/** OTEL-specific metadata attached to an Effect Schema node. */
export interface OtelAttrMetadata {
  readonly key?: string
  readonly role?: 'span.label'
  readonly encode?: OtelAttrEncodePolicy
  readonly cardinality?: 'low' | 'bounded' | 'high'
}

/** Private annotation key used to attach OTEL metadata to Effect schemas. */
export const OtelAttrAnnotationId: unique symbol = Symbol.for('@overeng/utils/otel/Attr')

/** Raised when `OtelAttrs.define` cannot derive a safe field plan from a schema. */
export class OtelAttrPlanError extends Schema.TaggedError<OtelAttrPlanError>()(
  'OtelAttrPlanError',
  {
    path: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

/** Raised when a value cannot be encoded as an OTEL attribute. */
export class OtelAttrEncodeError extends Schema.TaggedError<OtelAttrEncodeError>()(
  'OtelAttrEncodeError',
  {
    key: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

type FieldEncoder = (
  value: unknown,
) => Effect.Effect<OtelAttributeValue | undefined, OtelAttrEncodeError>

interface FieldPlan {
  readonly sourceKey: PropertyKey
  readonly attrKey: string
  readonly role?: OtelAttrMetadata['role']
  readonly optional: boolean
  readonly encode: FieldEncoder
}

/** Compiled schema-backed OTEL attribute contract. */
export interface OtelAttrs<S extends Schema.Schema.AnyNoContext> {
  readonly schema: S
  readonly keys: ReadonlySet<string>
  readonly hasSpanLabel: boolean
  readonly encode: (
    value: Schema.Schema.Type<S>,
  ) => Effect.Effect<OtelAttributeMap, OtelAttrEncodeError>
  readonly unsafeEncode: (value: Schema.Schema.Type<S>) => OtelAttributeMap
}

/** Named span contract coupled to a compiled attribute schema. */
export interface OtelSpanDefinition<S extends Schema.Schema.AnyNoContext> {
  readonly name: string
  readonly attributes: OtelAttrs<S>
  readonly root?: boolean
}

const getAttrMetadata = (annotated: AST.Annotated): OtelAttrMetadata | undefined =>
  Option.getOrUndefined(AST.getAnnotation<OtelAttrMetadata>(annotated, OtelAttrAnnotationId))

const getAttrMetadataDeep = (ast: AST.AST): OtelAttrMetadata | undefined => {
  const metadata = getAttrMetadata(ast)
  if (metadata !== undefined) return metadata
  switch (ast._tag) {
    case 'Refinement':
      return getAttrMetadataDeep(ast.from)
    case 'Transformation':
      return getAttrMetadataDeep(ast.to) ?? getAttrMetadataDeep(ast.from)
    case 'Union':
      return ast.types
        .filter((member) => isUndefinedAst(member) === false)
        .map(getAttrMetadataDeep)
        .find((memberMetadata) => memberMetadata !== undefined)
    default:
      return undefined
  }
}

const withAttrMetadata =
  (metadata: OtelAttrMetadata) =>
  <S extends Schema.Annotable.All>(schema: S): Schema.Annotable.Self<S> =>
    Schema.make<Schema.Schema.Type<S>, Schema.Schema.Encoded<S>, Schema.Schema.Context<S>>(
      addAnnotation({ ast: schema.ast, metadata }),
    ) as Schema.Annotable.Self<S>

const addAnnotation = ({
  ast,
  metadata,
}: {
  readonly ast: AST.AST
  readonly metadata: OtelAttrMetadata
}): AST.AST => {
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(ast)
  descriptors.annotations = {
    configurable: true,
    enumerable: true,
    value: {
      ...ast.annotations,
      [OtelAttrAnnotationId]: {
        ...getAttrMetadata(ast),
        ...metadata,
      },
    },
    writable: true,
  }
  return Object.create(Object.getPrototypeOf(ast), descriptors) as AST.AST
}

/** Schema annotation helpers for deriving OTEL attribute keys and encoding policies. */
export const OtelAttr = {
  key: (metadata: { readonly key: string } & Omit<OtelAttrMetadata, 'key'>) =>
    withAttrMetadata(metadata),
  spanLabel: (metadata: Omit<OtelAttrMetadata, 'key' | 'role'> = {}) =>
    withAttrMetadata({ ...metadata, key: 'span.label', role: 'span.label' }),
  encode: (encode: OtelAttrEncodePolicy) => withAttrMetadata({ encode }),
  cardinality: (cardinality: NonNullable<OtelAttrMetadata['cardinality']>) =>
    withAttrMetadata({ cardinality }),
} as const

const unsupported = ({
  path,
  message,
}: {
  readonly path: ReadonlyArray<PropertyKey>
  readonly message: string
}) =>
  new OtelAttrPlanError({
    path: path.map(String),
    message,
  })

const primitiveEncodeError = ({ key, value }: { readonly key: string; readonly value: unknown }) =>
  new OtelAttrEncodeError({
    key,
    message: `Encoded value for ${key} is not an OTEL primitive: ${String(value)}`,
  })

const missingSpanLabelError = () =>
  new OtelAttrEncodeError({
    key: 'span.label',
    message: 'OtelSpan.with requires encoded attributes to include span.label',
  })

const encodeFailure = ({ key, cause }: { readonly key: string; readonly cause: unknown }) =>
  new OtelAttrEncodeError({
    key,
    message: `Failed to encode OTEL attribute ${key}`,
    cause,
  })

const isPrimitive = (value: unknown): value is OtelPrimitive =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const isFiniteOtelNumber = (value: number): boolean => Number.isFinite(value)

const primitiveFromUnknown = ({
  key,
  value,
}: {
  readonly key: string
  readonly value: unknown
}) => {
  if (typeof value === 'number' && isFiniteOtelNumber(value) === false) {
    return Either.left(
      new OtelAttrEncodeError({
        key,
        message: `OTEL number attribute ${key} must be finite`,
      }),
    )
  }
  return isPrimitive(value) === true
    ? Either.right(value)
    : Either.left(primitiveEncodeError({ key, value }))
}

const effectFromEither = <A, E>(either: Either.Either<A, E>): Effect.Effect<A, E> =>
  Either.isRight(either) === true ? Effect.succeed(either.right) : Effect.fail(either.left)

const encodeUnknown = ({
  key,
  schema,
  value,
}: {
  readonly key: string
  readonly schema: Schema.Schema<unknown, unknown, never>
  readonly value: unknown
}) =>
  effectFromEither(Schema.encodeUnknownEither(schema)(value)).pipe(
    Effect.mapError((cause) => encodeFailure({ key, cause })),
  )

const astIdentifier = (ast: AST.AST): string | undefined =>
  Option.getOrUndefined(AST.getIdentifierAnnotation(ast))

const typeConstructorTag = (ast: AST.AST): string | undefined =>
  Option.getOrUndefined(AST.getTypeConstructorAnnotation(ast))?._tag

const typeConstructorTagDeep = (ast: AST.AST): string | undefined =>
  typeConstructorTag(ast) ??
  (ast._tag === 'Transformation' ? typeConstructorTagDeep(ast.to) : undefined)

const typeConstructorParametersDeep = (ast: AST.AST): ReadonlyArray<AST.AST> => {
  if (ast._tag === 'Declaration') return ast.typeParameters
  if (ast._tag === 'Transformation') return typeConstructorParametersDeep(ast.to)
  return []
}

const unwrapRefinement = (ast: AST.AST): AST.AST =>
  ast._tag === 'Refinement' ? unwrapRefinement(ast.from) : ast

const isUndefinedAst = (ast: AST.AST): boolean =>
  ast._tag === 'UndefinedKeyword' ||
  (ast._tag === 'Union' && ast.types.some((member) => isUndefinedAst(member)))

const isPrimitiveAst = (ast: AST.AST): boolean => {
  const unwrapped = unwrapRefinement(ast)
  switch (unwrapped._tag) {
    case 'StringKeyword':
    case 'NumberKeyword':
    case 'BooleanKeyword':
      return true
    case 'Literal':
      return isPrimitive(unwrapped.literal)
    case 'Union':
      return unwrapped.types
        .filter((member) => isUndefinedAst(member) === false)
        .every(isPrimitiveAst)
    case 'TemplateLiteral':
      return true
    default:
      return false
  }
}

const rootTypeLiteral = (schema: Schema.Schema.AnyNoContext) => {
  const ast = schema.ast
  if (ast._tag === 'TypeLiteral') return ast
  if (ast._tag === 'Transformation' && ast.to._tag === 'TypeLiteral') return ast.to
  return undefined
}

const compileAutoEncoder = ({
  attrKey,
  path,
  schema,
}: {
  readonly attrKey: string
  readonly path: ReadonlyArray<PropertyKey>
  readonly schema: Schema.Schema<unknown, unknown, never>
}): Effect.Effect<FieldEncoder, OtelAttrPlanError> => {
  const ast = schema.ast
  const tag = typeConstructorTagDeep(ast)
  if (tag === 'effect/Redacted') {
    return Effect.fail(
      unsupported({ path, message: 'Redacted attributes require OtelAttr.encode("redacted")' }),
    )
  }
  if (tag === 'effect/Option') {
    const valueAst = typeConstructorParametersDeep(ast)[0]
    if (valueAst === undefined || isPrimitiveAst(valueAst) === false) {
      return Effect.fail(
        unsupported({ path, message: 'Option attributes must wrap a primitive-safe schema' }),
      )
    }
    return Effect.succeed((value) =>
      Effect.gen(function* () {
        const encoded = yield* encodeUnknown({ key: attrKey, schema, value })
        if (encoded === null || encoded === undefined) return undefined
        return yield* effectFromEither(primitiveFromUnknown({ key: attrKey, value: encoded }))
      }),
    )
  }
  if (tag === 'effect/Duration') {
    if (astIdentifier(ast) !== 'DurationFromMillis') {
      return Effect.fail(
        unsupported({
          path,
          message: 'Duration attributes must use DurationFromMillis or an explicit encoder',
        }),
      )
    }
    return Effect.succeed((value) =>
      Effect.succeed(Duration.toMillis(value as Duration.DurationInput)),
    )
  }
  if (tag === 'effect/DateTime.Utc') {
    return Effect.succeed((value) => Effect.succeed(DateTime.formatIso(value as DateTime.Utc)))
  }
  if (ast._tag === 'TypeLiteral') {
    return Effect.fail(
      unsupported({ path, message: 'Nested Struct attributes require an explicit encoder' }),
    )
  }
  if (ast._tag === 'TupleType') {
    return Effect.fail(
      unsupported({
        path,
        message: 'Array attributes require OtelAttr.encode("json") or OtelAttr.encode("string")',
      }),
    )
  }
  if (isPrimitiveAst(ast) === false && ast._tag !== 'Transformation') {
    return Effect.fail(
      unsupported({ path, message: `Unsupported OTEL attribute schema: ${String(ast)}` }),
    )
  }

  return Effect.succeed((value) =>
    encodeUnknown({ key: attrKey, schema, value }).pipe(
      Effect.flatMap((encoded) =>
        encoded === null || encoded === undefined
          ? Effect.succeed(undefined)
          : effectFromEither(primitiveFromUnknown({ key: attrKey, value: encoded })),
      ),
    ),
  )
}

const compilePolicyEncoder = ({
  attrKey,
  policy,
  schema,
}: {
  readonly attrKey: string
  readonly policy: Exclude<OtelAttrEncodePolicy, 'auto'>
  readonly schema: Schema.Schema<unknown, unknown, never>
}): FieldEncoder => {
  switch (policy) {
    case 'drop':
      return () => Effect.succeed(undefined)
    case 'redacted':
      return (value) =>
        Redacted.isRedacted(value) === true
          ? encodeUnknown({ key: attrKey, schema, value }).pipe(Effect.as('<redacted>'))
          : Effect.fail(encodeFailure({ key: attrKey, cause: value }))
    case 'json':
      return (value) =>
        encodeUnknown({ key: attrKey, schema, value }).pipe(
          Effect.flatMap((encoded) =>
            Effect.try({
              try: () => {
                const json = JSON.stringify(encoded)
                if (json === undefined) throw new Error('JSON.stringify returned undefined')
                return json
              },
              catch: (cause) => encodeFailure({ key: attrKey, cause }),
            }),
          ),
        )
    case 'string':
      return (value) =>
        encodeUnknown({ key: attrKey, schema, value }).pipe(
          Effect.map((encoded) => String(encoded)),
        )
    case 'number':
      return (value) =>
        encodeUnknown({ key: attrKey, schema, value }).pipe(
          Effect.flatMap((encoded) =>
            typeof encoded === 'number' && isFiniteOtelNumber(encoded) === true
              ? Effect.succeed(encoded)
              : Effect.fail(primitiveEncodeError({ key: attrKey, value: encoded })),
          ),
        )
    case 'boolean':
      return (value) =>
        encodeUnknown({ key: attrKey, schema, value }).pipe(
          Effect.flatMap((encoded) =>
            typeof encoded === 'boolean'
              ? Effect.succeed(encoded)
              : Effect.fail(primitiveEncodeError({ key: attrKey, value: encoded })),
          ),
        )
  }
}

const compileField = (
  field: AST.PropertySignature,
): Effect.Effect<FieldPlan, OtelAttrPlanError> => {
  const metadata = getAttrMetadataDeep(field.type) ?? getAttrMetadata(field)
  const attrKey = metadata?.key ?? String(field.name)
  const fieldSchema = Schema.make<unknown, unknown, never>(field.type)
  return Effect.gen(function* () {
    const tag = typeConstructorTagDeep(field.type)
    if (
      tag === 'effect/Redacted' &&
      metadata?.encode !== undefined &&
      metadata.encode !== 'auto' &&
      metadata.encode !== 'redacted' &&
      metadata.encode !== 'drop'
    ) {
      return yield* unsupported({
        path: [field.name],
        message: 'Redacted attributes only support OtelAttr.encode("redacted") or "drop"',
      })
    }
    const encode =
      metadata?.encode === undefined || metadata.encode === 'auto'
        ? yield* compileAutoEncoder({ attrKey, path: [field.name], schema: fieldSchema })
        : compilePolicyEncoder({ attrKey, policy: metadata.encode, schema: fieldSchema })
    return {
      sourceKey: field.name,
      attrKey,
      ...(metadata?.role === undefined ? {} : { role: metadata.role }),
      optional: field.isOptional || isUndefinedAst(field.type),
      encode,
    }
  })
}

const compilePlan = (
  schema: Schema.Schema.AnyNoContext,
): Effect.Effect<ReadonlyArray<FieldPlan>, OtelAttrPlanError> =>
  Effect.gen(function* () {
    const root = rootTypeLiteral(schema)
    if (root === undefined) {
      return yield* unsupported({
        path: [],
        message: 'OtelAttrs.define requires a Struct-like schema',
      })
    }
    if (root.indexSignatures.length > 0) {
      return yield* unsupported({
        path: [],
        message: 'Record/index-signature attributes require an explicit encoder',
      })
    }
    const plans = yield* Effect.all(root.propertySignatures.map(compileField))
    const seen = new Set<string>()
    for (const plan of plans) {
      if (seen.has(plan.attrKey) === true) {
        return yield* unsupported({
          path: [plan.sourceKey],
          message: `Duplicate OTEL attribute key: ${plan.attrKey}`,
        })
      }
      seen.add(plan.attrKey)
    }
    return plans
  })

/** Constructors for schema-backed OTEL attribute contracts. */
export const OtelAttrs = {
  define<S extends Schema.Schema.AnyNoContext>(
    schema: S,
  ): Effect.Effect<OtelAttrs<S>, OtelAttrPlanError> {
    return Effect.gen(function* () {
      const plan = yield* compilePlan(schema)
      const encode = (value: Schema.Schema.Type<S>) =>
        Effect.gen(function* () {
          const out: Record<string, OtelAttributeValue> = {}
          for (const field of plan) {
            const valueRecord = value as Record<PropertyKey, unknown>
            const raw = valueRecord[field.sourceKey]
            if (raw === undefined && field.optional === true) continue
            const encoded = yield* field.encode(raw)
            if (encoded !== undefined) out[field.attrKey] = encoded
          }
          return out
        })
      return {
        schema,
        keys: new Set(plan.map((field) => field.attrKey)),
        hasSpanLabel: plan.some(
          (field) => field.attrKey === 'span.label' && field.role === 'span.label',
        ),
        encode,
        unsafeEncode: (value) => Effect.runSync(encode(value).pipe(Effect.orDie)),
      }
    })
  },
  defineSync<S extends Schema.Schema.AnyNoContext>(schema: S): OtelAttrs<S> {
    return Effect.runSync(OtelAttrs.define(schema).pipe(Effect.orDie))
  },
}

function withSpanContract<S extends Schema.Schema.AnyNoContext, A, E, R>(options: {
  readonly span: OtelSpanDefinition<S>
  readonly attributes: Schema.Schema.Type<S>
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E | OtelAttrEncodeError, R>
function withSpanContract<S extends Schema.Schema.AnyNoContext>(options: {
  readonly span: OtelSpanDefinition<S>
  readonly attributes: Schema.Schema.Type<S>
}): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | OtelAttrEncodeError, R>
function withSpanContract<S extends Schema.Schema.AnyNoContext, A, E, R>(options: {
  readonly span: OtelSpanDefinition<S>
  readonly attributes: Schema.Schema.Type<S>
  readonly effect?: Effect.Effect<A, E, R>
}) {
  const wrap = (effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const attributes = yield* options.span.attributes.encode(options.attributes)
      if (attributes['span.label'] === undefined) return yield* missingSpanLabelError()
      return yield* effect.pipe(
        Effect.withSpan(options.span.name, {
          attributes,
          ...(options.span.root === undefined ? {} : { root: options.span.root }),
        }),
      )
    })
  return options.effect === undefined ? wrap : wrap(options.effect)
}

function unsafeWithSpanContract<S extends Schema.Schema.AnyNoContext, A, E, R>(options: {
  readonly span: OtelSpanDefinition<S>
  readonly attributes: Schema.Schema.Type<S>
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R>
function unsafeWithSpanContract<S extends Schema.Schema.AnyNoContext>(options: {
  readonly span: OtelSpanDefinition<S>
  readonly attributes: Schema.Schema.Type<S>
}): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
function unsafeWithSpanContract<S extends Schema.Schema.AnyNoContext, A, E, R>(options: {
  readonly span: OtelSpanDefinition<S>
  readonly attributes: Schema.Schema.Type<S>
  readonly effect?: Effect.Effect<A, E, R>
}) {
  const wrap = (effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.withSpan(options.span.name, {
        attributes: options.span.attributes.unsafeEncode(options.attributes),
        ...(options.span.root === undefined ? {} : { root: options.span.root }),
      }),
    )
  return options.effect === undefined ? wrap : wrap(options.effect)
}

/** Helpers for applying schema-backed span contracts to Effects. */
export const OtelSpan = {
  defineSync<S extends Schema.Schema.AnyNoContext>(options: {
    readonly name: string
    readonly schema: S
    readonly root?: boolean
  }): OtelSpanDefinition<S> {
    return OtelSpan.define({
      name: options.name,
      attributes: OtelAttrs.defineSync(options.schema),
      ...(options.root === undefined ? {} : { root: options.root }),
    })
  },
  define<S extends Schema.Schema.AnyNoContext>(options: {
    readonly name: string
    readonly attributes: OtelAttrs<S>
    readonly root?: boolean
  }): OtelSpanDefinition<S> {
    if (options.attributes.hasSpanLabel !== true) {
      throw new OtelAttrPlanError({
        path: ['span.label'],
        message: 'OtelSpan.define requires an OtelAttr.spanLabel() attribute',
      })
    }
    return {
      name: options.name,
      attributes: options.attributes,
      ...(options.root === undefined ? {} : { root: options.root }),
    }
  },
  with: withSpanContract,
  unsafeWith: unsafeWithSpanContract,
  annotate<S extends Schema.Schema.AnyNoContext>(options: {
    readonly attributes: OtelAttrs<S>
    readonly value: Schema.Schema.Type<S>
  }): Effect.Effect<void, OtelAttrEncodeError> {
    return Effect.gen(function* () {
      const attrs = yield* options.attributes.encode(options.value)
      yield* Effect.annotateCurrentSpan(attrs)
    })
  },
  unsafeAnnotate<S extends Schema.Schema.AnyNoContext>(options: {
    readonly attributes: OtelAttrs<S>
    readonly value: Schema.Schema.Type<S>
  }): Effect.Effect<void> {
    return Effect.annotateCurrentSpan(options.attributes.unsafeEncode(options.value))
  },
}
