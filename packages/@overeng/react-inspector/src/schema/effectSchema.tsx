import type { SchemaAST } from 'effect'

import * as Lineage from './lineage.ts'

export interface SchemaView {
  readonly ast: SchemaAST.AST
}

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

export interface SchemaConstraint {
  label: string
  value: string
}

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
  containerLabel?: string
  lineage?: LineageBundle
  hasContent: boolean
}

export interface LineageBundle {
  display: Lineage.LineageDisplay
  authority?: Lineage.Authority
  freshness?: Lineage.Freshness
  reference?: Lineage.Reference
}

const view = (ast: SchemaAST.AST): SchemaView => ({ ast })

const isNullishAst = (ast: SchemaAST.AST): boolean =>
  ast._tag === 'Null' || ast._tag === 'Undefined' || ast._tag === 'Void'

const unwrapAstForDisplay = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (ast._tag === 'Suspend') return unwrapAstForDisplay(ast.thunk())
  if (ast._tag === 'Union') {
    const nonNullish = ast.types.filter((member) => isNullishAst(member) === false)
    if (nonNullish.length === 1 && nonNullish[0] !== undefined) {
      return unwrapAstForDisplay(nonNullish[0])
    }
  }
  return ast
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

export const getAnnotationsFromAST = (ast: SchemaAST.AST): SchemaAnnotations => {
  const annotations: Record<string, unknown> = {
    ...ast.context?.annotations,
    ...ast.annotations,
  }
  for (const check of ast.checks ?? []) Object.assign(annotations, check.annotations)
  const customPretty = annotations.pretty
  const formatterFactory = annotations.toFormatter
  let pretty: ((value: unknown) => string) | undefined
  if (typeof customPretty === 'function') {
    pretty = (value) => {
      const formatted = customPretty(value)
      if (typeof formatted !== 'string')
        throw new TypeError('pretty annotation must return a string')
      return formatted
    }
  } else if (typeof formatterFactory === 'function') {
    try {
      const formatter = formatterFactory([])
      if (typeof formatter === 'function') pretty = formatter
    } catch {
      // Some declaration formatters require type-parameter formatters.
    }
  }
  return {
    ...(typeof annotations.identifier === 'string' ? { identifier: annotations.identifier } : {}),
    ...(typeof annotations.title === 'string' ? { title: annotations.title } : {}),
    ...(typeof annotations.description === 'string'
      ? { description: annotations.description }
      : {}),
    ...(pretty === undefined ? {} : { pretty }),
    ...(Array.isArray(annotations.examples) === true ? { examples: annotations.examples } : {}),
    ...('default' in annotations ? { default: annotations.default } : {}),
    ...(asRecord(annotations.jsonSchema) === undefined
      ? {}
      : { jsonSchema: asRecord(annotations.jsonSchema) }),
    ...(typeof annotations.documentation === 'string'
      ? { documentation: annotations.documentation }
      : {}),
  }
}

export const getAnnotations = (schema: SchemaView): SchemaAnnotations =>
  getAnnotationsFromAST(unwrapAstForDisplay(schema.ast))

export const getDisplayName = (annotations: SchemaAnnotations): string | undefined =>
  annotations.title ?? annotations.identifier

export const formatWithPretty = (
  value: unknown,
  annotations: SchemaAnnotations,
): string | undefined => {
  try {
    return annotations.pretty?.(value)
  } catch {
    return undefined
  }
}

export const isEffectSchema = (obj: unknown): obj is SchemaView => {
  if (obj === null || typeof obj !== 'object' || !('ast' in obj)) return false
  const ast = (obj as { readonly ast?: unknown }).ast
  return ast !== null && typeof ast === 'object' && '_tag' in ast
}

export const getFieldSchema = (schema: SchemaView, fieldName: string): SchemaView | undefined => {
  const ast = unwrapAstForDisplay(schema.ast)
  if (ast._tag !== 'Objects') return undefined
  const property = ast.propertySignatures.find((signature) => signature.name === fieldName)
  if (property !== undefined) return view(property.type)
  const index = ast.indexSignatures[0]
  return index === undefined ? undefined : view(index.type)
}

