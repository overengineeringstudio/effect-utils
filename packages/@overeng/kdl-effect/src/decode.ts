import type { SchemaAST } from 'effect'

import type { Document, Node } from '@overeng/kdl'

/** Convert a KDL Document to a plain JS object for Schema decoding */
export const kdlToObject = (doc: Document): Record<string, unknown> => {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>

  for (const node of doc.nodes) {
    const name = node.getName()
    const existing = result[name]
    const value = nodeToValue(node)

    if (existing !== undefined) {
      if (Array.isArray(existing)) {
        existing.push(value)
      } else {
        result[name] = [existing, value]
      }
    } else {
      result[name] = value
    }
  }

  return result
}

const nodeToValue = (node: Node): unknown => {
  const args = node.getArguments()
  const props = node.getProperties()
  const hasChildBlock = node.children !== null

  // Simple value node: `key "value"` or `key 42`
  if (args.length === 1 && props.size === 0 && !hasChildBlock) {
    return args[0]
  }

  // Properties-only node: `key prop1="val1" prop2="val2"`
  if (args.length === 0 && props.size > 0 && !hasChildBlock) {
    return Object.fromEntries(props)
  }

  // Node with children block (including empty `{}`): `key { ... }`
  if (hasChildBlock) {
    const childObj = kdlToObject(node.children!)

    if (props.size > 0) {
      for (const [k, v] of props) {
        childObj[k] = v
      }
    }
    if (args.length === 1) {
      childObj['_value'] = args[0]
    } else if (args.length > 1) {
      childObj['_args'] = args
    }

    return childObj
  }

  // Multiple args, no children: `key "a" "b" "c"`
  if (args.length > 1) {
    return args
  }

  // Bare node with no args, no props, no children: `key` → true (presence flag)
  if (args.length === 0 && props.size === 0) {
    return true
  }

  // Mixed args + props without children
  const obj: Record<string, unknown> = Object.fromEntries(props)
  if (args.length > 0) {
    obj['_args'] = args
  }
  return obj
}

/**
 * Normalize a plain object for Schema decoding.
 * Walks the Schema AST to find array fields, and wraps scalar values
 * into single-element arrays where the Schema expects an array.
 */
export const normalizeForSchema = (obj: unknown, ast: SchemaAST.AST): unknown => {
  switch (ast._tag) {
    case 'TupleType': {
      const arr = Array.isArray(obj) ? obj : [obj]
      // Recurse into elements to normalize nested schemas
      const elementType = ast.rest[0]?.type
      if (elementType !== undefined) {
        return arr.map((item) => normalizeForSchema(item, elementType))
      }
      return arr
    }

    case 'TypeLiteral': {
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj
      const record = obj as Record<string, unknown>
      const result: Record<string, unknown> = { ...record }
      // Normalize known property signatures
      for (const prop of ast.propertySignatures) {
        const key = prop.name
        if (typeof key === 'string' && key in result) {
          result[key] = normalizeForSchema(result[key], prop.type)
        }
      }
      // Normalize index signature (Record) values
      for (const idx of ast.indexSignatures) {
        for (const key of Object.keys(result)) {
          if (ast.propertySignatures.some((p) => p.name === key)) continue
          result[key] = normalizeForSchema(result[key], idx.type)
        }
      }
      return result
    }

    case 'Transformation': {
      return normalizeForSchema(obj, ast.from)
    }

    case 'Union': {
      // Try to find a matching member. For normalization purposes,
      // we pick the first member that is a TypeLiteral or TupleType
      // and apply normalization based on it.
      for (const member of ast.types) {
        if (
          member._tag === 'TupleType' ||
          member._tag === 'TypeLiteral' ||
          member._tag === 'Transformation'
        ) {
          return normalizeForSchema(obj, member)
        }
      }
      return obj
    }

    case 'Suspend': {
      return normalizeForSchema(obj, ast.f())
    }

    case 'Refinement': {
      return normalizeForSchema(obj, ast.from)
    }

    case 'Declaration': {
      // Declarations like Schema.Array use typeParameters
      if (ast.typeParameters.length > 0) {
        // Check if this is array-like by seeing if the input should be an array
        if (!Array.isArray(obj)) {
          return [obj]
        }
      }
      return obj
    }

    default:
      return obj
  }
}
