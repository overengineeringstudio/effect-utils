import { Schema } from 'effect'

import { docsPath, NotionUUID, shouldNeverHappen } from '../common.ts'
import { User } from '../users.ts'

// -----------------------------------------------------------------------------
// People Property
// -----------------------------------------------------------------------------

/**
 * People property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#people
 */
export const PeopleProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('people').annotations({
    description: 'Property type identifier.',
  }),
  people: Schema.Array(User).annotations({
    description: 'Array of assigned users.',
  }),
}).annotations({
  identifier: 'Notion.PeopleProperty',
  title: 'People Property',
  description: 'A people property value.',
  [docsPath]: 'property-value-object#people',
})

export type PeopleProperty = typeof PeopleProperty.Type

/**
 * People property write payload (for create/update page requests).
 * Notion expects an array of user references (by id).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const PeopleWrite = Schema.Struct({
  people: Schema.Array(
    Schema.Struct({
      id: NotionUUID,
    }),
  ),
}).annotations({
  identifier: 'Notion.PeopleWrite',
  title: 'People (Write)',
  description: 'Write payload for a people property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type PeopleWrite = typeof PeopleWrite.Type

export const PeopleWriteFromIds = Schema.transform(Schema.Array(NotionUUID), PeopleWrite, {
  strict: false,
  decode: (ids) => ({
    people: ids.map((id) => ({ id })),
  }),
  encode: (write) => write.people.map((p) => p.id),
}).annotations({
  identifier: 'Notion.PeopleWriteFromIds',
  title: 'People (Write) From IDs',
  description: 'Transform user IDs into a people write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for People property. */
export const People = {
  /** The raw PeopleProperty schema. */
  Property: PeopleProperty,

  /** Transform to raw array of Users. */
  raw: Schema.transform(PeopleProperty, Schema.Array(User), {
    strict: false,
    decode: (prop) => prop.people,
    encode: () =>
      shouldNeverHappen(
        'People.raw encode is not supported. Use PeopleWrite / PeopleWriteFromIds.',
      ),
  }),

  /** Transform to array of user IDs. */
  asIds: Schema.transform(PeopleProperty, Schema.Array(Schema.String), {
    strict: false,
    decode: (prop) => prop.people.map((u) => u.id),
    encode: () =>
      shouldNeverHappen(
        'People.asIds encode is not supported. Use PeopleWrite / PeopleWriteFromIds.',
      ),
  }),

  Write: {
    Schema: PeopleWrite,
    fromIds: PeopleWriteFromIds,
  },
} as const

// -----------------------------------------------------------------------------
// Relation Property
// -----------------------------------------------------------------------------

/**
 * Relation property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#relation
 */
export const RelationProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('relation').annotations({
    description: 'Property type identifier.',
  }),
  relation: Schema.Array(
    Schema.Struct({
      id: NotionUUID.annotations({
        description: 'ID of the related page.',
      }),
    }),
  ).annotations({
    description: 'Array of related page references.',
  }),
  has_more: Schema.optionalWith(Schema.Boolean, { as: 'Option' }).annotations({
    description: 'Whether there are more relations than returned.',
  }),
}).annotations({
  identifier: 'Notion.RelationProperty',
  title: 'Relation Property',
  description: 'A relation property value linking to other pages.',
  [docsPath]: 'property-value-object#relation',
})

export type RelationProperty = typeof RelationProperty.Type

/**
 * Relation property write payload (for create/update page requests).
 * Notion expects an array of page references (by id).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const RelationWrite = Schema.Struct({
  relation: Schema.Array(
    Schema.Struct({
      id: NotionUUID,
    }),
  ),
}).annotations({
  identifier: 'Notion.RelationWrite',
  title: 'Relation (Write)',
  description: 'Write payload for a relation property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type RelationWrite = typeof RelationWrite.Type

export const RelationWriteFromIds = Schema.transform(Schema.Array(NotionUUID), RelationWrite, {
  strict: false,
  decode: (ids) => ({
    relation: ids.map((id) => ({ id })),
  }),
  encode: (write) => write.relation.map((r) => r.id),
}).annotations({
  identifier: 'Notion.RelationWriteFromIds',
  title: 'Relation (Write) From IDs',
  description: 'Transform page IDs into a relation write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Relation property. */
