import { basename } from 'node:path'

import { Effect } from 'effect'

import type {
  NmdFrontmatterV1,
  NmdObjectRef,
  NmdParentRef,
  NmdPropertyValue,
  NmdStorage,
} from '@overeng/notion-effect-client'

import { NmdConflictError, type NmdError, type NmdFileSystemError } from './errors.ts'
import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { canonicalizeMarkdown, sha256Digest } from './hash.ts'
import {
  NotionMdGateway,
  type MarkdownUpdateCommand,
  type PullPageResult,
  type RemoteMarkdownSnapshot,
  type RemotePageSnapshot,
} from './model.ts'
import {
  NmdStateStore,
  objectRelativePath,
  readBaseSnapshot,
  validateReferencedObjects,
  writeBaseSnapshot,
  writeStorageObject,
} from './state-store.ts'
import { decideStorage } from './storage-policy.ts'

/** Inputs for pulling a Notion page into a local `.nmd` file. */
export interface PullOptions {
  readonly pageId: string
  readonly outPath: string
}

/** Result of writing a pulled Notion page locally. */
export interface PullResult {
  readonly path: string
  readonly pageId: string
  readonly storage: 'self_contained' | 'object_store'
  readonly storageObjectPath?: string
}

/** Inputs for checking local and remote page state. */
export interface StatusOptions {
  readonly path: string
}

/** Local-vs-remote state summary for a `.nmd` file. */
export interface StatusResult {
  readonly path: string
  readonly pageId: string
  readonly localChanged: boolean
  readonly localPropertiesChanged: boolean
  readonly remoteChanged: boolean
  readonly remoteBodyChanged: boolean
  readonly remotePageMetadataChanged: boolean
  readonly bodyHash: string
  readonly localBodyHash: string
  readonly remoteBodyHash: string
  readonly unresolvedUnknownBlocks: readonly string[]
}

/** Inputs for pushing local `.nmd` edits through the guarded sync path. */
export interface PushOptions {
  readonly path: string
  readonly force?: boolean
  readonly allowDeletingUnknownBlocks?: boolean
  readonly allowReviewMarkup?: boolean
}

/** Result of a guarded push attempt. */
export interface PushResult {
  readonly path: string
  readonly pageId: string
  readonly pushed: boolean
  readonly status: StatusResult
}

/** Inputs for one-shot or watched two-way reconciliation. */
export interface SyncOptions extends PushOptions {}

/** Tagged result of one reconciliation pass. */
export type SyncResult =
  | {
      readonly _tag: 'noop'
      readonly path: string
      readonly pageId: string
      readonly status: StatusResult
    }
  | {
      readonly _tag: 'pulled'
      readonly path: string
      readonly pageId: string
      readonly status: StatusResult
      readonly pull: PullResult
    }
  | {
      readonly _tag: 'pushed'
      readonly path: string
      readonly pageId: string
      readonly status: StatusResult
      readonly push: PushResult
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

const hasWritablePropertyValues = (properties: Record<string, NmdPropertyValue>): boolean =>
  Object.values(properties).some((property) => property._tag !== 'read_only')

const richText = (value: string): readonly unknown[] => [{ type: 'text', text: { content: value } }]

const encodePropertyValue = (property: NmdPropertyValue): unknown | undefined => {
  switch (property._tag) {
    case 'read_only':
      return undefined
    case 'title':
      return { title: richText(property.value) }
    case 'rich_text':
      return { rich_text: property.value === null ? [] : richText(property.value) }
    case 'number':
      return { number: property.value }
    case 'select':
      return { select: property.value === null ? null : { name: property.value } }
    case 'multi_select':
      return { multi_select: property.value.map((name) => ({ name })) }
    case 'status':
      return { status: property.value === null ? null : { name: property.value } }
    case 'date':
      return { date: property.value }
    case 'people':
      return { people: property.value.map((id) => ({ id })) }
    case 'checkbox':
      return { checkbox: property.value }
    case 'url':
      return { url: property.value }
    case 'email':
      return { email: property.value }
    case 'phone_number':
      return { phone_number: property.value }
    case 'relation':
      return { relation: property.value.map((id) => ({ id })) }
    case 'files':
      return {
        files: property.value
          .map((file) => {
            switch (file._tag) {
              case 'external_url':
                return { type: 'external', name: file.url, external: { url: file.url } }
              case 'notion_file':
                return file.file_upload_id === undefined
                  ? undefined
                  : {
                      type: 'file_upload',
                      name: file.filename,
                      file_upload: { id: file.file_upload_id },
                    }
              case 'local_file':
                return undefined
            }
          })
          .filter((file) => file !== undefined),
      }
  }
}

const encodeWritableProperties = (
  properties: Record<string, NmdPropertyValue>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(properties).flatMap(([name, property]) => {
      const encoded = encodePropertyValue(property)
      return encoded === undefined ? [] : [[name, encoded]]
    }),
  )

const storageUnknownBlockIds = (storage: NmdStorage): readonly string[] => {
  switch (storage._tag) {
    case 'self_contained':
      return storage.unsupported_blocks.map((block) => block.block_id)
    case 'object_store':
      return storage.unsupported_block_ids
  }
}

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)]

