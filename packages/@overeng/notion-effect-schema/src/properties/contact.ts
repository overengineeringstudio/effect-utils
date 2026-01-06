import { Option, Schema } from 'effect'

import { docsPath, shouldNeverHappen, withOptionValueSchema } from '../common.ts'

// -----------------------------------------------------------------------------
// URL Property
// -----------------------------------------------------------------------------

/**
 * URL property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#url
 */
export const UrlProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('url').annotations({
    description: 'Property type identifier.',
  }),
  url: Schema.NullOr(Schema.String).annotations({
    description: 'The URL value, or null if empty.',
    examples: ['https://example.com'],
  }),
}).annotations({
  identifier: 'Notion.UrlProperty',
  title: 'URL Property',
  description: 'A URL property value.',
  [docsPath]: 'property-value-object#url',
})

export type UrlProperty = typeof UrlProperty.Type

/**
 * URL property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const UrlWrite = Schema.Struct({
  url: Schema.NullOr(Schema.String),
}).annotations({
  identifier: 'Notion.UrlWrite',
  title: 'URL (Write)',
  description: 'Write payload for a URL property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type UrlWrite = typeof UrlWrite.Type

export const UrlWriteFromString = Schema.transform(Schema.NullOr(Schema.String), UrlWrite, {
  strict: false,
  decode: (url) => ({ url }),
  encode: (write) => write.url,
}).annotations({
  identifier: 'Notion.UrlWriteFromString',
  title: 'URL (Write) From String',
  description: 'Transform a URL string (or null) into a URL write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for URL property. */
export const Url = {
  /** The raw UrlProperty schema. */
  Property: UrlProperty,

  /** Transform to raw nullable string. */
  raw: Schema.transform(UrlProperty, Schema.NullOr(Schema.String), {
    strict: false,
    decode: (prop) => prop.url,
    encode: () =>
      shouldNeverHappen('Url.raw encode is not supported. Use UrlWrite / UrlWriteFromString.'),
  }),

  /** Transform to Option<string>. */
  asOption: withOptionValueSchema(
    Schema.transform(UrlProperty, Schema.OptionFromSelf(Schema.String), {
      strict: false,
      decode: (prop) => (prop.url === null ? Option.none() : Option.some(prop.url)),
      encode: () =>
        shouldNeverHappen(
          'Url.asOption encode is not supported. Use UrlWrite / UrlWriteFromString.',
        ),
    }),
    Schema.String,
  ),

  Write: {
    Schema: UrlWrite,
    fromString: UrlWriteFromString,
  },
} as const

// -----------------------------------------------------------------------------
// Email Property
// -----------------------------------------------------------------------------

/**
 * Email property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#email
 */
export const EmailProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('email').annotations({
    description: 'Property type identifier.',
  }),
  email: Schema.NullOr(Schema.String).annotations({
    description: 'The email address, or null if empty.',
    examples: ['user@example.com'],
  }),
}).annotations({
  identifier: 'Notion.EmailProperty',
  title: 'Email Property',
  description: 'An email property value.',
  [docsPath]: 'property-value-object#email',
})

export type EmailProperty = typeof EmailProperty.Type

/**
 * Email property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const EmailWrite = Schema.Struct({
  email: Schema.NullOr(Schema.String),
}).annotations({
  identifier: 'Notion.EmailWrite',
  title: 'Email (Write)',
  description: 'Write payload for an email property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type EmailWrite = typeof EmailWrite.Type

export const EmailWriteFromString = Schema.transform(Schema.NullOr(Schema.String), EmailWrite, {
  strict: false,
  decode: (email) => ({ email }),
  encode: (write) => write.email,
}).annotations({
  identifier: 'Notion.EmailWriteFromString',
  title: 'Email (Write) From String',
  description: 'Transform an email string (or null) into an email write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Email property. */
export const Email = {
  /** The raw EmailProperty schema. */
  Property: EmailProperty,

  /** Transform to raw nullable string. */
  raw: Schema.transform(EmailProperty, Schema.NullOr(Schema.String), {
    strict: false,
    decode: (prop) => prop.email,
    encode: () =>
      shouldNeverHappen(
        'Email.raw encode is not supported. Use EmailWrite / EmailWriteFromString.',
      ),
  }),

  /** Transform to Option<string>. */
  asOption: withOptionValueSchema(
    Schema.transform(EmailProperty, Schema.OptionFromSelf(Schema.String), {
      strict: false,
      decode: (prop) => (prop.email === null ? Option.none() : Option.some(prop.email)),
      encode: () =>
        shouldNeverHappen(
          'Email.asOption encode is not supported. Use EmailWrite / EmailWriteFromString.',
        ),
    }),
    Schema.String,
  ),

  Write: {
    Schema: EmailWrite,
    fromString: EmailWriteFromString,
  },
} as const

// -----------------------------------------------------------------------------
// Phone Number Property
// -----------------------------------------------------------------------------

/**
 * Phone number property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#phone-number
 */
export const PhoneNumberProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('phone_number').annotations({
    description: 'Property type identifier.',
  }),
  phone_number: Schema.NullOr(Schema.String).annotations({
    description: 'The phone number, or null if empty.',
    examples: ['+1 555-123-4567'],
  }),
}).annotations({
  identifier: 'Notion.PhoneNumberProperty',
  title: 'Phone Number Property',
  description: 'A phone number property value.',
  [docsPath]: 'property-value-object#phone-number',
})

export type PhoneNumberProperty = typeof PhoneNumberProperty.Type

/**
 * Phone number property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const PhoneNumberWrite = Schema.Struct({
  phone_number: Schema.NullOr(Schema.String),
}).annotations({
  identifier: 'Notion.PhoneNumberWrite',
  title: 'Phone Number (Write)',
  description: 'Write payload for a phone number property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type PhoneNumberWrite = typeof PhoneNumberWrite.Type

export const PhoneNumberWriteFromString = Schema.transform(
  Schema.NullOr(Schema.String),
  PhoneNumberWrite,
  {
    strict: false,
    decode: (phone_number) => ({ phone_number }),
    encode: (write) => write.phone_number,
  },
).annotations({
  identifier: 'Notion.PhoneNumberWriteFromString',
  title: 'Phone Number (Write) From String',
  description: 'Transform a phone number string (or null) into a phone number write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for PhoneNumber property. */
export const PhoneNumber = {
  /** The raw PhoneNumberProperty schema. */
  Property: PhoneNumberProperty,

  /** Transform to raw nullable string. */
  raw: Schema.transform(PhoneNumberProperty, Schema.NullOr(Schema.String), {
    strict: false,
    decode: (prop) => prop.phone_number,
    encode: () =>
      shouldNeverHappen(
        'PhoneNumber.raw encode is not supported. Use PhoneNumberWrite / PhoneNumberWriteFromString.',
      ),
  }),

  /** Transform to Option<string>. */
  asOption: withOptionValueSchema(
    Schema.transform(PhoneNumberProperty, Schema.OptionFromSelf(Schema.String), {
      strict: false,
      decode: (prop) =>
        prop.phone_number === null ? Option.none() : Option.some(prop.phone_number),
      encode: () =>
        shouldNeverHappen(
          'PhoneNumber.asOption encode is not supported. Use PhoneNumberWrite / PhoneNumberWriteFromString.',
        ),
    }),
    Schema.String,
  ),

  Write: {
    Schema: PhoneNumberWrite,
    fromString: PhoneNumberWriteFromString,
  },
} as const
