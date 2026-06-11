import {
  Cause,
  DateTime,
  Duration,
  Effect,
  Either,
  Exit,
  Option,
  Redacted,
  Schema,
  Stream,
} from 'effect'
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

/** Stable metadata for one compiled schema field. */
export interface OtelAttrFieldMetadata {
  readonly sourceKey: string
  readonly attrKey: string
  readonly role?: OtelAttrMetadata['role']
  readonly optional: boolean
  readonly encodePolicy: OtelAttrEncodePolicy
  readonly cardinality?: NonNullable<OtelAttrMetadata['cardinality']>
  readonly schemaIdentifier?: string
  readonly astTag: string
}

interface FieldPlan {
  readonly sourceKey: PropertyKey
  readonly attrKey: string
  readonly role?: OtelAttrMetadata['role']
  readonly optional: boolean
  readonly encodePolicy: OtelAttrEncodePolicy
  readonly cardinality?: NonNullable<OtelAttrMetadata['cardinality']>
  readonly schemaIdentifier?: string
  readonly astTag: string
  readonly encode: FieldEncoder
}

/** Compiled schema-backed OTEL attribute contract. */
export interface OtelAttrs<S extends Schema.Schema.AnyNoContext> {
  readonly schema: S
  readonly keys: ReadonlySet<string>
  readonly fields: ReadonlyArray<OtelAttrFieldMetadata>
  readonly hasSpanLabel: boolean
  readonly encode: (
    value: Schema.Schema.Type<S>,
  ) => Effect.Effect<OtelAttributeMap, OtelAttrEncodeError>
  readonly encodeSync: (value: Schema.Schema.Type<S>) => OtelAttributeMap
  readonly unsafeEncode: (value: Schema.Schema.Type<S>) => OtelAttributeMap
}

/** Named span contract coupled to a compiled attribute schema. */
export interface OtelSpanDefinition<S extends Schema.Schema.AnyNoContext> {
  readonly name: string
  readonly attributes: OtelAttrs<S>
  readonly root?: boolean
  readonly metadata: OtelSpanMetadata
}

/** Stable metadata for compiled span contracts. */
export interface OtelSpanMetadata {
  readonly kind: 'span'
  readonly name: string
  readonly root: boolean
  readonly attributes: ReadonlyArray<OtelAttrFieldMetadata>
  readonly attributeKeys: ReadonlyArray<string>
  readonly hasSpanLabel: boolean
}

/** Stable metadata for compiled operation contracts. */
export interface OtelOperationMetadata {
  readonly kind: 'operation'
  readonly name: string
  readonly root: boolean
  readonly attributes: ReadonlyArray<OtelAttrFieldMetadata>
  readonly attributeKeys: ReadonlyArray<string>
  readonly derivesSpanLabel: boolean
}