const unresolvedUnknownBlockIds = (opts: {
  readonly frontmatter: NmdFrontmatterV1
  readonly remoteMarkdown?: RemoteMarkdownSnapshot
}): readonly string[] =>
  unique([
    ...opts.frontmatter.notion_md.body.unknown_block_ids,
    ...storageUnknownBlockIds(opts.frontmatter.notion_md.storage),
    ...(opts.remoteMarkdown?.unknown_block_ids ?? []),
  ])

const containsRoughdraftReviewMarkup = (body: string): boolean =>
  /\{(?:==|\+\+|--|~~|>>)/u.test(body)

const tryMergeBodies = (opts: {
  readonly baseBody: string
  readonly localBody: string
  readonly remoteBody: string
}): string | undefined => {
  const base = canonicalizeMarkdown(opts.baseBody)
  const local = canonicalizeMarkdown(opts.localBody)
  const remote = canonicalizeMarkdown(opts.remoteBody)

  if (local === remote) return local
  if (local === base) return remote
  if (remote === base) return local

  const baseLines = base.split('\n')
  const localLines = local.split('\n')
  const remoteLines = remote.split('\n')

  const localRange = changedRange({ baseLines, changedLines: localLines })
  const remoteRange = changedRange({ baseLines, changedLines: remoteLines })

  if (sameRange({ left: localRange, right: remoteRange }) === true) {
    return sameLines({ left: localRange.replacement, right: remoteRange.replacement }) === true
      ? local
      : undefined
  }

  if (localRange.end <= remoteRange.start) {
    return applyRanges({ baseLines, rangesDescending: [remoteRange, localRange] })
  }

  if (remoteRange.end <= localRange.start) {
    return applyRanges({ baseLines, rangesDescending: [localRange, remoteRange] })
  }

  return undefined
}

interface ChangedRange {
  readonly start: number
  readonly end: number
  readonly replacement: readonly string[]
}

const changedRange = (opts: {
  readonly baseLines: readonly string[]
  readonly changedLines: readonly string[]
}): ChangedRange => {
  const { baseLines, changedLines } = opts
  let prefix = 0
  while (
    prefix < baseLines.length &&
    prefix < changedLines.length &&
    baseLines[prefix] === changedLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < baseLines.length - prefix &&
    suffix < changedLines.length - prefix &&
    baseLines[baseLines.length - 1 - suffix] === changedLines[changedLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  return {
    start: prefix,
    end: baseLines.length - suffix,
    replacement: changedLines.slice(prefix, changedLines.length - suffix),
  }
}

const sameRange = (opts: { readonly left: ChangedRange; readonly right: ChangedRange }): boolean =>
  opts.left.start === opts.right.start && opts.left.end === opts.right.end

const sameLines = (opts: {
  readonly left: readonly string[]
  readonly right: readonly string[]
}): boolean =>
  opts.left.length === opts.right.length &&
  opts.left.every((line, index) => line === opts.right[index])

const applyRanges = (opts: {
  readonly baseLines: readonly string[]
  readonly rangesDescending: readonly ChangedRange[]
}): string => {
  const merged = [...opts.baseLines]
  for (const range of opts.rangesDescending) {
    merged.splice(range.start, range.end - range.start, ...range.replacement)
  }
  return merged.join('\n')
}

const countOccurrences = (opts: { readonly haystack: string; readonly needle: string }): number => {
  if (opts.needle.length === 0) return 0

  let count = 0
  let offset = 0
  while (true) {
    const index = opts.haystack.indexOf(opts.needle, offset)
    if (index === -1) return count
    count += 1
    offset = index + opts.needle.length
  }
}

const planMarkdownUpdate = (opts: {
  readonly baseBody: string
  readonly remoteBody: string
  readonly desiredBody: string
}): MarkdownUpdateCommand => {
  const base = canonicalizeMarkdown(opts.baseBody)
  const remote = canonicalizeMarkdown(opts.remoteBody)
  const desired = canonicalizeMarkdown(opts.desiredBody)

  let prefix = 0
  while (
    prefix < base.length &&
    prefix < desired.length &&
    base.charCodeAt(prefix) === desired.charCodeAt(prefix)
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < base.length - prefix &&
    suffix < desired.length - prefix &&
    base.charCodeAt(base.length - 1 - suffix) === desired.charCodeAt(desired.length - 1 - suffix)
  ) {
    suffix += 1
  }

  const oldStr = base.slice(prefix, base.length - suffix)
  const newStr = desired.slice(prefix, desired.length - suffix)
  const isSafeTargetedUpdate =
    oldStr.length > 0 &&
    countOccurrences({ haystack: remote, needle: oldStr }) === 1 &&
    remote.replace(oldStr, newStr) === desired

  return isSafeTargetedUpdate === true
    ? {
        _tag: 'update_content',
        contentUpdates: [{ oldStr, newStr }],
        expectedMarkdown: desired,
      }
    : {
        _tag: 'replace_content',
        markdown: desired,
      }
}

const roughdraftConflictPath = (path: string): string => `${path}.conflict.roughdraft.md`

const writeRoughdraftConflict = (opts: {
  readonly path: string
  readonly pageId: string
  readonly baseBody: string
  readonly localBody: string
  readonly remoteBody: string
}): Effect.Effect<string, NmdConflictError, NmdStateStore> => {
  const conflictPath = roughdraftConflictPath(opts.path)
  return Effect.gen(function* () {
    const store = yield* NmdStateStore
    const now = new Date().toISOString()
    yield* store
      .writeConflictFile({
        path: conflictPath,
        content: `# notion-md body conflict

{==Body conflict==}{>>Remote and local body content both changed since the last clean pull. Resolve the chosen content back into the .nmd file, then rerun status/push.<<}{id="body-conflict" by="notion-md" at="${now}"}

Page: ${opts.pageId}

## Base body

\`\`\`markdown
${opts.baseBody}
\`\`\`

## Local body

\`\`\`markdown
${opts.localBody}
\`\`\`

## Remote body

\`\`\`markdown
${opts.remoteBody}
\`\`\`
`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new NmdConflictError({
              path: opts.path,
              page_id: opts.pageId,
              local_changed: true,
              remote_changed: true,
              conflict_path: conflictPath,
              cause,
              message: `Failed to write Roughdraft conflict file ${conflictPath}`,
            }),
        ),
      )
    return conflictPath
  })
}

const buildFrontmatter = (opts: {
  readonly page: RemotePageSnapshot
  readonly markdown: RemoteMarkdownSnapshot
  readonly storage: NmdStorage
  readonly base: NmdObjectRef
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
        base: opts.base,
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
  readonly page: RemotePageSnapshot
  readonly markdown: RemoteMarkdownSnapshot
  readonly storage: NmdStorage
  readonly body: string
}): Effect.Effect<PullResult, NmdFileSystemError, NmdStateStore> =>
  Effect.gen(function* () {
    const base = yield* writeBaseSnapshot({
      path: opts.path,
      pageId: opts.page.id,
      body: opts.body,
    })
    let frontmatter = buildFrontmatter({
      page: opts.page,
      markdown: opts.markdown,
      storage: opts.storage,
      base,
    })
    const decision = decideStorage(frontmatter)
    let storageObjectPath: string | undefined

    if (decision._tag === 'requires_object_store') {
      const storage = frontmatter.notion_md.storage
      const object = yield* writeStorageObject({
        path: opts.path,
        pageId: opts.page.id,
        reason: decision.reason,
        storage,
      })
      storageObjectPath = object.path

      frontmatter = {
        notion_md: {
          ...frontmatter.notion_md,
          storage: {
            _tag: 'object_store',
            object,
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

    const store = yield* NmdStateStore
    yield* store.writeNmdFile({
      path: opts.path,
      content: renderNmdFile({ frontmatter, body: opts.body }),
    })
    const storage: PullResult['storage'] =
      frontmatter.notion_md.storage._tag === 'object_store' ? 'object_store' : 'self_contained'

    return storageObjectPath === undefined
      ? {
          path: opts.path,
          pageId: opts.page.id,
          storage,
        }
      : {
          path: opts.path,
          pageId: opts.page.id,
          storage,
          storageObjectPath,
        }
  })

/** Pull a Notion page through the Markdown endpoint and write a local `.nmd` file. */
export const pullPage = (
  opts: PullOptions,
): Effect.Effect<PullResult, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const pulled = yield* gateway.pullPage({ pageId: opts.pageId })
    const storage = pulled.storage ?? {
      _tag: 'self_contained',
      unsupported_blocks: [],
      files: [],
      comments: [],
    }

    return yield* writeNmdWithStoragePolicy({
      path: opts.outPath,
      page: pulled.page,
      markdown: pulled.markdown,
      storage,
      body: pulled.markdown.markdown,
    })
  }).pipe(
    Effect.withSpan('notion-md.pull-page', {
      attributes: {
        'span.label': opts.pageId.slice(0, 8),
        'notion_md.page_id': opts.pageId,
        'notion_md.path.basename': basename(opts.outPath),
      },
    }),
  )

const readNmd = (path: string) =>
  NmdStateStore.pipe(
    Effect.flatMap((store) => store.readNmdFile({ path })),
    Effect.flatMap((content) => parseNmdFile({ path, content })),
    Effect.tap((local) => validateReferencedObjects({ path, frontmatter: local.frontmatter })),
  )

/** Compare local body/frontmatter state with the current remote Notion page. */
export const statusPage = (
  opts: StatusOptions,
): Effect.Effect<StatusResult, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const local = yield* readNmd(opts.path)
    const gateway = yield* NotionMdGateway
    const remote = yield* gateway.pullPage({ pageId: local.frontmatter.notion_md.page_id })
    const localBodyHash = sha256Digest(local.body)
    const remoteBody = canonicalizeMarkdown(remote.markdown.markdown)
    const remoteBodyHash = sha256Digest(remoteBody)
    const bodyHash = local.frontmatter.notion_md.body.hash
    const localChanged = localBodyHash !== bodyHash
    const localPropertiesChanged = hasWritablePropertyValues(local.frontmatter.notion_md.properties)
    const remoteBodyChanged = remoteBodyHash !== bodyHash
    const remotePageMetadataChanged =
      remote.page.last_edited_time !== local.frontmatter.notion_md.body.remote_last_edited_time
    const remoteChanged = remoteBodyChanged || remotePageMetadataChanged
    const unknownBlockIds = unresolvedUnknownBlockIds({
      frontmatter: local.frontmatter,
      remoteMarkdown: remote.markdown,
    })

    return {
      path: opts.path,
      pageId: local.frontmatter.notion_md.page_id,
      localChanged,
      localPropertiesChanged,
      remoteChanged,
      remoteBodyChanged,
      remotePageMetadataChanged,
      bodyHash,
      localBodyHash,
      remoteBodyHash,
      unresolvedUnknownBlocks: unknownBlockIds,
    }
  }).pipe(
    Effect.tap((status) =>
      Effect.annotateCurrentSpan({
        'notion_md.page_id': status.pageId,
        'notion_md.status.local_changed': status.localChanged,
        'notion_md.status.local_properties_changed': status.localPropertiesChanged,
        'notion_md.status.remote_changed': status.remoteChanged,
        'notion_md.status.remote_body_changed': status.remoteBodyChanged,
        'notion_md.status.remote_page_metadata_changed': status.remotePageMetadataChanged,
        'notion_md.status.unknown_block_count': status.unresolvedUnknownBlocks.length,
      }),
    ),
    Effect.withSpan('notion-md.status-page', {
      attributes: {
        'span.label': basename(opts.path),
        'notion_md.path.basename': basename(opts.path),
      },
    }),
  )

/** Push local `.nmd` edits to Notion after conflict, unknown-block, and review-markup checks. */
export const pushPage = (
  opts: PushOptions,
): Effect.Effect<PushResult, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const local = yield* readNmd(opts.path)
    const status = yield* statusPage({ path: opts.path })

    if (status.localChanged === false && status.localPropertiesChanged === false) {
      return { path: opts.path, pageId: status.pageId, pushed: false, status }
    }

    if (containsRoughdraftReviewMarkup(local.body) === true && opts.allowReviewMarkup !== true) {
      return yield* new NmdConflictError({
        path: opts.path,
        page_id: status.pageId,
        local_changed: status.localChanged,
        remote_changed: status.remoteChanged,
        message:
          'Local body contains unresolved Roughdraft review markup; refusing push so review state is not sent as Notion content',
      })
    }

    if (status.unresolvedUnknownBlocks.length > 0 && opts.allowDeletingUnknownBlocks !== true) {
      return yield* new NmdConflictError({
        path: opts.path,
        page_id: status.pageId,
        local_changed: status.localChanged,
        remote_changed: status.remoteChanged,
        message:
          'Page contains unresolved unknown Notion blocks; refusing push because replace_content can delete them. Pass allowDeletingUnknownBlocks only for explicit destructive intent.',
      })
    }

    if (status.remoteBodyChanged === true && opts.force !== true) {
      const gateway = yield* NotionMdGateway
      const remote = yield* gateway.pullPage({ pageId: status.pageId })
      const baseSnapshot = yield* readBaseSnapshot({
        path: opts.path,
        frontmatter: local.frontmatter,
      })
      const mergedBody =
        status.localChanged === true
          ? tryMergeBodies({
              baseBody: baseSnapshot.body,
              localBody: local.body,
              remoteBody: remote.markdown.markdown,
            })
          : undefined

      if (mergedBody !== undefined) {
        const updated = yield* gateway.updateMarkdown({
          pageId: status.pageId,
          command: planMarkdownUpdate({
            baseBody: baseSnapshot.body,
            remoteBody: remote.markdown.markdown,
            desiredBody: mergedBody,
          }),
          allowDeletingContent: opts.allowDeletingUnknownBlocks === true,
        })
        if (status.localPropertiesChanged === true) {
          yield* gateway.updatePageProperties({
            pageId: status.pageId,
            properties: encodeWritableProperties(local.frontmatter.notion_md.properties),
          })
        }
        const pulled = yield* gateway.pullPage({ pageId: status.pageId })
        yield* writeNmdWithStoragePolicy({
          path: opts.path,
          page: pulled.page,
          markdown: updated.markdown,
          storage: pulled.storage ?? local.frontmatter.notion_md.storage,
          body: mergedBody,
        })

        return {
          path: opts.path,
          pageId: status.pageId,
          pushed: true,
          status,
        }
      }

      const conflictPath = yield* writeRoughdraftConflict({
        path: opts.path,
        pageId: status.pageId,
        baseBody: baseSnapshot.body,
        localBody: local.body,
        remoteBody: remote.markdown.markdown,
      })
      return yield* new NmdConflictError({
        path: opts.path,
        page_id: status.pageId,
        local_changed: status.localChanged,
        remote_changed: status.remoteChanged,
        conflict_path: conflictPath,
        message: 'Remote page changed since the last clean pull; refusing guarded push',
      })
    }

    const gateway = yield* NotionMdGateway
    const updated =
      status.localChanged === true
        ? yield* Effect.gen(function* () {
            const baseSnapshot = yield* readBaseSnapshot({
              path: opts.path,
              frontmatter: local.frontmatter,
            })
            const remote = yield* gateway.pullPage({ pageId: status.pageId })
            if (
              opts.force !== true &&
              sha256Digest(remote.markdown.markdown) !== status.remoteBodyHash
            ) {
              return yield* new NmdConflictError({
                path: opts.path,
                page_id: status.pageId,
                local_changed: status.localChanged,
                remote_changed: true,
                message: 'Remote page changed while preparing guarded Markdown push',
              })
            }
            return yield* gateway.updateMarkdown({
              pageId: status.pageId,
              command:
                opts.force === true
                  ? { _tag: 'replace_content', markdown: local.body }
                  : planMarkdownUpdate({
                      baseBody: baseSnapshot.body,
                      remoteBody: remote.markdown.markdown,
                      desiredBody: local.body,
                    }),
              allowDeletingContent: opts.allowDeletingUnknownBlocks === true,
            })
          })
        : undefined
    if (status.localPropertiesChanged === true) {
      yield* gateway.updatePageProperties({
        pageId: status.pageId,
        properties: encodeWritableProperties(local.frontmatter.notion_md.properties),
      })
    }
    const pulled = yield* gateway.pullPage({ pageId: status.pageId })
    yield* writeNmdWithStoragePolicy({
      path: opts.path,
      page: pulled.page,
      markdown: updated?.markdown ?? pulled.markdown,
      storage: pulled.storage ?? local.frontmatter.notion_md.storage,
      body: local.body,
    })

    return {
      path: opts.path,
      pageId: status.pageId,
      pushed: true,
      status,
    }
  }).pipe(
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({
        'notion_md.page_id': result.pageId,
        'notion_md.push.pushed': result.pushed,
      }),
    ),
    Effect.withSpan('notion-md.push-page', {
      attributes: {
        'span.label': basename(opts.path),
        'notion_md.path.basename': basename(opts.path),
        'notion_md.push.force': opts.force === true,
        'notion_md.push.allow_delete_unknown_blocks': opts.allowDeletingUnknownBlocks === true,
      },
    }),
  )

