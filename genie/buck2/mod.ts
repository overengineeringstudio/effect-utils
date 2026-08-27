import { createHash } from 'node:crypto'

type CanonicalJson =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalJson[]
  | CanonicalJsonObject
type CanonicalJsonObject = { readonly [key: string]: CanonicalJson }

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const canonicalJsonValue = ({
  value,
  path = '$',
}: {
  value: unknown
  path?: string
}): CanonicalJson => {
  if (Array.isArray(value) === true) {
    return value.map((child, index) =>
      canonicalJsonValue({ value: child, path: `${path}[${index}]` }),
    )
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value) === true) return value
  if (value === null || typeof value !== 'object') {
    throw new Error(`Buck2 projection value at ${path} is not JSON-compatible`)
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .toSorted(([left], [right]) => compareStrings({ left, right }))
      .map(([key, child]) => [key, canonicalJsonValue({ value: child, path: `${path}.${key}` })]),
  )
}

export const buck2SemanticFingerprint = ({
  generator,
  schemaVersion,
  semanticData,
}: {
  generator: string
  schemaVersion: number
  semanticData: unknown
}): `sha256:${string}` =>
  `sha256:${createHash('sha256')
    .update(
      JSON.stringify(
        canonicalJsonValue({
          value: { generator, schemaVersion, semanticData },
        }),
      ),
    )
    .digest('hex')}`
