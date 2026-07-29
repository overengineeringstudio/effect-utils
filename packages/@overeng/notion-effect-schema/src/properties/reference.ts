import { Option, Schema, SchemaTransformation } from 'effect'

import { docsPath, NotionUUID, shouldNeverHappen } from '../common.ts'
import {
  ExternalFile as ExternalFileReference,
  NotionFile as NotionFileReference,
} from '../objects.ts'
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
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('people').annotate({
    description: 'Property type identifier.',
  }),
  people: Schema.Array(User).annotate({
    description: 'Array of assigned users.',
  }),
}).annotate({
  identifier: 'Notion.PeopleProperty',
  title: 'People Property',
  description: 'A people property value.',
  [docsPath]: 'property-value-object#people',
})

export type PeopleProperty = typeof PeopleProperty.Type

const PeopleArray = Schema.Array(User)
const encodePeopleArray = Schema.encodeSync(PeopleArray)

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
}).annotate({
  identifier: 'Notion.PeopleWrite',
  title: 'People (Write)',
  description: 'Write payload for a people property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type PeopleWrite = typeof PeopleWrite.Type

/** Transforms user IDs array into a people write payload */
export const PeopleWriteFromIds = Schema.Array(NotionUUID)
  .pipe(
    Schema.decodeTo(
      PeopleWrite,
      SchemaTransformation.transform<PeopleWrite, ReadonlyArray<NotionUUID>>({
        decode: (ids) => ({
          people: ids.map((id) => ({ id })),
        }),
        encode: (write) => write.people.map((p) => p.id),
      }),
    ),
  )
  .annotate({
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
  raw: PeopleProperty.pipe(
    Schema.decodeTo(
      PeopleArray,
      SchemaTransformation.transform<typeof PeopleArray.Encoded, PeopleProperty>({
        decode: (prop) => encodePeopleArray(prop.people),
        encode: (): PeopleProperty =>
          shouldNeverHappen(
            'People.raw encode is not supported. Use PeopleWrite / PeopleWriteFromIds.',
          ),
      }),
    ),
  ),

  /** Transform to array of user IDs. */
  asIds: PeopleProperty.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform<ReadonlyArray<string>, PeopleProperty>({
        decode: (prop) => prop.people.map((u) => u.id),
        encode: (): PeopleProperty =>
          shouldNeverHappen(
            'People.asIds encode is not supported. Use PeopleWrite / PeopleWriteFromIds.',
          ),
      }),
    ),
  ),

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
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('relation').annotate({
    description: 'Property type identifier.',
  }),
  relation: Schema.Array(
    Schema.Struct({
      id: NotionUUID.annotate({
        description: 'ID of the related page.',
      }),
    }),
  ).annotate({
    description: 'Array of related page references.',
  }),
  has_more: Schema.OptionFromOptional(Schema.Boolean).annotate({
    description: 'Whether there are more relations than returned.',
  }),
}).annotate({
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
}).annotate({
  identifier: 'Notion.RelationWrite',
  title: 'Relation (Write)',
  description: 'Write payload for a relation property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type RelationWrite = typeof RelationWrite.Type

/** Transforms page IDs array into a relation write payload */
export const RelationWriteFromIds = Schema.Array(NotionUUID)
  .pipe(
    Schema.decodeTo(
      RelationWrite,
      SchemaTransformation.transform<RelationWrite, ReadonlyArray<NotionUUID>>({
        decode: (ids) => ({
          relation: ids.map((id) => ({ id })),
        }),
        encode: (write) => write.relation.map((r) => r.id),
      }),
    ),
  )
  .annotate({
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
  asIds: RelationProperty.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform<ReadonlyArray<string>, RelationProperty>({
        decode: (prop) => prop.relation.map((r) => r.id),
        encode: (): RelationProperty =>
          shouldNeverHappen(
            'Relation.asIds encode is not supported. Use RelationWrite / RelationWriteFromIds.',
          ),
      }),
    ),
  ),

  /** Transform to a single relation object (fails if not exactly one). */
  asSingle: RelationProperty.pipe(
    Schema.refine((p): p is typeof p & { relation: [{ id: string }] } => p.relation.length === 1, {
      message: 'Relation must have exactly one item',
    }),
  ).pipe(
    Schema.decodeTo(
      Schema.Struct({ id: NotionUUID }),
      SchemaTransformation.transform<
        { readonly id: NotionUUID },
        RelationProperty & { relation: [{ id: string }] }
      >({
        decode: (prop) => prop.relation[0],
        encode: (): RelationProperty & { relation: [{ id: string }] } =>
          shouldNeverHappen(
            'Relation.asSingle encode is not supported. Use RelationWrite / RelationWriteFromIds.',
          ),
      }),
    ),
  ),

  /** Transform to a single related page ID (fails if not exactly one). */
  asSingleId: RelationProperty.pipe(
    Schema.refine((p): p is typeof p & { relation: [{ id: string }] } => p.relation.length === 1, {
      message: 'Relation must have exactly one item',
    }),
  ).pipe(
    Schema.decodeTo(
      NotionUUID,
      SchemaTransformation.transform<NotionUUID, RelationProperty & { relation: [{ id: string }] }>(
        {
          decode: (prop) => prop.relation[0].id,
          encode: (): RelationProperty & { relation: [{ id: string }] } =>
            shouldNeverHappen(
              'Relation.asSingleId encode is not supported. Use RelationWrite / RelationWriteFromIds.',
            ),
        },
      ),
    ),
  ),

  /** Transform to an optional single relation object (allows 0 or 1 items). */
  asSingleOption: RelationProperty.pipe(
    Schema.check(
      Schema.makeFilter((p) => p.relation.length <= 1, {
        message: 'Relation must have at most one item',
      }),
    ),
  ).pipe(
    Schema.decodeTo(
      Schema.Option(Schema.Struct({ id: NotionUUID })),
      SchemaTransformation.transform<Option.Option<{ readonly id: NotionUUID }>, RelationProperty>({
        decode: (prop) => Option.fromNullishOr(prop.relation[0]),
        encode: (): RelationProperty =>
          shouldNeverHappen(
            'Relation.asSingleOption encode is not supported. Use RelationWrite / RelationWriteFromIds.',
          ),
      }),
    ),
  ),

  /** Transform to an optional single related page ID (allows 0 or 1 items). */
  asSingleIdOption: RelationProperty.pipe(
    Schema.check(
      Schema.makeFilter((p) => p.relation.length <= 1, {
        message: 'Relation must have at most one item',
      }),
    ),
  ).pipe(
    Schema.decodeTo(
      Schema.Option(NotionUUID),
      SchemaTransformation.transform<Option.Option<NotionUUID>, RelationProperty>({
        decode: (prop) => Option.fromNullishOr(prop.relation[0]?.id),
        encode: (): RelationProperty =>
          shouldNeverHappen(
            'Relation.asSingleIdOption encode is not supported. Use RelationWrite / RelationWriteFromIds.',
          ),
      }),
    ),
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
  ...ExternalFileReference.fields,
  ...Schema.Struct({
    name: Schema.String.annotate({
      description: 'Name of the file.',
    }),
  }).fields,
}).annotate({
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
  ...NotionFileReference.fields,
  ...Schema.Struct({
    name: Schema.String.annotate({
      description: 'Name of the file.',
    }),
  }).fields,
}).annotate({
  identifier: 'Notion.NotionFile',
  title: 'Notion File',
  description: 'A file hosted on Notion (URL expires).',
  [docsPath]: 'property-value-object#files',
})

export type NotionFile = typeof NotionFile.Type

/**
 * File object (either external or Notion-hosted).
 */
export const FileObject = Schema.Union([ExternalFile, NotionFile]).annotate({
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
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('files').annotate({
    description: 'Property type identifier.',
  }),
  files: Schema.Array(FileObject).annotate({
    description: 'Array of file objects.',
  }),
}).annotate({
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
}).annotate({
  identifier: 'Notion.FilesWrite',
  title: 'Files (Write)',
  description: 'Write payload for a files property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type FilesWrite = typeof FilesWrite.Type

/** Transforms external URLs array into a files write payload */
export const FilesWriteFromUrls = Schema.Array(Schema.String)
  .pipe(
    Schema.decodeTo(
      FilesWrite,
      SchemaTransformation.transform<FilesWrite, ReadonlyArray<string>>({
        decode: (urls) => ({
          files: urls.map((url) => ({
            type: 'external' as const,
            external: { url },
          })),
        }),
        encode: (write) => write.files.map((f) => f.external.url),
      }),
    ),
  )
  .annotate({
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
  raw: FilesProperty.pipe(
    Schema.decodeTo(
      Schema.Array(FileObject),
      SchemaTransformation.transform<ReadonlyArray<FileObject>, FilesProperty>({
        decode: (prop) => prop.files,
        encode: (): FilesProperty =>
          shouldNeverHappen(
            'Files.raw encode is not supported. Use FilesWrite / FilesWriteFromUrls.',
          ),
      }),
    ),
  ),

  /** Transform to array of URLs. */
  asUrls: FilesProperty.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform<ReadonlyArray<string>, FilesProperty>({
        decode: (prop) =>
          prop.files.map((f) => (f.type === 'external' ? f.external.url : f.file.url)),
        encode: (): FilesProperty =>
          shouldNeverHappen(
            'Files.asUrls encode is not supported. Use FilesWrite / FilesWriteFromUrls.',
          ),
      }),
    ),
  ),

  Write: {
    Schema: FilesWrite,
    fromUrls: FilesWriteFromUrls,
  },
} as const
