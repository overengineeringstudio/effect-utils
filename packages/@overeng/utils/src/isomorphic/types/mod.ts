export * from './json.ts'

export type Prettify<T> = T extends infer U ? { [K in keyof U]: Prettify<U[K]> } : never
export type PrettifyFlat<T> = T extends infer U ? { [K in keyof U]: U[K] } : never

export type TypeEq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** `A` is subtype of `B` */
export type IsSubtype<A, B> = A extends B ? true : false
export type AssertTrue<T extends true> = T

export type Writeable<T> = { -readonly [P in keyof T]: T[P] }
export type DeepWriteable<T> = { -readonly [P in keyof T]: DeepWriteable<T[P]> }

export type Primitive = null | undefined | string | number | boolean | symbol | bigint

export type LiteralUnion<LiteralType, BaseType extends Primitive> =
  | LiteralType
  | (BaseType & Record<never, never>)

/** NOTE This type might alter the order of fields */
export type NullableFieldsToOptional<T> = PrettifyFlat<
  Partial<T> & {
    [K in keyof T as null extends T[K] ? K : never]?: Exclude<T[K], null>
  } & {
    [K in keyof T as null extends T[K] ? never : K]: T[K]
  }
>

// Keeps `| null` additionally to optional fields
export type NullableFieldsToOptional_<T> = PrettifyFlat<
  Partial<T> & {
    [K in keyof T as null extends T[K] ? K : never]?: T[K]
  } & {
    [K in keyof T as null extends T[K] ? never : K]: T[K]
  }
>

/** NOTE This type might alter the order of fields */
export type UndefinedFieldsToOptional<T> = PrettifyFlat<
  Partial<T> & {
    [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>
  } & {
    [K in keyof T as undefined extends T[K] ? never : K]: T[K]
  }
>

export type PartialPick<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>
