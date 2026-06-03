import { Effect, Schema } from 'effect'

import type { Sha256Digest } from '@overeng/notion-effect-client'

import type { NmdError } from './errors.ts'
import { parseNmdFile } from './frontmatter.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import { NotionMdGateway } from './model.ts'
import type { PullPageResult } from './model.ts'
import { NmdStateStore } from './state-store.ts'
import { pullPage, type PullResult } from './sync.ts'

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
}

export interface NotionMdLocalBodySnapshot extends NotionMdBodySnapshot {
  readonly path: string
  readonly fileContentHash: Sha256Digest
}

export interface NotionMdMaterializedBody extends NotionMdLocalBodySnapshot {
  readonly pull: PullResult
}

export interface NotionMdVerifiedRemoteReplaceResult {
  readonly pageId: string
  readonly previousBodyHash: Sha256Digest
  readonly bodyHash: Sha256Digest
  readonly markdown: string
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
  }
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
    return {
      path: opts.path,
      pageId: parsed.frontmatter.notion_md.page_id,
      markdown: parsed.body,
      bodyHash: sha256Digest(parsed.body),
      fileContentHash: sha256Digest(content),
    }
  })

/** Pull a remote page through the existing materialization path and return body hashes. */
export const materializeBody = (opts: {
  readonly pageId: string
  readonly outPath: string
}): Effect.Effect<NotionMdMaterializedBody, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const pull = yield* pullPage(opts)
    const local = yield* readLocalBody({ path: opts.outPath })
    return { ...local, pull }
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
    if (current.bodyHash !== opts.baseBodyHash) {
      return yield* new NotionMdBodyConflictError({
        operation: 'replace_remote_body_verified',
        page_id: opts.pageId,
        expected_body_hash: opts.baseBodyHash,
        actual_body_hash: current.bodyHash,
        message: `Remote body for page ${opts.pageId} changed before verified replace`,
      })
    }

    const updated = yield* gateway.updateMarkdown({
      pageId: opts.pageId,
      command: { _tag: 'replace_content', markdown: opts.markdown },
      allowDeletingContent: false,
    })
    const markdown = normalizeMarkdownLineEndings(updated.markdown.markdown)
    return {
      pageId: opts.pageId,
      previousBodyHash: current.bodyHash,
      bodyHash: sha256Digest(markdown),
      markdown,
    }
  })

/** Re-check local body stability, then observe the settled remote body after a verified push. */
export const settleVerifiedBodyPush = (opts: {
  readonly pageId: string
  readonly path: string
  readonly expectedLocalBodyHash: Sha256Digest
}): Effect.Effect<
  NotionMdSettledBodyPush,
  NmdError | NotionMdBodyConflictError,
  NotionMdGateway | NmdStateStore
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

    const remote = yield* observeRemoteBody({ pageId: opts.pageId })
    return {
      pageId: opts.pageId,
      path: opts.path,
      localBodyHash: local.bodyHash,
      localFileContentHash: local.fileContentHash,
      remoteBodyHash: remote.bodyHash,
      remoteMarkdown: remote.markdown,
    }
  })
