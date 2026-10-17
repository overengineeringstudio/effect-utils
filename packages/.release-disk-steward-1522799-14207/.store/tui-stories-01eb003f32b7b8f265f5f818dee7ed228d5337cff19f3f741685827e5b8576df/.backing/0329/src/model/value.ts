import { Tag } from './tag.ts'

/** Primitive value type in KDL */
export type Primitive = string | number | boolean | null

/**
 * Tracks how a number was written in source, so normalized output
 * preserves the distinction between integers, floats, and scientific notation.
 */
export type NumberFormat = 'integer' | 'float' | 'int-exponent' | 'float-exponent'

/** A KDL value (string, number, boolean, or null) */
export class Value {
  readonly type = 'value' as const
  static readonly type = 'value' as const

  /** String representation of the value (raw text from source) */
  representation: string | undefined
  /** Type annotation tag */
  tag: Tag | null = null
  /** Whitespace between tag and value */
  betweenTagAndValue: string | undefined
  /** How the number was written in source (survives clearFormat) */
  numberFormat: NumberFormat | undefined

  readonly value: Primitive

  constructor(value: Primitive) {
    this.value = value
  }

  clone(): Value {
    const clone = new Value(this.value)
    clone.tag = this.tag?.clone() ?? null
    clone.betweenTagAndValue = this.betweenTagAndValue
    clone.representation = this.representation
    clone.numberFormat = this.numberFormat
    return clone
  }

  getValue(): Primitive {
    return this.value
  }

  setValue(value: Primitive): void {
    if (value !== this.value) {
      ;(this as { value: Primitive }).value = value
      this.representation = undefined
    }
  }

  getTag(): string | null {
    return this.tag ? this.tag.name : null
  }

  setTag(tag: string | null | undefined): void {
    if (tag == null) {
      this.tag = null
    } else if (this.tag != null) {
      this.tag.setName(tag)
    } else {
      this.tag = new Tag(tag)
    }
  }
}
