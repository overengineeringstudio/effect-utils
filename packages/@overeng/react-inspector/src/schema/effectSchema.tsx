import * as Lineage from './lineage.ts'

export interface SchemaAstView {
  readonly _tag: string
}

export interface SchemaAst extends SchemaAstView {
  readonly annotations?: object
  readonly context?: { readonly annotations?: object }
  readonly checks?: ReadonlyArray<{
    readonly annotations?: object
  }>
  readonly types?: ReadonlyArray<SchemaAst>
  readonly propertySignatures?: ReadonlyArray<{
    readonly name: PropertyKey
    readonly type: SchemaAst
    readonly annotations?: object
  }>
  readonly indexSignatures?: ReadonlyArray<{
    readonly parameter: SchemaAst
    readonly type: SchemaAst
  }>
  readonly elements?: ReadonlyArray<SchemaAst | { readonly type: SchemaAst }>
  readonly rest?: ReadonlyArray<SchemaAst | { readonly type: SchemaAst }>
  readonly literal?: unknown
  readonly enums?: ReadonlyArray<unknown | readonly [string, unknown]>
  readonly typeParameters?: ReadonlyArray<SchemaAst>
  readonly thunk?: () => SchemaAst
  readonly f?: () => SchemaAst
  readonly from?: SchemaAst
  readonly to?: SchemaAst
  readonly toString: () => string
}

