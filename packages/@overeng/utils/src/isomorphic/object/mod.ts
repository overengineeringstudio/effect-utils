import { pipe } from 'effect'

import type { PrettifyFlat } from '../types/mod.ts'

export * from './omit.ts'
export * from './pick.ts'

type ValueOfRecord<R extends Record<any, any>> = R extends Record<any, infer V> ? V : never

export const mapObjectValues = <O_In extends Record<string, any>, V_Out>({
  obj,
  mapValue,
}: {
  obj: O_In
  mapValue: (key: keyof O_In, val: ValueOfRecord<O_In>) => V_Out
}): { [K in keyof O_In]: V_Out } => {
  const mappedEntries = Object.entries(obj).map(
    ([key, val]) => [key, mapValue(key as keyof O_In, val)] as const,
  )
  return Object.fromEntries(mappedEntries) as any
}

export type Entries<T> = { [K in keyof T]: [K, T[K]] }[keyof T][]

export const objectEntries = <T extends Record<string, any>>(obj: T): Entries<T> =>
  Object.entries(obj) as Entries<T>

export const keyObjectFromObject = <TObj extends Record<string, any>>(
  obj: TObj,
): { [K in keyof TObj]: K } =>
  pipe(
    objectEntries(obj).map(([k]) => [k, k]),
    Object.fromEntries,
  ) as any

export type UndefinedFieldsToNull<T> = PrettifyFlat<{
  [K in keyof T]-?: undefined extends T[K] ? (T[K] & {}) | null : T[K]
}>

export const undefinedFieldsToNull = <T extends {}>(obj: T): UndefinedFieldsToNull<T> =>
  Object.fromEntries(Object.entries(obj).map(([key, val]) => [key, val ?? null])) as any

export const objectWithKeyPrefix = <TObj extends Record<string, any>, TPrefix extends string>({
  obj,
  prefix,
}: {
  obj: TObj
  prefix: TPrefix
}): { [K in keyof TObj as K extends string ? `${TPrefix}${K}` : never]: TObj[K] } => {
  const newObj: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    newObj[`${prefix}${k}` as any] = v
  }
  return newObj as any
}
