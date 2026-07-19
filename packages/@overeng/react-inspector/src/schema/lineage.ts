import { Schema, type SchemaAST } from 'effect'

export type LineageRef =
  | { readonly _tag: 'Field'; readonly path: string }
  | { readonly _tag: 'Schema'; readonly identifier: string }
  | { readonly _tag: 'External'; readonly system: string; readonly ref: string }

export type DerivationKind =
  | { readonly _tag: 'Pure' }
  | {
      readonly _tag: 'Aggregation'
      readonly op: 'sum' | 'count' | 'min' | 'max' | 'avg' | 'custom'
    }
  | { readonly _tag: 'Reduction'; readonly description: string }
  | { readonly _tag: 'External'; readonly service: string }

export type Lineage =
  | { readonly _tag: 'SourceOfTruth'; readonly owner?: string; readonly system?: string }
  | {
      readonly _tag: 'Derived'
      readonly from: ReadonlyArray<LineageRef>
      readonly how: DerivationKind
      readonly pure?: boolean
    }
  | { readonly _tag: 'Projection'; readonly of: LineageRef; readonly stalenessMs?: number }
  | { readonly _tag: 'Cache'; readonly of: LineageRef; readonly ttlMs?: number }
  | { readonly _tag: 'Mirror'; readonly of: LineageRef; readonly system?: string }
  | { readonly _tag: 'External'; readonly system: string; readonly ref?: string }
  | { readonly _tag: 'Computed'; readonly fn?: string; readonly description?: string }

export interface Authority {
  readonly writers: ReadonlyArray<string>
  readonly readers?: ReadonlyArray<string>
}

export interface Freshness {
  readonly capturedAt?: 'now' | 'event-time' | 'snapshot'
  readonly maxAgeMs?: number
}

export interface Reference {
  readonly _tag: 'ForeignKey'
  readonly targetSchema: string
  readonly targetField?: string
}

export interface LineageDisplay {
  readonly badge: string
  readonly badgeTitle: string
  readonly kindLabel: string
  readonly summary: string
  readonly details?: ReadonlyArray<{ readonly label: string; readonly value: string }>
}

const annotationKeys = {
  lineage: '@overeng/lineage',
  authority: '@overeng/authority',
  freshness: '@overeng/freshness',
  reference: '@overeng/reference',
} as const

const LineageRefSchema = Schema.Union([
  Schema.TaggedStruct('Field', { path: Schema.String }),
  Schema.TaggedStruct('Schema', { identifier: Schema.String }),
  Schema.TaggedStruct('External', { system: Schema.String, ref: Schema.String }),
])

const DerivationKindSchema = Schema.Union([
  Schema.TaggedStruct('Pure', {}),
  Schema.TaggedStruct('Aggregation', {
    op: Schema.Literal('sum', 'count', 'min', 'max', 'avg', 'custom'),
  }),
  Schema.TaggedStruct('Reduction', { description: Schema.String }),
  Schema.TaggedStruct('External', { service: Schema.String }),
])

