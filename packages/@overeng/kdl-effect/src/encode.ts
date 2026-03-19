import { Document, Entry, Node } from '@overeng/kdl'

/** Convert a plain object to a KDL Document */
export const objectToKdlDocument = (obj: Record<string, unknown>): Document => {
  const doc = new Document()
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        /* Empty array: emit a bare node so the field survives round-tripping */
        doc.nodes.push(Node.create(key))
      } else {
        for (const item of value) {
          doc.nodes.push(valueToNode(key, item))
        }
      }
    } else {
      doc.nodes.push(valueToNode(key, value))
    }
  }
  return doc
}

const valueToNode = (name: string, value: unknown): Node => {
  const node = Node.create(name)

  if (value === undefined) return node
  if (value === null) {
    node.entries.push(Entry.createArgument(null))
    return node
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    node.entries.push(Entry.createArgument(value))
    return node
  }
  if (typeof value === 'object') {
    node.children = objectToKdlDocument(value as Record<string, unknown>)
    return node
  }
  return node
}
