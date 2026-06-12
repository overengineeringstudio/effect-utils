import type { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { descriptorForUtf8, type ContentDescriptor } from '@overeng/content-address'
import type { BodyCompleteness } from '@overeng/notion-core'
import type {
  BodyEvidenceFingerprint,
  RemoteBodyObservationEvidence,
  Sha256Digest,
} from '@overeng/notion-effect-client'

import { NmdFrontmatterError, NmdRemoteBodyLossyError, type NmdError } from './errors.ts'
import { parseNmdFile } from './frontmatter.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import { NotionMdGateway } from './model.ts'
import type { PullPageResult } from './model.ts'
import { trackPage, type TrackResult } from './reconcile.ts'
import { NmdStateStore } from './state-store.ts'

/** Raised when the body-only facade refuses a stale verified operation. */
export class NotionMdBodyConflictError extends Schema.TaggedError<NotionMdBodyConflictError>()(
  'NotionMdBodyConflictError',
  {
    operation: Schema.Literal('replace_remote_body_verified', 'settle_verified_body_push'),
    page_id: Schema.String,
    path: Schema.optional(Schema.String),
    expected_body_hash: Schema.String,
    actual_body_hash: Schema.String,
    message: Schema.String,
  },
) {}

export interface NotionMdBodySnapshot {
  readonly pageId: string
  readonly markdown: string
  readonly bodyHash: Sha256Digest
  readonly bodyDescriptor: ContentDescriptor
  readonly bodyEvidence?: RemoteBodyObservationEvidence
  readonly bodyEvidenceFingerprint?: BodyEvidenceFingerprint
  readonly completeness?: BodyCompleteness
}

export interface NotionMdLocalBodySnapshot extends NotionMdBodySnapshot {
  readonly path: string
  readonly fileContentHash: Sha256Digest
}

export interface NotionMdMaterializedBody extends NotionMdLocalBodySnapshot {
  readonly track: TrackResult
}

export interface NotionMdVerifiedRemoteReplaceResult {
  readonly pageId: string
  readonly previousBodyHash: Sha256Digest
  readonly bodyHash: Sha256Digest
  readonly bodyDescriptor: ContentDescriptor
  readonly bodyEvidence?: RemoteBodyObservationEvidence
  readonly bodyEvidenceFingerprint?: BodyEvidenceFingerprint
  readonly markdown: string
  readonly completeness?: BodyCompleteness
}

export interface NotionMdSettledBodyPush {
  readonly pageId: string
  readonly path: string
  readonly localBodyHash: Sha256Digest
  readonly localFileContentHash: Sha256Digest
  readonly remoteBodyHash: Sha256Digest
  readonly remoteMarkdown: string
}

const remoteBodySnapshot = (pulled: PullPageResult): NotionMdBodySnapshot => {
  const markdown = normalizeMarkdownLineEndings(pulled.markdown.markdown)
  return {
    pageId: pulled.page.id,
    markdown,
    bodyHash: sha256Digest(markdown),
    bodyDescriptor: descriptorForUtf8({
      value: markdown,
      mediaType: 'text/markdown; charset=utf-8',
      codec: 'notion-enhanced-markdown',
      schemaVersion: 1,
    }),
    ...(pulled.markdown.body_evidence === undefined
      ? {}
      : { bodyEvidence: pulled.markdown.body_evidence }),
    ...(pulled.markdown.body_evidence_fingerprint === undefined
      ? {}
      : { bodyEvidenceFingerprint: pulled.markdown.body_evidence_fingerprint }),
    ...(pulled.markdown.completeness === undefined
      ? {}
      : { completeness: pulled.markdown.completeness }),
  }
}

const assertSnapshotComplete = (opts: {
  readonly operation: string
  readonly snapshot: NotionMdBodySnapshot
}): Effect.Effect<void, NmdRemoteBodyLossyError> => {
  const completeness = opts.snapshot.completeness
  if (completeness === undefined || completeness._tag === 'complete') return Effect.void

  return Effect.fail(
    new NmdRemoteBodyLossyError({
      operation: opts.operation,
      page_id: opts.snapshot.pageId,
      reasons: [...completeness.reasons],
      message: `Remote Markdown body for page ${opts.snapshot.pageId} is lossy (${completeness.reasons.join(', ')}); refusing verified body operation`,
    }),
  )
}

/** Observe only the current remote Markdown body for a Notion page. */
export const observeRemoteBody = (opts: {
  readonly pageId: string
}): Effect.Effect<NotionMdBodySnapshot, NmdError, NotionMdGateway> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const pulled = yield* gateway.pullPage({ pageId: opts.pageId })
    return remoteBodySnapshot(pulled)
  })

