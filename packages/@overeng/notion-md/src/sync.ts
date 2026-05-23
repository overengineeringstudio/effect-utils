import { basename } from 'node:path'

import { Effect } from 'effect'

import type {
  NmdFrontmatterV2,
  NmdObjectRef,
  NmdParentRef,
  NmdStorage,
  NmdSyncStateV1,
  NmdWritablePropertyValue,
} from '@overeng/notion-effect-client'

import {
  NmdConflictError,
  NmdFrontmatterError,
  type NmdError,
  type NmdFileSystemError,
} from './errors.ts'
import { parseNmdFile, renderNmdFile, type ParsedNmdFile } from './frontmatter.ts'
import { canonicalizeMarkdown, sha256Digest } from './hash.ts'
import { planMarkdownUpdate, tryMergeMarkdownBodies } from './merge.ts'
import {
  NotionMdGateway,
  type PageMetadataUpdate,
  type PullPageResult,
  type RemoteMarkdownSnapshot,
  type RemotePageSnapshot,
  toCreatePageParent,
  type WritablePageCover,
  type WritablePageIcon,
} from './model.ts'
import {
  NmdStateStore,
  readBaseSnapshot,
  readSyncStateOptional,
  validateReferencedObjects,
  writeBaseSnapshot,
  writeStorageObject,
  writeSyncState,
} from './state-store.ts'
import { decideStorage } from './storage-policy.ts'

/*
 * Combined local view of a `.nmd` file plus its sidecar sync state.
 *
 * After the V1→V2 schema split, derived sync bookkeeping (body hash, base
 * snapshot ref, last-pulled timestamps, unknown-block ids, storage
 * inventory, read-only property echoes, data-source binding) lives in
 * `.notion-md/sync/{page_id}.json`, not in the `.nmd` frontmatter. The
 * sync engine threads both through `LocalState` so engine logic doesn't
 * need to know about the on-disk split.
 *
 * `syncState` is `undefined` for an unmaterialized `.nmd` file
 * (frontmatter has `page_id: null`), which is the entry point for the
 * convention-driven `create` flow.
 */
export interface LocalState {
  readonly path: string
  readonly frontmatter: NmdFrontmatterV2
  readonly body: string
  readonly syncState: NmdSyncStateV1 | undefined
}

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
  readonly localPageMetadataChanged: boolean
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

const readOnlyPropertyEchoes = (
  properties: Record<string, unknown>,
): Record<string, { readonly property_type: string; readonly value: unknown }> =>
  Object.fromEntries(
    Object.entries(properties).map(([name, value]) => [
      name,
      { property_type: inferPropertyType(value), value },
    ]),
  )

const inferPropertyType = (value: unknown): string => {
  if (typeof value === 'object' && value !== null && 'type' in value) {
    const typeValue = (value as { readonly type?: unknown }).type
    if (typeof typeValue === 'string') return typeValue
  }

  return 'unknown'
}

const hasWritablePropertyValues = (
  properties: Record<string, NmdWritablePropertyValue>,
): boolean => Object.keys(properties).length > 0

const stableJson = (value: unknown): string => JSON.stringify(value) ?? 'undefined'

const isWritablePageFile = (
  value: NmdFrontmatterV2['notion_md']['page']['cover'],
): value is WritablePageCover => {
  if (value === null) return true
  return value.type === 'external'
}

const isWritablePageIcon = (
  value: NmdFrontmatterV2['notion_md']['page']['icon'],
): value is WritablePageIcon => {
  if (value === null) return true
  return value.type === 'emoji' || value.type === 'icon' || value.type === 'external'
}

const pageMetadataUpdate = (opts: {
  readonly local: NmdFrontmatterV2['notion_md']['page']
  readonly remote: RemotePageSnapshot
}): PageMetadataUpdate => {
  const update: {
    title?: string
    icon?: WritablePageIcon
    cover?: WritablePageCover
    in_trash?: boolean
    is_locked?: boolean
  } = {}

  if (opts.local.title !== opts.remote.title) {
    update.title = opts.local.title
  }

  if (stableJson(opts.local.icon) !== stableJson(opts.remote.icon)) {
    if (isWritablePageIcon(opts.local.icon) === true) update.icon = opts.local.icon
  }

  if (stableJson(opts.local.cover) !== stableJson(opts.remote.cover)) {
    if (isWritablePageFile(opts.local.cover) === true) update.cover = opts.local.cover
  }

  if (opts.local.in_trash !== opts.remote.in_trash) {
    update.in_trash = opts.local.in_trash
  }

  if (opts.local.is_locked !== opts.remote.is_locked) {
    update.is_locked = opts.local.is_locked
  }

  return update
}

