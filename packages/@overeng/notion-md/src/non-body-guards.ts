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
 * SM6.1 exercises the file/media guards; SM6.2 adds the comment guard;
 * SM6.3 will add the destructive-body guard. `Replacement`/`Deletion` are
 * declared now but have no call site yet — they describe invariants the
 * file/media boundary will name once mutation paths exist.
 */
export const nonBodyGuardNames = [
  // File/media boundary (SM6.1).
  'DurableFileWriteUnsupported',
  'DurableFileUploadUnsupported',
  'DurableFileReplacementUnsupported',
  'DurableFileDeletionUnsupported',
  // Comment-write boundary (SM6.2). Shares the reason string
  // `'comments-api-not-implemented'` with the webhook CommentWebhookBoundary
  // so both trigger and write surfaces use a single vocabulary.
  'CommentWriteUnsupported',
] as const

/** A single non-body write guard name. */
export const NonBodyGuardName = Schema.Literal(...nonBodyGuardNames).annotations({
  identifier: 'NotionMd.NonBodyGuardName',
})
export type NonBodyGuardName = typeof NonBodyGuardName.Type
