/**
 * Non-body write guard vocabulary.
 *
 * These names identify the safety invariants enforced at the non-body write
 * boundaries (files/media this phase; comments and destructive body in later
 * sub-milestones). They are a DELIBERATELY SEPARATE literal from
 * {@link PropertyWriteGuardName}: property writes and non-body writes are
 * different invariant families, so folding them into one vocabulary would
 * conflate two unrelated fail-closed surfaces. A blocked non-body write carries
 * one of these names on {@link NmdNonBodyWriteBlockedError} so the refusal is
 * observable rather than a silent drop (R13).
 *
 * @module
 */

import { Schema } from 'effect'

/**
 * The set of non-body write guard names.
 *
 * This phase (SM6.1) only exercises the file/media guards; the comment and
 * destructive-body guards land in SM6.2/SM6.3. `Replacement`/`Deletion` are
 * declared now but have no call site yet — they describe invariants the
 * file/media boundary will name once mutation paths exist.
 */
export const nonBodyGuardNames = [
  // File/media boundary (SM6.1).
  'DurableFileWriteUnsupported',
  'DurableFileUploadUnsupported',
  'DurableFileReplacementUnsupported',
  'DurableFileDeletionUnsupported',
] as const

/** A single non-body write guard name. */
export const NonBodyGuardName = Schema.Literal(...nonBodyGuardNames).annotations({
  identifier: 'NotionMd.NonBodyGuardName',
})
export type NonBodyGuardName = typeof NonBodyGuardName.Type
