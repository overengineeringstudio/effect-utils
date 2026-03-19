import { Node } from './node.ts'
import { reverseIterate } from './utils.ts'
import type { Value } from './value.ts'

const getNodes = function* (node: Node | Document): Generator<Node> {
  if (node instanceof Document) {
    yield* node.nodes
  } else {
    yield node
  }
}

/** A KDL document — a collection of zero or more nodes */
export class Document {
  readonly type = 'document' as const
  static readonly type = 'document' as const

  /** The nodes in this document */
  nodes: Node[]

  /** Trailing whitespace */
  trailing: string | undefined

  constructor(nodes: Node[] = []) {
    this.nodes = nodes
  }

  clone(options?: { shallow?: boolean }): Document {
    const clone = new Document(
      options?.shallow ? [] : this.nodes.map((node) => node.clone()),
    )
    clone.trailing = this.trailing
    return clone
  }

  appendNode(node: Node | Document): void {
    this.nodes.push(...getNodes(node))
  }

  insertNodeBefore(newNode: Node | Document, referenceNode: Node | null): void {
    if (referenceNode == null) {
      this.nodes.push(...getNodes(newNode))
      return
    }
    const index = this.nodes.indexOf(referenceNode)
    if (index === -1) {
      throw new Error('Reference node is not in document')
    }
    this.nodes.splice(index, 0, ...getNodes(newNode))
  }

  insertNodeAfter(newNode: Node | Document, referenceNode: Node | null): void {
    if (referenceNode == null) {
      this.nodes.unshift(...getNodes(newNode))
      return
    }
    const index = this.nodes.indexOf(referenceNode)
    if (index === -1) {
      throw new Error('Reference node is not in document')
    }
    this.nodes.splice(index + 1, 0, ...getNodes(newNode))
  }

  removeNode(node: Node): void {
    const index = this.nodes.indexOf(node)
    if (index === -1) {
      throw new Error('Node to remove is not in document')
    }
    this.nodes.splice(index, 1)
  }

  replaceNode(oldNode: Node, newNode: Node | Document): void {
    const index = this.nodes.indexOf(oldNode)
    if (index === -1) {
      throw new Error('Node to replace is not in document')
    }
    this.nodes.splice(index, 1, ...getNodes(newNode))
  }

  findNodesByName(name: string): Node[] {
    return this.nodes.filter((node) => node.name.name === name)
  }

  findNodeByName(name: string): Node | undefined {
    for (const node of reverseIterate(this.nodes)) {
      if (node.name.name === name) {
        return node
      }
    }
    return undefined
  }

  findParameterizedNode(name: string, parameter?: Value['value']): Node | undefined {
    for (const node of reverseIterate(this.nodes)) {
      if (node.name.name !== name) {
        continue
      }
      const args = node.getArguments()
      if (args.length !== 1 || (parameter !== undefined && args[0] !== parameter)) {
        continue
      }
      return node
    }
    return undefined
  }

  removeNodesByName(name: string): void {
    this.nodes = this.nodes.filter((node) => node.name.name !== name)
  }

  isEmpty(): boolean {
    return this.nodes.length === 0
  }
}
