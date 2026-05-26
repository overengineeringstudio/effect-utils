/**
 * Lineage annotation namespace for Effect Schema.
 *
 * A standardized vocabulary for the *epistemic* status of a field — is it the
 * source of truth, a projection, a cache, a derivation, etc. — designed to be
 * read by the inspector (and other downstream tools) to surface badges and
 * tooltips without authors having to hand-roll prose in `description`.
 *
 * Design follows the hybrid recommended in the issue: one fat `Lineage`
 * tagged union for the core epistemic kind, plus small focused companion
 * annotations (`Authority`, `Freshness`, `Reference`) for orthogonal concerns
 * that compose freely with any `Lineage` value.
 *
 * @see https://github.com/overengineeringstudio/effect-utils/issues/687
 */

import { Option, Schema, type SchemaAST } from 'effect'

/* --------------------------------------------------------------------------
 * Schemas
 * -------------------------------------------------------------------------- */

/** A reference to another field, schema, or external system. */
export const LineageRef = Schema.Union(
  /** Path relative to the root schema, e.g. `$.foo.bar` (same syntax as `SchemaContext`). */
  Schema.TaggedStruct('Field', { path: Schema.String }),
  /** Reference by schema identifier (the `identifier` annotation). */
  Schema.TaggedStruct('Schema', { identifier: Schema.String }),
  /** Foreign-system reference (e.g. `{ system: 'stripe', ref: 'cus_123' }`). */
  Schema.TaggedStruct('External', { system: Schema.String, ref: Schema.String }),
)
export type LineageRef = typeof LineageRef.Type

/** How a `Derived` field is computed from its inputs. */
export const DerivationKind = Schema.Union(
  Schema.TaggedStruct('Pure', {}),
  Schema.TaggedStruct('Aggregation', {
    op: Schema.Literal('sum', 'count', 'min', 'max', 'avg', 'custom'),
  }),
  Schema.TaggedStruct('Reduction', { description: Schema.String }),
  Schema.TaggedStruct('External', { service: Schema.String }),
)
export type DerivationKind = typeof DerivationKind.Type

/**
 * The lineage kind for a single field — exactly one variant per annotation.
 *
 * @see https://github.com/overengineeringstudio/effect-utils/issues/687
 */
