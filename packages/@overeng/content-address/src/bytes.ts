import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { Schema } from 'effect'

import { Codec, ContentDescriptor, ContentDigest, MediaType } from './schema.ts'

const textEncoder = new TextEncoder()
const decodeDigest = Schema.decodeUnknownSync(ContentDigest)
const decodeMediaType = Schema.decodeUnknownSync(MediaType)
const decodeCodec = Schema.decodeUnknownSync(Codec)
const decodeDescriptor = Schema.decodeUnknownSync(ContentDescriptor)

/** Codec tag stamped on descriptors hashed via the canonical-JSON encoding. */
export const canonicalJsonCodec = decodeCodec('canonical-json')
/** Media type for canonical-JSON payloads. */
export const canonicalJsonMediaType = decodeMediaType('application/json')
/** Default media type for plain UTF-8 text payloads. */
export const utf8TextMediaType = decodeMediaType('text/plain; charset=utf-8')

/** Encode a string to its UTF-8 byte representation. */
export const utf8Bytes = (value: string): Uint8Array => textEncoder.encode(value)

/** Compute the SHA-256 {@link ContentDigest} of raw bytes. */
export const hashBytes = (bytes: Uint8Array): ContentDigest =>
  decodeDigest(`sha256:${bytesToHex(sha256(bytes))}`)

/** Hash a string by its UTF-8 bytes; equivalent to `hashBytes(utf8Bytes(value))`. */
export const hashUtf8 = (value: string): ContentDigest => hashBytes(utf8Bytes(value))

const canonicalizeJson = (value: unknown): string => {
  if (value === undefined) return '"[undefined]"'

  if (
    value !== null &&
    typeof value === 'object' &&
    'toJSON' in value &&
    typeof value.toJSON === 'function'
  ) {
    return canonicalizeJson(value.toJSON())
  }

  if (Array.isArray(value) === true) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      // Deterministic UTF-16 code-unit key order (locale-independent): `localeCompare`
      // depends on the host ICU/collation, which would let the same value canonicalize
      // to different byte orderings on different machines and break content addressing.
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJson(item)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

/** Encode `value` and render it as canonical JSON with object keys sorted, for stable hashing across key-insertion order. */
export const canonicalJsonString = <TSchema extends Schema.Codec<any>>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: Schema.Schema.Type<TSchema>
}): string => canonicalizeJson(Schema.encodeSync(schema)(value))

/** UTF-8 bytes of {@link canonicalJsonString} — the exact bytes that get hashed. */
export const canonicalJsonBytes = <TSchema extends Schema.Codec<any>>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: Schema.Schema.Type<TSchema>
}): Uint8Array => utf8Bytes(canonicalJsonString({ schema, value }))

/** Content digest of a value's canonical-JSON encoding; stable regardless of object key order. */
export const hashCanonicalJson = <TSchema extends Schema.Codec<any>>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: Schema.Schema.Type<TSchema>
}): ContentDigest => hashBytes(canonicalJsonBytes({ schema, value }))

/** Build a {@link ContentDescriptor} from raw bytes, hashing them and recording their byte length and media type. */
export const descriptorForBytes = ({
  bytes,
  mediaType,
  codec,
  schemaVersion,
}: {
  readonly bytes: Uint8Array
  readonly mediaType: MediaType | string
  readonly codec?: Codec | string
  readonly schemaVersion?: number
}): ContentDescriptor =>
  decodeDescriptor({
    _tag: 'ContentDescriptor',
    digest: hashBytes(bytes),
    byteLength: bytes.byteLength,
    mediaType,
    ...(codec === undefined ? {} : { codec }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
  })

/** Build a descriptor for a UTF-8 string, defaulting the media type to {@link utf8TextMediaType}. */
export const descriptorForUtf8 = ({
  value,
  mediaType = utf8TextMediaType,
  codec,
  schemaVersion,
}: {
  readonly value: string
  readonly mediaType?: MediaType | string
  readonly codec?: Codec | string
  readonly schemaVersion?: number
}): ContentDescriptor =>
  descriptorForBytes({
    bytes: utf8Bytes(value),
    mediaType,
    ...(codec === undefined ? {} : { codec }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
  })

/** Build a descriptor for a value's canonical-JSON encoding; stamps the canonical-JSON codec and media type and requires an explicit `schemaVersion`. */
export const descriptorForCanonicalJson = <TSchema extends Schema.Codec<any>>({
  schema,
  value,
  schemaVersion,
}: {
  readonly schema: TSchema
  readonly value: typeof schema.Type
  readonly schemaVersion: number
}): ContentDescriptor =>
  descriptorForBytes({
    bytes: canonicalJsonBytes({ schema, value }),
    mediaType: canonicalJsonMediaType,
    codec: canonicalJsonCodec,
    schemaVersion,
  })
