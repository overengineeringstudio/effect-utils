/** Integer widths admitted without loss at the Rust boundary. */
export type Width = 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32' | 'u64' | 'i64'
/** Numeric JSON ranges: 64-bit storage must still enforce JavaScript's safe-integer bounds. */
export const integerRanges: Readonly<Record<Width, readonly [number, number]>> = {
  u8: [0, 255],
  u16: [0, 65535],
  u32: [0, 4294967295],
  i8: [-128, 127],
  i16: [-32768, 32767],
  i32: [-2147483648, 2147483647],
  u64: [0, Number.MAX_SAFE_INTEGER],
  i64: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
}
/** Portable scalar, container, semantic codec or named reference in the contract IR. */
export type Type =
  | { readonly kind: 'string' | 'bool' | 'dateTime' | 'null' }
  | { readonly kind: 'u64' | 'i64'; readonly minimum?: string; readonly maximum?: string }
  | {
      readonly kind: 'int'
      readonly width: Width
      readonly minimum?: number
      readonly maximum?: number
    }
  | { readonly kind: 'nullable' | 'patch'; readonly inner: Type }
  | { readonly kind: 'array'; readonly item: Type }
  | { readonly kind: 'record'; readonly key: Type; readonly value: Type }
  | { readonly kind: 'ref'; readonly name: string }
/** Wire field name, admitted value type and key-presence policy. */
export interface Field {
  readonly wire: string
  readonly type: Type
  readonly presence: 'required' | 'optional'
}
/** Named portable contract definition with its validation and wire policies. */
export type Definition =
  | {
      readonly kind: 'string'
      readonly pattern?: string
      readonly flags?: 'u' | 'iu'
      readonly minLength?: number
      readonly maxLength?: number
      readonly brand?: boolean
    }
  | { readonly kind: 'literals'; readonly values: readonly string[] }
  | {
      readonly kind: 'struct'
      readonly fields: readonly Field[]
      readonly nonExhaustive?: boolean
      readonly excess?: 'error' | 'ignore'
    }
  | {
      readonly kind: 'taggedUnion'
      readonly tagField: string
      readonly variants: readonly { readonly tag: string; readonly ref: string }[]
      readonly nonExhaustive?: boolean
    }
  | { readonly kind: 'alias'; readonly type: Type }
/** Versioned portable contract set shared by every compiler emitter. */
export interface ContractIR {
  readonly irVersion: 1
  readonly contract: string
  readonly defs: Readonly<Record<string, Definition>>
}
/** Sorted discriminator keys used by canonical encoders in both languages. */
export const tagFields = (ir: ContractIR): readonly string[] =>
  [
    ...new Set(
      Object.values(ir.defs).flatMap((definition) =>
        definition.kind === 'taggedUnion' ? [definition.tagField] : [],
      ),
    ),
    // eslint-disable-next-line unicorn/no-array-sort -- This array is freshly constructed here; sorting in place avoids an unnecessary copy.
  ].sort()
/** Contract admission failure with a precise path, unsupported feature and remedy. */
export class AdmissionError extends Error {
  readonly _tag = 'AdmissionError'
  readonly path: string
  readonly feature: string
  readonly remedy: string
  // eslint-disable-next-line overeng/named-args -- Preserve the public AdmissionError positional error constructor.
  constructor(path: string, feature: string, remedy: string) {
    super(`${path}: ${feature}. Remedy: ${remedy}`)
    this.path = path
    this.feature = feature
    this.remedy = remedy
  }
}
/** Throws a structured admission failure without discarding unsupported constraints. */
// eslint-disable-next-line overeng/named-args -- Preserve the public reject positional SDK signature.
export const reject = (path: string, feature: string, remedy: string): never => {
  throw new AdmissionError(path, feature, remedy)
}
