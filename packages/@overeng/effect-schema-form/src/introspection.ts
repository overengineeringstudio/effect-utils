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
 * AST = Declaration | Literal | UniqueSymbol | Undefined | Void | Never | Unknown |
 *       Any | String | Number | Boolean | BigInt | Symbol | Object | Enum |
 *       TemplateLiteral | Arrays | Objects | Union | Suspend
 * ```
 *
 * ## Support Matrix
 *
 * ### Supported (renders UI)
 *
 * | AST Node         | Schema Example                              | UI Component                    |
 * |------------------|---------------------------------------------|---------------------------------|
 * | `String`  | `Schema.String`                             | TextField                       |
 * | `Number`  | `Schema.Number`                             | TextField type="number"         |
 * | `Number`  | `Schema.optional(Schema.Number)`            | Checkbox toggle + number input  |
 * | `Boolean` | `Schema.Boolean`                            | Checkbox                        |
 * | `Literal` | `Schema.Literals(['a', 'b'])`               | SegmentedControl/Select         |
 * | `Objects` | `Schema.Struct({...})`                      | Nested field group              |
 * | `Number`  | `Schema.Int`, `Schema.nonNegative()`        | Checks remain on decoded node   |
 * | `Number`  | `Schema.NumberFromString`                   | Decoded view selected           |
 * | `Union`   | `Schema.Union([A, B])` with `Undefined`     | Optional field handling         |
 *
 * ### Partial Support
 *
 * | AST Node  | Schema Example                    | Limitation                          |
 * |-----------|-----------------------------------|-------------------------------------|
 * | `Union`   | `Schema.Union([A, B])` (non-optional)| Only literal unions fully supported |
 * | `Enum`    | `Schema.Enums(MyEnum)`             | Not yet implemented (renders unknown)|
 *
 * ### Not Supported (renders "unknown")
 *
 * | AST Node          | Schema Example            | Reason                              |
 * |-------------------|---------------------------|-------------------------------------|
 * | `BigInt`          | `Schema.BigInt`           | Needs bigint input handling         |
 * | `Arrays`          | `Schema.Tuple([A, B])`    | Array UI not implemented            |
 * | `TemplateLiteral` | `Schema.TemplateLiteral`  | Complex string patterns             |
 * | `UniqueSymbol`    | `Schema.UniqueSymbol`     | Not user-inputtable                 |
 * | `Symbol`          | `Schema.Symbol`           | Not user-inputtable                 |
 * | `Suspend`         | `Schema.suspend(() => X)` | Recursive types need special UI     |
 * | `Declaration`     | Custom declarations       | Too generic for auto-UI             |
 * | `Undefined`       | (internal)                | Not directly renderable             |
 * | `Void`            | `Schema.Void`             | Not user-inputtable                 |
 * | `Never`           | `Schema.Never`            | Not user-inputtable                 |
 * | `Unknown`         | `Schema.Unknown`          | Too generic                         |
 * | `Any`             | `Schema.Any`              | Too generic                         |
 * | `Object`          | `Schema.Object`           | Too generic                         |
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
 * The `unwrapToBase()` function selects the decoded AST view for UI selection:
 *
 * ```
 * Schema.UndefinedOr(Schema.Int.pipe(Schema.nonNegative()))
 *   -> Union [Number, Undefined]
 *       Number.checks = [Int, nonNegative]
 * ```
 *
 * ## Future Improvements
 *
 * - [ ] Support `Enum` -> Select dropdown
 * - [ ] Support `BigInt` -> TextField with bigint validation
 * - [ ] Support `Arrays` -> Array of indexed fields
 * - [ ] Support discriminated unions -> Type selector + dynamic form
 * - [ ] Use `examples` annotation for placeholder text
 * - [ ] Use `default` annotation for initial values
 */
import { Schema, SchemaAST } from 'effect'

import type { FieldMeta, FieldType, PropertyInfo, TaggedStructInfo } from './types.ts'

type AnyNoContext = Schema.Codec<unknown, unknown, never, never>

/** Extract the title annotation from an AST node or annotated object */
const getTitle = (ast: SchemaAST.AST): string | undefined => {
  const value = ast.context?.annotations?.title ?? SchemaAST.resolveTitle(ast)
  return typeof value === 'string' ? value : undefined
}

/** Extract the description annotation from an AST node or annotated object */
const getDescription = (ast: SchemaAST.AST): string | undefined => {
  const value = ast.context?.annotations?.description ?? SchemaAST.resolveDescription(ast)
  return typeof value === 'string' ? value : undefined
}

/** Unwrap transformations and refinements to get the underlying primitive type */
const unwrapToBase = (ast: SchemaAST.AST): SchemaAST.AST => SchemaAST.toType(ast)

/** Check if an AST represents an optional property */
const isOptionalAST = (ast: SchemaAST.AST): { isOptional: boolean; inner: SchemaAST.AST } => {
  const unwrapped = unwrapToBase(ast)

  // Check for Union with Undefined (Schema.optional pattern)
  if (unwrapped._tag === 'Union') {
    const nonUndefined = unwrapped.types.filter((t: SchemaAST.AST) => t._tag !== 'Undefined')
    const first = nonUndefined[0]
    if (nonUndefined.length === 1 && unwrapped.types.length === 2 && first !== undefined) {
      return { isOptional: true, inner: first }
    }
  }

  return { isOptional: SchemaAST.isOptional(unwrapped), inner: unwrapped }
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
    case 'String':
      return 'string'
    case 'Number':
      return 'number'
    case 'Boolean':
      return 'boolean'
    case 'Objects':
      return 'struct'
    default:
      return 'unknown'
  }
}

/** Analyze a schema and extract UI-relevant metadata. */
export const analyzeSchema = (schema: AnyNoContext): FieldMeta => {
  const ast = schema.ast
  const { isOptional, inner } = isOptionalAST(ast)

  const type = getFieldType(inner)

  return {
    type,
    title: getTitle(ast) ?? getTitle(inner),
    description: getDescription(ast) ?? getDescription(inner),
    literals: type === 'literal' ? extractLiterals(inner) : undefined,
    isOptional,
    innerSchema: Schema.make<AnyNoContext>(inner),
  }
}

/**
 * Extract property info from a struct schema.
 * Returns an array of properties with their keys and metadata.
 */
export const getStructProperties = (schema: AnyNoContext): readonly PropertyInfo[] => {
  const ast = unwrapToBase(schema.ast)

  if (ast._tag !== 'Objects') {
    return []
  }

  return ast.propertySignatures.map((prop: SchemaAST.PropertySignature) => {
    const propSchema = Schema.make<AnyNoContext>(prop.type)
    const meta = analyzeSchema(propSchema)

    // Key-level annotations live in prop.type.context and take precedence over value annotations.
    const propTitle = getTitle(prop.type)
    const propDescription = getDescription(prop.type)

    return {
      key: String(prop.name),
      schema: propSchema,
      meta: {
        ...meta,
        isOptional: SchemaAST.isOptional(prop.type) || meta.isOptional,
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
export const analyzeTaggedStruct = (schema: AnyNoContext): TaggedStructInfo => {
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
