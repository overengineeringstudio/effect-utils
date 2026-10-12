import { Schema, SchemaAST as AST } from 'effect'

import { Registry } from './annotations.ts'

/** Semantic schema node plus its resolved metadata and dotted registry path. */
export type SchemaNode = {
  readonly ast: AST.AST
  readonly path: string
  readonly annotations: Schema.Annotations.Annotations
  readonly kind: 'struct' | 'array' | 'union' | 'leaf'
}
/** Registration failure naming the semantic node and missing or invalid annotation. */
export class SchemaAnnotationError extends Schema.TaggedError<SchemaAnnotationError>()(
  'SchemaAnnotationError',
  {
    path: Schema.String,
    annotation: Schema.String,
    message: Schema.String,
  },
) {}
/** Unsupported or nonfinite AST shape that cannot form a portable registry record. */
export class UnsupportedSchemaNodeError extends Schema.TaggedError<UnsupportedSchemaNodeError>()(
  'UnsupportedSchemaNodeError',
  {
    path: Schema.String,
    kind: Schema.String,
    message: Schema.String,
  },
) {}

/** Visits every node, including union arms; paths use [] for homogeneous array elements. */
export const walkSchema = ({
  schema,
  onNode,
}: {
  readonly schema: Schema.Constraint
  readonly onNode?: (node: SchemaNode) => void
}): ReadonlyArray<SchemaNode> => {
  const nodes: Array<SchemaNode> = []
  const ancestors = new Set<AST.AST>()
  const visit = ({
    ast,
    path,
    inherited = {},
  }: {
    readonly ast: AST.AST
    readonly path: string
    readonly inherited?: Schema.Annotations.Annotations
  }): void => {
    if (ancestors.has(ast))
      throw new UnsupportedSchemaNodeError({
        path,
        kind: ast._tag,
        message: `Recursive schema at ${path} is not a finite registry record`,
      })
    const kind = AST.isObjects(ast)
      ? 'struct'
      : AST.isArrays(ast)
        ? 'array'
        : AST.isUnion(ast)
          ? 'union'
          : 'leaf'
    const node: SchemaNode = {
      ast,
      path,
      kind,
      annotations: {
        ...inherited,
        ...Schema.resolveAnnotations(Schema.make(ast)),
        ...Schema.resolveAnnotationsKey(Schema.make(ast)),
      },
    }
    nodes.push(node)
    onNode?.(node)
    ancestors.add(ast)
    if (AST.isObjects(ast)) {
      if (ast.indexSignatures.length)
        throw new UnsupportedSchemaNodeError({
          path,
          kind: ast._tag,
          message: `Index signatures are not finite registry fields at ${path}`,
        })
      for (const property of ast.propertySignatures) {
        if (typeof property.name !== 'string')
          throw new UnsupportedSchemaNodeError({
            path,
            kind: ast._tag,
            message: `Registry field names must be strings at ${path}`,
          })
        visit({ ast: property.type, path: path ? `${path}.${property.name}` : property.name })
      }
    } else if (AST.isArrays(ast)) {
      if (ast.elements.length || ast.rest.length !== 1)
        throw new UnsupportedSchemaNodeError({
          path,
          kind: ast._tag,
          message: `Only homogeneous arrays are supported at ${path}`,
        })
      const element = ast.rest[0]
      if (element !== undefined) visit({ ast: element, path: `${path}[]` })
    } else if (AST.isUnion(ast)) {
      // Union arms describe the same semantic key; its key metadata applies to every arm.
      for (const member of ast.types) visit({ ast: member, path, inherited: node.annotations })
    } else if (AST.isSuspend(ast)) {
      throw new UnsupportedSchemaNodeError({
        path,
        kind: ast._tag,
        message: `Suspended schemas require explicit lowering at ${path}`,
      })
    }
    ancestors.delete(ast)
  }
  visit({ ast: schema.ast, path: '' })
  return nodes
}

/** Fail-closed registration hook; reusable containers and union arms are checked, not just leaves. */
export const assertAnnotationCompleteness = (options: {
  readonly schema: Schema.Constraint
  readonly sensitivityKey?: string
  readonly requireTitle?: boolean
  readonly requireDescription?: boolean
  readonly includeRoot?: boolean
  readonly knownCustomKeys?: ReadonlyArray<string>
}): void => {
  const sensitivityKey = options.sensitivityKey ?? Registry.sensitivity
  const knownCustomKeys = new Set<string>([
    ...Object.values(Registry),
    ...(options.knownCustomKeys ?? []),
  ])
  walkSchema({
    schema: options.schema,
    onNode: ({ path, annotations }) => {
      if (!path && !options.includeRoot) return
      const fail = (annotation: string): never => {
        throw new SchemaAnnotationError({
          path,
          annotation,
          message: `Missing or invalid ${annotation} annotation at ${path || '<root>'}`,
        })
      }
      const sensitivity = annotations[sensitivityKey]
      if (
        sensitivity !== 'public' &&
        sensitivity !== 'internal' &&
        sensitivity !== 'restricted' &&
        sensitivity !== 'secret'
      )
        fail(sensitivityKey)
      if (
        options.requireTitle !== false &&
        (typeof annotations.title !== 'string' || !annotations.title.trim())
      )
        fail('title')
      if (
        options.requireDescription !== false &&
        (typeof annotations.description !== 'string' || !annotations.description.trim())
      )
        fail('description')
      for (const key of Object.keys(annotations)) {
        if (key.startsWith('x-') && key !== sensitivityKey && !knownCustomKeys.has(key)) fail(key)
      }
    },
  })
}