/** Named operation contract: the normal schema-first API for product code. */
export interface OtelOperationDefinition<S extends Schema.Schema.AnyNoContext> {
  readonly name: string
  readonly attributes: OtelAttrs<S>
  readonly root?: boolean
  readonly metadata: OtelOperationMetadata
  readonly encode: (
    value: Schema.Schema.Type<S>,
  ) => Effect.Effect<OtelAttributeMap, OtelAttrEncodeError>
  readonly encodeSync: (value: Schema.Schema.Type<S>) => OtelAttributeMap
  readonly unsafeEncode: (value: Schema.Schema.Type<S>) => OtelAttributeMap
  readonly with: {
    <A, E, R>(options: {
      readonly attributes: Schema.Schema.Type<S>
      readonly effect: Effect.Effect<A, E, R>
    }): Effect.Effect<A, E | OtelAttrEncodeError, R>
    (
      attributes: Schema.Schema.Type<S>,
    ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | OtelAttrEncodeError, R>
  }
  readonly withRoot: {
    <A, E, R>(options: {
      readonly attributes: Schema.Schema.Type<S>
      readonly effect: Effect.Effect<A, E, R>
    }): Effect.Effect<A, E | OtelAttrEncodeError, R>
    (
      attributes: Schema.Schema.Type<S>,
    ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | OtelAttrEncodeError, R>
  }
  readonly withStream: {
    <A, E, R>(options: {
      readonly attributes: Schema.Schema.Type<S>
      readonly stream: Stream.Stream<A, E, R>
    }): Stream.Stream<A, E | OtelAttrEncodeError, R>
    (
      attributes: Schema.Schema.Type<S>,
    ): <A, E, R>(stream: Stream.Stream<A, E, R>) => Stream.Stream<A, E | OtelAttrEncodeError, R>
  }
  readonly annotate: (attributes: Schema.Schema.Type<S>) => Effect.Effect<void, OtelAttrEncodeError>
}

/** Stable metadata for a schema-backed metric label contract. */
export interface OtelMetricLabelsMetadata {
  readonly kind: 'metric.labels'
  readonly labels: ReadonlyArray<OtelAttrFieldMetadata>
  readonly labelKeys: ReadonlyArray<string>
}

/** Schema-backed metric labels. Metric labels intentionally use stricter cardinality policy than spans. */
export interface OtelMetricLabels<S extends Schema.Schema.AnyNoContext> {
  readonly schema: S
  readonly attributes: OtelAttrs<S>
  readonly metadata: OtelMetricLabelsMetadata
  readonly encode: (
    value: Schema.Schema.Type<S>,
  ) => Effect.Effect<OtelAttributeMap, OtelAttrEncodeError>
  readonly encodeSync: (value: Schema.Schema.Type<S>) => OtelAttributeMap
  readonly unsafeEncode: (value: Schema.Schema.Type<S>) => OtelAttributeMap
}

export type OtelMetricInstrumentKind = 'counter' | 'histogram'

/** Stable metadata for schema-backed metric definitions. */
export interface OtelMetricMetadata {
  readonly kind: 'metric'
  readonly instrument: OtelMetricInstrumentKind
  readonly name: string
  readonly description?: string
  readonly unit?: string
  readonly labels: ReadonlyArray<OtelAttrFieldMetadata>
  readonly labelKeys: ReadonlyArray<string>
  readonly boundaries?: ReadonlyArray<number>
}

/** Runtime-light metric contract. It owns names, labels, cardinality, and metadata, not emission. */
export interface OtelMetricDefinition<S extends Schema.Schema.AnyNoContext> {
  readonly instrument: OtelMetricInstrumentKind
  readonly name: string
  readonly description?: string
  readonly unit?: string
  readonly labels: OtelMetricLabels<S>
  readonly metadata: OtelMetricMetadata
  readonly encodeLabels: (
    value: Schema.Schema.Type<S>,
  ) => Effect.Effect<OtelAttributeMap, OtelAttrEncodeError>
  readonly encodeLabelsSync: (value: Schema.Schema.Type<S>) => OtelAttributeMap
  readonly unsafeEncodeLabels: (value: Schema.Schema.Type<S>) => OtelAttributeMap
}

export interface OtelHistogramDefinition<
  S extends Schema.Schema.AnyNoContext,
> extends OtelMetricDefinition<S> {
  readonly instrument: 'histogram'
  readonly boundaries?: ReadonlyArray<number>
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
  string: (
    key: string,
    metadata: Omit<OtelAttrMetadata, 'key' | 'encode'> = {},
  ): Schema.Schema<string> => Schema.String.pipe(OtelAttr.key({ ...metadata, key })),
  boolean: (
    key: string,
    metadata: Omit<OtelAttrMetadata, 'key' | 'encode'> = {},
  ): Schema.Schema<boolean> =>
    Schema.Boolean.pipe(OtelAttr.key({ cardinality: 'low', ...metadata, key })),
  number: (
    key: string,
    metadata: Omit<OtelAttrMetadata, 'key' | 'encode'> = {},
  ): Schema.Schema<number> => Schema.Number.pipe(OtelAttr.key({ ...metadata, key })),
  literal: <Literals extends readonly [AST.LiteralValue, ...Array<AST.LiteralValue>]>(
    key: string,
    ...values: Literals
  ): Schema.Literal<Literals> =>
    Schema.Literal(...values).pipe(
      OtelAttr.key({ key, cardinality: values.length <= 2 ? 'low' : 'bounded' }),
    ) as Schema.Literal<Literals>,
  optional: <S extends Schema.Schema.AnyNoContext>(schema: S) => Schema.optional(schema),
  redacted: (key: string): Schema.Schema<Redacted.Redacted<string>, string, never> =>
    Schema.Redacted(Schema.String).pipe(OtelAttr.key({ key, encode: 'redacted' })),
  json: <S extends Schema.Schema.AnyNoContext>(
    key: string,
    schema: S,
    metadata: Omit<OtelAttrMetadata, 'key' | 'encode'> = {},
  ): S => schema.pipe(OtelAttr.key({ ...metadata, key, encode: 'json' })) as S,
  drop: <S extends Schema.Schema.AnyNoContext>(schema: S): S =>
    schema.pipe(OtelAttr.encode('drop')) as S,
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

const runSyncOrThrow = <A, E>(effect: Effect.Effect<A, E>): A =>
  Exit.match(Effect.runSyncExit(effect), {
    onSuccess: (value) => value,
    onFailure: (cause) => {
      const failure = Option.getOrUndefined(Cause.failureOption(cause))
      if (failure !== undefined) throw failure
      throw Cause.squash(cause)
    },
  })

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

const inferCardinality = (
  ast: AST.AST,
): NonNullable<OtelAttrMetadata['cardinality']> | undefined => {
  const unwrapped = unwrapRefinement(ast)
  switch (unwrapped._tag) {
    case 'BooleanKeyword':
      return 'low'
    case 'Literal':
      return typeof unwrapped.literal === 'boolean' ? 'low' : 'bounded'
    case 'Union': {
      const members = unwrapped.types.filter((member) => isUndefinedAst(member) === false)
      if (members.length === 0) return undefined
      if (members.every((member) => unwrapRefinement(member)._tag === 'Literal') === false) {
        return undefined
      }
      return members.length <= 2 ? 'low' : 'bounded'
    }
    default:
      return undefined
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
    const encodePolicy = metadata?.encode ?? 'auto'
    const cardinality = metadata?.cardinality ?? inferCardinality(field.type)
    const schemaIdentifier = astIdentifier(field.type)
    return {
      sourceKey: field.name,
      attrKey,
      ...(metadata?.role === undefined ? {} : { role: metadata.role }),
      optional: field.isOptional || isUndefinedAst(field.type),
      encodePolicy,
      ...(cardinality === undefined ? {} : { cardinality }),
      ...(schemaIdentifier === undefined ? {} : { schemaIdentifier }),
      astTag: field.type._tag,
      encode,
    }
  })
}

const fieldMetadata = (field: FieldPlan): OtelAttrFieldMetadata => ({
  sourceKey: String(field.sourceKey),
  attrKey: field.attrKey,
  ...(field.role === undefined ? {} : { role: field.role }),
  optional: field.optional,
  encodePolicy: field.encodePolicy,
  ...(field.cardinality === undefined ? {} : { cardinality: field.cardinality }),
  ...(field.schemaIdentifier === undefined ? {} : { schemaIdentifier: field.schemaIdentifier }),
  astTag: field.astTag,
})

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
        fields: plan.map(fieldMetadata),
        hasSpanLabel: plan.some(
          (field) => field.attrKey === 'span.label' && field.role === 'span.label',
        ),
        encode,
        encodeSync: (value) => runSyncOrThrow(encode(value)),
        unsafeEncode: (value) => runSyncOrThrow(encode(value)),
      }
    })
  },
  defineSync<S extends Schema.Schema.AnyNoContext>(schema: S): OtelAttrs<S> {
    return runSyncOrThrow(OtelAttrs.define(schema))
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

function withStreamSpanContract<S extends Schema.Schema.AnyNoContext, A, E, R>(options: {
  readonly span: OtelSpanDefinition<S>
  readonly attributes: Schema.Schema.Type<S>
  readonly stream: Stream.Stream<A, E, R>
}): Stream.Stream<A, E | OtelAttrEncodeError, R>
function withStreamSpanContract<S extends Schema.Schema.AnyNoContext>(options: {
  readonly span: OtelSpanDefinition<S>
  readonly attributes: Schema.Schema.Type<S>
}): <A, E, R>(stream: Stream.Stream<A, E, R>) => Stream.Stream<A, E | OtelAttrEncodeError, R>
function withStreamSpanContract<S extends Schema.Schema.AnyNoContext, A, E, R>(options: {
  readonly span: OtelSpanDefinition<S>
  readonly attributes: Schema.Schema.Type<S>
  readonly stream?: Stream.Stream<A, E, R>
}) {
  const wrap = (stream: Stream.Stream<A, E, R>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const attributes = yield* options.span.attributes.encode(options.attributes)
        if (attributes['span.label'] === undefined) return yield* missingSpanLabelError()
        return stream.pipe(
          Stream.withSpan(options.span.name, {
            attributes,
            ...(options.span.root === undefined ? {} : { root: options.span.root }),
          }),
        )
      }),
    )
  return options.stream === undefined ? wrap : wrap(options.stream)
}