export const getArrayElementSchema = (schema: SchemaView): SchemaView | undefined => {
  const ast = unwrapAstForDisplay(schema.ast)
  if (ast._tag !== 'Arrays') return undefined
  const element = ast.rest[0] ?? ast.elements[0]
  return element === undefined ? undefined : view(element)
}

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

const getTypeKind = (ast: SchemaAST.AST): string | undefined => {
  switch (ast._tag) {
    case 'String':
      return 'string'
    case 'Number':
      return 'number'
    case 'Boolean':
      return 'boolean'
    case 'BigInt':
      return 'bigint'
    case 'Symbol':
      return 'symbol'
    case 'ObjectKeyword':
      return 'object'
    case 'Unknown':
      return 'unknown'
    case 'Any':
      return 'any'
    case 'Never':
      return 'never'
    case 'Void':
      return 'void'
    case 'Undefined':
      return 'undefined'
    case 'Null':
      return 'null'
    case 'Literal':
      return 'literal'
    case 'Enum':
      return 'enum'
    case 'TemplateLiteral':
      return 'template literal'
    case 'Arrays':
      return 'array'
    case 'Objects':
      return 'struct'
    case 'Union':
      return 'union'
    case 'Suspend':
      return 'suspend'
    case 'Declaration':
      return 'declaration'
    default:
      return undefined
  }
}

const constraintRules: ReadonlyArray<
  [key: string, render: (value: unknown) => SchemaConstraint | undefined]
> = [
  ['minLength', (value) => ({ label: 'min length', value: String(value) })],
  ['maxLength', (value) => ({ label: 'max length', value: String(value) })],
  ['minimum', (value) => ({ label: '≥', value: String(value) })],
  ['maximum', (value) => ({ label: '≤', value: String(value) })],
  ['exclusiveMinimum', (value) => ({ label: '>', value: String(value) })],
  ['exclusiveMaximum', (value) => ({ label: '<', value: String(value) })],
  ['multipleOf', (value) => ({ label: 'multiple of', value: String(value) })],
  [
    'pattern',
    (value) => ({
      label: 'pattern',
      value: value instanceof RegExp ? value.toString() : `/${String(value)}/`,
    }),
  ],
  ['integer', () => ({ label: 'integer', value: 'yes' })],
  ['format', (value) => ({ label: 'format', value: String(value) })],
]

export const getConstraintsFromJSONSchema = (
  ast: SchemaAST.AST,
): ReadonlyArray<SchemaConstraint> => {
  const constraints: Record<string, unknown> = {
    ...getAnnotationsFromAST(ast).jsonSchema,
  }
  for (const check of ast.checks ?? []) {
    const arbitrary = asRecord(check.annotations?.arbitrary)
    const constraint = asRecord(arbitrary?.constraint)
    if (constraint !== undefined) Object.assign(constraints, constraint)

    const meta = asRecord(check.annotations?.meta)
    switch (meta?._tag) {
      case 'isMinLength':
        constraints.minLength = meta.minLength
        break
      case 'isMaxLength':
        constraints.maxLength = meta.maxLength
        break
      case 'isPattern':
        constraints.pattern = meta.regExp
        break
      case 'isInt':
        constraints.integer = true
        break
      case 'isBetween':
        constraints[meta.exclusiveMinimum === true ? 'exclusiveMinimum' : 'minimum'] = meta.minimum
        constraints[meta.exclusiveMaximum === true ? 'exclusiveMaximum' : 'maximum'] = meta.maximum
        break
    }
  }
  return constraintRules.flatMap(([key, render]) => {
    if (!(key in constraints)) return []
    const rendered = render(constraints[key])
    return rendered === undefined ? [] : [rendered]
  })
}

const MAX_POSSIBLE_VALUES = 12

