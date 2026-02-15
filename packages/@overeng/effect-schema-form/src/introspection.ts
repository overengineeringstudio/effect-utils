/**
 * Schema introspection utilities for extracting UI-relevant metadata from Effect Schemas.
 *
 * Uses the Effect Schema AST to determine field types and annotations.
 *
 * ## Effect Schema AST Overview
 *
 * The Schema AST consists of the following node types (from `SchemaAST.AST`):
 *
 * ```
 * AST = Declaration | Literal | UniqueSymbol | UndefinedKeyword | VoidKeyword |
 *       NeverKeyword | UnknownKeyword | AnyKeyword | StringKeyword | NumberKeyword |
 *       BooleanKeyword | BigIntKeyword | SymbolKeyword | ObjectKeyword | Enums |
 *       TemplateLiteral | Refinement | TupleType | TypeLiteral | Union |
 *       Suspend | Transformation
 * ```
 *
 * ## Support Matrix
 *
 * ### Supported (renders UI)
 *
 * | AST Node         | Schema Example                              | UI Component                    |
 * |------------------|---------------------------------------------|---------------------------------|
 * | `StringKeyword`  | `Schema.String`                             | TextField                       |
 * | `NumberKeyword`  | `Schema.Number`                             | TextField type="number"         |
 * | `NumberKeyword`  | `Schema.optional(Schema.Number)`            | Checkbox toggle + number input  |
 * | `BooleanKeyword` | `Schema.Boolean`                            | Checkbox                        |
 * | `Literal`        | `Schema.Literal('a', 'b')`                  | SegmentedControl/Select         |
 * | `TypeLiteral`    | `Schema.Struct({...})`                      | Nested field group              |
 * | `Refinement`     | `Schema.Int`, `Schema.nonNegative()`        | Unwrapped to base type          |
 * | `Transformation` | `Schema.optional()`, `Schema.DateFromSelf`  | Unwrapped to base type          |
 * | `Union`          | `Schema.Union(A, B)` with `UndefinedKeyword`| Optional field handling         |
 *
 * ### Partial Support
 *
 * | AST Node  | Schema Example                    | Limitation                          |
 * |-----------|-----------------------------------|-------------------------------------|
 * | `Union`   | `Schema.Union(A, B)` (non-optional)| Only literal unions fully supported |
 * | `Enums`   | `Schema.Enums(MyEnum)`            | Not yet implemented (renders unknown)|
 *
 * ### Not Supported (renders "unknown")
 *
 * | AST Node          | Schema Example            | Reason                              |
 * |-------------------|---------------------------|-------------------------------------|
 * | `BigIntKeyword`   | `Schema.BigInt`           | Needs bigint input handling         |
 * | `TupleType`       | `Schema.Tuple(A, B)`      | Array UI not implemented            |
 * | `TemplateLiteral` | `Schema.TemplateLiteral`  | Complex string patterns             |
 * | `UniqueSymbol`    | `Schema.UniqueSymbol`     | Not user-inputtable                 |
 * | `SymbolKeyword`   | `Schema.Symbol`           | Not user-inputtable                 |
 * | `Suspend`         | `Schema.suspend(() => X)` | Recursive types need special UI     |
 * | `Declaration`     | Custom declarations       | Too generic for auto-UI             |
 * | `UndefinedKeyword`| (internal)                | Not directly renderable             |
 * | `VoidKeyword`     | `Schema.Void`             | Not user-inputtable                 |
 * | `NeverKeyword`    | `Schema.Never`            | Not user-inputtable                 |
 * | `UnknownKeyword`  | `Schema.Unknown`          | Too generic                         |
 * | `AnyKeyword`      | `Schema.Any`              | Too generic                         |
 * | `ObjectKeyword`   | `Schema.Object`           | Too generic                         |
 *
 * ## Annotations Used
 *
 * | Annotation      | Usage                                  |
 * |-----------------|----------------------------------------|
 * | `title`         | Field label                            |
 * | `description`   | Hint text below field                  |
 * | `examples`      | (Future) Placeholder text              |
 * | `default`       | (Future) Initial value                 |
 *
 * ## AST Unwrapping
 *
 * The `unwrapToBase()` function recursively unwraps wrapper nodes to find the
 * primitive type for UI selection:
 *
 * ```
 * Schema.optional(Schema.Int.pipe(Schema.nonNegative()))
 *   -> Transformation (optional)
 *     -> Union [UndefinedKeyword, Refinement]
 *       -> Refinement (nonNegative)
 *         -> Refinement (Int)
 *           -> NumberKeyword  <- base type for UI
 * ```
 *
 * ## Future Improvements
 *
 * - [ ] Support `Enums` -> Select dropdown
 * - [ ] Support `BigIntKeyword` -> TextField with bigint validation
 * - [ ] Support `TupleType` -> Array of indexed fields
 * - [ ] Support discriminated unions -> Type selector + dynamic form
 * - [ ] Use `examples` annotation for placeholder text
 * - [ ] Use `default` annotation for initial values
 */
import { Schema, SchemaAST } from 'effect'

import type { FieldMeta, FieldType, PropertyInfo, TaggedStructInfo } from './types.ts'

/** Extract the title annotation from an AST node or annotated object */
const getTitle = (annotated: {
  readonly annotations: SchemaAST.Annotations
}): string | undefined => {
  const value = annotated.annotations[SchemaAST.TitleAnnotationId]
  return typeof value === 'string' ? value : undefined
}

