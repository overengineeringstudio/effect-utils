import type { Schema as S, SchemaAST } from 'effect'

/** Symbols used by Effect Schema for annotations */
const IdentifierAnnotationId = Symbol.for('effect/annotation/Identifier')
const TitleAnnotationId = Symbol.for('effect/annotation/Title')
const DescriptionAnnotationId = Symbol.for('effect/annotation/Description')
const PrettyAnnotationId = Symbol.for('effect/annotation/Pretty')
const ExamplesAnnotationId = Symbol.for('effect/annotation/Examples')
const DefaultAnnotationId = Symbol.for('effect/annotation/Default')
const JSONSchemaAnnotationId = Symbol.for('effect/annotation/JSONSchema')
const DocumentationAnnotationId = Symbol.for('effect/annotation/Documentation')

export interface SchemaAnnotations {
  identifier?: string | undefined
  title?: string | undefined
  description?: string | undefined
  pretty?: ((value: unknown) => string) | undefined
  examples?: ReadonlyArray<unknown> | undefined
  default?: unknown
  jsonSchema?: Record<string, unknown> | undefined
  documentation?: string | undefined
}

/** A constraint extracted from a JSON Schema annotation, ready for display. */
export interface SchemaConstraint {
  label: string
  value: string
}

/**
 * Aggregated, display-ready schema information for a single tree node.
 *
 * `hasContent` is true when at least one field beyond `displayName`/`typeKind`
 * has content — callers use it to decide whether to render a tooltip at all.
 */
export interface SchemaInfo {
  displayName?: string
  typeKind?: string
  description?: string
  documentation?: string
  examples?: ReadonlyArray<string>
  defaultValue?: string
  constraints?: ReadonlyArray<SchemaConstraint>
  possibleValues?: ReadonlyArray<string>
  possibleValuesTruncated?: number
  hasContent: boolean
}

const isNullishAst = (ast: SchemaAST.AST): boolean => {
  if (ast._tag === 'UndefinedKeyword' || ast._tag === 'VoidKeyword') return true
  return ast._tag === 'Literal' && ast.literal === null
}

const unwrapAstForDisplay = (ast: SchemaAST.AST): SchemaAST.AST => {
  switch (ast._tag) {
    case 'Transformation':
      return unwrapAstForDisplay(ast.to)
    case 'Refinement':
      return unwrapAstForDisplay(ast.from)
    case 'Suspend':
      return unwrapAstForDisplay(ast.f())
    case 'Union': {
      const nonNullish = ast.types.filter((member) => !isNullishAst(member))
      if (nonNullish.length === 1) {
        const [only] = nonNullish
        if (only !== undefined) return unwrapAstForDisplay(only)
      }
      return ast
    }
    default:
      return ast
  }
}

/** Extract annotations from a Schema AST node */
export const getAnnotationsFromAST = (ast: SchemaAST.AST): SchemaAnnotations => {
  const annotations = ast.annotations
  return {
    identifier: annotations[IdentifierAnnotationId] as string | undefined,
    title: annotations[TitleAnnotationId] as string | undefined,
    description: annotations[DescriptionAnnotationId] as string | undefined,
    pretty: annotations[PrettyAnnotationId] as ((value: unknown) => string) | undefined,
    examples: annotations[ExamplesAnnotationId] as ReadonlyArray<unknown> | undefined,
    default: annotations[DefaultAnnotationId],
    jsonSchema: annotations[JSONSchemaAnnotationId] as Record<string, unknown> | undefined,
    documentation: annotations[DocumentationAnnotationId] as string | undefined,
  }
}

/** Extract annotations from a Schema */
export const getAnnotations = (schema: S.Schema.AnyNoContext): SchemaAnnotations => {
  return getAnnotationsFromAST(unwrapAstForDisplay(schema.ast))
}

/** Get display name from schema annotations (prefer title, fallback to identifier) */
export const getDisplayName = (annotations: SchemaAnnotations): string | undefined => {
  return annotations.title ?? annotations.identifier
}

