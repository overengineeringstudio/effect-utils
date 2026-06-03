/**
 * Bidirectional codec between a raw Notion property value and the
 * {@link CanonicalPropertyValue} union.
 *
 * This is the single bridge that the sync engine relies on for change
 * detection, so the canonical JSON it produces must stay **byte-identical**
 * across versions (key order, optional-field omission, `_tag` placement). The
 * decode branches therefore build plain object literals in a fixed key order and
 * are asserted against captured golden strings in the unit tests — they are
 * intentionally *not* round-tripped through `Schema.decode`, which would
 * reorder keys and normalize date strings.
 *
 * Hashing is injected: the `computed` and `files[].identityHash` branches call
 * `deps.hash`, so this package never owns a hashing policy.
 *
 * @module
 */

import { Effect, Option, Schema } from 'effect'

import { richTextPlainText } from '../rich-text-utils.ts'
import {
  type CanonicalFileValue,
  type CanonicalOptionValue,
  type CanonicalPropertyValue,
  type PageId,
} from './canonical.ts'

/** A raw Notion property value could not be projected to canonical form. */
export class CanonicalDecodeError extends Schema.TaggedError<CanonicalDecodeError>()(
  'Notion.CanonicalDecodeError',
  {
    propertyType: Schema.String,
    reason: Schema.Literal('unsupported_type', 'malformed_payload'),
    message: Schema.String,
  },
) {}

