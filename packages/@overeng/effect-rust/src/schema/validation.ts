import { Schema, SchemaAST } from 'effect'

const needsPreparation = (root: SchemaAST.AST): boolean => {
  const seen = new Set<SchemaAST.AST>()
  const visit = (ast: SchemaAST.AST): boolean => {
    if (seen.has(ast)) return false
    seen.add(ast)
    if (Schema.resolveAnnotations(Schema.make(ast))?.['x-effect-rust-excess'] === 'ignore') return true
    if (ast.encoding) return visit(SchemaAST.toEncoded(ast))
    if (ast._tag === 'Suspend') return visit(ast.thunk())
    if (ast._tag === 'Objects') return ast.propertySignatures.some((field) => visit(field.type)) || ast.indexSignatures.some((field) => visit(field.type))
    if (ast._tag === 'Arrays') return ast.elements.some(visit) || ast.rest.some(visit)
    if (ast._tag === 'Union') return ast.types.some(visit)
    return false
  }
  return visit(root)
}
/** Per-object ignore is explicit; every other object remains strict at the boundary. */
const prepare = (ast: SchemaAST.AST, input: unknown, depth = 0): unknown => {
  if (depth > 128) return input // Schema reports invalid structure; strict JSON/frame boundaries enforce their depth limits.
  if (ast._tag === 'Suspend') return prepare(ast.thunk(), input, depth + 1)
  if (ast.encoding) return prepare(SchemaAST.toEncoded(ast), input, depth + 1)
  if (ast._tag === 'Union') {
    if (input === null) return input
    const member = ast.types.find((candidate) => {
      if (candidate._tag === 'Objects' && typeof input === 'object' && input !== null) {
        const literals = candidate.propertySignatures.filter((field) => field.type._tag === 'Literal')
        return literals.length > 0 && literals.every((field) => field.type._tag === 'Literal' && Reflect.get(input, field.name) === field.type.literal)
      }
      return candidate._tag !== 'Null' && ast.types.length === 2 && ast.types.some((other) => other._tag === 'Null')
    })
    return member ? prepare(member, input, depth + 1) : input
  }
  if (ast._tag === 'Arrays' && Array.isArray(input) && ast.elements.length === 0 && ast.rest.length === 1) return input.map((value) => prepare(ast.rest[0]!, value, depth + 1))
  if (ast._tag !== 'Objects' || typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const ignore = Schema.resolveAnnotations(Schema.make(ast))?.['x-effect-rust-excess'] === 'ignore'
  const fields = new Map(ast.propertySignatures.map((field) => [String(field.name), field.type]))
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const target = fields.get(key) ?? ast.indexSignatures[0]?.type
    if (!target && ignore) continue
    Object.defineProperty(output, key, { value: target ? prepare(target, value, depth + 1) : value, enumerable: true, writable: true, configurable: true })
  }
  return output
}
export const decode = <TSchema extends Schema.ConstraintDecoder<unknown>>(schema: TSchema) => {
  const parser = Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })
  if (!needsPreparation(schema.ast)) return parser
  return (input: unknown): TSchema['Type'] => parser(prepare(schema.ast, input))
}
export const encode = <TSchema extends Schema.ConstraintEncoder<unknown>>(schema: TSchema) => {
  const parser = Schema.encodeUnknownSync(schema, { onExcessProperty: 'error' })
  if (!needsPreparation(SchemaAST.toType(schema.ast))) return parser
  return (input: TSchema['Type']): TSchema['Encoded'] => parser(prepare(SchemaAST.toType(schema.ast), input))
}