const hasPageMetadataUpdate = (update: PageMetadataUpdate): boolean =>
  Object.keys(update).length > 0

const richText = (value: string): readonly unknown[] => [{ type: 'text', text: { content: value } }]

const encodePropertyValue = (opts: {
  readonly path: string
  readonly name: string
  readonly property: NmdWritablePropertyValue
}): Effect.Effect<unknown | undefined, NmdFrontmatterError> =>
  Effect.gen(function* () {
    const property = opts.property
    switch (property._tag) {
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
      case 'place':
        return { place: property.value }
      case 'verification':
        return { verification: property.value }
      case 'files': {
        const files: unknown[] = []
        for (const file of property.value) {
          switch (file._tag) {
            case 'external_url':
              files.push({ type: 'external', name: file.url, external: { url: file.url } })
              break
            case 'notion_file':
              if (file.file_upload_id === undefined) {
                return yield* new NmdFrontmatterError({
                  path: opts.path,
                  message: `File property ${opts.name} contains a Notion-hosted file without file_upload_id; notion-md refuses to drop it during push`,
                })
              }
              files.push({
                type: 'file_upload',
                name: file.filename,
                file_upload: { id: file.file_upload_id },
              })
              break
            case 'local_file':
              return yield* new NmdFrontmatterError({
                path: opts.path,
                message: `File property ${opts.name} contains local_file ${file.path}; file upload is not implemented by notion-md push yet`,
              })
          }
        }
        return { files }
      }
    }
  })

const encodeWritableProperties = (opts: {
  readonly path: string
  readonly properties: Record<string, NmdWritablePropertyValue>
}): Effect.Effect<Record<string, unknown>, NmdFrontmatterError> =>
  Effect.gen(function* () {
    const entries: Array<readonly [string, unknown]> = []
    for (const [name, property] of Object.entries(opts.properties)) {
      const encoded = yield* encodePropertyValue({ path: opts.path, name, property })
      if (encoded !== undefined) entries.push([name, encoded])
    }
    return Object.fromEntries(entries)
  })

const storageUnknownBlockIds = (storage: NmdStorage): readonly string[] => {
  switch (storage._tag) {
    case 'self_contained':
      return storage.unsupported_blocks.map((block) => block.block_id)
    case 'object_store':
      return storage.unsupported_block_ids
  }
}

const emptyStorage = (): NmdStorage => ({
  _tag: 'self_contained',
  unsupported_blocks: [],
  files: [],
  comments: [],
})

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)]

const unresolvedUnknownBlockIds = (opts: {
  readonly syncState: NmdSyncStateV1 | undefined
  readonly remoteMarkdown?: RemoteMarkdownSnapshot
}): readonly string[] =>
  unique([
    ...(opts.syncState?.body.unknown_block_ids ?? []),
    ...(opts.syncState === undefined ? [] : storageUnknownBlockIds(opts.syncState.storage)),
    ...(opts.remoteMarkdown?.unknown_block_ids ?? []),
  ])