/** A canonical value cannot be expressed as a Notion write payload. */
export class CanonicalEncodeError extends Schema.TaggedError<CanonicalEncodeError>()(
  'Notion.CanonicalEncodeError',
  {
    tag: Schema.String,
    reason: Schema.Literal('computed', 'unsupported_remote_shape'),
    message: Schema.String,
  },
) {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Injected hashing dependency supplied by the consuming package. */
export type CanonicalCodecDeps = {
  readonly hash: (value: unknown) => string
}

const canonicalOptionFromRemote = (option: unknown): CanonicalOptionValue | null =>
  isRecord(option) === false
    ? null
    : ({
        _tag: 'CanonicalOptionValue',
        ...(typeof option.id === 'string' ? { id: option.id } : {}),
        name: String(option.name ?? ''),
        ...(typeof option.color === 'string' ? { color: option.color } : {}),
      } as CanonicalOptionValue)

const canonicalFileFromRemote = (opts: {
  file: unknown
  hash: (value: unknown) => string
}): CanonicalFileValue | undefined => {
  const { file, hash } = opts
  if (isRecord(file) === false || typeof file.name !== 'string' || file.name.length === 0) {
    return undefined
  }
  const externalUrl =
    isRecord(file.external) === true && typeof file.external.url === 'string'
      ? file.external.url
      : undefined
  return {
    _tag: 'CanonicalFileValue',
    name: file.name,
    identityHash: hash(file),
    ...(externalUrl === undefined ? {} : { externalUrl }),
  } as CanonicalFileValue
}

/**
 * Project one raw Notion page-property value into a {@link CanonicalPropertyValue}.
 *
 * Returns `Option.none()` for property types that are deliberately dropped today
 * (unknown/unsupported types, missing `title`/`rich_text` arrays) so such
 * entries never enter the hashed canonical surface. The returned value is a
 * plain literal whose `JSON.stringify` reproduces the historical bytes exactly.
 */
const decodeCanonicalPropertyValueWith =
  (hash: (value: unknown) => string) =>
  (property: unknown): Option.Option<CanonicalPropertyValue> => {
    if (isRecord(property) === false || typeof property.type !== 'string') return Option.none()

    switch (property.type) {
      case 'title':
      case 'rich_text':
        return Array.isArray(property[property.type]) === true
          ? Option.some({
              _tag: property.type,
              plainText: richTextPlainText(property[property.type] as readonly unknown[]),
            } as CanonicalPropertyValue)
          : Option.none()
      case 'number':
        return Option.some(
          (typeof property.number === 'number'
            ? { _tag: 'number', value: property.number }
            : { _tag: 'empty' }) as CanonicalPropertyValue,
        )
      case 'checkbox':
        return Option.some({
          _tag: 'checkbox',
          checked: property.checkbox === true,
        } as CanonicalPropertyValue)
      case 'date':
        return Option.some(
          (isRecord(property.date) === true && typeof property.date.start === 'string'
            ? {
                _tag: 'date',
                start: property.date.start,
                end: typeof property.date.end === 'string' ? property.date.end : null,
              }
            : { _tag: 'empty' }) as CanonicalPropertyValue,
        )
      case 'select':
      case 'status':
        return Option.some({
          _tag: property.type,
          option: canonicalOptionFromRemote(property[property.type]),
        } as CanonicalPropertyValue)
      case 'multi_select':
        return Option.some({
          _tag: 'multi_select',
          options:
            Array.isArray(property.multi_select) === true
              ? property.multi_select.flatMap((option) => {
                  const canonical = canonicalOptionFromRemote(option)
                  return canonical === null ? [] : [canonical]
                })
              : [],
        } as CanonicalPropertyValue)
      case 'relation':
        return Option.some({
          _tag: 'relation',
          pageIds:
            Array.isArray(property.relation) === true
              ? property.relation.flatMap((relation) =>
                  isRecord(relation) === true && typeof relation.id === 'string'
                    ? [relation.id as PageId]
                    : [],
                )
              : [],
        } as CanonicalPropertyValue)
      case 'people':
        return Option.some({
          _tag: 'people',
          userIds:
            Array.isArray(property.people) === true
              ? property.people.flatMap((person) =>
                  isRecord(person) === true && typeof person.id === 'string' ? [person.id] : [],
                )
              : [],
        } as CanonicalPropertyValue)
      case 'files':
        return Option.some({
          _tag: 'files',
          files:
            Array.isArray(property.files) === true
              ? property.files.flatMap((file) => {
                  const canonical = canonicalFileFromRemote({ file, hash })
                  return canonical === undefined ? [] : [canonical]
                })
              : [],
        } as CanonicalPropertyValue)
      case 'email':
      case 'url':
      case 'phone_number':
        return Option.some({
          _tag: property.type,
          value: typeof property[property.type] === 'string' ? property[property.type] : null,
        } as CanonicalPropertyValue)
      case 'formula':
      case 'rollup':
      case 'created_time':
      case 'created_by':
      case 'last_edited_time':
      case 'last_edited_by':
        return Option.some({
          _tag: 'computed',
          valueHash: hash(property[property.type]),
        } as CanonicalPropertyValue)
      default:
        return Option.none()
    }
  }

const optionValue = (option: CanonicalOptionValue) => ({
  ...(option.id === undefined ? {} : { id: option.id }),
  name: option.name,
  ...(option.color === undefined ? {} : { color: option.color }),
})

const encodeDateTimeUtc = Schema.encodeSync(Schema.DateTimeUtc)

/**
 * Encode is only ever fed values produced by decoding a write command, where
 * `date.start`/`date.end` are real `DateTime.Utc` instances — so they are
 * serialized to ISO strings via `Schema.DateTimeUtc`. The end field is omitted
 * (not `null`) when absent, matching the Notion API shape.
 */
const encodeDate = (value: Extract<CanonicalPropertyValue, { _tag: 'date' }>) => ({
  date: {
    start: encodeDateTimeUtc(value.start),
    ...(value.end === null ? {} : { end: encodeDateTimeUtc(value.end) }),
  },
})

const encodeCanonicalPropertyValueImpl = (
  value: CanonicalPropertyValue,
): Effect.Effect<unknown, CanonicalEncodeError> => {
  switch (value._tag) {
    case 'title':
      return Effect.succeed({
        title: [{ type: 'text', text: { content: value.plainText } }],
      })
    case 'rich_text':
      return Effect.succeed({
        rich_text: [{ type: 'text', text: { content: value.plainText } }],
      })
    case 'number':
      return Effect.succeed({ number: value.value })
    case 'checkbox':
      return Effect.succeed({ checkbox: value.checked })
    case 'date':
      return Effect.succeed(encodeDate(value))
    case 'select':
      return Effect.succeed({
        select: value.option === null ? null : optionValue(value.option),
      })
    case 'multi_select':
      return Effect.succeed({
        multi_select: value.options.map(optionValue),
      })
    case 'status':
      return Effect.succeed({
        status: value.option === null ? null : optionValue(value.option),
      })
    case 'relation':
      return Effect.succeed({
        relation: value.pageIds.map((pageId) => ({ id: pageId })),
      })
    case 'people':
      return Effect.succeed({
        people: value.userIds.map((id) => ({ id })),
      })
    case 'email':
      return Effect.succeed({ email: value.value })
    case 'url':
      return Effect.succeed({ url: value.value })
    case 'phone_number':
      return Effect.succeed({ phone_number: value.value })
    case 'files':
      return value.files.length > 0 &&
        value.files.every((file) => file.externalUrl !== undefined) === true
        ? Effect.succeed({
            files: value.files.map((file) => ({
              type: 'external',
              name: file.name,
              external: { url: file.externalUrl },
            })),
          })
        : Effect.fail(
            new CanonicalEncodeError({
              tag: value._tag,
              reason: 'unsupported_remote_shape',
              message:
                'Files property writes require explicit external URL or modeled file_upload identity for every file',
            }),
          )
    case 'empty':
      return Effect.fail(
        new CanonicalEncodeError({
          tag: value._tag,
          reason: 'unsupported_remote_shape',
          message: `Canonical ${value._tag} property writes need additional remote shape information`,
        }),
      )
    case 'computed':
      return Effect.fail(
        new CanonicalEncodeError({
          tag: value._tag,
          reason: 'computed',
          message: 'Computed Notion properties cannot be written',
        }),
      )
  }
}

/** Encode one {@link CanonicalPropertyValue} into a Notion property write payload. */
export const encodeCanonicalPropertyValue = Effect.fn('Notion.encodeCanonicalPropertyValue')(
  function* (value: CanonicalPropertyValue) {
    return yield* encodeCanonicalPropertyValueImpl(value)
  },
)

/** Encode a property patch map into a Notion update payload (`propertyId → payload`). */
export const encodeCanonicalPatch = Effect.fn('Notion.encodeCanonicalPatch')(function* (
  patch: Readonly<Record<string, CanonicalPropertyValue>>,
) {
  const entries = yield* Effect.forEach(Object.entries(patch), ([propertyId, value]) =>
    encodeCanonicalPropertyValueImpl(value).pipe(
      Effect.map((notionValue) => [propertyId, notionValue] as const),
    ),
  )
  return Object.fromEntries(entries) as Record<string, unknown>
})

/**
 * Build a canonical codec bound to an injected hashing policy.
 *
 * `deps.hash` is supplied by the consuming sync package (its `canonicalHash`),
 * so the hashing policy stays out of this package while the data semantics live
 * here.
 */
export const makeCanonicalCodec = (deps: CanonicalCodecDeps) => {
  const decodeValue = decodeCanonicalPropertyValueWith(deps.hash)

  /** Project one raw Notion page-property value into canonical form. */
  const decode = Effect.fn('Notion.decodeCanonicalPropertyValue')((property: unknown) =>
    Effect.sync(() => decodeValue(property)),
  )

  /**
   * Project a raw Notion `properties` record into a canonical map, dropping
   * entries the decoder declines. The caller derives the map key (the raw
   * Notion `properties` keys are passed straight through here).
   */
  const decodePageProperties = Effect.fn('Notion.decodeCanonicalPageProperties')(
    (properties: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => {
        const entries = Object.entries(properties).flatMap(([key, property]) =>
          Option.match(decodeValue(property), {
            onNone: () => [],
            onSome: (value) => [[key, value] as const],
          }),
        )
        return Object.fromEntries(entries) as Record<string, CanonicalPropertyValue>
      }),
  )

  return {
    decode,
    decodePageProperties,
    decodeSync: decodeValue,
    encode: encodeCanonicalPropertyValue,
    encodePatch: encodeCanonicalPatch,
  }
}
