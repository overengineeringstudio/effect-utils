import { Option, Schema, SchemaGetter, SchemaTransformation } from 'effect'

import {
  docsPath,
  NotionUUID,
  SelectColor,
  shouldNeverHappen,
  withOptionNameSchema,
  withOptionValueSchema,
} from '../common.ts'
import { SelectOption, SelectOptionWrite } from './common.ts'

// -----------------------------------------------------------------------------
// Select Property
// -----------------------------------------------------------------------------

/**
 * Select property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#select
 */
export const SelectProperty = Schema.Struct({
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('select').annotate({
    description: 'Property type identifier.',
  }),
  select: Schema.NullOr(SelectOption).annotate({
    description: 'The selected option, or null if none selected.',
  }),
}).annotate({
  identifier: 'Notion.SelectProperty',
  title: 'Select Property',
  description: 'A select property value.',
  [docsPath]: 'property-value-object#select',
})

export type SelectProperty = typeof SelectProperty.Type

/**
 * Select property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const SelectWrite = Schema.Struct({
  select: Schema.NullOr(SelectOptionWrite),
}).annotate({
  identifier: 'Notion.SelectWrite',
  title: 'Select (Write)',
  description: 'Write payload for a select property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type SelectWrite = typeof SelectWrite.Type

/** Transforms option name (or null) into a select write payload */
export const SelectWriteFromName = Schema.NullOr(Schema.String).pipe(
  Schema.decodeTo(
    SelectWrite,
    SchemaTransformation.transform<Schema.Codec.Encoded<typeof SelectWrite>, string | null>({
      decode: (name) => ({
        select: name === null ? null : { name },
      }),
      encode: (write) => {
        if (write.select === null) {
          return null
        }

        if ('name' in write.select) {
          return write.select.name
        }

        return shouldNeverHappen('SelectWriteFromName cannot encode option referenced by id.')
      },
    }),
  ),
).annotate({
  identifier: 'Notion.SelectWriteFromName',
  title: 'Select (Write) From Name',
  description: 'Transform an option name (or null) into a select write payload.',
  [docsPath]: 'page#page-property-value',
})

const isAllowedName = <TName extends string>(options: {
  nameSchema: Schema.Codec<TName, TName>
  name: string
}): options is { nameSchema: Schema.Codec<TName, TName>; name: TName } =>
  Option.isSome(Schema.decodeUnknownOption(options.nameSchema)(options.name))

const makeSelectOptionWithName = <TName extends string>(nameSchema: Schema.Codec<TName, TName>) =>
  Schema.Struct({
    id: NotionUUID,
    name: nameSchema,
    color: SelectColor,
  })

