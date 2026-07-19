import type { SchemaAst, SchemaAstView } from './effectSchema.tsx'

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

const effect3AnnotationKeys = {
  lineage: Symbol.for('effect/annotation/Lineage'),
  authority: Symbol.for('effect/annotation/Authority'),
  freshness: Symbol.for('effect/annotation/Freshness'),
  reference: Symbol.for('effect/annotation/Reference'),
} as const

type SchemaView = { readonly ast: SchemaAstView }

const annotation = (schema: SchemaView, key: keyof typeof annotationKeys): unknown => {
  const ast: SchemaAst = schema.ast
  const effect3Key = effect3AnnotationKeys[key]
  let value =
    (ast.context?.annotations === undefined
      ? undefined
      : Reflect.get(ast.context.annotations, annotationKeys[key])) ??
    (ast.annotations === undefined
      ? undefined
      : Reflect.get(ast.annotations, annotationKeys[key])) ??
    (ast.annotations === undefined ? undefined : Reflect.get(ast.annotations, effect3Key))
  for (const check of ast.checks ?? []) {
    const annotations = check.annotations ?? {}
    if (annotationKeys[key] in annotations) value = Reflect.get(annotations, annotationKeys[key])
    if (effect3Key in annotations) value = Reflect.get(annotations, effect3Key)
  }
  return value
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object'

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string'
const isOptionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === 'boolean'
const isOptionalFinite = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value))
const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) === true && value.every((item) => typeof item === 'string')

const isLineageRef = (value: unknown): value is LineageRef => {
  if (isRecord(value) === false) return false
  switch (value._tag) {
    case 'Field':
      return typeof value.path === 'string'
    case 'Schema':
      return typeof value.identifier === 'string'
    case 'External':
      return typeof value.system === 'string' && typeof value.ref === 'string'
    default:
      return false
  }
}

const isDerivationKind = (value: unknown): value is DerivationKind => {
  if (isRecord(value) === false) return false
  switch (value._tag) {
    case 'Pure':
      return true
    case 'Aggregation':
      return (
        typeof value.op === 'string' &&
        ['sum', 'count', 'min', 'max', 'avg', 'custom'].includes(value.op)
      )
    case 'Reduction':
      return typeof value.description === 'string'
    case 'External':
      return typeof value.service === 'string'
    default:
      return false
  }
}

const isLineage = (value: unknown): value is Lineage => {
  if (isRecord(value) === false) return false
  switch (value._tag) {
    case 'SourceOfTruth':
      return isOptionalString(value.owner) && isOptionalString(value.system)
    case 'Derived':
      return (
        Array.isArray(value.from) === true &&
        value.from.every(isLineageRef) &&
        isDerivationKind(value.how) &&
        isOptionalBoolean(value.pure)
      )
    case 'Projection':
      return isLineageRef(value.of) && isOptionalFinite(value.stalenessMs)
    case 'Cache':
      return isLineageRef(value.of) && isOptionalFinite(value.ttlMs)
    case 'Mirror':
      return isLineageRef(value.of) && isOptionalString(value.system)
    case 'External':
      return typeof value.system === 'string' && isOptionalString(value.ref)
    case 'Computed':
      return isOptionalString(value.fn) && isOptionalString(value.description)
    default:
      return false
  }
}

const isAuthority = (value: unknown): value is Authority =>
  isRecord(value) === true &&
  isStringArray(value.writers) &&
  (value.readers === undefined || isStringArray(value.readers))

const isFreshness = (value: unknown): value is Freshness =>
  isRecord(value) === true &&
  isOptionalFinite(value.maxAgeMs) &&
  (value.capturedAt === undefined ||
    value.capturedAt === 'now' ||
    value.capturedAt === 'event-time' ||
    value.capturedAt === 'snapshot')

const isReference = (value: unknown): value is Reference =>
  isRecord(value) === true &&
  value._tag === 'ForeignKey' &&
  typeof value.targetSchema === 'string' &&
  (value.targetField === undefined || typeof value.targetField === 'string')

const validatedAnnotation = <A>(
  schema: SchemaView,
  key: keyof typeof annotationKeys,
  validate: (value: unknown) => value is A,
): A | undefined => {
  const value = annotation(schema, key)
  return validate(value) === true ? value : undefined
}

export const getLineage = (schema: SchemaView): Lineage | undefined =>
  validatedAnnotation(schema, 'lineage', isLineage)

export const getAuthority = (schema: SchemaView): Authority | undefined =>
  validatedAnnotation(schema, 'authority', isAuthority)

export const getFreshness = (schema: SchemaView): Freshness | undefined =>
  validatedAnnotation(schema, 'freshness', isFreshness)

export const getReference = (schema: SchemaView): Reference | undefined =>
  validatedAnnotation(schema, 'reference', isReference)

interface AnnotatableSchema extends SchemaView {
  readonly annotate?: (annotations: Readonly<Record<string, unknown>>) => AnnotatableSchema
  readonly annotations?: (annotations: Readonly<Record<PropertyKey, unknown>>) => AnnotatableSchema
}

const annotate =
  <V>(key: keyof typeof annotationKeys, value: V) =>
  <S extends AnnotatableSchema>(schema: S): S => {
    if (schema.annotate !== undefined) {
      return schema.annotate({ [annotationKeys[key]]: value }) as S
    }
    if (schema.annotations !== undefined) {
      return schema.annotations({ [effect3AnnotationKeys[key]]: value }) as S
    }
    throw new TypeError('Schema does not expose an Effect 3 or Effect 4 annotation method')
  }

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
  annotate('lineage', { _tag: 'SourceOfTruth', ...opts } satisfies Lineage)

export const derivedFrom = (args: {
  from: ReadonlyArray<string | LineageRef>
  how?: DerivationKind | DerivationKind['_tag']
  pure?: boolean
}) =>
  annotate('lineage', {
    _tag: 'Derived',
    from: args.from.map(coerceRef),
    how: coerceDerivationKind(args.how),
    ...(args.pure === undefined ? {} : { pure: args.pure }),
  } satisfies Lineage)

export const projection = (args: { of: string | LineageRef; stalenessMs?: number }) =>
  annotate('lineage', {
    _tag: 'Projection',
    of: coerceRef(args.of),
    ...(args.stalenessMs === undefined ? {} : { stalenessMs: args.stalenessMs }),
  } satisfies Lineage)

export const cache = (args: { of: string | LineageRef; ttlMs?: number }) =>
  annotate('lineage', {
    _tag: 'Cache',
    of: coerceRef(args.of),
    ...(args.ttlMs === undefined ? {} : { ttlMs: args.ttlMs }),
  } satisfies Lineage)

export const mirror = (args: { of: string | LineageRef; system?: string }) =>
  annotate('lineage', {
    _tag: 'Mirror',
    of: coerceRef(args.of),
    ...(args.system === undefined ? {} : { system: args.system }),
  } satisfies Lineage)

export const external = (args: { system: string; ref?: string }) =>
  annotate('lineage', {
    _tag: 'External',
    system: args.system,
    ...(args.ref === undefined ? {} : { ref: args.ref }),
  } satisfies Lineage)

export const computed = (opts: { fn?: string; description?: string } = {}) =>
  annotate('lineage', { _tag: 'Computed', ...opts } satisfies Lineage)

export const authority = (value: Authority) => annotate('authority', value)
export const freshness = (value: Freshness) => annotate('freshness', value)
export const foreignKey = (args: { targetSchema: string; targetField?: string }) =>
  annotate('reference', {
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
