import { Schema } from 'effect'

import { Wire } from '@overeng/effect-rust'

import { ContentDescriptor } from './schema.ts'

/** Canonical decimal transport for the public schema's nonnegative JS safe integers. */
export const NonNegativeInt = (() => {
  const maximum = String(Number.MAX_SAFE_INTEGER)
  const belowMaximum = [...maximum].flatMap((digit, index) => {
    const minimum = index === 0 ? 1 : 0
    const last = Number(digit) - 1
    if (last < minimum) return []
    const range = minimum === last ? String(last) : `[${minimum}-${last}]`
    const suffix = maximum.length - index - 1
    return `${maximum.slice(0, index)}${range}${suffix === 0 ? '' : `[0-9]{${suffix}}`}`
  })
  return Schema.String.check(
    Wire.pattern(`^(0|[1-9][0-9]{0,14}|${belowMaximum.join('|')}|${maximum})$`),
  ).annotate({ identifier: 'ContentAddress.NonNegativeInt' })
})()

/** Nonempty media type trimmed using exact ECMAScript whitespace, not Unicode \s. */
export const MediaType = (() => {
  const whitespace =
    '\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
  const trimmed = `^[^${whitespace}]([\u0000-\u{10ffff}]*[^${whitespace}])?$`
  return Schema.String.check(Wire.pattern(trimmed)).annotate({
    identifier: 'ContentAddress.MediaType',
  })
})()

/** Codec transport with the same nonempty ECMAScript-trim constraint as media types. */
export const Codec = MediaType.annotate({ identifier: 'ContentAddress.Codec' })

/** Full-match digest vocabulary admitted by the portable schema compiler. */
export const ContentDigest = Schema.String.check(Wire.pattern('^sha256:[a-f0-9]{64}$')).annotate({
  identifier: 'ContentAddress.ContentDigest',
})

/** Effect-owned descriptor projection; public JS metadata still uses ContentDescriptor. */
// @effect-diagnostics-next-line schemaStructWithTag:off -- The portable wire requires an explicit constructor tag; TaggedStruct injects a constructor default that the compiler correctly rejects.
export const DescriptorWire = Schema.Struct({
  ...ContentDescriptor.fields,
  _tag: Schema.Literal('ContentDescriptor'),
  digest: ContentDigest,
  byteLength: NonNegativeInt,
  mediaType: MediaType,
  codec: Schema.optionalKey(Codec),
  schemaVersion: Schema.optionalKey(NonNegativeInt),
}).annotate({ identifier: 'ContentAddress.ContentDescriptor' })