const spanMetadata = <S extends Schema.Schema.AnyNoContext>(
  options: Omit<OtelSpanDefinition<S>, 'metadata'>,
): OtelSpanMetadata => ({
  kind: 'span',
  name: options.name,
  root: options.root === true,
  attributes: options.attributes.fields,
  attributeKeys: Array.from(options.attributes.keys),
  hasSpanLabel: options.attributes.hasSpanLabel,
})

const normalizeSpanLabel = (label: string): Either.Either<string, OtelAttrEncodeError> => {
  const normalized = label.trim()
  if (normalized.length === 0) {
    return Either.left(
      new OtelAttrEncodeError({
        key: 'span.label',
        message: 'OtelOperation label must be a non-empty string',
      }),
    )
  }
  return Either.right(normalized)
}

const operationMetadata = <S extends Schema.Schema.AnyNoContext>(options: {
  readonly name: string
  readonly root?: boolean
  readonly attributes: OtelAttrs<S>
}): OtelOperationMetadata => ({
  kind: 'operation',
  name: options.name,
  root: options.root === true,
  attributes: options.attributes.fields,
  attributeKeys: Array.from(new Set([...options.attributes.keys, 'span.label'])),
  derivesSpanLabel: true,
})

const metricLabelsMetadata = <S extends Schema.Schema.AnyNoContext>(
  attributes: OtelAttrs<S>,
): OtelMetricLabelsMetadata => ({
  kind: 'metric.labels',
  labels: attributes.fields,
  labelKeys: Array.from(attributes.keys),
})