export const Relation = {
  /** The raw RelationProperty schema. */
  Property: RelationProperty,

  /** Transform to array of page IDs. */
  asIds: Schema.transform(RelationProperty, Schema.Array(Schema.String), {
    strict: false,
    decode: (prop) => prop.relation.map((r) => r.id),
    encode: () =>
      shouldNeverHappen(
        'Relation.asIds encode is not supported. Use RelationWrite / RelationWriteFromIds.',
      ),
  }),

  /** Transform to a single relation object (fails if not exactly one). */
  asSingle: Schema.transform(
    RelationProperty.pipe(
      Schema.filter((p): p is typeof p & { relation: [{ id: string }] } => p.relation.length === 1, {
        message: () => 'Relation must have exactly one item',
      }),
    ),
    Schema.Struct({ id: NotionUUID }),
    {
      strict: false,
      decode: (prop) => prop.relation[0],
      encode: () =>
        shouldNeverHappen(
          'Relation.asSingle encode is not supported. Use RelationWrite / RelationWriteFromIds.',
        ),
    },
  ),

  /** Transform to a single related page ID (fails if not exactly one). */
  asSingleId: Schema.transform(
    RelationProperty.pipe(
      Schema.filter((p): p is typeof p & { relation: [{ id: string }] } => p.relation.length === 1, {
        message: () => 'Relation must have exactly one item',
      }),
    ),
    NotionUUID,
    {
      strict: false,
      decode: (prop) => prop.relation[0].id,
      encode: () =>
        shouldNeverHappen(
          'Relation.asSingleId encode is not supported. Use RelationWrite / RelationWriteFromIds.',
        ),
    },
  ),

  Write: {
    Schema: RelationWrite,
    fromIds: RelationWriteFromIds,
  },
} as const

// -----------------------------------------------------------------------------
// Files Property
// -----------------------------------------------------------------------------

/**
 * External file object.
 */
export const ExternalFile = Schema.Struct({
  type: Schema.Literal('external'),
  name: Schema.String.annotations({
    description: 'Name of the file.',
  }),
  external: Schema.Struct({
    url: Schema.String.annotations({
      description: 'External URL of the file.',
      examples: ['https://example.com/image.png'],
    }),
  }),
}).annotations({
  identifier: 'Notion.ExternalFile',
  title: 'External File',
  description: 'A file hosted externally.',
  [docsPath]: 'property-value-object#files',
})

export type ExternalFile = typeof ExternalFile.Type

/**
 * Notion-hosted file object.
 */
export const NotionFile = Schema.Struct({
  type: Schema.Literal('file'),
  name: Schema.String.annotations({
    description: 'Name of the file.',
  }),
  file: Schema.Struct({
    url: Schema.String.annotations({
      description: 'Notion-hosted URL of the file (expires).',
    }),
    expiry_time: Schema.String.annotations({
      description: 'When the URL expires (ISO 8601).',
    }),
  }),
}).annotations({
  identifier: 'Notion.NotionFile',
  title: 'Notion File',
  description: 'A file hosted on Notion (URL expires).',
  [docsPath]: 'property-value-object#files',
})

export type NotionFile = typeof NotionFile.Type

/**
 * File object (either external or Notion-hosted).
 */
export const FileObject = Schema.Union(ExternalFile, NotionFile).annotations({
  identifier: 'Notion.FileObject',
  title: 'File Object',
  description: 'A file, either external or Notion-hosted.',
  [docsPath]: 'property-value-object#files',
})

export type FileObject = typeof FileObject.Type

/**
 * Files property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#files
 */
export const FilesProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('files').annotations({
    description: 'Property type identifier.',
  }),
  files: Schema.Array(FileObject).annotations({
    description: 'Array of file objects.',
  }),
}).annotations({
  identifier: 'Notion.FilesProperty',
  title: 'Files Property',
  description: 'A files property value.',
  [docsPath]: 'property-value-object#files',
})

export type FilesProperty = typeof FilesProperty.Type

/**
 * Files property write payload (for create/update page requests).
 * Notion accepts external files in write requests.
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const FilesWrite = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      type: Schema.Literal('external'),
      name: Schema.optional(Schema.String),
      external: Schema.Struct({
        url: Schema.String,
      }),
    }),
  ),
}).annotations({
  identifier: 'Notion.FilesWrite',
  title: 'Files (Write)',
  description: 'Write payload for a files property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type FilesWrite = typeof FilesWrite.Type

export const FilesWriteFromUrls = Schema.transform(Schema.Array(Schema.String), FilesWrite, {
  strict: false,
  decode: (urls) => ({
    files: urls.map((url) => ({
      type: 'external' as const,
      external: { url },
    })),
  }),
  encode: (write) => write.files.map((f) => f.external.url),
}).annotations({
  identifier: 'Notion.FilesWriteFromUrls',
  title: 'Files (Write) From URLs',
  description: 'Transform external URLs into a files write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Files property. */
export const Files = {
  /** The raw FilesProperty schema. */
  Property: FilesProperty,

  /** Transform to raw array of FileObjects. */
  raw: Schema.transform(FilesProperty, Schema.Array(FileObject), {
    strict: false,
    decode: (prop) => prop.files,
    encode: () =>
      shouldNeverHappen('Files.raw encode is not supported. Use FilesWrite / FilesWriteFromUrls.'),
  }),

  /** Transform to array of URLs. */
  asUrls: Schema.transform(FilesProperty, Schema.Array(Schema.String), {
    strict: false,
    decode: (prop) => prop.files.map((f) => (f.type === 'external' ? f.external.url : f.file.url)),
    encode: () =>
      shouldNeverHappen(
        'Files.asUrls encode is not supported. Use FilesWrite / FilesWriteFromUrls.',
      ),
  }),

  Write: {
    Schema: FilesWrite,
    fromUrls: FilesWriteFromUrls,
  },
} as const
