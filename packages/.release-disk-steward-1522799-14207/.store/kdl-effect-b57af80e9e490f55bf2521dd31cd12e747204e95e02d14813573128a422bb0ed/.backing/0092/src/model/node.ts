import { Document } from './document.ts'
import { Entry } from './entry.ts'
import { Identifier } from './identifier.ts'
import { Tag } from './tag.ts'
import { reverseIterate } from './utils.ts'
import type { Primitive } from './value.ts'

const getOrCreateDocument = (node: Node): Document =>
  node.children ?? (node.children = new Document())

/** A KDL node: name + arguments/properties + optional children */
export class Node {
  static create(name: string): Node {
    return new Node(new Identifier(name))
  }

  readonly type = 'node' as const
  static readonly type = 'node' as const

  /** Node name */
  name: Identifier
  /** Type annotation tag */
  tag: Tag | null = null
  /** Arguments and properties */
  entries: Entry[]
  /** Child nodes (null = no children block, empty Document = empty block `{}`) */
  children: Document | null
  /** Leading whitespace */
  leading: string | undefined
  /** Trailing whitespace */
  trailing: string | undefined
  /** Whitespace before children block */
  beforeChildren: string | undefined
  /** Whitespace between tag and node name */
  betweenTagAndName: string | undefined

  constructor(name: Identifier, entries: Entry[] = [], children: Document | null = null) {
    this.name = name
    this.entries = entries
    this.children = children
  }

  clone({ shallow = false } = {}): Node {
    const clone = new Node(
      this.name.clone(),
      shallow ? [] : this.entries.map((entry) => entry.clone()),
      this.children?.clone({ shallow }),
    )
    if (this.tag) {
      clone.tag = this.tag.clone()
    }
    clone.leading = this.leading
    clone.betweenTagAndName = this.betweenTagAndName
    clone.beforeChildren = this.beforeChildren
    clone.trailing = this.trailing
    return clone
  }

  getTag(): string | null {
    return this.tag ? this.tag.name : null
  }

  setTag(tag: string | null | undefined): void {
    this.tag = tag != null ? new Tag(tag) : null
  }

  getName(): string {
    return this.name.name
  }

  setName(name: string): void {
    this.name.setName(name)
  }

  hasArguments(): boolean {
    return this.entries.some((entry) => entry.isArgument())
  }

  getArguments(): Primitive[] {
    return this.getArgumentEntries().map((entry) => entry.getValue())
  }

  getArgumentEntries(): Entry[] {
    return this.entries.filter((entry) => entry.isArgument())
  }

  hasArgument(index: number): boolean {
    return this.getArgumentEntry(index) != null
  }

  getArgument(index: number): Primitive | undefined {
    return this.getArgumentEntry(index)?.getValue()
  }

  getArgumentEntry(index: number): Entry | undefined {
    let idx = index
    for (const entry of this.entries) {
      if (!entry.isArgument()) continue
      if (idx === 0) return entry
      idx--
    }
    return undefined
  }

  addArgument(value: Primitive, tag?: string | null, index?: number): void {
    const entry = Entry.createArgument(value)
    entry.value.setTag(tag)

    if (index != null) {
      let idx = index
      for (const [i, e] of this.entries.entries()) {
        if (!e.isArgument()) continue
        if (idx === 0) {
          this.entries.splice(i, 0, entry)
          return
        }
        idx--
      }
    }

    this.entries.push(entry)
  }

  removeArgument(index: number): void {
    let idx = index
    for (const [i, entry] of this.entries.entries()) {
      if (!entry.isArgument()) continue
      if (idx === 0) {
        this.entries.splice(i, 1)
        return
      }
      idx--
    }
  }

  hasProperties(): boolean {
    return this.entries.some((entry) => entry.isProperty())
  }

  getProperties(): Map<string, Primitive> {
    return new Map(
      this.getPropertyEntries().map((entry) => [entry.getName() as string, entry.getValue()]),
    )
  }

  getPropertyEntries(): Entry[] {
    return this.entries.filter((entry) => entry.isProperty())
  }

  getPropertyEntryMap(): Map<string, Entry> {
    return new Map(this.getPropertyEntries().map((entry) => [entry.getName() as string, entry]))
  }

  hasProperty(name: string): boolean {
    return this.getPropertyEntry(name) != null
  }

  getProperty(name: string): Primitive | undefined {
    return this.getPropertyEntry(name)?.getValue()
  }

  getPropertyEntry(name: string): Entry | undefined {
    for (const entry of reverseIterate(this.entries)) {
      if (entry.getName() === name) return entry
    }
    return undefined
  }

  setProperty(name: string, value: Primitive, tag?: string | null): void {
    for (const entry of reverseIterate(this.entries)) {
      if (entry.getName() === name) {
        entry.setValue(value)
        entry.value.setTag(tag)
        return
      }
    }
    const entry = Entry.createProperty(name, value)
    entry.value.setTag(tag)
    this.entries.push(entry)
  }

  deleteProperty(name: string): void {
    this.entries = this.entries.filter((entry) => entry.getName() !== name)
  }

  hasChildren(): boolean {
    return this.children != null && !this.children.isEmpty()
  }

  appendNode(node: Node | Document): void {
    getOrCreateDocument(this).appendNode(node)
  }

  insertNodeBefore(newNode: Node | Document, referenceNode: Node | null): void {
    getOrCreateDocument(this).insertNodeBefore(newNode, referenceNode)
  }

  insertNodeAfter(newNode: Node | Document, referenceNode: Node | null): void {
    getOrCreateDocument(this).insertNodeAfter(newNode, referenceNode)
  }

  removeNode(node: Node): void {
    if (this.children == null) throw new Error('Node to remove is not in document')
    this.children.removeNode(node)
  }

  replaceNode(oldNode: Node, newNode: Node | Document): void {
    if (this.children == null) throw new Error('Node to replace is not in document')
    this.children.replaceNode(oldNode, newNode)
  }

  findNodesByName(name: string): Node[] {
    return this.children != null ? this.children.findNodesByName(name) : []
  }

  findNodeByName(name: string): Node | undefined {
    return this.children?.findNodeByName(name)
  }

  findParameterizedNode(name: string, parameter?: Primitive): Node | undefined {
    return this.children?.findParameterizedNode(name, parameter)
  }

  removeNodesByName(name: string): void {
    this.children?.removeNodesByName(name)
  }
}