/** Run one two-way reconciliation pass for a `.nmd` file. */
export const syncPage = (
  opts: SyncOptions,
): Effect.Effect<SyncResult, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const status = yield* statusPage({ path: opts.path })

    if (status.localChanged === true || status.localPropertiesChanged === true) {
      const push = yield* pushPage(opts)
      return {
        _tag: 'pushed',
        path: opts.path,
        pageId: status.pageId,
        status,
        push,
      } as const
    }

    if (status.remoteChanged === true) {
      const pull = yield* pullPage({ pageId: status.pageId, outPath: opts.path })
      return {
        _tag: 'pulled',
        path: opts.path,
        pageId: status.pageId,
        status,
        pull,
      } as const
    }

    return {
      _tag: 'noop',
      path: opts.path,
      pageId: status.pageId,
      status,
    } as const
  }).pipe(
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({
        'notion_md.page_id': result.pageId,
        'notion_md.sync.result': result._tag,
      }),
    ),
    Effect.withSpan('notion-md.sync-page', {
      attributes: {
        'span.label': basename(opts.path),
        'notion_md.path.basename': basename(opts.path),
      },
    }),
  )

/** Build strict `.nmd` frontmatter from a remote pull result. */
export const buildFrontmatterFromPull = (pulled: PullPageResult): NmdFrontmatterV1 =>
  buildFrontmatter({
    page: pulled.page,
    markdown: pulled.markdown,
    base: {
      _tag: 'object_ref',
      role: 'base_snapshot',
      hash: sha256Digest(''),
      path: objectRelativePath(sha256Digest('')),
      media_type: 'application/json',
      byte_length: 0,
    },
    storage: pulled.storage ?? {
      _tag: 'self_contained',
      unsupported_blocks: [],
      files: [],
      comments: [],
    },
  })
