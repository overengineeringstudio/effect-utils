import { Schema, SchemaAST } from 'effect'

import { excess } from './effect-rust.ts'

const needsPreparation = (root: SchemaAST.AST): boolean => {
  const seen = new Set<SchemaAST.AST>()
  const visit = (ast: SchemaAST.AST): boolean => {
    if (seen.has(ast) === true) return false
    seen.add(ast)
    if (Schema.resolveAnnotations(Schema.make(ast))?.[excess] === 'ignore') return true
    if (ast.encoding !== undefined) return visit(SchemaAST.toEncoded(ast))
    if (ast._tag === 'Suspend') return visit(ast.thunk())
    if (ast._tag === 'Objects')
      return (
        ast.propertySignatures.some((field) => visit(field.type)) ||
        ast.indexSignatures.some((field) => visit(field.type))
      )
    if (ast._tag === 'Arrays') return ast.elements.some(visit) || ast.rest.some(visit)
    if (ast._tag === 'Union') return ast.types.some(visit)
    return false
  }
  return visit(root)
}
/** Per-object ignore is explicit; every other object remains strict at the boundary. */
export const prepare = ({
  ast,
  input,
  depth = 0,
}: {
  ast: SchemaAST.AST
  input: unknown
  depth?: number
}): unknown => {
  if (depth > 128) return input // Schema reports invalid structure; strict JSON/frame boundaries enforce their depth limits.
  if (ast._tag === 'Suspend') return prepare({ ast: ast.thunk(), input, depth: depth + 1 })
  if (ast.encoding !== undefined)
    return prepare({ ast: SchemaAST.toEncoded(ast), input, depth: depth + 1 })
  if (ast._tag === 'Union') {
    if (input === null) return input
    const member = ast.types.find((candidate) => {
      if (candidate._tag === 'Objects' && typeof input === 'object' && input !== null) {
        const literals = candidate.propertySignatures.filter(
          (field) => field.type._tag === 'Literal',
        )
        return (
          literals.length > 0 &&
          literals.every(
            (field) =>
              field.type._tag === 'Literal' &&
              Reflect.get(input, field.name) === field.type.literal,
          )
        )
      }
      return (
        candidate._tag !== 'Null' &&
        ast.types.length === 2 &&
        ast.types.some((other) => other._tag === 'Null')
      )
    })
    return member !== undefined ? prepare({ ast: member, input, depth: depth + 1 }) : input
  }
  if (
    ast._tag === 'Arrays' &&
    Array.isArray(input) === true &&
    ast.elements.length === 0 &&
    ast.rest.length === 1
  )
    return input.map((value) => prepare({ ast: ast.rest[0]!, input: value, depth: depth + 1 }))
  if (
    ast._tag !== 'Objects' ||
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) === true
  )
    return input
  const ignore = Schema.resolveAnnotations(Schema.make(ast))?.[excess] === 'ignore'
  const fields = new Map(ast.propertySignatures.map((field) => [String(field.name), field.type]))
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const target = fields.get(key) ?? ast.indexSignatures[0]?.type
    if (target === undefined && ignore === true) continue
    Object.defineProperty(output, key, {
      value:
        target !== undefined ? prepare({ ast: target, input: value, depth: depth + 1 }) : value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return output
}
/** Creates a strict schema decoder honoring explicitly annotated excess-key policies. */
export const decode = <TSchema extends Schema.ConstraintDecoder<unknown>>(schema: TSchema) => {
  const parser = Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })
  if (needsPreparation(schema.ast) === false) return parser
  return (input: unknown): TSchema['Type'] => parser(prepare({ ast: schema.ast, input }))
}
/** Creates a strict schema encoder honoring explicitly annotated excess-key policies. */
export const encode = <TSchema extends Schema.ConstraintEncoder<unknown>>(schema: TSchema) => {
  const parser = Schema.encodeUnknownSync(schema, { onExcessProperty: 'error' })
  if (needsPreparation(SchemaAST.toType(schema.ast)) === false) return parser
  return (input: TSchema['Type']): TSchema['Encoded'] =>
    parser(prepare({ ast: SchemaAST.toType(schema.ast), input }))
}