/** Transforms for Select property. */
export const Select = {
  /** The raw SelectProperty schema. */
  Property: SelectProperty,

  /** Transform to raw nullable SelectOption. */
  raw: SelectProperty.pipe(
    Schema.decodeTo(Schema.NullOr(SelectOption), {
      decode: SchemaGetter.transform((prop) => prop.select),
      encode: SchemaGetter.forbidden(
        () => 'Select.raw encode is not supported. Use SelectWrite / SelectWriteFromName.',
      ),
    }),
  ),

  /** Transform to Option<SelectOption>. */
  asOption: withOptionNameSchema({
    schema: withOptionValueSchema({
      schema: SelectProperty.pipe(
        Schema.decodeTo(Schema.Option(SelectOption), {
          decode: SchemaGetter.transform((prop) =>
            prop.select === null ? Option.none() : Option.some(prop.select)
          ),
          encode: SchemaGetter.forbidden(
            () => 'Select.asOption encode is not supported. Use SelectWrite / SelectWriteFromName.',
          ),
        }),
      ),
      valueSchema: SelectOption,
    }),
    nameSchema: Schema.String,
  }),

  /** Transform to SelectProperty with a typed name (fails for unknown options). */
  asPropertyNamed: <TName extends string>(nameSchema: Schema.Codec<TName, TName>) => {
    const optionSchema = makeSelectOptionWithName(nameSchema)

    return SelectProperty.pipe(
      Schema.refine(
        (p): p is typeof p & { select: typeof optionSchema.Type | null } =>
          p.select === null || isAllowedName({ nameSchema, name: p.select.name }),
        { message: 'Select option must be one of the allowed options' },
      ),
    )
  },

  /** Transform to Option<SelectOption> with a typed name (fails for unknown options). */
  asOptionNamed: <TName extends string>(nameSchema: Schema.Codec<TName, TName>) => {
    const optionSchema = makeSelectOptionWithName(nameSchema)

    return withOptionNameSchema({
      schema: withOptionValueSchema({
        schema: SelectProperty.pipe(
          Schema.refine(
            (p): p is typeof p & { select: typeof optionSchema.Type | null } =>
              p.select === null || isAllowedName({ nameSchema, name: p.select.name }),
            { message: 'Select option must be one of the allowed options' },
          ),
          Schema.decodeTo(Schema.Option(optionSchema), {
            decode: SchemaGetter.transform((prop) =>
              prop.select === null ? Option.none() : Option.some(prop.select)
            ),
            encode: SchemaGetter.forbidden(
              () =>
                'Select.asOptionNamed encode is not supported. Use SelectWrite / SelectWriteFromName.',
            ),
          }),
        ),
        valueSchema: optionSchema,
      }),
      nameSchema,
    })
  },

  /** Transform to Option<name> with allowed options (fails for unknown options). */
  asName: <TName extends string>(nameSchema: Schema.Codec<TName, TName>) =>
    withOptionValueSchema({
      schema: SelectProperty.pipe(
        Schema.refine(
          (p): p is typeof p & { select: { name: TName } | null } =>
            p.select === null || isAllowedName({ nameSchema, name: p.select.name }),
          { message: 'Select option must be one of the allowed options' },
        ),
        Schema.decodeTo(Schema.Option(nameSchema), {
          decode: SchemaGetter.transform((prop) =>
            prop.select === null ? Option.none() : Option.some(prop.select.name)
          ),
          encode: SchemaGetter.forbidden(
            () => 'Select.asName encode is not supported. Use SelectWrite / SelectWriteFromName.',
          ),
        }),
      ),
      valueSchema: nameSchema,
    }),

  /** Transform to Option<string> (option name). */
  asString: withOptionValueSchema({
    schema: SelectProperty.pipe(
      Schema.decodeTo(Schema.Option(Schema.String), {
        decode: SchemaGetter.transform((prop) =>
          prop.select === null ? Option.none() : Option.some(prop.select.name)
        ),
        encode: SchemaGetter.forbidden(
          () => 'Select.asString encode is not supported. Use SelectWrite / SelectWriteFromName.',
        ),
      }),
    ),
    valueSchema: Schema.String,
  }),

  Write: {
    Schema: SelectWrite,
    fromName: SelectWriteFromName,
  },
} as const

// -----------------------------------------------------------------------------
// Multi-Select Property
// -----------------------------------------------------------------------------

/**
 * Multi-select property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#multi-select
 */
export const MultiSelectProperty = Schema.Struct({
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('multi_select').annotate({
    description: 'Property type identifier.',
  }),
  multi_select: Schema.Array(SelectOption).annotate({
    description: 'Array of selected options.',
  }),
}).annotate({
  identifier: 'Notion.MultiSelectProperty',
  title: 'Multi-Select Property',
  description: 'A multi-select property value.',
  [docsPath]: 'property-value-object#multi-select',
})

export type MultiSelectProperty = typeof MultiSelectProperty.Type