export const Lineage = Schema.Union(
  Schema.TaggedStruct('SourceOfTruth', {
    owner: Schema.optional(Schema.String),
    system: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('Derived', {
    from: Schema.Array(LineageRef),
    how: DerivationKind,
    pure: Schema.optional(Schema.Boolean),
  }),
  Schema.TaggedStruct('Projection', {
    of: LineageRef,
    stalenessMs: Schema.optional(Schema.Number),
  }),
  Schema.TaggedStruct('Cache', {
    of: LineageRef,
    ttlMs: Schema.optional(Schema.Number),
  }),
  Schema.TaggedStruct('Mirror', {
    of: LineageRef,
    system: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('External', {
    system: Schema.String,
    ref: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('Computed', {
    fn: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
  }),
)
export type Lineage = typeof Lineage.Type

/** Who can read/write this field. Composable with any `Lineage`. */
export const Authority = Schema.Struct({
  writers: Schema.Array(Schema.String),
  readers: Schema.optional(Schema.Array(Schema.String)),
})
export type Authority = typeof Authority.Type

/** Temporal freshness of a captured value. */
export const Freshness = Schema.Struct({
  capturedAt: Schema.optional(Schema.Literal('now', 'event-time', 'snapshot')),
  maxAgeMs: Schema.optional(Schema.Number),
})
export type Freshness = typeof Freshness.Type

/** Cross-entity reference (foreign key). */
export const Reference = Schema.TaggedStruct('ForeignKey', {
  targetSchema: Schema.String,
  targetField: Schema.optional(Schema.String),
})
export type Reference = typeof Reference.Type

/* --------------------------------------------------------------------------
 * Annotation symbols
 * -------------------------------------------------------------------------- */

export const LineageAnnotationId = Symbol.for('effect/annotation/Lineage')
export const AuthorityAnnotationId = Symbol.for('effect/annotation/Authority')
export const FreshnessAnnotationId = Symbol.for('effect/annotation/Freshness')
export const ReferenceAnnotationId = Symbol.for('effect/annotation/Reference')

/* --------------------------------------------------------------------------
 * Extraction helpers
 * -------------------------------------------------------------------------- */

/*
 * Mirror of `unwrapAstForDisplay` from `effectSchema.tsx`, kept local so this
 * module has no cross-file coupling. Walks Refinement/Transformation/Suspend
 * wrappers (and trivial single-member Unions) so annotations on either the
 * outer or inner layer are discoverable.
 */
const isNullishAst = (ast: SchemaAST.AST): boolean => {
  if (ast._tag === 'UndefinedKeyword' || ast._tag === 'VoidKeyword') return true
  return ast._tag === 'Literal' && ast.literal === null
}

const unwrapAst = (ast: SchemaAST.AST): SchemaAST.AST => {
  switch (ast._tag) {
    case 'Transformation':
      return unwrapAst(ast.to)
    case 'Refinement':
      return unwrapAst(ast.from)
    case 'Suspend':
      try {
        return unwrapAst(ast.f())
      } catch {
        return ast
      }
    case 'Union': {
      const nonNullish = ast.types.filter((m) => !isNullishAst(m))
      if (nonNullish.length === 1) {
        const [only] = nonNullish
        if (only !== undefined) return unwrapAst(only)
      }
      return ast
    }
    default:
      return ast
  }
}

/*
 * Generic, fail-soft annotation reader. Tries the raw AST first (so wrapper
 * annotations win), then the unwrapped AST. Validates via the matching
 * schema decoder; a corrupt or unrecognized value yields `undefined` rather
 * than throwing — the inspector must never crash on bad annotations.
 */
const readAnnotation = <A>(
  schema: Schema.Schema.AnyNoContext,
  id: symbol,
  decoder: Schema.Schema<A>,
): A | undefined => {
  const decode = Schema.decodeUnknownOption(decoder)
  const raw = schema.ast.annotations[id]
  if (raw !== undefined) {
    const decoded = decode(raw)
    if (Option.isSome(decoded) === true) return decoded.value
  }
  const unwrapped = unwrapAst(schema.ast)
  if (unwrapped !== schema.ast) {
    const innerRaw = unwrapped.annotations[id]
    if (innerRaw !== undefined) {
      const decoded = decode(innerRaw)
      if (Option.isSome(decoded) === true) return decoded.value
    }
  }
  return undefined
}

export const getLineage = (schema: Schema.Schema.AnyNoContext): Lineage | undefined =>
  readAnnotation(schema, LineageAnnotationId, Lineage)

export const getAuthority = (schema: Schema.Schema.AnyNoContext): Authority | undefined =>
  readAnnotation(schema, AuthorityAnnotationId, Authority)

export const getFreshness = (schema: Schema.Schema.AnyNoContext): Freshness | undefined =>
  readAnnotation(schema, FreshnessAnnotationId, Freshness)

export const getReference = (schema: Schema.Schema.AnyNoContext): Reference | undefined =>
  readAnnotation(schema, ReferenceAnnotationId, Reference)

/* --------------------------------------------------------------------------
 * Ergonomic constructors
 *
 * Each returns a `Schema -> Schema` function suitable for `.pipe(...)`, e.g.
 *   Schema.Number.pipe(derivedFrom(['subtotal', 'tax']))
 * -------------------------------------------------------------------------- */

const fieldRef = (path: string): LineageRef => ({
  _tag: 'Field',
  /* Normalize: bare names become root-relative paths, matching SchemaContext. */
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

const annotate =
  <V>(id: symbol, value: V) =>
  <S extends Schema.Schema.AnyNoContext>(schema: S): S =>
    schema.annotations({ [id]: value }) as S

const lineageAnnotation =
  (value: Lineage) =>
  <S extends Schema.Schema.AnyNoContext>(schema: S): S =>
    annotate(LineageAnnotationId, value)(schema)

export const sourceOfTruth = (opts?: { owner?: string; system?: string }) =>
  lineageAnnotation({ _tag: 'SourceOfTruth', ...opts })

export const derivedFrom = (
  from: ReadonlyArray<string | LineageRef>,
  how?: DerivationKind | DerivationKind['_tag'],
  opts?: { pure?: boolean },
) =>
  lineageAnnotation({
    _tag: 'Derived',
    from: from.map(coerceRef),
    how: coerceDerivationKind(how),
    ...opts,
  })

export const projection = (of: string | LineageRef, opts?: { stalenessMs?: number }) =>
  lineageAnnotation({ _tag: 'Projection', of: coerceRef(of), ...opts })

export const cache = (of: string | LineageRef, opts?: { ttlMs?: number }) =>
  lineageAnnotation({ _tag: 'Cache', of: coerceRef(of), ...opts })

export const mirror = (of: string | LineageRef, opts?: { system?: string }) =>
  lineageAnnotation({ _tag: 'Mirror', of: coerceRef(of), ...opts })

export const external = (system: string, ref?: string) =>
  lineageAnnotation(
    ref !== undefined ? { _tag: 'External', system, ref } : { _tag: 'External', system },
  )

export const computed = (opts?: { fn?: string; description?: string }) =>
  lineageAnnotation({ _tag: 'Computed', ...opts })

export const authority = (a: Authority) => annotate(AuthorityAnnotationId, a)
export const freshness = (f: Freshness) => annotate(FreshnessAnnotationId, f)
export const foreignKey = (targetSchema: string, targetField?: string) =>
  annotate(
    ReferenceAnnotationId,
    targetField !== undefined
      ? { _tag: 'ForeignKey', targetSchema, targetField }
      : { _tag: 'ForeignKey', targetSchema },
  )

/* --------------------------------------------------------------------------
 * Display-ready bundle
 * -------------------------------------------------------------------------- */

/** Pre-rendered strings the inspector can drop into a badge + tooltip. */
export interface LineageDisplay {
  /** Single-glyph badge to render inline with the field label. */
  badge: string
  /** Tooltip text for the badge alone (no kind label). */
  badgeTitle: string
  /** User-facing kind label, e.g. `"Source of truth"`, `"Derived"`. */
  kindLabel: string
  /** One-line summary for the tooltip body. */
  summary: string
  /** Optional extra `label: value` lines for the tooltip body. */
  details?: ReadonlyArray<{ label: string; value: string }>
}

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

const derivationToString = (how: DerivationKind): string => {
  switch (how._tag) {
    case 'Pure':
      return 'pure'
    case 'Aggregation':
      return `aggregation (${how.op})`
    case 'Reduction':
      return how.description !== '' ? `reduction: ${how.description}` : 'reduction'
    case 'External':
      return how.service !== '' ? `external service: ${how.service}` : 'external service'
  }
}

export const getLineageDisplay = (lineage: Lineage): LineageDisplay => {
  switch (lineage._tag) {
    case 'SourceOfTruth': {
      const parts: { label: string; value: string }[] = []
      if (lineage.owner !== undefined) parts.push({ label: 'owner', value: lineage.owner })
      if (lineage.system !== undefined) parts.push({ label: 'system', value: lineage.system })
      return {
        badge: '⇆',
        badgeTitle: 'Source of truth',
        kindLabel: 'Source of truth',
        summary:
          lineage.system !== undefined ? `Owned by ${lineage.system}` : 'Authoritative value',
        details: parts.length > 0 ? parts : undefined,
      }
    }
    case 'Derived': {
      const fromList = lineage.from.map(refToString).join(', ')
      const how = derivationToString(lineage.how)
      return {
        badge: 'ƒ',
        badgeTitle: `Derived from ${fromList}`,
        kindLabel: 'Derived',
        summary: `${how} of ${fromList}`,
        details: lineage.pure === true ? [{ label: 'pure', value: 'true' }] : undefined,
      }
    }
    case 'Projection': {
      const of = refToString(lineage.of)
      return {
        badge: '≈',
        badgeTitle: `Projection of ${of}`,
        kindLabel: 'Projection',
        summary: `Projection of ${of}`,
        details:
          lineage.stalenessMs !== undefined
            ? [{ label: 'staleness', value: `${lineage.stalenessMs}ms` }]
            : undefined,
      }
    }
    case 'Cache': {
      const of = refToString(lineage.of)
      return {
        badge: '☷',
        badgeTitle: `Cache of ${of}`,
        kindLabel: 'Cache',
        summary: `Cached value of ${of}`,
        details:
          lineage.ttlMs !== undefined ? [{ label: 'ttl', value: `${lineage.ttlMs}ms` }] : undefined,
      }
    }
    case 'Mirror': {
      const of = refToString(lineage.of)
      return {
        badge: '↻',
        badgeTitle: `Mirror of ${of}`,
        kindLabel: 'Mirror',
        summary:
          lineage.system !== undefined
            ? `Mirror of ${of} from ${lineage.system}`
            : `Mirror of ${of}`,
        details:
          lineage.system !== undefined ? [{ label: 'system', value: lineage.system }] : undefined,
      }
    }
    case 'External': {
      return {
        badge: '↗',
        badgeTitle: `External (${lineage.system})`,
        kindLabel: 'External',
        summary:
          lineage.ref !== undefined
            ? `External reference ${lineage.system}:${lineage.ref}`
            : `External reference in ${lineage.system}`,
        details: [{ label: 'system', value: lineage.system }],
      }
    }
    case 'Computed': {
      return {
        badge: '⊙',
        badgeTitle: 'Computed (not persisted)',
        kindLabel: 'Computed',
        summary: lineage.description ?? lineage.fn ?? 'Computed at read time',
        details: lineage.fn !== undefined ? [{ label: 'fn', value: lineage.fn }] : undefined,
      }
    }
  }
}
