import type { Document, Node } from '@overeng/kdl'

/** Convert a KDL Document to a plain JS object for Schema decoding */
export const kdlToObject = (doc: Document): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

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
  const hasChildren = node.hasChildren()

  // Simple value node: `key "value"` or `key 42`
  if (args.length === 1 && props.size === 0 && !hasChildren) {
    return args[0]
  }

  // Properties-only node: `key prop1="val1" prop2="val2"`
  if (args.length === 0 && props.size > 0 && !hasChildren) {
    return Object.fromEntries(props)
  }

  // Complex node with children: `key { ... }`
  if (hasChildren) {
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
