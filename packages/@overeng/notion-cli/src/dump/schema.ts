/**
 * NDJSON schema for database dump rows
 */

import { Schema } from 'effect'

/** Block with depth information for flat dump output */
export const DumpBlockWithDepth = Schema.Struct({
  /** The block object (raw Notion format) */
  block: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  /** Depth level (0 = top-level) */
  depth: Schema.Number,
  /** Parent block ID (null for top-level blocks) */
  parentId: Schema.NullOr(Schema.String),
})

export type DumpBlockWithDepth = typeof DumpBlockWithDepth.Type

/** A single page row in the NDJSON dump */
export class DumpPage extends Schema.Class<DumpPage>('DumpPage')({
  /** Page ID */
  id: Schema.String,
  /** Page URL */
  url: Schema.String,
  /** ISO timestamp when page was created */
  createdTime: Schema.String,
  /** ISO timestamp when page was last edited */
  lastEditedTime: Schema.String,
  /** Page properties as key-value pairs (raw Notion format) */
  properties: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  /** Page content blocks with depth info (if --content flag was used) */
  content: Schema.optional(Schema.Array(DumpBlockWithDepth)),
}) {}

/** Encode a DumpPage to JSON string */
export const encodeDumpPage = Schema.encodeSync(Schema.parseJson(DumpPage))

/** Decode a DumpPage from JSON string */
export const decodeDumpPage = Schema.decodeSync(Schema.parseJson(DumpPage))