/**
 * Multi-select property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const MultiSelectWrite = Schema.Struct({
  multi_select: Schema.Array(SelectOptionWrite),
}).annotate({
  identifier: 'Notion.MultiSelectWrite',
  title: 'Multi-Select (Write)',
  description: 'Write payload for a multi-select property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type MultiSelectWrite = typeof MultiSelectWrite.Type

/** Transforms option names array into a multi-select write payload */
export const MultiSelectWriteFromNames = Schema.Array(Schema.String).pipe(
  Schema.decodeTo(
    MultiSelectWrite,
    SchemaTransformation.transform<
      Schema.Codec.Encoded<typeof MultiSelectWrite>,
      ReadonlyArray<string>
    >({
      decode: (names) => ({
        multi_select: names.map((name) => ({ name })),
      }),
      encode: (write) =>
        write.multi_select.map((opt) => {
          if ('name' in opt) {
            return opt.name
          }

          return shouldNeverHappen('MultiSelectWriteFromNames cannot encode option referenced by id.')
        }),
    }),
  ),
).annotate({
  identifier: 'Notion.MultiSelectWriteFromNames',
  title: 'Multi-Select (Write) From Names',
  description: 'Transform option names into a multi-select write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for MultiSelect property. */
export const MultiSelect = {
  /** The raw MultiSelectProperty schema. */
  Property: MultiSelectProperty,

  /** Transform to raw array of SelectOptions. */
  raw: withOptionNameSchema({
    schema: MultiSelectProperty.pipe(
      Schema.decodeTo(Schema.Array(SelectOption), {
        decode: SchemaGetter.transform((prop) => prop.multi_select),
        encode: SchemaGetter.forbidden(
          () =>
            'MultiSelect.raw encode is not supported. Use MultiSelectWrite / MultiSelectWriteFromNames.',
        ),
      }),
    ),
    nameSchema: Schema.String,
  }),

  /** Transform to array of option names. */
  asStrings: MultiSelectProperty.pipe(
    Schema.decodeTo(Schema.Array(Schema.String), {
      decode: SchemaGetter.transform((prop) => prop.multi_select.map((opt) => opt.name)),
      encode: SchemaGetter.forbidden(
        () =>
          'MultiSelect.asStrings encode is not supported. Use MultiSelectWrite / MultiSelectWriteFromNames.',
      ),
    }),
  ),

  /** Transform to array of option names with allowed options (fails for unknown options). */
  asNames: <TName extends string>(nameSchema: Schema.Codec<TName, TName>) =>
    MultiSelectProperty.pipe(
      Schema.refine(
        (p): p is typeof p & { multi_select: Array<{ name: TName }> } =>
          p.multi_select.every((opt) => isAllowedName({ nameSchema, name: opt.name })),
        { message: 'MultiSelect options must be one of the allowed options' },
      ),
      Schema.decodeTo(Schema.Array(nameSchema), {
        decode: SchemaGetter.transform(
          (
            prop: {
              multi_select: ReadonlyArray<{ name: TName }>
            },
          ): ReadonlyArray<TName> => prop.multi_select.map((opt) => opt.name),
        ),
        encode: SchemaGetter.forbidden(
          () =>
            'MultiSelect.asNames encode is not supported. Use MultiSelectWrite / MultiSelectWriteFromNames.',
        ),
      }),
    ),

  /** Transform to MultiSelectProperty with typed option names (fails for unknown options). */
  asPropertyNamed: <TName extends string>(nameSchema: Schema.Codec<TName, TName>) => {
    const optionSchema = makeSelectOptionWithName(nameSchema)

    return MultiSelectProperty.pipe(
      Schema.refine(
        (p): p is typeof p & { multi_select: Array<typeof optionSchema.Type> } =>
          p.multi_select.every((opt) => isAllowedName({ nameSchema, name: opt.name })),
        { message: 'MultiSelect options must be one of the allowed options' },
      ),
    )
  },

  /** Transform to array of options with typed option names (fails for unknown options). */
  asOptionsNamed: <TName extends string>(nameSchema: Schema.Codec<TName, TName>) => {
    const optionSchema = makeSelectOptionWithName(nameSchema)

    return withOptionNameSchema({
      schema: MultiSelectProperty.pipe(
        Schema.refine(
          (
            p,
          ): p is typeof p & {
            multi_select: Array<typeof optionSchema.Type>
          } => p.multi_select.every((opt) => isAllowedName({ nameSchema, name: opt.name })),
          { message: 'MultiSelect options must be one of the allowed options' },
        ),
        Schema.decodeTo(Schema.Array(optionSchema), {
          decode: SchemaGetter.transform((prop) => prop.multi_select),
          encode: SchemaGetter.forbidden(
            () =>
              'MultiSelect.asOptionsNamed encode is not supported. Use MultiSelectWrite / MultiSelectWriteFromNames.',
          ),
        }),
      ),
      nameSchema,
    })
  },

  Write: {
    Schema: MultiSelectWrite,
    fromNames: MultiSelectWriteFromNames,
  },
} as const

// -----------------------------------------------------------------------------
// Status Property
// -----------------------------------------------------------------------------

/**
 * Status property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#status
 */
export const StatusProperty = Schema.Struct({
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('status').annotate({
    description: 'Property type identifier.',
  }),
  status: Schema.NullOr(SelectOption).annotate({
    description: 'The current status, or null if none.',
  }),
}).annotate({
  identifier: 'Notion.StatusProperty',
  title: 'Status Property',
  description: 'A status property value.',
  [docsPath]: 'property-value-object#status',
})

export type StatusProperty = typeof StatusProperty.Type

/**
 * Status property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const StatusWrite = Schema.Struct({
  status: Schema.NullOr(SelectOptionWrite),
}).annotate({
  identifier: 'Notion.StatusWrite',
  title: 'Status (Write)',
  description: 'Write payload for a status property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type StatusWrite = typeof StatusWrite.Type

/** Transforms status name (or null) into a status write payload */
export const StatusWriteFromName = Schema.NullOr(Schema.String).pipe(
  Schema.decodeTo(
    StatusWrite,
    SchemaTransformation.transform<Schema.Codec.Encoded<typeof StatusWrite>, string | null>({
      decode: (name) => ({
        status: name === null ? null : { name },
      }),
      encode: (write) => {
        if (write.status === null) {
          return null
        }

        if ('name' in write.status) {
          return write.status.name
        }

        return shouldNeverHappen('StatusWriteFromName cannot encode option referenced by id.')
      },
    }),
  ),
).annotate({
  identifier: 'Notion.StatusWriteFromName',
  title: 'Status (Write) From Name',
  description: 'Transform a status name (or null) into a status write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Status property. */
export const Status = {
  /** The raw StatusProperty schema. */
  Property: StatusProperty,

  /** Transform to raw nullable SelectOption. */
  raw: StatusProperty.pipe(
    Schema.decodeTo(Schema.NullOr(SelectOption), {
      decode: SchemaGetter.transform((prop) => prop.status),
      encode: SchemaGetter.forbidden(
        () => 'Status.raw encode is not supported. Use StatusWrite / StatusWriteFromName.',
      ),
    }),
  ),

  /** Transform to Option<SelectOption>. */
  asOption: withOptionNameSchema({
    schema: withOptionValueSchema({
      schema: StatusProperty.pipe(
        Schema.decodeTo(Schema.Option(SelectOption), {
          decode: SchemaGetter.transform((prop) =>
            prop.status === null ? Option.none() : Option.some(prop.status)
          ),
          encode: SchemaGetter.forbidden(
            () => 'Status.asOption encode is not supported. Use StatusWrite / StatusWriteFromName.',
          ),
        }),
      ),
      valueSchema: SelectOption,
    }),
    nameSchema: Schema.String,
  }),

  /** Transform to StatusProperty with a typed name (fails for unknown options). */
  asPropertyNamed: <TName extends string>(nameSchema: Schema.Codec<TName, TName>) => {
    const optionSchema = makeSelectOptionWithName(nameSchema)

    return StatusProperty.pipe(
      Schema.refine(
        (p): p is typeof p & { status: typeof optionSchema.Type | null } =>
          p.status === null || isAllowedName({ nameSchema, name: p.status.name }),
        { message: 'Status must be one of the allowed options' },
      ),
    )
  },

  /** Transform to Option<string> (status name). */
  asString: withOptionValueSchema({
    schema: StatusProperty.pipe(
      Schema.decodeTo(Schema.Option(Schema.String), {
        decode: SchemaGetter.transform((prop) =>
          prop.status === null ? Option.none() : Option.some(prop.status.name)
        ),
        encode: SchemaGetter.forbidden(
          () => 'Status.asString encode is not supported. Use StatusWrite / StatusWriteFromName.',
        ),
      }),
    ),
    valueSchema: Schema.String,
  }),

  /** Transform to Option<SelectOption> with a typed name (fails for unknown options). */
  asOptionNamed: <TName extends string>(nameSchema: Schema.Codec<TName, TName>) => {
    const optionSchema = makeSelectOptionWithName(nameSchema)

    return withOptionNameSchema({
      schema: withOptionValueSchema({
        schema: StatusProperty.pipe(
          Schema.refine(
            (p): p is typeof p & { status: typeof optionSchema.Type | null } =>
              p.status === null || isAllowedName({ nameSchema, name: p.status.name }),
            { message: 'Status must be one of the allowed options' },
          ),
          Schema.decodeTo(Schema.Option(optionSchema), {
            decode: SchemaGetter.transform((prop) =>
              prop.status === null ? Option.none() : Option.some(prop.status)
            ),
            encode: SchemaGetter.forbidden(
              () =>
                'Status.asOptionNamed encode is not supported. Use StatusWrite / StatusWriteFromName.',
            ),
          }),
        ),
        valueSchema: optionSchema,
      }),
      nameSchema,
    })
  },

  /** Transform to Option<name> with allowed options (fails for unknown options). */
  asName: <TName extends string>(nameSchema: Schema.Codec<TName, TName>) =>
    withOptionValueSchema({
      schema: StatusProperty.pipe(
        Schema.refine(
          (p): p is typeof p & { status: { name: TName } | null } =>
            p.status === null || isAllowedName({ nameSchema, name: p.status.name }),
          { message: 'Status must be one of the allowed options' },
        ),
        Schema.decodeTo(Schema.Option(nameSchema), {
          decode: SchemaGetter.transform((prop) =>
            prop.status === null ? Option.none() : Option.some(prop.status.name)
          ),
          encode: SchemaGetter.forbidden(
            () => 'Status.asName encode is not supported. Use StatusWrite / StatusWriteFromName.',
          ),
        }),
      ),
      valueSchema: nameSchema,
    }),

  Write: {
    Schema: StatusWrite,
    fromName: StatusWriteFromName,
  },
} as const