const LineageSchema = Schema.Union([
  Schema.TaggedStruct('SourceOfTruth', {
    owner: Schema.optionalKey(Schema.String),
    system: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct('Derived', {
    from: Schema.Array(LineageRefSchema),
    how: DerivationKindSchema,
    pure: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.TaggedStruct('Projection', {
    of: LineageRefSchema,
    stalenessMs: Schema.optionalKey(Schema.Finite),
  }),
  Schema.TaggedStruct('Cache', {
    of: LineageRefSchema,
    ttlMs: Schema.optionalKey(Schema.Finite),
  }),
  Schema.TaggedStruct('Mirror', {
    of: LineageRefSchema,
    system: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct('External', {
    system: Schema.String,
    ref: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct('Computed', {
    fn: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
  }),
])

const AuthoritySchema = Schema.Struct({
  writers: Schema.Array(Schema.String),
  readers: Schema.optionalKey(Schema.Array(Schema.String)),
})
const FreshnessSchema = Schema.Struct({
  capturedAt: Schema.optionalKey(Schema.Literal('now', 'event-time', 'snapshot')),
  maxAgeMs: Schema.optionalKey(Schema.Finite),
})
const ReferenceSchema = Schema.TaggedStruct('ForeignKey', {
  targetSchema: Schema.String,
  targetField: Schema.optionalKey(Schema.String),
})

type SchemaView = { readonly ast: SchemaAST.AST }

const annotation = (schema: SchemaView, key: string): unknown => {
  let value = schema.ast.context?.annotations?.[key] ?? schema.ast.annotations?.[key]
  for (const check of schema.ast.checks ?? []) {
    if (key in (check.annotations ?? {})) value = check.annotations?.[key]
  }
  return value
}

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  decoder: S,
  value: unknown,
): S['Type'] | undefined =>
  Schema.decodeUnknownOption(decoder)(value).pipe((option) =>
    option._tag === 'Some' ? option.value : undefined,
  )

export const getLineage = (schema: SchemaView): Lineage | undefined =>
  decode(LineageSchema, annotation(schema, annotationKeys.lineage))

export const getAuthority = (schema: SchemaView): Authority | undefined =>
  decode(AuthoritySchema, annotation(schema, annotationKeys.authority))

export const getFreshness = (schema: SchemaView): Freshness | undefined =>
  decode(FreshnessSchema, annotation(schema, annotationKeys.freshness))

export const getReference = (schema: SchemaView): Reference | undefined =>
  decode(ReferenceSchema, annotation(schema, annotationKeys.reference))

const annotate =
  <V>(key: string, value: V) =>
  <S extends Schema.Top>(schema: S): S['Rebuild'] =>
    schema.annotate({ [key]: value })

const fieldRef = (path: string): LineageRef => ({
  _tag: 'Field',
  path: path.startsWith('$') === true ? path : `$.${path}`,
})
const coerceRef = (ref: string | LineageRef): LineageRef =>
  typeof ref === 'string' ? fieldRef(ref) : ref

const coerceDerivationKind = (
  how: DerivationKind | DerivationKind['_tag'] | undefined,
): DerivationKind => {
  if (how === undefined) return { _tag: 'Pure' }
  if (typeof how !== 'string') return how

  switch (how) {
    case 'Pure':
      return { _tag: 'Pure' }
    case 'Aggregation':
      return { _tag: 'Aggregation', op: 'custom' }
    case 'Reduction':
      return { _tag: 'Reduction', description: '' }
    case 'External':
      return { _tag: 'External', service: '' }
  }
}

export const sourceOfTruth = (opts: { owner?: string; system?: string } = {}) =>
  annotate(annotationKeys.lineage, { _tag: 'SourceOfTruth', ...opts } satisfies Lineage)

export const derivedFrom = (args: {
  from: ReadonlyArray<string | LineageRef>
  how?: DerivationKind | DerivationKind['_tag']
  pure?: boolean
}) =>
  annotate(annotationKeys.lineage, {
    _tag: 'Derived',
    from: args.from.map(coerceRef),
    how: coerceDerivationKind(args.how),
    ...(args.pure === undefined ? {} : { pure: args.pure }),
  } satisfies Lineage)

export const projection = (args: { of: string | LineageRef; stalenessMs?: number }) =>
  annotate(annotationKeys.lineage, {
    _tag: 'Projection',
    of: coerceRef(args.of),
    ...(args.stalenessMs === undefined ? {} : { stalenessMs: args.stalenessMs }),
  } satisfies Lineage)

export const cache = (args: { of: string | LineageRef; ttlMs?: number }) =>
  annotate(annotationKeys.lineage, {
    _tag: 'Cache',
    of: coerceRef(args.of),
    ...(args.ttlMs === undefined ? {} : { ttlMs: args.ttlMs }),
  } satisfies Lineage)

export const mirror = (args: { of: string | LineageRef; system?: string }) =>
  annotate(annotationKeys.lineage, {
    _tag: 'Mirror',
    of: coerceRef(args.of),
    ...(args.system === undefined ? {} : { system: args.system }),
  } satisfies Lineage)

export const external = (args: { system: string; ref?: string }) =>
  annotate(annotationKeys.lineage, {
    _tag: 'External',
    system: args.system,
    ...(args.ref === undefined ? {} : { ref: args.ref }),
  } satisfies Lineage)

export const computed = (opts: { fn?: string; description?: string } = {}) =>
  annotate(annotationKeys.lineage, { _tag: 'Computed', ...opts } satisfies Lineage)

export const authority = (value: Authority) => annotate(annotationKeys.authority, value)
export const freshness = (value: Freshness) => annotate(annotationKeys.freshness, value)
export const foreignKey = (args: { targetSchema: string; targetField?: string }) =>
  annotate(annotationKeys.reference, {
    _tag: 'ForeignKey',
    targetSchema: args.targetSchema,
    ...(args.targetField === undefined ? {} : { targetField: args.targetField }),
  } satisfies Reference)

const refToString = (ref: LineageRef): string => {
  switch (ref._tag) {
    case 'Field':
      return ref.path
    case 'Schema':
      return ref.identifier
    case 'External':
      return `${ref.system}:${ref.ref}`
  }
}

const withDetails = (
  base: Omit<LineageDisplay, 'details'>,
  details: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): LineageDisplay => (details.length === 0 ? base : { ...base, details })

export const getLineageDisplay = (lineage: Lineage): LineageDisplay => {
  switch (lineage._tag) {
    case 'SourceOfTruth':
      return withDetails(
        {
          badge: '⇆',
          badgeTitle: 'Source of truth',
          kindLabel: 'Source of truth',
          summary:
            lineage.system === undefined ? 'Authoritative value' : `Owned by ${lineage.system}`,
        },
        [
          ...(lineage.owner === undefined ? [] : [{ label: 'owner', value: lineage.owner }]),
          ...(lineage.system === undefined ? [] : [{ label: 'system', value: lineage.system }]),
        ],
      )
    case 'Derived': {
      const sources = lineage.from.map(refToString).join(', ')
      return {
        badge: 'ƒ',
        badgeTitle: `Derived from ${sources}`,
        kindLabel: 'Derived',
        summary: `Derived from ${sources}`,
      }
    }
    case 'Projection': {
      const source = refToString(lineage.of)
      return {
        badge: '≈',
        badgeTitle: `Projection of ${source}`,
        kindLabel: 'Projection',
        summary: `Projection of ${source}`,
      }
    }
    case 'Cache': {
      const source = refToString(lineage.of)
      return {
        badge: '☷',
        badgeTitle: `Cache of ${source}`,
        kindLabel: 'Cache',
        summary: `Cached value of ${source}`,
      }
    }
    case 'Mirror': {
      const source = refToString(lineage.of)
      return {
        badge: '↻',
        badgeTitle: `Mirror of ${source}`,
        kindLabel: 'Mirror',
        summary: `Mirror of ${source}`,
      }
    }
    case 'External':
      return {
        badge: '↗',
        badgeTitle: `External: ${lineage.system}`,
        kindLabel: 'External',
        summary: lineage.ref === undefined ? lineage.system : `${lineage.system}:${lineage.ref}`,
      }
    case 'Computed':
      return {
        badge: '⊙',
        badgeTitle: 'Computed',
        kindLabel: 'Computed',
        summary: lineage.description ?? lineage.fn ?? 'Computed at read time',
      }
  }
}