/** Read and hash only the parsed body from a local `.nmd` file. */
export const readLocalBody = (opts: {
  readonly path: string
}): Effect.Effect<NotionMdLocalBodySnapshot, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const content = yield* store.readNmdFile({ path: opts.path })
    const parsed = yield* parseNmdFile({ path: opts.path, content })
    const pageId = parsed.frontmatter.notion_md.page_id
    if (pageId === null) {
      return yield* new NmdFrontmatterError({
        path: opts.path,
        message: `.nmd file ${opts.path} is unbound (page_id: null); the body-only facade only operates on bound pages`,
      })
    }
    return {
      path: opts.path,
      pageId,
      markdown: parsed.body,
      bodyHash: sha256Digest(parsed.body),
      bodyDescriptor: descriptorForUtf8({
        value: parsed.body,
        mediaType: 'text/markdown; charset=utf-8',
        codec: 'notion-enhanced-markdown',
        schemaVersion: 1,
      }),
      fileContentHash: sha256Digest(content),
    }
  })

/** Track a remote page as shared local state and return body hashes. */
export const materializeBody = (opts: {
  readonly pageId: string
  readonly outPath: string
}): Effect.Effect<
  NotionMdMaterializedBody,
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const track = yield* trackPage({ pageId: opts.pageId, outPath: opts.outPath, source: 'shared' })
    const local = yield* readLocalBody({ path: opts.outPath })
    return { ...local, track }
  })

/** Replace remote Markdown body only after proving the caller's remote base is current. */
export const replaceRemoteBodyVerified = (opts: {
  readonly pageId: string
  readonly baseBodyHash: Sha256Digest
  readonly markdown: string
}): Effect.Effect<
  NotionMdVerifiedRemoteReplaceResult,
  NmdError | NotionMdBodyConflictError,
  NotionMdGateway
> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const current = remoteBodySnapshot(yield* gateway.pullPage({ pageId: opts.pageId }))
    yield* assertSnapshotComplete({
      operation: 'replace_remote_body_verified',
      snapshot: current,
    })
    if (current.bodyHash !== opts.baseBodyHash) {
      return yield* new NotionMdBodyConflictError({
        operation: 'replace_remote_body_verified',
        page_id: opts.pageId,
        expected_body_hash: opts.baseBodyHash,
        actual_body_hash: current.bodyHash,
        message: `Remote body for page ${opts.pageId} changed before verified replace`,
      })
    }

    yield* gateway.updateMarkdown({
      pageId: opts.pageId,
      command: { _tag: 'replace_content', markdown: opts.markdown },
      allowDeletingContent: false,
    })
    const updated = remoteBodySnapshot(yield* gateway.pullPage({ pageId: opts.pageId }))
    yield* assertSnapshotComplete({
      operation: 'replace_remote_body_verified',
      snapshot: updated,
    })
    return {
      pageId: opts.pageId,
      previousBodyHash: current.bodyHash,
      bodyHash: updated.bodyHash,
      bodyDescriptor: updated.bodyDescriptor,
      ...(updated.bodyEvidence === undefined ? {} : { bodyEvidence: updated.bodyEvidence }),
      ...(updated.bodyEvidenceFingerprint === undefined
        ? {}
        : { bodyEvidenceFingerprint: updated.bodyEvidenceFingerprint }),
      markdown: updated.markdown,
      ...(updated.completeness === undefined ? {} : { completeness: updated.completeness }),
    }
  })

/** Re-check local body stability, then refresh the local materialization after a verified push. */
export const settleVerifiedBodyPush = (opts: {
  readonly pageId: string
  readonly path: string
  readonly expectedLocalBodyHash: Sha256Digest
}): Effect.Effect<
  NotionMdSettledBodyPush,
  NmdError | NotionMdBodyConflictError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const local = yield* readLocalBody({ path: opts.path })
    if (local.bodyHash !== opts.expectedLocalBodyHash) {
      return yield* new NotionMdBodyConflictError({
        operation: 'settle_verified_body_push',
        page_id: opts.pageId,
        path: opts.path,
        expected_body_hash: opts.expectedLocalBodyHash,
        actual_body_hash: local.bodyHash,
        message: `Local .nmd body for page ${opts.pageId} changed before verified push settlement`,
      })
    }

    const materialized = yield* materializeBody({ pageId: opts.pageId, outPath: opts.path })
    return {
      pageId: opts.pageId,
      path: opts.path,
      localBodyHash: materialized.bodyHash,
      localFileContentHash: materialized.fileContentHash,
      remoteBodyHash: materialized.bodyHash,
      remoteMarkdown: materialized.markdown,
    }
  })