export const getPossibleValuesFromAST = (
  rawAst: SchemaAST.AST,
): { values: ReadonlyArray<string>; truncated: number } | undefined => {
  const ast = unwrapAstForDisplay(rawAst)
  const collected: string[] = []
  if (ast._tag === 'Literal') collected.push(stringifyShort(ast.literal))
  else if (ast._tag === 'Enum') {
    for (const value of ast.enums) collected.push(stringifyShort(value))
  } else if (
    ast._tag === 'Union' &&
    ast.types.every((member) => member._tag === 'Literal') === true
  ) {
    for (const member of ast.types) {
      if (member._tag === 'Literal') collected.push(stringifyShort(member.literal))
    }
  } else if (ast._tag === 'TemplateLiteral') collected.push(`\`${ast.toString()}\``)
  if (collected.length === 0) return undefined
  return {
    values: collected.slice(0, MAX_POSSIBLE_VALUES),
    truncated: Math.max(0, collected.length - MAX_POSSIBLE_VALUES),
  }
}

const TRIVIAL_DESCRIPTIONS = new Set([
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
])

const getElementLabelForAST = (rawAst: SchemaAST.AST): string | undefined => {
  const displayName = getDisplayName(getAnnotationsFromAST(rawAst))
  if (displayName !== undefined) return displayName
  const ast = unwrapAstForDisplay(rawAst)
  if (ast._tag === 'Literal') return stringifyShort(ast.literal)
  return getTypeKind(ast)
}

const getContainerLabelForAST = (rawAst: SchemaAST.AST): string | undefined => {
  const ast = unwrapAstForDisplay(rawAst)
  if (ast._tag === 'Arrays') {
    if (ast.elements.length === 0 && ast.rest[0] !== undefined) {
      const label = getElementLabelForAST(ast.rest[0])
      return label === undefined ? undefined : `Array<${label}>`
    }
    if (ast.elements.length > 0) {
      const labels = ast.elements.map(getElementLabelForAST)
      return labels.every((label) => label !== undefined) === true
        ? `[${labels.join(', ')}]`
        : undefined
    }
  }
  if (ast._tag === 'Objects' && ast.propertySignatures.length === 0) {
    const index = ast.indexSignatures[0]
    if (index !== undefined) {
      const key = getElementLabelForAST(index.parameter) ?? 'string'
      const value = getElementLabelForAST(index.type)
      return value === undefined ? undefined : `Record<${key}, ${value}>`
    }
  }
  if (ast._tag === 'Declaration') {
    const typeConstructor = asRecord(ast.annotations?.typeConstructor)
    if (typeConstructor?._tag === 'ReadonlyMap' && ast.typeParameters.length === 2) {
      const key =
        ast.typeParameters[0] === undefined
          ? undefined
          : getElementLabelForAST(ast.typeParameters[0])
      const value =
        ast.typeParameters[1] === undefined
          ? undefined
          : getElementLabelForAST(ast.typeParameters[1])
      return key === undefined || value === undefined ? undefined : `ReadonlyMap<${key}, ${value}>`
    }
    if (typeConstructor?._tag === 'ReadonlySet' && ast.typeParameters[0] !== undefined) {
      const value = getElementLabelForAST(ast.typeParameters[0])
      return value === undefined ? undefined : `ReadonlySet<${value}>`
    }
  }
  return undefined
}

export const narrowUnionByTag = (rawAst: SchemaAST.AST, value: unknown): SchemaAST.AST => {
  if (value === null || typeof value !== 'object' || !('_tag' in value)) return rawAst
  const ast = unwrapAstForDisplay(rawAst)
  if (ast._tag !== 'Union') return rawAst
  for (const member of ast.types) {
    const candidate = unwrapAstForDisplay(member)
    if (candidate._tag !== 'Objects') continue
    const tag = candidate.propertySignatures.find((property) => property.name === '_tag')?.type
    if (tag?._tag === 'Literal' && tag.literal === (value as { readonly _tag: unknown })._tag) {
      return member
    }
  }
  return rawAst
}