const containsRoughdraftReviewMarkup = (body: string): boolean =>
  /\{(?:==|\+\+|--|~~|>>)/u.test(body)

const roughdraftConflictPath = (path: string): string => `${path}.conflict.roughdraft.md`

const markdownFenceFor = (bodies: readonly string[]): string => {
  let longestFenceLength = 2
  for (const body of bodies) {
    for (const match of body.matchAll(/`{3,}/gu)) {
      longestFenceLength = Math.max(longestFenceLength, match[0].length)
    }
  }
  return '`'.repeat(longestFenceLength + 1)
}

const writeRoughdraftConflict = (opts: {
  readonly path: string
  readonly pageId: string
  readonly baseBody: string
  readonly localBody: string
  readonly remoteBody: string
}): Effect.Effect<string, NmdConflictError, NmdStateStore> => {
  const conflictPath = roughdraftConflictPath(opts.path)
  const fence = markdownFenceFor([opts.baseBody, opts.localBody, opts.remoteBody])
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

${fence}markdown
${opts.baseBody}
${fence}

## Local body

${fence}markdown
${opts.localBody}
${fence}

## Remote body

${fence}markdown
${opts.remoteBody}
${fence}
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

const buildFrontmatterV2 = (opts: {
  readonly page: RemotePageSnapshot
}): NmdFrontmatterV2 => ({
  notion_md: {
    version: 2,
    api_version: '2026-03-11',
    object: 'page',
    page_id: opts.page.id,
    url: opts.page.url,
    parent: toParentRef(opts.page),
    page: {
      title: opts.page.title,
      icon: opts.page.icon,
      cover: opts.page.cover,
      in_trash: opts.page.in_trash,
      is_locked: opts.page.is_locked,
    },
    /*
     * V2 frontmatter only carries the user-editable writable properties.
     * Notion echoes back every page property on retrieve, but most are
     * derived from the data-source schema and the user can't edit them
     * locally — those land in the sidecar `read_only_properties` instead.
     */
    properties: {},
  },
})

const buildSyncState = (opts: {
  readonly page: RemotePageSnapshot
  readonly markdown: RemoteMarkdownSnapshot
  readonly storage: NmdStorage
  readonly base: NmdObjectRef
}): NmdSyncStateV1 => {
  const body = canonicalizeMarkdown(opts.markdown.markdown)
  return {
    version: 1,
    page_id: opts.page.id,
    body: {
      format: 'notion-enhanced-markdown',
      hash: sha256Digest(body),
      base: opts.base,
      last_pulled_at: new Date().toISOString(),
      remote_last_edited_time: opts.page.last_edited_time,
      truncated: opts.markdown.truncated,
      unknown_block_ids: [...opts.markdown.unknown_block_ids],
    },
    storage: opts.storage,
    read_only_properties: readOnlyPropertyEchoes(opts.page.properties),
    data_source: null,
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
    const frontmatter = buildFrontmatterV2({ page: opts.page })
    let syncState = buildSyncState({
      page: opts.page,
      markdown: opts.markdown,
      storage: opts.storage,
      base,
    })
    const decision = decideStorage(syncState)
    let storageObjectPath: string | undefined

    if (decision._tag === 'requires_object_store') {
      const storage = syncState.storage
      const object = yield* writeStorageObject({
        path: opts.path,
        pageId: opts.page.id,
        reason: decision.reason,
        storage,
      })
      storageObjectPath = object.path

      syncState = {
        ...syncState,
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
      }
    }

    const store = yield* NmdStateStore
    yield* store.writeNmdFile({
      path: opts.path,
      content: renderNmdFile({ frontmatter, body: opts.body }),
    })
    yield* writeSyncState({ path: opts.path, syncState })
    const storage: PullResult['storage'] =
      syncState.storage._tag === 'object_store' ? 'object_store' : 'self_contained'

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
    const storage = pulled.storage ?? emptyStorage()

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

const readNmd = (
  path: string,
): Effect.Effect<LocalState, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const content = yield* store.readNmdFile({ path })
    const parsed = yield* parseNmdFile({ path, content })
    const pageId = parsed.frontmatter.notion_md.page_id
    /*
     * Page id is null for an unmaterialized `.nmd` (the convention-driven
     * create entry point); there's no sidecar to load yet. For real pages
     * we expect the sidecar to exist — its absence is fine (caller may be
     * a freshly cloned repo with `.notion-md/` in `.gitignore`), in which
     * case sync logic treats body/storage/props as if just-pulled.
     */
    let syncState: NmdSyncStateV1 | undefined
    if (pageId === null) {
      syncState = undefined
    } else {
      syncState = yield* store.readSyncStateOptional({ path, pageId })
    }
    if (syncState !== undefined) {
      yield* validateReferencedObjects({ path, syncState })
    }
    return {
      path,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      syncState,
    }
  })

const assertLocalBodyUnchanged = (opts: {
  readonly path: string
  readonly pageId: string
  readonly expectedBodyHash: string
  readonly status: StatusResult
}): Effect.Effect<void, NmdError, NmdStateStore> =>
  readNmd(opts.path).pipe(
    Effect.flatMap((current) =>
      sha256Digest(current.body) === opts.expectedBodyHash
        ? Effect.void
        : new NmdConflictError({
            path: opts.path,
            page_id: opts.pageId,
            local_changed: true,
            remote_changed: opts.status.remoteChanged,
            message:
              'Local .nmd body changed while push was in progress; refusing to overwrite it with refreshed Notion state',
          }),
    ),
  )

/*
 * Push paths that touch the body merge logic require the sidecar to be
 * present (no base snapshot ⇒ no three-way merge possible). The status
 * preflight earlier in `pushPage` ensures we never enter these branches
 * for an unmaterialized `.nmd`, so a missing sidecar here is a defect.
 */
const requireSyncState = (opts: {
  readonly path: string
  readonly local: LocalState
}): NmdSyncStateV1 => {
  if (opts.local.syncState === undefined) {
    throw new NmdFrontmatterError({
      path: opts.path,
      message: 'Internal invariant violation: sync state required for guarded push',
    })
  }
  return opts.local.syncState
}

const statusFromSnapshots = (opts: {
  readonly path: string
  readonly local: LocalState
  readonly remote: PullPageResult
}): StatusResult => {
  const localBodyHash = sha256Digest(opts.local.body)
  const remoteBody = canonicalizeMarkdown(opts.remote.markdown.markdown)
  const remoteBodyHash = sha256Digest(remoteBody)
  /*
   * Without a sidecar (fresh checkout, or pre-create), there is no
   * "previously pulled" baseline. Treat the local body bytes as the
   * baseline so we don't fabricate a phantom local edit on first
   * status.
   */
  const bodyHash = opts.local.syncState?.body.hash ?? localBodyHash
  const localChanged = localBodyHash !== bodyHash
  const localPageMetadataChanged = hasPageMetadataUpdate(
    pageMetadataUpdate({
      local: opts.local.frontmatter.notion_md.page,
      remote: opts.remote.page,
    }),
  )
  const localPropertiesChanged = hasWritablePropertyValues(
    opts.local.frontmatter.notion_md.properties,
  )
  const remoteBodyChanged = remoteBodyHash !== bodyHash
  const remotePageMetadataChanged =
    opts.local.syncState !== undefined &&
    opts.remote.page.last_edited_time !== opts.local.syncState.body.remote_last_edited_time
  const remoteChanged = remoteBodyChanged || remotePageMetadataChanged
  const unknownBlockIds = unresolvedUnknownBlockIds({
    syncState: opts.local.syncState,
    remoteMarkdown: opts.remote.markdown,
  })

  return {
    path: opts.path,
    pageId: opts.remote.page.id,
    localChanged,
    localPageMetadataChanged,
    localPropertiesChanged,
    remoteChanged,
    remoteBodyChanged,
    remotePageMetadataChanged,
    bodyHash,
    localBodyHash,
    remoteBodyHash,
    unresolvedUnknownBlocks: unknownBlockIds,
  }
}

/** Compare local body/frontmatter state with the current remote Notion page. */
export const statusPage = (
  opts: StatusOptions,
): Effect.Effect<StatusResult, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const local = yield* readNmd(opts.path)
    /*
     * An unmaterialized `.nmd` (page_id: null) has nothing to compare
     * against on Notion yet. Surface a "fully local" status so `sync` /
     * tooling knows the next action is `push` (which will create).
     */
    if (local.frontmatter.notion_md.page_id === null) {
      const localBodyHash = sha256Digest(local.body)
      return {
        path: opts.path,
        pageId: 'unmaterialized',
        localChanged: true,
        localPageMetadataChanged: false,
        localPropertiesChanged: hasWritablePropertyValues(local.frontmatter.notion_md.properties),
        remoteChanged: false,
        remoteBodyChanged: false,
        remotePageMetadataChanged: false,
        bodyHash: localBodyHash,
        localBodyHash,
        remoteBodyHash: localBodyHash,
        unresolvedUnknownBlocks: [],
      }
    }
    const gateway = yield* NotionMdGateway
    const remote = yield* gateway.pullPage({ pageId: local.frontmatter.notion_md.page_id })
    return statusFromSnapshots({ path: opts.path, local, remote })
  }).pipe(
    Effect.tap((status) =>
      Effect.annotateCurrentSpan({
        'notion_md.page_id': status.pageId,
        'notion_md.status.local_changed': status.localChanged,
        'notion_md.status.local_page_metadata_changed': status.localPageMetadataChanged,
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

/*
 * Convention-driven create: a `.nmd` file with `page_id: null` and a
 * `parent` set describes an unmaterialized page. The first `push` calls
 * Notion's create endpoint, then pulls to populate the sidecar — the
 * same `.nmd` file then drives every subsequent push through the normal
 * guarded path with no `--create` flag and no second tool.
 */
const createFromUnmaterialized = (opts: {
  readonly path: string
  readonly local: LocalState
}): Effect.Effect<PushResult, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const parent = toCreatePageParent(opts.local.frontmatter.notion_md.parent)
    if (parent === undefined) {
      return yield* new NmdFrontmatterError({
        path: opts.path,
        message: `Cannot create a Notion page under parent kind '${opts.local.frontmatter.notion_md.parent._tag}'`,
      })
    }
    const gateway = yield* NotionMdGateway
    const created = yield* gateway.createPage({
      parent,
      title: opts.local.frontmatter.notion_md.page.title,
      body: opts.local.body,
    })
    const pulled = yield* gateway.pullPage({ pageId: created.id })
    /*
     * Use Notion's returned body for both the on-disk body and the base
     * snapshot. Using `local.body` here would leave the base snapshot's
     * stored hash out of sync with the sync-state body hash (which is
     * computed from `pulled.markdown.markdown`), breaking the next
     * `status` invariant. After create, the canonical form is whatever
     * Notion stored — subsequent edits start from that baseline.
     */
    const pullResult = yield* writeNmdWithStoragePolicy({
      path: opts.path,
      page: pulled.page,
      markdown: pulled.markdown,
      storage: pulled.storage ?? emptyStorage(),
      body: pulled.markdown.markdown,
    })
    return {
      path: opts.path,
      pageId: pullResult.pageId,
      pushed: true,
      status: {
        path: opts.path,
        pageId: pullResult.pageId,
        localChanged: true,
        localPageMetadataChanged: false,
        localPropertiesChanged: false,
        remoteChanged: false,
        remoteBodyChanged: false,
        remotePageMetadataChanged: false,
        bodyHash: sha256Digest(opts.local.body),
        localBodyHash: sha256Digest(opts.local.body),
        remoteBodyHash: sha256Digest(opts.local.body),
        unresolvedUnknownBlocks: [],
      },
    }
  })

/** Push local `.nmd` edits to Notion after conflict, unknown-block, and review-markup checks. */
export const pushPage = (
  opts: PushOptions,
): Effect.Effect<PushResult, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const local = yield* readNmd(opts.path)
    if (local.frontmatter.notion_md.page_id === null) {
      return yield* createFromUnmaterialized({ path: opts.path, local })
    }
    const gateway = yield* NotionMdGateway
    const remoteForStatus = yield* gateway.pullPage({
      pageId: local.frontmatter.notion_md.page_id,
    })
    const status = statusFromSnapshots({ path: opts.path, local, remote: remoteForStatus })
    const metadataUpdate = pageMetadataUpdate({
      local: local.frontmatter.notion_md.page,
      remote: remoteForStatus.page,
    })

    if (
      status.localChanged === false &&
      status.localPageMetadataChanged === false &&
      status.localPropertiesChanged === false
    ) {
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

    if (
      status.localChanged === true &&
      status.unresolvedUnknownBlocks.length > 0 &&
      opts.allowDeletingUnknownBlocks !== true
    ) {
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
      const baseSnapshot = yield* readBaseSnapshot({
        path: opts.path,
        syncState: requireSyncState({ path: opts.path, local }),
      })
      const mergedBody =
        status.localChanged === true
          ? tryMergeMarkdownBodies({
              baseBody: baseSnapshot.body,
              localBody: local.body,
              remoteBody: remoteForStatus.markdown.markdown,
            })
          : undefined

      if (
        status.localChanged === false &&
        (status.localPageMetadataChanged === true || status.localPropertiesChanged === true)
      ) {
        yield* Effect.annotateCurrentSpan({
          'notion_md.push.decision': 'metadata_only_remote_body_changed',
        })
        if (hasPageMetadataUpdate(metadataUpdate) === true) {
          yield* gateway.updatePageMetadata({
            pageId: status.pageId,
            metadata: metadataUpdate,
          })
        }
        if (status.localPropertiesChanged === true) {
          yield* gateway.updatePageProperties({
            pageId: status.pageId,
            properties: yield* encodeWritableProperties({
              path: opts.path,
              properties: local.frontmatter.notion_md.properties,
            }),
          })
        }
        const pulled = yield* gateway.pullPage({ pageId: status.pageId })
        yield* assertLocalBodyUnchanged({
          path: opts.path,
          pageId: status.pageId,
          expectedBodyHash: status.localBodyHash,
          status,
        })
        yield* writeNmdWithStoragePolicy({
          path: opts.path,
          page: pulled.page,
          markdown: pulled.markdown,
          storage: pulled.storage ?? emptyStorage(),
          body: pulled.markdown.markdown,
        })

        return {
          path: opts.path,
          pageId: status.pageId,
          pushed: true,
          status,
        }
      }

      if (mergedBody !== undefined) {
        yield* Effect.annotateCurrentSpan({
          'notion_md.push.decision': 'auto_merge',
        })
        const command = planMarkdownUpdate({
          baseBody: baseSnapshot.body,
          remoteBody: remoteForStatus.markdown.markdown,
          desiredBody: mergedBody,
        })
        yield* Effect.annotateCurrentSpan({
          'notion_md.push.markdown_command': command._tag,
        })
        const updated = yield* gateway.updateMarkdown({
          pageId: status.pageId,
          command,
          allowDeletingContent: opts.allowDeletingUnknownBlocks === true,
        })
        if (status.localPropertiesChanged === true) {
          yield* gateway.updatePageProperties({
            pageId: status.pageId,
            properties: yield* encodeWritableProperties({
              path: opts.path,
              properties: local.frontmatter.notion_md.properties,
            }),
          })
        }
        if (hasPageMetadataUpdate(metadataUpdate) === true) {
          yield* gateway.updatePageMetadata({
            pageId: status.pageId,
            metadata: metadataUpdate,
          })
        }
        const pulled = yield* gateway.pullPage({ pageId: status.pageId })
        yield* assertLocalBodyUnchanged({
          path: opts.path,
          pageId: status.pageId,
          expectedBodyHash: status.localBodyHash,
          status,
        })
        yield* writeNmdWithStoragePolicy({
          path: opts.path,
          page: pulled.page,
          markdown: updated.markdown,
          storage: pulled.storage ?? emptyStorage(),
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
        remoteBody: remoteForStatus.markdown.markdown,
      })
      yield* Effect.annotateCurrentSpan({
        'notion_md.push.decision': 'body_conflict',
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

    if (status.localChanged === true) {
      yield* Effect.gen(function* () {
        const baseSnapshot = yield* readBaseSnapshot({
          path: opts.path,
          syncState: requireSyncState({ path: opts.path, local }),
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
        const command =
          opts.force === true
            ? ({ _tag: 'replace_content', markdown: local.body } as const)
            : planMarkdownUpdate({
                baseBody: baseSnapshot.body,
                remoteBody: remote.markdown.markdown,
                desiredBody: local.body,
              })
        yield* Effect.annotateCurrentSpan({
          'notion_md.push.decision': opts.force === true ? 'force_replace' : 'guarded_update',
          'notion_md.push.markdown_command': command._tag,
        })
        yield* gateway.updateMarkdown({
          pageId: status.pageId,
          command,
          allowDeletingContent: opts.allowDeletingUnknownBlocks === true,
        })
      })
    }
    if (status.localPropertiesChanged === true) {
      yield* gateway.updatePageProperties({
        pageId: status.pageId,
        properties: yield* encodeWritableProperties({
          path: opts.path,
          properties: local.frontmatter.notion_md.properties,
        }),
      })
    }
    if (hasPageMetadataUpdate(metadataUpdate) === true) {
      yield* gateway.updatePageMetadata({
        pageId: status.pageId,
        metadata: metadataUpdate,
      })
    }
    const pulled = yield* gateway.pullPage({ pageId: status.pageId })
    yield* assertLocalBodyUnchanged({
      path: opts.path,
      pageId: status.pageId,
      expectedBodyHash: status.localBodyHash,
      status,
    })
    yield* writeNmdWithStoragePolicy({
      path: opts.path,
      page: pulled.page,
      markdown: pulled.markdown,
      storage: pulled.storage ?? emptyStorage(),
      body: pulled.markdown.markdown,
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

    if (
      status.localChanged === true ||
      status.localPageMetadataChanged === true ||
      status.localPropertiesChanged === true
    ) {
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