/** Extract the description annotation from an AST node or annotated object */
const getDescription = (annotated: {
  readonly annotations: SchemaAST.Annotations
}): string | undefined => {
  const value = annotated.annotations[SchemaAST.DescriptionAnnotationId]
  return typeof value === 'string' ? value : undefined
}

/** Unwrap transformations and refinements to get the underlying primitive type */
const unwrapToBase = (ast: SchemaAST.AST): SchemaAST.AST => {
  switch (ast._tag) {
    case 'Transformation':
      return unwrapToBase(ast.to)
    case 'Refinement':
      return unwrapToBase(ast.from)
    default:
      return ast
  }
}

/** Check if an AST represents an optional property */
const isOptionalAST = (ast: SchemaAST.AST): { isOptional: boolean; inner: SchemaAST.AST } => {
  const unwrapped = unwrapToBase(ast)

  // Check for Union with UndefinedKeyword (Schema.optional pattern)
  if (unwrapped._tag === 'Union') {
    const nonUndefined = unwrapped.types.filter((t: SchemaAST.AST) => t._tag !== 'UndefinedKeyword')
    const first = nonUndefined[0]
    if (nonUndefined.length === 1 && unwrapped.types.length === 2 && first !== undefined) {
      return { isOptional: true, inner: first }
    }
  }

  return { isOptional: false, inner: unwrapped }
}

/** Extract literal values from a Literal or Union of Literals AST */
const extractLiterals = (ast: SchemaAST.AST): readonly string[] | undefined => {
  const unwrapped = unwrapToBase(ast)

  if (unwrapped._tag === 'Literal' && typeof unwrapped.literal === 'string') {
    return [unwrapped.literal]
  }

  if (unwrapped._tag === 'Union') {
    const literals: string[] = []
    for (const member of unwrapped.types) {
      const innerUnwrapped = unwrapToBase(member)
      if (innerUnwrapped._tag === 'Literal' && typeof innerUnwrapped.literal === 'string') {
        literals.push(innerUnwrapped.literal)
      } else {
        // Not a pure literal union
        return undefined
      }
    }
    return literals.length > 0 ? literals : undefined
  }

  return undefined
}

/** Determine the field type from an AST node */
const getFieldType = (ast: SchemaAST.AST): FieldType => {
  const unwrapped = unwrapToBase(ast)

  // Check for literals first (including union of literals)
  const literals = extractLiterals(unwrapped)
  if (literals !== undefined) {
    return 'literal'
  }

  switch (unwrapped._tag) {
    case 'StringKeyword':
      return 'string'
    case 'NumberKeyword':
      return 'number'
    case 'BooleanKeyword':
      return 'boolean'
    case 'TypeLiteral':
      return 'struct'
    default:
      return 'unknown'
  }
}

/** Analyze a schema and extract UI-relevant metadata. */
export const analyzeSchema = (schema: Schema.Schema.AnyNoContext): FieldMeta => {
  const ast = schema.ast
  const { isOptional, inner } = isOptionalAST(ast)

  const type = getFieldType(inner)

  return {
    type,
    title: getTitle(ast) ?? getTitle(inner),
    description: getDescription(ast) ?? getDescription(inner),
    literals: type === 'literal' ? extractLiterals(inner) : undefined,
    isOptional,
    innerSchema: Schema.make(inner),
  }
}

/**
 * Extract property info from a struct schema.
 * Returns an array of properties with their keys and metadata.
 */
export const getStructProperties = (
  schema: Schema.Schema.AnyNoContext,
): readonly PropertyInfo[] => {
  const ast = unwrapToBase(schema.ast)

  if (ast._tag !== 'TypeLiteral') {
    return []
  }

  return ast.propertySignatures.map((prop: SchemaAST.PropertySignature) => {
    const propSchema = Schema.make(prop.type)
    const meta = analyzeSchema(propSchema)

    // Use property-level annotations if available, fall back to type annotations
    // Note: annotations from Schema.optional(X).annotations({...}) are on prop, not prop.type
    const propTitle = getTitle(prop) ?? getTitle(prop.type)
    const propDescription = getDescription(prop) ?? getDescription(prop.type)

    return {
      key: String(prop.name),
      schema: propSchema,
      meta: {
        ...meta,
        isOptional: prop.isOptional || meta.isOptional,
        title: propTitle ?? meta.title,
        description: propDescription ?? meta.description,
      },
    }
  })
}

/**
 * Analyze a schema for tagged struct characteristics.
 *
 * Detects if a schema is a tagged struct (has a `_tag` field with a single literal value)
 * and extracts the tag value and remaining content properties.
 */
export const analyzeTaggedStruct = (schema: Schema.Schema.AnyNoContext): TaggedStructInfo => {
  const properties = getStructProperties(schema)

  const tagProp = properties.find((p) => p.key === '_tag')
  const isSingleLiteralTag = tagProp?.meta.type === 'literal' && tagProp.meta.literals?.length === 1

  if (isSingleLiteralTag === false || tagProp === undefined) {
    return {
      isTagged: false,
      tagValue: undefined,
      contentProperties: properties,
    }
  }

  return {
    isTagged: true,
    tagValue: tagProp.meta.literals?.[0],
    contentProperties: properties.filter((p) => p.key !== '_tag'),
  }
}
