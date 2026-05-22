import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { Effect } from 'effect'

import type {
  NmdFrontmatterV1,
  NmdParentRef,
  NmdPropertyValue,
  NmdStorage,
} from '@overeng/notion-effect-client'

import { NmdConflictError } from './errors.ts'
import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { canonicalizeMarkdown, sha256Digest } from './hash.ts'
import {
  NotionMdGateway,
  type PullPageResult,
  type RemoteMarkdownSnapshot,
  type RemotePageSnapshot,
} from './model.ts'
import { validateReferencedSidecar } from './sidecar.ts'
import { decideStorage } from './storage-policy.ts'

export interface PullOptions {
  readonly pageId: string
  readonly outPath: string
}

export interface PullResult {
  readonly path: string
  readonly pageId: string
  readonly storage: 'self_contained' | 'sidecar'
  readonly sidecarPath?: string
}

export interface StatusOptions {
  readonly path: string
}

export interface StatusResult {
  readonly path: string
  readonly pageId: string
  readonly localChanged: boolean
  readonly remoteChanged: boolean
  readonly bodyHash: string
  readonly localBodyHash: string
  readonly remoteBodyHash: string
  readonly unresolvedUnknownBlocks: readonly string[]
}

export interface PushOptions {
  readonly path: string
  readonly force?: boolean
}

export interface PushResult {
  readonly path: string
  readonly pageId: string
  readonly pushed: boolean
  readonly status: StatusResult
}

const toParentRef = (page: RemotePageSnapshot): NmdParentRef => {
  switch (page.parent.type) {
    case 'page_id':
      return { _tag: 'page', id: page.parent.page_id }
    case 'data_source_id':
      return { _tag: 'data_source', id: page.parent.data_source_id }
    case 'database_id':
      return { _tag: 'database', id: page.parent.database_id }
    case 'block_id':
      return { _tag: 'block', id: page.parent.block_id }
    case 'workspace':
      return { _tag: 'workspace' }
    default:
      return { _tag: 'unknown', raw: page.parent }
  }
}

const readOnlyProperties = (
  properties: Record<string, unknown>,
): Record<string, NmdPropertyValue> =>
  Object.fromEntries(
    Object.entries(properties).map(([name, value]) => [
      name,
      { _tag: 'read_only', property_type: inferPropertyType(value), value },
    ]),
  )

const inferPropertyType = (value: unknown): string => {
  if (typeof value === 'object' && value !== null && 'type' in value) {
    const typeValue = (value as { readonly type?: unknown }).type
    if (typeof typeValue === 'string') return typeValue
  }

  return 'unknown'
}

const buildFrontmatter = (opts: {
  readonly page: RemotePageSnapshot
  readonly markdown: RemoteMarkdownSnapshot
  readonly storage: NmdStorage
}): NmdFrontmatterV1 => {
  const body = canonicalizeMarkdown(opts.markdown.markdown)

  return {
    notion_md: {
      version: 1,
      api_version: '2026-03-11',
      object: 'page',
      page_id: opts.page.id,
      url: opts.page.url,
      parent: toParentRef(opts.page),
      body: {
        format: 'notion-enhanced-markdown',
        hash: sha256Digest(body),
        last_pulled_at: new Date().toISOString(),
        remote_last_edited_time: opts.page.last_edited_time,
        truncated: opts.markdown.truncated,
        unknown_block_ids: [...opts.markdown.unknown_block_ids],
      },
      page: {
        title: opts.page.title,
        icon: opts.page.icon,
        cover: opts.page.cover,
        in_trash: opts.page.in_trash,
        is_locked: opts.page.is_locked,
      },
      data_source: null,
      properties: readOnlyProperties(opts.page.properties),
      storage: opts.storage,
    },
  }
}

const writeNmdWithStoragePolicy = (opts: {
  readonly path: string
  readonly frontmatter: NmdFrontmatterV1
  readonly body: string
}): Effect.Effect<PullResult, unknown> =>
  Effect.tryPromise(async () => {
    const decision = decideStorage(opts.frontmatter)
    let frontmatter = opts.frontmatter
    let sidecarPath: string | undefined

    if (decision._tag === 'requires_sidecar') {
      sidecarPath = `${basename(opts.path)}.notion.json`
      const sidecarFullPath = join(dirname(opts.path), sidecarPath)
      const storage = opts.frontmatter.notion_md.storage
      await writeFile(
        sidecarFullPath,
        `${JSON.stringify(
          {
            version: 1,
            page_id: opts.frontmatter.notion_md.page_id,
            reason: decision.reason,
            storage,
          },
          null,
          2,
        )}\n`,
      )

      frontmatter = {
        notion_md: {
          ...opts.frontmatter.notion_md,
          storage: {
            _tag: 'sidecar',
            path: sidecarPath,
            unsupported_block_ids:
              storage._tag === 'self_contained'
                ? storage.unsupported_blocks.map((block) => block.block_id)
                : [],
            file_ids: storage._tag === 'self_contained' ? storage.files.map((file) => file.id) : [],
            comment_ids:
              storage._tag === 'self_contained'
                ? storage.comments.map((comment) => comment.id)
                : [],
          },
        },
      }
    }

    await writeFile(opts.path, renderNmdFile(frontmatter, opts.body))
    const storage: PullResult['storage'] =
      frontmatter.notion_md.storage._tag === 'sidecar' ? 'sidecar' : 'self_contained'

    return sidecarPath === undefined
      ? {
          path: opts.path,
          pageId: opts.frontmatter.notion_md.page_id,
          storage,
        }
      : {
          path: opts.path,
          pageId: opts.frontmatter.notion_md.page_id,
          storage,
          sidecarPath,
        }
  })

