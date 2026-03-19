/** A type annotation tag attached to a node or value */
export class Tag {
  readonly type = 'tag' as const
  static readonly type = 'tag' as const

  /** String representation of the tag */
  representation: string | undefined
  /** Leading whitespace inside parens */
  leading: string | undefined
  /** Trailing whitespace inside parens */
  trailing: string | undefined
  /** Whether the tag is shown as a number suffix */
  suffix: boolean | undefined

  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  getName(): string {
    return this.name
  }

  setName(name: string): void {
    if (name !== this.name) {
      ;(this as { name: string }).name = name
      this.representation = undefined
    }
  }

  clone(): Tag {
    const clone = new Tag(this.name)
    clone.representation = this.representation
    clone.leading = this.leading
    clone.trailing = this.trailing
    clone.suffix = this.suffix
    return clone
  }
}
