/**
 * Non-body write guard vocabulary.
 *
 * Two distinct literal families cover the two distinct non-body invariant sets:
 *
 * - {@link NonBodyGuardName}: files/media (SM6.1) and comment (SM6.2) write
 *   boundaries. Carried on {@link NmdNonBodyWriteBlockedError}.
 * - {@link DestructiveBodyGuardName}: destructive body write gates (SM6.3):
 *   unknown-block deletion and review-markup-as-content. Carried on the
 *   dedicated {@link NmdDestructiveBodyBlockedError}.
 *
 * Both families are DELIBERATELY SEPARATE from {@link PropertyWriteGuardName}:
 * property writes and non-body writes are different invariant families, so
 * folding them into one vocabulary would conflate unrelated fail-closed surfaces.
 *
 * @module
 */

import { Schema } from 'effect'

/**
 * The set of files/media and comment write guard names.
 *
 * SM6.1 exercises the file/media guards; SM6.2 adds the comment guard.
 * `Replacement`/`Deletion` are declared now but have no call site yet — they
 * describe invariants the file/media boundary will name once mutation paths exist.
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

/** A single files/media or comment write guard name. */
export const NonBodyGuardName = Schema.Literals(nonBodyGuardNames).annotate({
  identifier: 'NotionMd.NonBodyGuardName',
})
export type NonBodyGuardName = typeof NonBodyGuardName.Type

/**
 * The set of destructive body write guard names (SM6.3).
 *
 * These guard the two opt-in destructive gates: deleting unknown Notion blocks
 * and writing Roughdraft review markup as Notion page content. Each is unblocked
 * by the specific allow flag named in `NmdDestructiveBodyBlockedError.allowFlag`.
 */
export const destructiveBodyGuardNames = [
  /** Blocked when a local body push would delete unknown Notion blocks. */
  'UnknownBlockDeletion',
  /** Blocked when the local body contains unresolved Roughdraft review markup. */
  'ReviewMarkupAsContent',
] as const

/** A single destructive body write guard name. */
export const DestructiveBodyGuardName = Schema.Literals(destructiveBodyGuardNames).annotate({
  identifier: 'NotionMd.DestructiveBodyGuardName',
})
export type DestructiveBodyGuardName = typeof DestructiveBodyGuardName.Type