export const pullPage = (opts: PullOptions): Effect.Effect<PullResult, unknown, NotionMdGateway> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const pulled = yield* gateway.pullPage({ pageId: opts.pageId })
    const frontmatter = buildFrontmatter({
      page: pulled.page,
      markdown: pulled.markdown,
      storage: pulled.storage ?? {
        _tag: 'self_contained',
        unsupported_blocks: [],
        files: [],
        comments: [],
      },
    })

    return yield* writeNmdWithStoragePolicy({
      path: opts.outPath,
      frontmatter,
      body: pulled.markdown.markdown,
    })
  }).pipe(Effect.withSpan('notion-md.pullPage'))

const readNmd = (path: string) =>
  Effect.tryPromise(() => readFile(path, 'utf8')).pipe(
    Effect.flatMap((content) => parseNmdFile({ path, content })),
    Effect.tap((local) => validateReferencedSidecar({ path, frontmatter: local.frontmatter })),
  )

export const statusPage = (
  opts: StatusOptions,
): Effect.Effect<StatusResult, unknown, NotionMdGateway> =>
  Effect.gen(function* () {
    const local = yield* readNmd(opts.path)
    const gateway = yield* NotionMdGateway
    const remote = yield* gateway.pullPage({ pageId: local.frontmatter.notion_md.page_id })
    const localBodyHash = sha256Digest(local.body)
    const remoteBody = canonicalizeMarkdown(remote.markdown.markdown)
    const remoteBodyHash = sha256Digest(remoteBody)
    const bodyHash = local.frontmatter.notion_md.body.hash
    const localChanged = localBodyHash !== bodyHash
    const remoteChanged =
      remoteBodyHash !== bodyHash ||
      remote.page.last_edited_time !== local.frontmatter.notion_md.body.remote_last_edited_time

    return {
      path: opts.path,
      pageId: local.frontmatter.notion_md.page_id,
      localChanged,
      remoteChanged,
      bodyHash,
      localBodyHash,
      remoteBodyHash,
      unresolvedUnknownBlocks: local.frontmatter.notion_md.body.unknown_block_ids,
    }
  }).pipe(Effect.withSpan('notion-md.statusPage'))

export const pushPage = (opts: PushOptions): Effect.Effect<PushResult, unknown, NotionMdGateway> =>
  Effect.gen(function* () {
    const local = yield* readNmd(opts.path)
    const status = yield* statusPage({ path: opts.path })

    if (status.localChanged === false) {
      return { path: opts.path, pageId: status.pageId, pushed: false, status }
    }

    if (status.remoteChanged === true && opts.force !== true) {
      return yield* new NmdConflictError({
        path: opts.path,
        page_id: status.pageId,
        local_changed: status.localChanged,
        remote_changed: status.remoteChanged,
        message: 'Remote page changed since the last clean pull; refusing guarded push',
      })
    }

    const gateway = yield* NotionMdGateway
    const updated = yield* gateway.updateMarkdown({
      pageId: status.pageId,
      markdown: local.body,
      allowDeletingContent: false,
    })
    const pulled = yield* gateway.pullPage({ pageId: status.pageId })
    const frontmatter = buildFrontmatter({
      page: pulled.page,
      markdown: updated.markdown,
      storage: pulled.storage ?? local.frontmatter.notion_md.storage,
    })

    yield* writeNmdWithStoragePolicy({
      path: opts.path,
      frontmatter,
      body: local.body,
    })

    return {
      path: opts.path,
      pageId: status.pageId,
      pushed: true,
      status,
    }
  }).pipe(Effect.withSpan('notion-md.pushPage'))

export const buildFrontmatterFromPull = (pulled: PullPageResult): NmdFrontmatterV1 =>
  buildFrontmatter({
    page: pulled.page,
    markdown: pulled.markdown,
    storage: pulled.storage ?? {
      _tag: 'self_contained',
      unsupported_blocks: [],
      files: [],
      comments: [],
    },
  })
