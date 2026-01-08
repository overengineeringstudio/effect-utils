/**
 * NDJSON schemas for database dump output
 */

import { Schema } from 'effect'

// TODO: Add SQLite output support in future version

/** Schema metadata for the dump */
export class DumpSchemaFile extends Schema.Class<DumpSchemaFile>('DumpSchemaFile')({
  /** Schema version for forward compatibility */
  version: Schema.Literal('1'),
  /** Database ID that was dumped */
  databaseId: Schema.String,
  /** Database name at time of dump */
  databaseName: Schema.String,
  /** ISO timestamp when dump was created */
  dumpedAt: Schema.String,
  /** Database property schema */
  properties: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      /** Additional type-specific metadata (e.g., select options) */
      config: Schema.optional(Schema.Unknown),
    }),
  ),
  /** Dump options used */
  options: Schema.Struct({
    includeContent: Schema.Boolean,
    contentDepth: Schema.optional(Schema.Number),
  }),
}) {}

/** A single page in the dump */
export class DumpPage extends Schema.Class<DumpPage>('DumpPage')({
  /** Page ID */
  id: Schema.String,
  /** Page URL */
  url: Schema.String,
  /** ISO timestamp when page was created */
  createdTime: Schema.String,
  /** ISO timestamp when page was last edited */
  lastEditedTime: Schema.String,
  /** Page properties as key-value pairs */
  properties: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  /** Page content blocks (if --content flag was used) */
  content: Schema.optional(Schema.Array(Schema.Unknown)),
}) {}

/** Encode a DumpSchemaFile to JSON string */
export const encodeDumpSchemaFile = Schema.encodeSync(Schema.parseJson(DumpSchemaFile))

/** Encode a DumpPage to JSON string */
export const encodeDumpPage = Schema.encodeSync(Schema.parseJson(DumpPage))

/** Decode a DumpSchemaFile from JSON string */
export const decodeDumpSchemaFile = Schema.decodeSync(Schema.parseJson(DumpSchemaFile))

/** Decode a DumpPage from JSON string */
export const decodeDumpPage = Schema.decodeSync(Schema.parseJson(DumpPage))
