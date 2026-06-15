/**
 * Files/media write boundary (SM6.1).
 *
 * notion-md has no v-next file upload/preservation gateway yet, so any write
 * that would carry modeled, byte-backed file/media payloads must fail closed
 * with a named guard (R13) rather than silently dropping or corrupting them.
 *
 * {@link classifyMediaWrite} replaces the coarse `rejectModeledMediaPayloadWrite`
 * blanket reject: it inspects the declared {@link NmdStorage} file units and
 * returns either `inert` (proven safe to proceed) or `blocked` (carries the
 * specific guard name and offending file ids).
 *
 * FAIL-CLOSED CONTRACT: `inert` requires positive proof of durability, never the
 * mere absence of a danger signal. A file unit whose byte-transfer obligation is
 * not provably satisfiable blocks. Since `NmdFileUnit` carries no `external_url`
 * variant (external media lives in body Markdown and frontmatter file properties,
 * never in `storage.files`), the only durable-proceed case is an empty
 * `storage.files`. This honors the design's external-URL allowance structurally:
 * an external-URL-only page never produces a `storage.files` entry, so it reaches
 * the empty -> inert path with no byte transfer. Any representable file unit is
 * Notion-hosted byte-backed (or ambiguous) and therefore blocks.
 *
 * @module
 */

import type { NmdFileUnit, NmdStorage } from '@overeng/notion-effect-client'

import type { NonBodyGuardName } from './non-body-guards.ts'

/** A write operation classified by the files/media boundary. */
export type MediaWriteOperation =
  /** Local Markdown push (local -> remote): would require uploading bytes. */
  | 'push'
  /** Remote Markdown pull (remote -> local): would require writing bytes. */
  | 'pull'
  /** Shared 3-way reconcile: would require writing bytes locally. */
  | 'shared'

/** Verdict of {@link classifyMediaWrite}. */
export type MediaWriteVerdict =
  | {
      /** No modeled byte-backed media: the write is durable and may proceed. */
      readonly _tag: 'inert'
    }
  | {
      /** Modeled byte-backed (or ambiguous) media: the write is blocked. */
      readonly _tag: 'blocked'
      /** The violated non-body guard name. */
      readonly guard: NonBodyGuardName
      /** Ids of the file units that triggered the block. */
      readonly fileIds: readonly string[]
      /** Human-readable explanation of the refusal. */
      readonly reason: string
    }

const fileUnitsOf = (storage: NmdStorage | undefined): readonly NmdFileUnit[] => {
  if (storage === undefined) return []
  switch (storage._tag) {
    case 'self_contained':
      return storage.files
    case 'object_store':
      // object_store keeps only ids, but a non-empty id set is still modeled
      // byte-backed media that this phase cannot durably write.
      return storage.file_ids.map(
        (id): NmdFileUnit => ({
          _tag: 'file_unit',
          id,
          role: 'block_file',
          filename: id,
        }),
      )
  }
}

/**
 * The guard a blocked write reports, chosen by the byte-transfer direction the
 * operation implies. Push uploads bytes to Notion; pull/shared write bytes
 * locally. `Replacement`/`Deletion` guards are reserved for mutation paths that
 * land in later sub-milestones.
 */
const guardForOperation = (operation: MediaWriteOperation): NonBodyGuardName => {
  switch (operation) {
    case 'push':
      return 'DurableFileUploadUnsupported'
    case 'pull':
    case 'shared':
      return 'DurableFileWriteUnsupported'
  }
}

/**
 * Classify a files/media write at a reconcile write site.
 *
 * Returns `inert` only when there are no modeled byte-backed file units (the
 * external-URL-only and no-media cases both reduce to an empty file-unit set in
 * the current storage model). Otherwise returns `blocked` with the
 * operation-specific guard and the offending file ids. Fail-closed by
 * construction: any representable file unit blocks.
 */
export const classifyMediaWrite = (opts: {
  readonly storage: NmdStorage | undefined
  readonly operation: MediaWriteOperation
}): MediaWriteVerdict => {
  const units = fileUnitsOf(opts.storage)
  if (units.length === 0) return { _tag: 'inert' }

  const fileIds = units.map((unit) => unit.id)
  const guard = guardForOperation(opts.operation)
  return {
    _tag: 'blocked',
    guard,
    fileIds,
    reason: `contains modeled file/media payloads (${fileIds.join(', ')}); ${opts.operation} cannot durably transfer file bytes because notion-md has no v-next file upload/preservation gateway yet`,
  }
}