export interface SchemaView {
  readonly ast: SchemaAstView
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

const details = (ast: SchemaAstView): SchemaAst => ast

const view = (ast: SchemaAstView): SchemaView => ({ ast })

const isNullishAst = (ast: SchemaAst): boolean =>
  ast._tag === 'Null' ||
  ast._tag === 'Undefined' ||
  ast._tag === 'Void' ||
  ast._tag === 'UndefinedKeyword' ||
  ast._tag === 'VoidKeyword' ||
  (ast._tag === 'Literal' && ast.literal === null)

const unwrapAstForDisplay = (rawAst: SchemaAstView): SchemaAst => {
  const ast = details(rawAst)
  if (ast._tag === 'Transformation' && ast.to !== undefined) return unwrapAstForDisplay(ast.to)
  if (ast._tag === 'Refinement' && ast.from !== undefined) return unwrapAstForDisplay(ast.from)
  if (ast._tag === 'Suspend') {
    const suspended = ast.thunk ?? ast.f
    if (suspended !== undefined) return unwrapAstForDisplay(suspended())
  }
  if (ast._tag === 'Union' && ast.types !== undefined) {
    const nonNullish = ast.types.filter((member) => isNullishAst(member) === false)
    if (nonNullish.length === 1 && nonNullish[0] !== undefined) {
      return unwrapAstForDisplay(nonNullish[0])
    }
  }
  return ast
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

const effect3AnnotationKeys = {
  identifier: Symbol.for('effect/annotation/Identifier'),
  title: Symbol.for('effect/annotation/Title'),
  description: Symbol.for('effect/annotation/Description'),
  pretty: Symbol.for('effect/annotation/Pretty'),
  examples: Symbol.for('effect/annotation/Examples'),
  default: Symbol.for('effect/annotation/Default'),
  jsonSchema: Symbol.for('effect/annotation/JSONSchema'),
  documentation: Symbol.for('effect/annotation/Documentation'),
  typeConstructor: Symbol.for('effect/annotation/TypeConstructor'),
} as const

const readAnnotation = (annotations: object, key: keyof typeof effect3AnnotationKeys): unknown =>
  Reflect.get(annotations, key) ?? Reflect.get(annotations, effect3AnnotationKeys[key])

export const getAnnotationsFromAST = (rawAst: SchemaAstView): SchemaAnnotations => {
  const ast = details(rawAst)
  const annotations = {
    ...ast.context?.annotations,
    ...ast.annotations,
  }
  for (const check of ast.checks ?? []) Object.assign(annotations, check.annotations)
  const customPretty = readAnnotation(annotations, 'pretty')
  const formatterFactory = Reflect.get(annotations, 'toFormatter')
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
    ...(typeof readAnnotation(annotations, 'identifier') === 'string'
      ? { identifier: readAnnotation(annotations, 'identifier') as string }
      : {}),
    ...(typeof readAnnotation(annotations, 'title') === 'string'
      ? { title: readAnnotation(annotations, 'title') as string }
      : {}),
    ...(typeof readAnnotation(annotations, 'description') === 'string'
      ? { description: readAnnotation(annotations, 'description') as string }
      : {}),
    ...(pretty === undefined ? {} : { pretty }),
    ...(Array.isArray(readAnnotation(annotations, 'examples')) === true
      ? { examples: readAnnotation(annotations, 'examples') as ReadonlyArray<unknown> }
      : {}),
    ...(readAnnotation(annotations, 'default') === undefined
      ? {}
      : { default: readAnnotation(annotations, 'default') }),
    ...(asRecord(readAnnotation(annotations, 'jsonSchema')) === undefined
      ? {}
      : { jsonSchema: asRecord(readAnnotation(annotations, 'jsonSchema')) }),
    ...(typeof readAnnotation(annotations, 'documentation') === 'string'
      ? { documentation: readAnnotation(annotations, 'documentation') as string }
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
  if (ast._tag !== 'Objects' && ast._tag !== 'TypeLiteral') return undefined
  const property = ast.propertySignatures?.find((signature) => signature.name === fieldName)
  if (property !== undefined) {
    const annotations = property.annotations
    if (annotations === undefined) return view(property.type)
    const merged: SchemaAst = {
      ...property.type,
      annotations: { ...property.type.annotations, ...annotations },
    }
    return view(merged)
  }
  const index = ast.indexSignatures?.[0]
  return index === undefined ? undefined : view(index.type)
}

export const getArrayElementSchema = (schema: SchemaView): SchemaView | undefined => {
  const ast = unwrapAstForDisplay(schema.ast)
  if (ast._tag !== 'Arrays' && ast._tag !== 'TupleType') return undefined
  const element = ast.rest?.[0] ?? ast.elements?.[0]
  if (element === undefined) return undefined
  return view('type' in element ? element.type : element)
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

const getTypeKind = (ast: SchemaAst): string | undefined => {
  switch (ast._tag) {
    case 'String':
    case 'StringKeyword':
      return 'string'
    case 'Number':
    case 'NumberKeyword':
      return 'number'
    case 'Boolean':
    case 'BooleanKeyword':
      return 'boolean'
    case 'BigInt':
    case 'BigIntKeyword':
      return 'bigint'
    case 'Symbol':
    case 'SymbolKeyword':
      return 'symbol'
    case 'ObjectKeyword':
      return 'object'
    case 'Unknown':
    case 'UnknownKeyword':
      return 'unknown'
    case 'Any':
    case 'AnyKeyword':
      return 'any'
    case 'Never':
    case 'NeverKeyword':
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
    case 'Enums':
      return 'enum'
    case 'TemplateLiteral':
      return 'template literal'
    case 'Arrays':
    case 'TupleType':
      return 'array'
    case 'Objects':
    case 'TypeLiteral':
      return 'struct'
    case 'Union':
      return 'union'
    case 'Suspend':
      return 'suspend'
    case 'Refinement':
      return 'refinement'
    case 'Transformation':
      return 'transform'
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
  rawAst: SchemaAstView,
): ReadonlyArray<SchemaConstraint> => {
  const ast = details(rawAst)
  const constraints: Record<string, unknown> = {
    ...getAnnotationsFromAST(ast).jsonSchema,
  }
  for (const check of ast.checks ?? []) {
    const arbitrary = asRecord(
      check.annotations === undefined ? undefined : Reflect.get(check.annotations, 'arbitrary'),
    )
    const constraint = asRecord(arbitrary?.constraint)
    if (constraint !== undefined) Object.assign(constraints, constraint)

    const meta = asRecord(
      check.annotations === undefined ? undefined : Reflect.get(check.annotations, 'meta'),
    )
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
  rawAst: SchemaAstView,
): { values: ReadonlyArray<string>; truncated: number } | undefined => {
  const ast = unwrapAstForDisplay(rawAst)
  const collected: string[] = []
  if (ast._tag === 'Literal') collected.push(stringifyShort(ast.literal))
  else if ((ast._tag === 'Enum' || ast._tag === 'Enums') && ast.enums !== undefined) {
    for (const entry of ast.enums) {
      collected.push(stringifyShort(Array.isArray(entry) === true ? entry[1] : entry))
    }
  } else if (
    ast._tag === 'Union' &&
    ast.types?.every((member) => member._tag === 'Literal') === true
  ) {
    for (const member of ast.types ?? []) {
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

const getElementLabelForAST = (rawAst: SchemaAstView): string | undefined => {
  const displayName = getDisplayName(getAnnotationsFromAST(rawAst))
  if (displayName !== undefined) return displayName
  const ast = unwrapAstForDisplay(rawAst)
  if (ast._tag === 'Literal') return stringifyShort(ast.literal)
  return getTypeKind(ast)
}

const elementAst = (element: SchemaAst | { readonly type: SchemaAst }): SchemaAst =>
  'type' in element ? element.type : element

const getContainerLabelForAST = (rawAst: SchemaAstView): string | undefined => {
  const ast = unwrapAstForDisplay(rawAst)
  if (ast._tag === 'Arrays' || ast._tag === 'TupleType') {
    if ((ast.elements?.length ?? 0) === 0 && ast.rest?.[0] !== undefined) {
      const label = getElementLabelForAST(elementAst(ast.rest[0]))
      return label === undefined ? undefined : `Array<${label}>`
    }
    if ((ast.elements?.length ?? 0) > 0) {
      const labels = (ast.elements ?? []).map((element) =>
        getElementLabelForAST(elementAst(element)),
      )
      return labels.every((label) => label !== undefined) === true
        ? `[${labels.join(', ')}]`
        : undefined
    }
  }
  if (
    (ast._tag === 'Objects' || ast._tag === 'TypeLiteral') &&
    (ast.propertySignatures?.length ?? 0) === 0
  ) {
    const index = ast.indexSignatures?.[0]
    if (index !== undefined) {
      const key = getElementLabelForAST(index.parameter) ?? 'string'
      const value = getElementLabelForAST(index.type)
      return value === undefined ? undefined : `Record<${key}, ${value}>`
    }
  }
  if (ast._tag === 'Declaration') {
    const typeConstructor = asRecord(readAnnotation(ast.annotations ?? {}, 'typeConstructor'))
    if (typeConstructor?._tag === 'ReadonlyMap' && ast.typeParameters?.length === 2) {
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
    if (typeConstructor?._tag === 'ReadonlySet' && ast.typeParameters?.[0] !== undefined) {
      const value = getElementLabelForAST(ast.typeParameters[0])
      return value === undefined ? undefined : `ReadonlySet<${value}>`
    }
  }
  return undefined
}

export const narrowUnionByTag = (rawAst: SchemaAstView, value: unknown): SchemaAstView => {
  if (value === null || typeof value !== 'object' || !('_tag' in value)) return rawAst
  const ast = unwrapAstForDisplay(rawAst)
  if (ast._tag !== 'Union') return rawAst
  for (const member of ast.types ?? []) {
    const candidate = unwrapAstForDisplay(member)
    if (candidate._tag !== 'Objects' && candidate._tag !== 'TypeLiteral') continue
    const tag = candidate.propertySignatures?.find((property) => property.name === '_tag')?.type
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
  const typeConstructor = asRecord(readAnnotation(ast.annotations ?? {}, 'typeConstructor'))
  if (typeConstructor?._tag !== 'ReadonlyMap') return undefined
  const [key, value] = ast.typeParameters ?? []
  return key === undefined || value === undefined
    ? undefined
    : { key: view(key), value: view(value) }
}

export const getSetElementSchema = (schema: SchemaView): SchemaView | undefined => {
  const ast = unwrapAstForDisplay(schema.ast)
  if (ast._tag !== 'Declaration') return undefined
  const typeConstructor = asRecord(readAnnotation(ast.annotations ?? {}, 'typeConstructor'))
  const value = ast.typeParameters?.[0]
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
