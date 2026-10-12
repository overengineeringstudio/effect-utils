import { fingerprint } from './artifact-registry.ts'

/** Closed portable data domain accepted by canonical contract projections. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }
/** Canonical object ordering; array order remains part of the semantic contract. */
export const canonicalizeJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalizeJson(nested)]),
    )
  }
  return value
}
/** Catalog wire fingerprints retain their explicit algorithm prefix. */
export const semanticFingerprint = (projection: JsonValue): string =>
  `sha256:${fingerprint(JSON.stringify(canonicalizeJson(projection)))}`
