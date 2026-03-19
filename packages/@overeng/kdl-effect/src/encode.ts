import { Document, Node, Entry } from '@overeng/kdl'

/** Convert a plain object to a KDL Document */
export const objectToKdlDocument = (obj: Record<string, unknown>): Document => {
  const doc = new Document()
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        doc.nodes.push(valueToNode(key, item))
      }
    } else {
      doc.nodes.push(valueToNode(key, value))
    }
  }
  return doc
}

const valueToNode = (name: string, value: unknown): Node => {
  const node = Node.create(name)

  if (value === null || value === undefined) return node
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
