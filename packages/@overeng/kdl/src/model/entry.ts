import { Identifier } from './identifier.ts'
import { Value, type Primitive } from './value.ts'

/** A KDL entry — either a positional argument or a named property */
export class Entry {
  static createArgument(value: Primitive): Entry {
    return new Entry(new Value(value), null)
  }

  static createProperty(name: string, value: Primitive): Entry {
    return new Entry(new Value(value), new Identifier(name))
  }

  readonly type = 'entry' as const
  static readonly type = 'entry' as const

  /** Property name (null for arguments) */
  name: Identifier | null
  /** Entry value */
  value: Value
  /** Leading whitespace */
  leading: string | undefined
  /** Trailing whitespace */
  trailing: string | undefined
  /** Text around the = sign (for properties) */
  equals: string | undefined

  constructor(value: Value, name: Identifier | null) {
    this.value = value
    this.name = name
  }

  clone(): Entry {
    const clone = new Entry(this.value.clone(), this.name?.clone() ?? null)
    clone.leading = this.leading
    clone.trailing = this.trailing
    clone.equals = this.equals
    return clone
  }

  getTag(): string | null {
    return this.value.getTag()
  }

  setTag(tag: string | null | undefined): void {
    this.value.setTag(tag)
  }

  getName(): string | null {
    return this.name ? this.name.name : null
  }

  setName(name: string | null | undefined): void {
    this.name = name != null ? new Identifier(name) : null
  }

  getValue(): Primitive {
    return this.value.value
  }

  setValue(value: Primitive): void {
    this.value = new Value(value)
  }

  isArgument(): boolean {
    return this.name == null
  }

  isProperty(): boolean {
    return this.name != null
  }
}
