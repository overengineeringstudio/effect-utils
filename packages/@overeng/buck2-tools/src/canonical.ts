/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args, overeng/explicit-boolean-compare, unicorn/no-array-sort -- Canonical JSON helpers mirror the wire format, comparators are naturally positional, and in-place sorting applies only to freshly-created arrays. */
import { createHash } from 'node:crypto'

export type CanonicalJson =
  | boolean
  | null
  | number
  | string
  | undefined
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson }

export const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

export const canonicalizeJson = (value: unknown): CanonicalJson => {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  )
    return value
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    )
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}`)
}

export const canonicalJsonString = (value: unknown): string => {
  const rendered = JSON.stringify(canonicalizeJson(value))
  if (rendered === undefined) throw new TypeError('Canonical JSON root cannot be undefined')
  return rendered
}

export const canonicalSha256 = (value: unknown): string =>
  createHash('sha256').update(canonicalJsonString(value)).digest('hex')

export const sortedRecord = <TValue>(
  entries: Iterable<readonly [string, TValue]>,
): Readonly<Record<string, TValue>> =>
  Object.fromEntries([...entries].sort(([left], [right]) => compareCodeUnits(left, right)))