export const getMapKeyValueSchema = (
  schema: SchemaView,
): { key: SchemaView; value: SchemaView } | undefined => {
  const ast = unwrapAstForDisplay(schema.ast)
  if (ast._tag !== 'Declaration') return undefined
  const typeConstructor = asRecord(ast.annotations?.typeConstructor)
  if (typeConstructor?._tag !== 'ReadonlyMap') return undefined
  const [key, value] = ast.typeParameters
  return key === undefined || value === undefined
    ? undefined
    : { key: view(key), value: view(value) }
}

export const getSetElementSchema = (schema: SchemaView): SchemaView | undefined => {
  const ast = unwrapAstForDisplay(schema.ast)
  if (ast._tag !== 'Declaration') return undefined
  const typeConstructor = asRecord(ast.annotations?.typeConstructor)
  const value = ast.typeParameters[0]
  return typeConstructor?._tag === 'ReadonlySet' && value !== undefined ? view(value) : undefined
}

export const getSchemaInfo = (schema: SchemaView): SchemaInfo => {
  const rawAst = schema.ast
  const displayAst = unwrapAstForDisplay(rawAst)
  const annotations = {
    ...getAnnotationsFromAST(displayAst),
    ...getAnnotationsFromAST(rawAst),
  }
  const displayName = getDisplayName(annotations)
  const examples = annotations.examples?.map(
    (value) => formatWithPretty(value, annotations) ?? stringifyShort(value),
  )
  const defaultValue =
    annotations.default === undefined
      ? undefined
      : (formatWithPretty(annotations.default, annotations) ?? stringifyShort(annotations.default))
  const constraints = getConstraintsFromJSONSchema(rawAst)
  const possible = getPossibleValuesFromAST(rawAst)
  const containerLabel = getContainerLabelForAST(rawAst)
  const typeKind = getTypeKind(rawAst)
  const lineageValue = Lineage.getLineage(schema)
  const authority = Lineage.getAuthority(schema)
  const freshness = Lineage.getFreshness(schema)
  const reference = Lineage.getReference(schema)
  const lineage: LineageBundle | undefined =
    lineageValue === undefined &&
    authority === undefined &&
    freshness === undefined &&
    reference === undefined
      ? undefined
      : {
          display:
            lineageValue === undefined
              ? { badge: '', badgeTitle: '', kindLabel: '', summary: '' }
              : Lineage.getLineageDisplay(lineageValue),
          ...(authority === undefined ? {} : { authority }),
          ...(freshness === undefined ? {} : { freshness }),
          ...(reference === undefined ? {} : { reference }),
        }
  const description =
    annotations.description !== undefined &&
    TRIVIAL_DESCRIPTIONS.has(annotations.description) === true
      ? undefined
      : annotations.description
  const hasContent =
    description !== undefined ||
    annotations.documentation !== undefined ||
    examples !== undefined ||
    defaultValue !== undefined ||
    constraints.length > 0 ||
    possible !== undefined ||
    lineage !== undefined
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(typeKind === undefined ? {} : { typeKind }),
    ...(description === undefined ? {} : { description }),
    ...(annotations.documentation === undefined
      ? {}
      : { documentation: annotations.documentation }),
    ...(examples === undefined ? {} : { examples }),
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(constraints.length === 0 ? {} : { constraints }),
    ...(possible === undefined
      ? {}
      : { possibleValues: possible.values, possibleValuesTruncated: possible.truncated }),
    ...(containerLabel === undefined ? {} : { containerLabel }),
    ...(lineage === undefined ? {} : { lineage }),
    hasContent,
  }
}

export type SchemaRegistry = Map<string, SchemaView>

export const createSchemaRegistry = (): SchemaRegistry => new Map()

export const registerSchema = (
  registry: SchemaRegistry,
  schema: SchemaView,
  name?: string,
): void => {
  const annotations = getAnnotations(schema)
  const key = name ?? annotations.identifier ?? annotations.title
  if (key !== undefined) registry.set(key, schema)
}

export const lookupSchema = (registry: SchemaRegistry, name: string): SchemaView | undefined =>
  registry.get(name)