const invalidMetricLabel = (field: OtelAttrFieldMetadata, message: string) =>
  new OtelAttrPlanError({
    path: [field.sourceKey],
    message,
  })

const assertMetricLabels = <S extends Schema.Schema.AnyNoContext>(
  attributes: OtelAttrs<S>,
): OtelMetricLabels<S> => {
  for (const field of attributes.fields) {
    if (field.encodePolicy === 'drop') {
      throw invalidMetricLabel(field, `Metric label ${field.attrKey} cannot use a drop encoder`)
    }
    if (field.cardinality === undefined) {
      throw invalidMetricLabel(
        field,
        `Metric label ${field.attrKey} must declare or infer low/bounded cardinality`,
      )
    }
    if (field.cardinality === 'high') {
      throw invalidMetricLabel(field, `Metric label ${field.attrKey} cannot use high cardinality`)
    }
  }
  const metadata = metricLabelsMetadata(attributes)
  return {
    schema: attributes.schema,
    attributes,
    metadata,
    encode: attributes.encode,
    encodeSync: attributes.encodeSync,
    unsafeEncode: attributes.unsafeEncode,
  }
}

const metricMetadata = <S extends Schema.Schema.AnyNoContext>(options: {
  readonly instrument: OtelMetricInstrumentKind
  readonly name: string
  readonly description?: string
  readonly unit?: string
  readonly labels: OtelMetricLabels<S>
  readonly boundaries?: ReadonlyArray<number>
}): OtelMetricMetadata => ({
  kind: 'metric',
  instrument: options.instrument,
  name: options.name,
  ...(options.description === undefined ? {} : { description: options.description }),
  ...(options.unit === undefined ? {} : { unit: options.unit }),
  labels: options.labels.metadata.labels,
  labelKeys: options.labels.metadata.labelKeys,
  ...(options.boundaries === undefined ? {} : { boundaries: options.boundaries }),
})

const validateHistogramBoundaries = (
  boundaries: ReadonlyArray<number> | undefined,
): ReadonlyArray<number> | undefined => {
  if (boundaries === undefined) return undefined
  let previous = Number.NEGATIVE_INFINITY
  for (const boundary of boundaries) {
    if (Number.isFinite(boundary) === false) {
      throw new OtelAttrPlanError({
        path: ['boundaries'],
        message: 'Histogram boundaries must be finite numbers',
      })
    }
    if (boundary <= previous) {
      throw new OtelAttrPlanError({
        path: ['boundaries'],
        message: 'Histogram boundaries must be strictly increasing',
      })
    }
    previous = boundary
  }
  return boundaries
}

