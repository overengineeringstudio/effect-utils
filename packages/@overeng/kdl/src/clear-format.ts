import { InvalidKdlError } from './parser/internal-error.ts'
import { Document } from './model/document.ts'
import { Entry } from './model/entry.ts'
import { Identifier } from './model/identifier.ts'
import { Node } from './model/node.ts'
import { Tag } from './model/tag.ts'
import { Value } from './model/value.ts'

const clearFormatValue = (value: Value): void => {
  value.representation = undefined
  value.betweenTagAndValue = undefined

  if (value.tag) {
    clearFormatTag(value.tag)
  }
}

const clearFormatIdentifier = (identifier: Identifier): void => {
  identifier.representation = undefined
}

const clearFormatTag = (tag: Tag): void => {
  tag.leading = undefined
  tag.trailing = undefined
  tag.representation = undefined
  tag.suffix = undefined
}

const clearFormatEntry = (entry: Entry): void => {
  entry.leading = undefined
  entry.equals = undefined
  entry.trailing = undefined

  clearFormatValue(entry.value)
  if (entry.name) {
    clearFormatIdentifier(entry.name)
  }
}

const clearFormatNode = (node: Node): void => {
  node.leading = undefined
  node.beforeChildren = undefined
  node.betweenTagAndName = undefined
  node.trailing = undefined

  if (node.tag) {
    clearFormatTag(node.tag)
  }
  clearFormatIdentifier(node.name)

  const args: Entry[] = []
  const properties = new Map<string, Entry>()

  for (const entry of node.entries) {
    clearFormatEntry(entry)

    if (entry.name == null) {
      args.push(entry)
    } else {
      properties.set(entry.name.name, entry)
    }
  }

  node.entries = [
    ...args,
    ...Array.from(properties.keys())
      .sort()
      .map((key) => properties.get(key)!),
  ]

  if (node.children?.nodes.length) {
    clearFormatDocument(node.children)
  } else {
    node.children = null
  }
}

const clearFormatDocument = (document: Document): void => {
  document.trailing = undefined

  for (const node of document.nodes) {
    clearFormatNode(node)
  }
}

type KdlFormattable = Value | Identifier | Tag | Entry | Node | Document

const clearFormatters = new Map<string, (value: any) => void>([
  [Value.type, clearFormatValue],
  [Identifier.type, clearFormatIdentifier],
  [Tag.type, clearFormatTag],
  [Entry.type, clearFormatEntry],
  [Node.type, clearFormatNode],
  [Document.type, clearFormatDocument],
])

/** Strip all formatting information from a KDL AST, normalizing it */
export const clearFormat = <T extends KdlFormattable>(v: T): T => {
  const clearFormatter = clearFormatters.get(v.type)
  if (clearFormatter == null) {
    throw new InvalidKdlError(`Cannot clear formatting on non-KDL ${v}`)
  }

  clearFormatter(v)
  return v
}
