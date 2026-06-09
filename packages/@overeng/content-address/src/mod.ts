import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { Effect, Schema } from 'effect'

export const ContentDigest = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/),
  Schema.brand('ContentAddress.ContentDigest'),
  Schema.annotations({ identifier: 'ContentAddress.ContentDigest' }),
)
export type ContentDigest = typeof ContentDigest.Type

export const MediaType = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('ContentAddress.MediaType'),
  Schema.annotations({ identifier: 'ContentAddress.MediaType' }),
)
export type MediaType = typeof MediaType.Type

export const Codec = Schema.NonEmptyTrimmedString.pipe(
  Schema.brand('ContentAddress.Codec'),
  Schema.annotations({ identifier: 'ContentAddress.Codec' }),
)
export type Codec = typeof Codec.Type

export const ContentDescriptor = Schema.TaggedStruct('ContentDescriptor', {
  digest: ContentDigest,
  byteLength: Schema.NonNegativeInt,
  mediaType: MediaType,
  codec: Schema.optional(Codec),
  schemaVersion: Schema.optional(Schema.NonNegativeInt),
}).annotations({ identifier: 'ContentAddress.ContentDescriptor' })
export type ContentDescriptor = typeof ContentDescriptor.Type

export class ContentDescriptorMismatchError extends Schema.TaggedError<ContentDescriptorMismatchError>()(
  'ContentDescriptorMismatchError',
  {
    expectedDigest: ContentDigest,
    actualDigest: ContentDigest,
    expectedByteLength: Schema.NonNegativeInt,
    actualByteLength: Schema.NonNegativeInt,
    mediaType: MediaType,
    message: Schema.String,
  },
) {}

const textEncoder = new TextEncoder()
const decodeDigest = Schema.decodeUnknownSync(ContentDigest)
const decodeMediaType = Schema.decodeUnknownSync(MediaType)
const decodeCodec = Schema.decodeUnknownSync(Codec)
const decodeDescriptor = Schema.decodeUnknownSync(ContentDescriptor)

export const canonicalJsonCodec = decodeCodec('canonical-json')
export const canonicalJsonMediaType = decodeMediaType('application/json')
export const utf8TextMediaType = decodeMediaType('text/plain; charset=utf-8')

export const utf8Bytes = (value: string): Uint8Array => textEncoder.encode(value)

export const hashBytes = (bytes: Uint8Array): ContentDigest =>
  decodeDigest(`sha256:${bytesToHex(sha256(bytes))}`)

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
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJson(item)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

export const canonicalJsonString = <TSchema extends Schema.Schema.AnyNoContext>(
  schema: TSchema,
  value: typeof schema.Type,
): string => canonicalizeJson(Schema.encodeSync(schema)(value))

export const canonicalJsonBytes = <TSchema extends Schema.Schema.AnyNoContext>(
  schema: TSchema,
  value: typeof schema.Type,
): Uint8Array => utf8Bytes(canonicalJsonString(schema, value))

export const hashCanonicalJson = <TSchema extends Schema.Schema.AnyNoContext>(
  schema: TSchema,
  value: typeof schema.Type,
): ContentDigest => hashBytes(canonicalJsonBytes(schema, value))

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

export const descriptorForCanonicalJson = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
  schemaVersion,
}: {
  readonly schema: TSchema
  readonly value: typeof schema.Type
  readonly schemaVersion: number
}): ContentDescriptor =>
  descriptorForBytes({
    bytes: canonicalJsonBytes(schema, value),
    mediaType: canonicalJsonMediaType,
    codec: canonicalJsonCodec,
    schemaVersion,
  })

export const verifyDescriptor = Effect.fn('ContentAddress.verifyDescriptor')(function* ({
  descriptor,
  bytes,
}: {
  readonly descriptor: ContentDescriptor
  readonly bytes: Uint8Array
}) {
  const actualDigest = hashBytes(bytes)
  if (actualDigest !== descriptor.digest || bytes.byteLength !== descriptor.byteLength) {
    return yield* new ContentDescriptorMismatchError({
      expectedDigest: descriptor.digest,
      actualDigest,
      expectedByteLength: descriptor.byteLength,
      actualByteLength: bytes.byteLength,
      mediaType: descriptor.mediaType,
      message: 'Content bytes do not match descriptor digest or byte length',
    })
  }
})

export const objectPathForDigest = (digest: ContentDigest | string): string => {
  const hex = Schema.decodeUnknownSync(ContentDigest)(digest).slice('sha256:'.length)
  return `sha256/${hex.slice(0, 2)}/${hex.slice(2)}`
}