const encodeOperationAttributes = <S extends Schema.Schema.AnyNoContext>(options: {
  readonly attributes: OtelAttrs<S>
  readonly label: (value: Schema.Schema.Type<S>) => string
  readonly value: Schema.Schema.Type<S>
}) =>
  Effect.gen(function* () {
    const attributes = yield* options.attributes.encode(options.value)
    const label = yield* effectFromEither(normalizeSpanLabel(options.label(options.value)))
    return { ...attributes, 'span.label': label }
  })

const isEffectOperationCall = <S extends Schema.Schema.AnyNoContext, A, E, R>(
  call:
    | {
        readonly attributes: Schema.Schema.Type<S>
        readonly effect: Effect.Effect<A, E, R>
      }
    | Schema.Schema.Type<S>,
): call is {
  readonly attributes: Schema.Schema.Type<S>
  readonly effect: Effect.Effect<A, E, R>
} => typeof call === 'object' && call !== null && 'attributes' in call && 'effect' in call

const isStreamOperationCall = <S extends Schema.Schema.AnyNoContext, A, E, R>(
  call:
    | {
        readonly attributes: Schema.Schema.Type<S>
        readonly stream: Stream.Stream<A, E, R>
      }
    | Schema.Schema.Type<S>,
): call is {
  readonly attributes: Schema.Schema.Type<S>
  readonly stream: Stream.Stream<A, E, R>
} => typeof call === 'object' && call !== null && 'attributes' in call && 'stream' in call

function defineOperation<S extends Schema.Schema.AnyNoContext>(options: {
  readonly name: string
  readonly schema: S
  readonly label: (value: Schema.Schema.Type<S>) => string
  readonly root?: boolean
}): OtelOperationDefinition<S>
function defineOperation<S extends Schema.Schema.AnyNoContext>(options: {
  readonly name: string
  readonly attributes: OtelAttrs<S>
  readonly label: (value: Schema.Schema.Type<S>) => string
  readonly root?: boolean
}): OtelOperationDefinition<S>
function defineOperation<S extends Schema.Schema.AnyNoContext>(
  options:
    | {
        readonly name: string
        readonly schema: S
        readonly label: (value: Schema.Schema.Type<S>) => string
        readonly root?: boolean
      }
    | {
        readonly name: string
        readonly attributes: OtelAttrs<S>
        readonly label: (value: Schema.Schema.Type<S>) => string
        readonly root?: boolean
      },
): OtelOperationDefinition<S> {
  const attributes =
    'attributes' in options ? options.attributes : OtelAttrs.defineSync(options.schema)
  const encode = (value: Schema.Schema.Type<S>) =>
    encodeOperationAttributes({ attributes, label: options.label, value })
  const metadata = operationMetadata({
    name: options.name,
    attributes,
    ...(options.root === undefined ? {} : { root: options.root }),
  })

  function withOperation<A, E, R>(
    call:
      | {
          readonly attributes: Schema.Schema.Type<S>
          readonly effect: Effect.Effect<A, E, R>
        }
      | Schema.Schema.Type<S>,
  ) {
    const wrap = (effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const encoded = yield* encode(isEffectOperationCall(call) ? call.attributes : call)
        return yield* effect.pipe(
          Effect.withSpan(options.name, {
            attributes: encoded,
            ...(options.root === undefined ? {} : { root: options.root }),
          }),
        )
      })
    return isEffectOperationCall(call) ? wrap(call.effect) : wrap
  }

  function withRootOperation<A, E, R>(
    call:
      | {
          readonly attributes: Schema.Schema.Type<S>
          readonly effect: Effect.Effect<A, E, R>
        }
      | Schema.Schema.Type<S>,
  ) {
    const wrap = (effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const encoded = yield* encode(isEffectOperationCall(call) ? call.attributes : call)
        return yield* effect.pipe(
          Effect.withSpan(options.name, {
            attributes: encoded,
            root: true,
          }),
        )
      })
    return isEffectOperationCall(call) ? wrap(call.effect) : wrap
  }

  function withOperationStream<A, E, R>(
    call:
      | {
          readonly attributes: Schema.Schema.Type<S>
          readonly stream: Stream.Stream<A, E, R>
        }
      | Schema.Schema.Type<S>,
  ) {
    const wrap = (stream: Stream.Stream<A, E, R>) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const encoded = yield* encode(isStreamOperationCall(call) ? call.attributes : call)
          return stream.pipe(
            Stream.withSpan(options.name, {
              attributes: encoded,
              ...(options.root === undefined ? {} : { root: options.root }),
            }),
          )
        }),
      )
    return isStreamOperationCall(call) ? wrap(call.stream) : wrap
  }

  return {
    name: options.name,
    attributes,
    ...(options.root === undefined ? {} : { root: options.root }),
    metadata,
    encode,
    encodeSync: (value) => runSyncOrThrow(encode(value)),
    unsafeEncode: (value) => runSyncOrThrow(encode(value)),
    with: withOperation as OtelOperationDefinition<S>['with'],
    withRoot: withRootOperation as OtelOperationDefinition<S>['withRoot'],
    withStream: withOperationStream as OtelOperationDefinition<S>['withStream'],
    annotate: (value) =>
      Effect.gen(function* () {
        const encoded = yield* encode(value)
        yield* Effect.annotateCurrentSpan(encoded)
      }),
  }
}