/** Format a value using the schema's pretty annotation if available */
export const formatWithPretty = (
  value: unknown,
  annotations: SchemaAnnotations,
): string | undefined => {
  if (annotations.pretty !== undefined) {
    try {
      const result = annotations.pretty(value)
      // Effect's built-in schemas may have pretty annotations that return functions (hooks)
      // rather than formatted strings. Only return the result if it's actually a string.
      if (typeof result === 'string') {
        return result
      }
      return undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Check if an object might be an Effect Schema (duck typing for optional dependency) */
export const isEffectSchema = (obj: unknown): obj is S.Schema.AnyNoContext => {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'ast' in obj &&
    typeof (obj as { ast: unknown }).ast === 'object' &&
    (obj as { ast: { annotations?: unknown } }).ast !== null &&
    'annotations' in ((obj as { ast: { annotations?: unknown } }).ast ?? {})
  )
}

/**
 * Apply field/property-level annotations on top of the field type's annotations.
 *
 * Why: Effect Schema lets users put `.annotations({ description: ... })` on
 * either the field itself (via `Schema.propertySignature(...).annotations(...)`)
 * or on the field's value type. We merge so the field-level annotations win,
 * which matches user intent — a field-specific description shouldn't be hidden
 * by a generic one on the value type.
 */
const mergeAnnotations = (
  base: SchemaAST.AST,
  overrides: SchemaAST.AST['annotations'] | undefined,
): SchemaAST.AST => {
  if (overrides === undefined || Object.getOwnPropertySymbols(overrides).length === 0) {
    return base
  }
  return {
    ...base,
    annotations: { ...base.annotations, ...overrides },
  } as SchemaAST.AST
}

/**
 * Try to find a matching schema for a Struct field.
 *
 * Returns the field type's *raw* AST (with the PropertySignature's own
 * annotations merged on top). Refinement/Transformation/Union wrappers are
 * preserved so callers like {@link getSchemaInfo} can read user-supplied
 * annotations that live on those wrappers. Downstream traversals
 * (`getFieldSchema`, `getArrayElementSchema`) re-apply `unwrapAstForDisplay`
 * before pattern-matching, so the preserved wrapper doesn't block deeper
 * lookups.
 */
export const getFieldSchema = (
  schema: S.Schema.AnyNoContext,
  fieldName: string,
): S.Schema.AnyNoContext | undefined => {
  const ast = unwrapAstForDisplay(schema.ast)

  if (ast._tag === 'TypeLiteral' && 'propertySignatures' in ast) {
    const typeLiteralAst = ast as SchemaAST.TypeLiteral
    const propSig = typeLiteralAst.propertySignatures.find((sig) => sig.name === fieldName)
    if (propSig !== undefined) {
      return {
        ast: mergeAnnotations(propSig.type, propSig.annotations),
      } as S.Schema.AnyNoContext
    }
  }

  return undefined
}

/** Get schema for array elements if the schema is an array/tuple. */
export const getArrayElementSchema = (
  schema: S.Schema.AnyNoContext,
): S.Schema.AnyNoContext | undefined => {
  const ast = unwrapAstForDisplay(schema.ast)

  if (ast._tag === 'TupleType' && 'rest' in ast) {
    const tupleAst = ast as SchemaAST.TupleType
    if (tupleAst.rest.length > 0) {
      const [firstRest] = tupleAst.rest
      if (firstRest !== undefined) {
        return { ast: firstRest.type } as S.Schema.AnyNoContext
      }
    }
  }

  return undefined
}

/* --------------------------------------------------------------------------
 * Display-ready schema info (used by the tooltip)
 * -------------------------------------------------------------------------- */

const stringifyShort = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

const formatValueForDisplay = (value: unknown, annotations: SchemaAnnotations): string => {
  return formatWithPretty(value, annotations) ?? stringifyShort(value)
}

/**
 * Human-friendly label for the AST kind. Surfaced as the small caps subtitle
 * in the tooltip header when no `title`/`identifier` is set, and as a hint
 * alongside `displayName` when one is set.
 */
const getTypeKind = (rawAst: SchemaAST.AST): string | undefined => {
  // Note: we read off the *raw* AST (before unwrap) so wrapper kinds like
  // Refinement/Union are visible to the user when they would otherwise be
  // silently unwrapped.
  switch (rawAst._tag) {
    case 'StringKeyword':
      return 'string'
    case 'NumberKeyword':
      return 'number'
    case 'BooleanKeyword':
      return 'boolean'
    case 'BigIntKeyword':
      return 'bigint'
    case 'SymbolKeyword':
      return 'symbol'
    case 'ObjectKeyword':
      return 'object'
    case 'UnknownKeyword':
      return 'unknown'
    case 'AnyKeyword':
      return 'any'
    case 'NeverKeyword':
      return 'never'
    case 'VoidKeyword':
      return 'void'
    case 'UndefinedKeyword':
      return 'undefined'
    case 'Literal':
      return 'literal'
    case 'Enums':
      return 'enum'
    case 'TemplateLiteral':
      return 'template literal'
    case 'TupleType':
      return 'array'
    case 'TypeLiteral':
      return 'struct'
    case 'Union':
      return 'union'
    case 'Refinement':
      return 'refinement'
    case 'Transformation':
      return 'transform'
    case 'Suspend':
      return 'suspend'
    case 'Declaration':
      return 'declaration'
    default:
      return undefined
  }
}

/* JSON Schema -> human constraint extraction.
 *
 * We deliberately only surface keys that have an obvious one-line rendering;
 * unknown keys are dropped rather than dumped as raw JSON. */
const jsonSchemaConstraintRules: ReadonlyArray<
  [key: string, render: (value: unknown) => SchemaConstraint | undefined]
> = [
  ['minLength', (v) => ({ label: 'min length', value: String(v) })],
  ['maxLength', (v) => ({ label: 'max length', value: String(v) })],
  ['minItems', (v) => ({ label: 'min items', value: String(v) })],
  ['maxItems', (v) => ({ label: 'max items', value: String(v) })],
  ['minimum', (v) => ({ label: '≥', value: String(v) })],
  ['maximum', (v) => ({ label: '≤', value: String(v) })],
  ['exclusiveMinimum', (v) => ({ label: '>', value: String(v) })],
  ['exclusiveMaximum', (v) => ({ label: '<', value: String(v) })],
  ['multipleOf', (v) => ({ label: 'multiple of', value: String(v) })],
  ['uniqueItems', (v) => (v === true ? { label: 'unique items', value: '' } : undefined)],
  ['pattern', (v) => ({ label: 'pattern', value: `/${String(v)}/` })],
  ['format', (v) => ({ label: 'format', value: String(v) })],
]

/**
 * Walk Refinement chain to collect JSON Schema annotations, then map known
 * keys to human-readable constraints.
 *
 * Refinements stack (e.g. `Int.pipe(positive(), between(0, 10))`) and each
 * link can contribute its own JSON Schema fragment. We merge with later
 * (outer) refinements winning, since those are the user's most specific
 * intent.
 */
export const getConstraintsFromJSONSchema = (
  rawAst: SchemaAST.AST,
): ReadonlyArray<SchemaConstraint> => {
  const fragments: Record<string, unknown> = {}
  /*
   * Guard against self-referential Suspend chains (e.g. recursive schemas
   * defined via `Schema.suspend(() => SomeSchema)`). Without this guard,
   * `collect` would recurse infinitely on identity-cycle schemas — try/catch
   * around `ast.f()` wouldn't catch it because it's not a thrown error.
   */
  const seen = new WeakSet<SchemaAST.AST>()

  const collect = (ast: SchemaAST.AST): void => {
    if (seen.has(ast)) return
    seen.add(ast)

    const fragment = ast.annotations[JSONSchemaAnnotationId] as Record<string, unknown> | undefined
    if (fragment !== undefined) {
      Object.assign(fragments, fragment)
    }
    if (ast._tag === 'Refinement') {
      collect(ast.from)
    } else if (ast._tag === 'Transformation') {
      collect(ast.to)
    } else if (ast._tag === 'Suspend') {
      try {
        collect(ast.f())
      } catch {
        /* ignore — Suspend may not be safe to evaluate eagerly */
      }
    }
  }

  collect(rawAst)

  const out: SchemaConstraint[] = []
  for (const [key, render] of jsonSchemaConstraintRules) {
    if (key in fragments) {
      const constraint = render(fragments[key])
      if (constraint !== undefined) out.push(constraint)
    }
  }
  return out
}

const MAX_POSSIBLE_VALUES = 12

/** Detect literal/enum/union-of-literal ASTs and surface their allowed values. */
export const getPossibleValuesFromAST = (
  rawAst: SchemaAST.AST,
): { values: ReadonlyArray<string>; truncated: number } | undefined => {
  const ast = unwrapAstForDisplay(rawAst)

  const collected: string[] = []
  let valid = false

  if (ast._tag === 'Literal') {
    collected.push(stringifyShort(ast.literal))
    valid = true
  } else if (ast._tag === 'Enums') {
    valid = true
    for (const [, value] of ast.enums) {
      collected.push(stringifyShort(value))
    }
  } else if (ast._tag === 'Union') {
    valid = ast.types.every((m) => m._tag === 'Literal')
    if (valid) {
      for (const member of ast.types) {
        if (member._tag === 'Literal') {
          collected.push(stringifyShort(member.literal))
        }
      }
    }
  } else if (ast._tag === 'TemplateLiteral') {
    valid = true
    collected.push(`\`${ast.toString()}\``)
  }

  if (!valid || collected.length === 0) return undefined

  if (collected.length > MAX_POSSIBLE_VALUES) {
    return {
      values: collected.slice(0, MAX_POSSIBLE_VALUES),
      truncated: collected.length - MAX_POSSIBLE_VALUES,
    }
  }
  return { values: collected, truncated: 0 }
}

/**
 * Effect's built-in primitive schemas (Schema.String, Schema.Number, etc.)
 * ship with trivial descriptions like "a string", "a number". These are
 * useless in a tooltip — they just repeat what the rendered value already
 * conveys. We exclude them from the `hasContent` decision so that fields
 * without any user-supplied annotations don't get a tooltip affordance.
 *
 * User-supplied descriptions that happen to match these strings are also
 * suppressed; that's an acceptable false negative for keeping the surface
 * clean.
 */
const TRIVIAL_DESCRIPTIONS: ReadonlySet<string> = new Set([
  'a string',
  'a number',
  'a boolean',
  'a bigint',
  'a symbol',
  'an object',
  'any value',
  'an unknown value',
  'never',
  'void',
  'undefined',
  'null',
  'a Date',
  'a Date from a string',
  'a Date from a number',
  'an integer',
  'a finite number',
])

const isTrivialDescription = (description: string | undefined): boolean =>
  description !== undefined && TRIVIAL_DESCRIPTIONS.has(description)

/**
 * Build the display-ready info bundle for a schema.
 *
 * Returns even when the schema has no annotations — callers should check
 * `hasContent` to decide whether the tooltip is worth rendering.
 */
export const getSchemaInfo = (schema: S.Schema.AnyNoContext): SchemaInfo => {
  const rawAst = schema.ast
  const displayAst = unwrapAstForDisplay(rawAst)

  // Read annotations from both the raw and unwrapped AST so things like
  // `description` set on a refinement wrapper are still surfaced.
  const rawAnnotations = getAnnotationsFromAST(rawAst)
  const displayAnnotations = getAnnotationsFromAST(displayAst)
  const annotations: SchemaAnnotations = { ...displayAnnotations, ...rawAnnotations }

  const displayName = getDisplayName(annotations)
  const typeKind = getTypeKind(rawAst)

  const examples =
    annotations.examples !== undefined && annotations.examples.length > 0
      ? annotations.examples.map((v) => formatValueForDisplay(v, annotations))
      : undefined

  const defaultValue =
    annotations.default !== undefined
      ? formatValueForDisplay(annotations.default, annotations)
      : undefined

  const constraints = getConstraintsFromJSONSchema(rawAst)
  const possible = getPossibleValuesFromAST(rawAst)

  const meaningfulDescription = isTrivialDescription(annotations.description)
    ? undefined
    : annotations.description

  const hasContent =
    meaningfulDescription !== undefined ||
    annotations.documentation !== undefined ||
    examples !== undefined ||
    defaultValue !== undefined ||
    constraints.length > 0 ||
    possible !== undefined

  return {
    displayName,
    typeKind,
    description: meaningfulDescription,
    documentation: annotations.documentation,
    examples,
    defaultValue,
    constraints: constraints.length > 0 ? constraints : undefined,
    possibleValues: possible?.values,
    possibleValuesTruncated: possible?.truncated,
    hasContent,
  }
}

export type SchemaRegistry = Map<string, S.Schema.AnyNoContext>

/** Create a schema registry for matching schemas to constructor names */
export const createSchemaRegistry = (): SchemaRegistry => new Map()

/** Register a schema with its identifier/title for lookup */
export const registerSchema = (
  registry: SchemaRegistry,
  schema: S.Schema.AnyNoContext,
  name?: string,
): void => {
  const annotations = getAnnotations(schema)
  const key = name ?? annotations.identifier ?? annotations.title
  if (key !== undefined) {
    registry.set(key, schema)
  }
}

/** Look up a schema by constructor name or other identifier */
export const lookupSchema = (
  registry: SchemaRegistry,
  name: string,
): S.Schema.AnyNoContext | undefined => {
  return registry.get(name)
}
