import { SchemaAST } from 'effect'

const isObjects = (ast: SchemaAST.AST): ast is SchemaAST.Objects => ast._tag === 'Objects'

/** The string-literal key shared by every member of an object union; the compiler's tagged-union admission uses the same rule. */
export const discriminator = (members: readonly SchemaAST.AST[]): string | undefined => {
  if (members.length === 0 || members.every(isObjects) === false) return undefined
  const objects: readonly SchemaAST.Objects[] = members
  const field = objects[0]!.propertySignatures.find(
    (candidate) =>
      typeof candidate.name === 'string' &&
      candidate.type._tag === 'Literal' &&
      typeof candidate.type.literal === 'string' &&
      objects.every((member) =>
        member.propertySignatures.some(
          (other) => other.name === candidate.name && other.type._tag === 'Literal',
        ),
      ),
  )
  return typeof field?.name === 'string' ? field.name : undefined
}

/**
 * Sorted discriminator keys of every tagged union reachable from the encoded side of a schema.
 * Matches the generated Rust `TAG_FIELDS`, so both canonical encoders choose the same leading key.
 */
export const tagKeys = (root: SchemaAST.AST): readonly string[] => {
  const keys = new Set<string>()
  const seen = new Set<SchemaAST.AST>()
  const visit = (ast: SchemaAST.AST): void => {
    if (seen.has(ast) === true) return
    seen.add(ast)
    if (ast.encoding !== undefined) return visit(SchemaAST.toEncoded(ast))
    switch (ast._tag) {
      case 'Suspend':
        return visit(ast.thunk())
      case 'Objects':
        ast.propertySignatures.forEach((field) => visit(field.type))
        ast.indexSignatures.forEach((field) => visit(field.type))
        return
      case 'Arrays':
        ast.elements.forEach(visit)
        ast.rest.forEach(visit)
        return
      case 'Union': {
        const key = discriminator(
          ast.types.map((member) => (member._tag === 'Suspend' ? member.thunk() : member)),
        )
        if (key !== undefined) keys.add(key)
        ast.types.forEach(visit)
        return
      }
      default:
        return
    }
  }
  visit(root)
  // eslint-disable-next-line unicorn/no-array-sort -- This array is freshly constructed here; sorting in place avoids an unnecessary copy.
  return [...keys].sort()
}