const defineMetricLabels = <S extends Schema.Schema.AnyNoContext>(schema: S): OtelMetricLabels<S> =>
  assertMetricLabels(OtelAttrs.defineSync(schema))

const metricLabelsFromInput = <S extends Schema.Schema.AnyNoContext>(
  labels: S | OtelMetricLabels<S>,
): OtelMetricLabels<S> => ('metadata' in labels ? labels : defineMetricLabels(labels))

const defineCounter = <S extends Schema.Schema.AnyNoContext>(options: {
  readonly name: string
  readonly description?: string
  readonly unit?: string
  readonly labels: S | OtelMetricLabels<S>
}): OtelMetricDefinition<S> => {
  const labels = metricLabelsFromInput(options.labels)
  return {
    instrument: 'counter',
    name: options.name,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.unit === undefined ? {} : { unit: options.unit }),
    labels,
    metadata: metricMetadata({
      instrument: 'counter',
      name: options.name,
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.unit === undefined ? {} : { unit: options.unit }),
      labels,
    }),
    encodeLabels: labels.encode,
    encodeLabelsSync: labels.encodeSync,
    unsafeEncodeLabels: labels.unsafeEncode,
  }
}

const defineHistogram = <S extends Schema.Schema.AnyNoContext>(options: {
  readonly name: string
  readonly description?: string
  readonly unit?: string
  readonly boundaries?: ReadonlyArray<number>
  readonly labels: S | OtelMetricLabels<S>
}): OtelHistogramDefinition<S> => {
  const labels = metricLabelsFromInput(options.labels)
  const boundaries = validateHistogramBoundaries(options.boundaries)
  return {
    instrument: 'histogram',
    name: options.name,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.unit === undefined ? {} : { unit: options.unit }),
    ...(boundaries === undefined ? {} : { boundaries }),
    labels,
    metadata: metricMetadata({
      instrument: 'histogram',
      name: options.name,
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.unit === undefined ? {} : { unit: options.unit }),
      labels,
      ...(boundaries === undefined ? {} : { boundaries }),
    }),
    encodeLabels: labels.encode,
    encodeLabelsSync: labels.encodeSync,
    unsafeEncodeLabels: labels.unsafeEncode,
  }
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
      metadata: spanMetadata(options),
    }
  },
  with: withSpanContract,
  withStream: withStreamSpanContract,
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
  annotateMap(attributes: OtelAttributeMap): Effect.Effect<void> {
    return Effect.forEach(
      Object.entries(attributes),
      ([key, value]) => Effect.annotateCurrentSpan(key, value),
      { discard: true },
    )
  },
  unsafeAnnotate<S extends Schema.Schema.AnyNoContext>(options: {
    readonly attributes: OtelAttrs<S>
    readonly value: Schema.Schema.Type<S>
  }): Effect.Effect<void> {
    return Effect.annotateCurrentSpan(options.attributes.unsafeEncode(options.value))
  },
  unsafeAnnotateMap(attributes: OtelAttributeMap): Effect.Effect<void> {
    return OtelSpan.annotateMap(attributes)
  },
}

/** User-facing schema-first operation API for product instrumentation. */
export const OtelOperation = {
  define: defineOperation,
} as const

/** Runtime-light schema-first metric contract API. */
export const OtelMetric = {
  labels: defineMetricLabels,
  counter: defineCounter,
  histogram: defineHistogram,
  defineCounter,
  defineHistogram,
} as const
