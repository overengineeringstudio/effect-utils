import type { FileSystem } from 'effect/FileSystem'
import { Effect, Schema } from 'effect'

import { descriptorForUtf8, type ContentDescriptor } from '@overeng/content-address'
import { describeBodyLossyRefusal, type BodyCompleteness } from '@overeng/notion-core'
import type {
  BodyEvidenceFingerprint,
  NmdWritablePropertyValue,
  RemoteBodyObservationEvidence,
  Sha256Digest,
} from '@overeng/notion-effect-client'

import { editorBaseHash } from './editor-surface.ts'
import { NmdFrontmatterError, NmdRemoteBodyLossyError, type NmdError } from './errors.ts'
import { parseNmdFile } from './frontmatter.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import { NotionMdGateway } from './model.ts'
import type { PullPageResult } from './model.ts'
import { trackPage, type TrackResult } from './reconcile.ts'
import { NmdStateStore } from './state-store.ts'

/** Raised when the body-only facade refuses a stale verified operation. */
export class NotionMdBodyConflictError extends Schema.TaggedErrorClass<NotionMdBodyConflictError>()(
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

/** Remote body-only observation with hashes and optional fidelity evidence. */
export interface NotionMdBodySnapshot {
  readonly pageId: string
  readonly markdown: string
  readonly bodyHash: Sha256Digest
  readonly bodyDescriptor: ContentDescriptor
  readonly bodyEvidence?: RemoteBodyObservationEvidence
  readonly bodyEvidenceFingerprint?: BodyEvidenceFingerprint
  readonly completeness?: BodyCompleteness
}

/** Parsed local `.nmd` body observation, including the editable property frontmatter. */
export interface NotionMdLocalBodySnapshot extends NotionMdBodySnapshot {
  readonly path: string
  readonly fileContentHash: Sha256Digest
  readonly properties: Readonly<Record<string, NmdWritablePropertyValue>>
}

/** Result of materializing a remote body through the shared NotionMD track path. */
export interface NotionMdMaterializedBody extends NotionMdLocalBodySnapshot {
  readonly track: TrackResult
}

/** Remote body replacement result after the write has been re-observed. */
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

/** Local body settlement result after a verified remote body push. */
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
      message: describeBodyLossyRefusal({
        pageId: opts.snapshot.pageId,
        completeness,
        context: 'refusing verified body operation',
      }),
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

/**
 * Editor-surface projection of a Notion page: title + body together, with the
 * default-mode editor base hash over title+body (decisions 0001/0006). Unlike
 * `observeRemoteBody` (body-only), this carries the title and its property key
 * so `cat`/`put` can present and route the title through the typed page API.
 * Refuses a lossy page (exit 3) at observe time, exactly like the file path.
 */
export interface NotionMdEditorSnapshot {
  readonly pageId: string
  readonly title: string
  readonly titlePropertyKey: string
  readonly body: string
  readonly baseHash: Sha256Digest
  readonly completeness?: BodyCompleteness
}

/** Observe the current remote title + body for a Notion page, refusing lossy pages. */
export const observeRemoteEditorPage = (opts: {
  readonly pageId: string
}): Effect.Effect<NotionMdEditorSnapshot, NmdError, NotionMdGateway> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const pulled = yield* gateway.pullPage({ pageId: opts.pageId })
    const snapshot = remoteBodySnapshot(pulled)
    yield* assertSnapshotComplete({ operation: 'observe_editor_page', snapshot })
    const title = pulled.page.title
    const body = snapshot.markdown
    return {
      pageId: pulled.page.id,
      title,
      titlePropertyKey: pulled.page.title_property_key,
      body,
      baseHash: editorBaseHash({ title, body }),
      ...(snapshot.completeness === undefined ? {} : { completeness: snapshot.completeness }),
    }
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
      properties: parsed.frontmatter.notion_md.properties,
    }
  })

/** Track a remote page as shared local state and return body hashes. */
export const materializeBody = (opts: {
  readonly pageId: string
  readonly outPath: string
  /**
   * Writable frontmatter properties to embed in the materialized `.nmd`
   * (visible-name → value). Absent keeps the empty-`properties` behavior, so a
   * standalone notion-md materialization is byte-unchanged. A datasource caller
   * supplies its observed writable cells so the pulled `.nmd` carries them, which
   * is what makes local-surface convergence active in production.
   */
  readonly properties?: Readonly<Record<string, NmdWritablePropertyValue>>
}): Effect.Effect<
  NotionMdMaterializedBody,
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const track = yield* trackPage({
      pageId: opts.pageId,
      outPath: opts.outPath,
      source: 'shared',
      ...(opts.properties === undefined ? {} : { properties: opts.properties }),
    })
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

/**
 * Replace the remote Markdown body **unconditionally** (last-writer-wins),
 * skipping the pre-write base-hash compare — the concurrency-only `--force`
 * escape (decision 0009). It still asserts body completeness before and after
 * the write (the lossy refusal is correctness, not concurrency, and `--force`
 * never bypasses it) and returns the re-pulled body so the caller's post-push
 * `semanticEquivalent` gate (exit 9) can run.
 */
export const replaceRemoteBodyForced = (opts: {
  readonly pageId: string
  readonly markdown: string
}): Effect.Effect<NotionMdVerifiedRemoteReplaceResult, NmdError, NotionMdGateway> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const current = remoteBodySnapshot(yield* gateway.pullPage({ pageId: opts.pageId }))
    yield* assertSnapshotComplete({ operation: 'replace_remote_body_forced', snapshot: current })

    yield* gateway.updateMarkdown({
      pageId: opts.pageId,
      command: { _tag: 'replace_content', markdown: opts.markdown },
      allowDeletingContent: false,
    })
    const updated = remoteBodySnapshot(yield* gateway.pullPage({ pageId: opts.pageId }))
    yield* assertSnapshotComplete({ operation: 'replace_remote_body_forced', snapshot: updated })
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

    const materialized = yield* materializeBody({
      pageId: opts.pageId,
      outPath: opts.path,
      properties: local.properties,
    })
    return {
      pageId: opts.pageId,
      path: opts.path,
      localBodyHash: materialized.bodyHash,
      localFileContentHash: materialized.fileContentHash,
      remoteBodyHash: materialized.bodyHash,
      remoteMarkdown: materialized.markdown,
    }
  })
