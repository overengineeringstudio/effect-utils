/** A KDL identifier (used for node names and property keys) */
export class Identifier {
  readonly type = 'identifier' as const
  static readonly type = 'identifier' as const

  /** String representation of the identifier (raw text from source) */
  representation: string | undefined

  name: string

  constructor(name: string) {
    this.name = name
  }

  getName(): string {
    return this.name
  }

  setName(name: string): void {
    if (name !== this.name) {
      this.name = name
      this.representation = undefined
    }
  }

  clone(): Identifier {
    const clone = new Identifier(this.name)
    clone.representation = this.representation
    return clone
  }
}
