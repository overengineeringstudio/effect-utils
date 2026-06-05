import { basename } from 'node:path'

import { Effect } from 'effect'

import {
  NOTION_API_VERSION,
  type NmdFrontmatterV2,
  type NmdObjectRef,
  type NmdParentRef,
  type NmdStorage,
  type NmdSyncStateV1,
  type NmdWritablePropertyValue,
} from '@overeng/notion-effect-client'

import {
  NmdConflictError,
  NmdFrontmatterError,
  type NmdError,
  type NmdFileSystemError,
} from './errors.ts'
import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import { planMarkdownUpdate, tryMergeMarkdownBodies } from './merge.ts'
import {
  NotionMdGateway,
  type PageMetadataUpdate,
  type PullPageResult,
  type RemoteMarkdownSnapshot,
  type RemotePageSnapshot,
  type WritablePageCover,
  type WritablePageIcon,
} from './model.ts'
import {
  NmdStateStore,
  readBaseSnapshot,
  validateReferencedObjects,
  writeBaseSnapshot,
  writeStorageObject,
  writeSyncState,
} from './state-store.ts'
import { decideStorage } from './storage-policy.ts'

/**
 * Combined local view of a `.nmd` file plus its sidecar sync state.
 *
 * After the V1→V2 schema split, derived sync bookkeeping (body hash, base
 * snapshot ref, last-pulled timestamps, unknown-block ids, storage
 * inventory, read-only property echoes, data-source binding) lives in
 * `.notion-md/sync/{page_id}.json`, not in the `.nmd` frontmatter. The
 * sync engine threads both through `LocalState` so engine logic doesn't
 * need to know about the on-disk split.
 *
 * A bound `.nmd` (the single-page sync path) must always have a non-null
 * page id and a sidecar sync state. Unbound (`page_id: null`) files are
 * handled by the tree reconcile engine (`tree.ts`), not by `readNmd`.
 * `pageId` is the narrowed non-null id so the engine does not re-check.
 */
export interface LocalState {
  readonly path: string
  /**
   * Where this page's `.notion-md/` state (sidecar + base/object snapshots)
   * lives. Equals `path` for single-page files (state colocated with the
   * file). For a tree node it is the TREE ROOT so all sidecars share one
   * `.notion-md/`, keyed by immutable page id — a moved/renamed file keeps its
   * baseline because the state location does not move with the file.
   */
  readonly statePath: string
  readonly pageId: string
  readonly frontmatter: NmdFrontmatterV2
  /** Bare body as it lives on disk (what gets written back to the `.nmd` file). */
  readonly body: string
  /**
   * The body the engine actually reconciles against Notion: status, 3-way
   * merge, conflict, plan, and the sidecar baseline all use this. For a
   * single-page file it equals `body`. For a tree node it is the COMPOSED
   * body (bare body + resolved cross-ref links + derived child anchors), so
   * the one guarded engine sees the same bytes that are stored on Notion and
   * the noop oracle is the hash of the last *pushed* composed body.
   */
  readonly desiredBody: string
  readonly syncState: NmdSyncStateV1
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
    case 'agent_id':
      return { _tag: 'agent', id: page.parent.agent_id }
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

const hasWritablePropertyValues = (properties: Record<string, NmdWritablePropertyValue>): boolean =>
  Object.keys(properties).length > 0

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
    title?: { readonly key: string; readonly value: string }
    icon?: WritablePageIcon
    cover?: WritablePageCover
    in_trash?: boolean
    is_locked?: boolean
  } = {}

  if (opts.local.title !== opts.remote.title) {
    update.title = { key: opts.remote.title_property_key, value: opts.local.title }
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

{==Body conflict==}{>>Remote and local body content both changed since the last clean pull. Resolve the chosen content back into the .nmd file, then rerun status/sync.<<}{id="body-conflict" by="notion-md" at="${now}"}

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

const buildFrontmatterV2 = (opts: { readonly page: RemotePageSnapshot }): NmdFrontmatterV2 => ({
  notion_md: {
    version: 2,
    api_version: NOTION_API_VERSION,
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
  /*
   * The noop oracle: hash of the body the engine intends to be on Notion
   * (composed for tree nodes), NOT the re-pulled remote markdown — Notion's
   * markdown GET merges blockquote-adjacent blocks, so a re-pull is a lying
   * oracle. For single-page the fake/real round-trip makes these equal.
   */
  readonly baselineBody: string
}): NmdSyncStateV1 => {
  const baseline = normalizeMarkdownLineEndings(opts.baselineBody)
  return {
    version: 1,
    page_id: opts.page.id,
    body: {
      format: 'notion-enhanced-markdown',
      hash: sha256Digest(baseline),
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
  /** Bytes written to the `.nmd` file body (bare body for tree nodes). */
  readonly fileBody: string
  /**
   * Bytes recorded as the sidecar baseline + base snapshot (the noop oracle).
   * For a tree node this is the COMPOSED pushed body, so the next reconcile
   * compares composed-vs-composed; for single-page it equals `fileBody`.
   */
  readonly baselineBody: string
}): Effect.Effect<PullResult, NmdFileSystemError, NmdStateStore> =>
  Effect.gen(function* () {
    const base = yield* writeBaseSnapshot({
      path: opts.path,
      pageId: opts.page.id,
      body: opts.baselineBody,
    })
    const frontmatter = buildFrontmatterV2({ page: opts.page })
    let syncState = buildSyncState({
      page: opts.page,
      markdown: opts.markdown,
      storage: opts.storage,
      base,
      baselineBody: opts.baselineBody,
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
            storage._tag === 'self_contained' ? storage.comments.map((comment) => comment.id) : [],
        },
      }
    }

    const store = yield* NmdStateStore
    yield* store.writeNmdFile({
      path: opts.path,
      content: renderNmdFile({ frontmatter, body: opts.fileBody }),
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
      fileBody: pulled.markdown.markdown,
      baselineBody: pulled.markdown.markdown,
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

/**
 * Establish the sidecar base snapshot for a bound page from its live remote
 * body, without clobbering the file's own frontmatter/body. Used to auto-heal a
 * missing sidecar (fresh clone where the gitignored `.notion-md/` is absent, or
 * a page bound outside notion-md) — identity lives in the file, derived state is
 * rebuilt from remote. Idempotent: re-pulls and rewrites the baseline.
 */
const establishSidecarFromRemote = (opts: {
  readonly path: string
  readonly pageId: string
}): Effect.Effect<void, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const pulled = yield* gateway.pullPage({ pageId: opts.pageId })
    const baselineBody = normalizeMarkdownLineEndings(pulled.markdown.markdown)
    const base = yield* writeBaseSnapshot({
      path: opts.path,
      pageId: opts.pageId,
      body: baselineBody,
    })
    yield* writeSyncState({
      path: opts.path,
      syncState: buildSyncState({
        page: pulled.page,
        markdown: pulled.markdown,
        storage: pulled.storage ?? emptyStorage(),
        base,
        baselineBody,
      }),
    })
  }).pipe(
    Effect.withSpan('notion-md.establish-sidecar', {
      attributes: { 'span.label': opts.pageId.slice(0, 8), 'notion_md.page_id': opts.pageId },
    }),
  )

const readNmd = (
  path: string,
): Effect.Effect<LocalState, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const content = yield* store.readNmdFile({ path })
    const parsed = yield* parseNmdFile({ path, content })
    const pageId = parsed.frontmatter.notion_md.page_id
    if (pageId === null) {
      /*
       * An unbound `.nmd` (`page_id: null`) is a to-be-created page. The
       * single-page guarded path requires a real remote page to reconcile
       * against; tree reconcile (`notion-md sync <dir>`) creates it first.
       */
      return yield* new NmdFrontmatterError({
        path,
        message: `.nmd file ${path} is unbound (page_id: null). Run \`notion-md sync <dir>\` so the tree engine creates the Notion page, or bind it to an existing page id.`,
      })
    }
    let loaded = yield* store.readSyncStateOptional({ path, pageId })
    if (loaded === undefined) {
      /*
       * Fresh-clone / externally-bound case: the `.nmd` carries a valid
       * `page_id` but the gitignored sidecar is absent. Identity lives in the
       * file; auto-heal by rebuilding the derived baseline from the live remote
       * page, then reconcile normally (idempotent establish-then-reconcile).
       */
      yield* establishSidecarFromRemote({ path, pageId })
      loaded = yield* store.readSyncStateOptional({ path, pageId })
      if (loaded === undefined) {
        return yield* new NmdFrontmatterError({
          path,
          message: `Failed to establish sidecar sync state for page ${pageId} at ${path}`,
        })
      }
    }
    const syncState = loaded
    yield* validateReferencedObjects({ path, syncState })
    return {
      path,
      statePath: path,
      pageId,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      /* single-page: the desired body is exactly the on-disk body */
      desiredBody: parsed.body,
      syncState,
    }
  })

/**
 * TOCTOU guard: refuse to overwrite the local file if its on-disk *bare* body
 * changed while the push was in flight. Reads the raw file (not `readNmd`) so
 * it works for tree nodes too — `readNmd` would re-narrow `page_id` and the
 * bare body is the right unit of "did someone edit this file under us".
 */
const assertLocalBodyUnchanged = (opts: {
  readonly path: string
  readonly pageId: string
  readonly expectedFileBodyHash: string
  readonly status: StatusResult
}): Effect.Effect<void, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const content = yield* store.readNmdFile({ path: opts.path })
    const parsed = yield* parseNmdFile({ path: opts.path, content })
    if (sha256Digest(parsed.body) === opts.expectedFileBodyHash) return
    return yield* new NmdConflictError({
      path: opts.path,
      page_id: opts.pageId,
      local_changed: true,
      remote_changed: opts.status.remoteChanged,
      message:
        'Local .nmd body changed while push was in progress; refusing to overwrite it with refreshed Notion state',
    })
  })

const statusFromSnapshots = (opts: {
  readonly path: string
  readonly local: LocalState
  readonly remote: PullPageResult
}): StatusResult => {
  /*
   * Compare the DESIRED body (composed, for tree nodes) against the recorded
   * baseline and the live remote, so the one guarded engine answers both "did
   * local change" and "did remote change" over the same bytes that live on
   * Notion. `local.body` (bare) is only what we write back to the file.
   */
  const localBodyHash = sha256Digest(opts.local.desiredBody)
  const remoteBody = normalizeMarkdownLineEndings(opts.remote.markdown.markdown)
  const remoteBodyHash = sha256Digest(remoteBody)
  const bodyHash = opts.local.syncState.body.hash
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
    const gateway = yield* NotionMdGateway
    const remote = yield* gateway.pullPage({ pageId: local.pageId })
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

/**
 * How a successful guarded push persists local state afterwards. Abstracts the
 * one place the single-page path and the tree path differ: a single-page file
 * round-trips the re-pulled remote body into both the `.nmd` file and the
 * sidecar baseline; a tree node keeps the bare body on disk but records the
 * COMPOSED pushed body as the sidecar baseline (the noop oracle). Everything
 * before this — status, guards, 3-way merge, conflict — is shared verbatim.
 */
export interface PushPersist {
  /** Hash of the on-disk bare body at read time, for the TOCTOU guard. */
  readonly expectedFileBodyHash: string
  /**
   * Persist after the gateway mutation. `pushedBody` is the exact body the
   * engine sent to Notion (bare, merged, or composed); `status` is the status
   * the guarded core computed. `adoptRemoteBody` is set only by the
   * metadata-only-with-remote-body-race branch, where no body was pushed and
   * the canonical local body is the freshly re-pulled remote one (a pull).
   * Implementations re-pull for storage/metadata, run the TOCTOU guard, then
   * write the `.nmd` file and the sidecar baseline per their body semantics.
   */
  readonly persist: (opts: {
    readonly pushedBody: string
    readonly status: StatusResult
    readonly adoptRemoteBody?: boolean
  }) => Effect.Effect<void, NmdError, NotionMdGateway | NmdStateStore>
}

/** Single-page persist: round-trip the re-pulled remote body into file + baseline. */
const singlePagePersist = (opts: {
  readonly path: string
  readonly expectedFileBodyHash: string
}): PushPersist => ({
  expectedFileBodyHash: opts.expectedFileBodyHash,
  persist: ({ pushedBody, status, adoptRemoteBody }) =>
    Effect.gen(function* () {
      const gateway = yield* NotionMdGateway
      const pulled = yield* gateway.pullPage({ pageId: status.pageId })
      yield* assertLocalBodyUnchanged({
        path: opts.path,
        pageId: status.pageId,
        expectedFileBodyHash: opts.expectedFileBodyHash,
        status,
      })
      /*
       * In the metadata-only race the local body didn't change, so the
       * canonical body is the re-pulled remote (a pull); otherwise round-trip
       * the body we just pushed.
       */
      const body = adoptRemoteBody === true ? pulled.markdown.markdown : pushedBody
      yield* writeNmdWithStoragePolicy({
        path: opts.path,
        page: pulled.page,
        markdown: pulled.markdown,
        storage: pulled.storage ?? emptyStorage(),
        fileBody: body,
        baselineBody: body,
      })
    }),
})

/**
 * Tree-node persist: keep the *bare* body on disk (preserving the node's own
 * bound frontmatter) but record the *composed* pushed body as the sidecar
 * baseline — the noop oracle for the next reconcile. Used by `tree.ts` so a
 * directory tree shares the one guarded engine without re-pulling the lossy
 * remote markdown as its baseline.
 */
export const treeNodePersist = (opts: {
  readonly path: string
  /** Tree root where the shared `.notion-md/` state lives (sidecar + base). */
  readonly statePath: string
  readonly frontmatter: NmdFrontmatterV2
  readonly bareBody: string
  readonly expectedFileBodyHash: string
}): PushPersist => ({
  expectedFileBodyHash: opts.expectedFileBodyHash,
  persist: ({ pushedBody, status }) =>
    Effect.gen(function* () {
      const gateway = yield* NotionMdGateway
      const pulled = yield* gateway.pullPage({ pageId: status.pageId })
      yield* assertLocalBodyUnchanged({
        path: opts.path,
        pageId: status.pageId,
        expectedFileBodyHash: opts.expectedFileBodyHash,
        status,
      })
      const store = yield* NmdStateStore
      /* file keeps the node's own frontmatter (bound id/url/title) + bare body */
      yield* store.writeNmdFile({
        path: opts.path,
        content: renderNmdFile({ frontmatter: opts.frontmatter, body: opts.bareBody }),
      })
      /* sidecar + base snapshot live at the tree root, keyed by page id */
      const base = yield* writeBaseSnapshot({
        path: opts.statePath,
        pageId: status.pageId,
        body: pushedBody,
      })
      yield* writeSyncState({
        path: opts.statePath,
        syncState: buildSyncState({
          page: pulled.page,
          markdown: pulled.markdown,
          storage: pulled.storage ?? emptyStorage(),
          base,
          baselineBody: pushedBody,
        }),
      })
    }),
})

/**
 * Build a `LocalState` for a tree node so it can flow through the one guarded
 * engine. `body` is the bare on-disk body; `desiredBody` is the composed body
 * (bare + resolved cross-refs + derived child anchors); `statePath` is the tree
 * root so all sidecars share one `.notion-md/`, surviving file moves/renames.
 */
export const buildTreeNodeLocalState = (opts: {
  readonly path: string
  readonly statePath: string
  readonly pageId: string
  readonly frontmatter: NmdFrontmatterV2
  readonly bareBody: string
  readonly composedBody: string
  readonly syncState: NmdSyncStateV1
}): LocalState => ({
  path: opts.path,
  statePath: opts.statePath,
  pageId: opts.pageId,
  frontmatter: opts.frontmatter,
  body: opts.bareBody,
  desiredBody: opts.composedBody,
  syncState: opts.syncState,
})

/**
 * The shared guarded push core. Runs the full safety suite over `local`
 * (review-markup guard, unknown-block guard, remote-changed conflict + 3-way
 * merge + `.conflict.roughdraft.md`, storage policy, TOCTOU) and delegates the
 * write-back to `persist`. `local.desiredBody` is the content reconciled
 * against Notion; `local.body` is only the bytes written back to the `.nmd`
 * file. Both the single-page path and the tree path call this — there is one
 * reconcile engine, not two.
 */
export const pushGuarded = (opts: {
  readonly local: LocalState
  readonly remoteForStatus: PullPageResult
  readonly persist: PushPersist
  readonly options: PushOptions
}): Effect.Effect<PushResult, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const { local, remoteForStatus, options } = opts
    const path = local.path
    /* `.notion-md/` state location (tree root for tree nodes, else the file). */
    const statePath = local.statePath
    const gateway = yield* NotionMdGateway
    const status = statusFromSnapshots({ path, local, remote: remoteForStatus })
    const metadataUpdate = pageMetadataUpdate({
      local: local.frontmatter.notion_md.page,
      remote: remoteForStatus.page,
    })

    if (
      status.localChanged === false &&
      status.localPageMetadataChanged === false &&
      status.localPropertiesChanged === false
    ) {
      return { path, pageId: status.pageId, pushed: false, status }
    }

    if (
      containsRoughdraftReviewMarkup(local.desiredBody) === true &&
      options.allowReviewMarkup !== true
    ) {
      return yield* new NmdConflictError({
        path,
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
      options.allowDeletingUnknownBlocks !== true
    ) {
      return yield* new NmdConflictError({
        path,
        page_id: status.pageId,
        local_changed: status.localChanged,
        remote_changed: status.remoteChanged,
        message:
          'Page contains unresolved unknown Notion blocks; refusing push because replace_content can delete them. Pass allowDeletingUnknownBlocks only for explicit destructive intent.',
      })
    }

    if (status.remoteBodyChanged === true && options.force !== true) {
      const baseSnapshot = yield* readBaseSnapshot({ path: statePath, syncState: local.syncState })
      const mergedBody =
        status.localChanged === true
          ? tryMergeMarkdownBodies({
              baseBody: baseSnapshot.body,
              localBody: local.desiredBody,
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
          yield* gateway.updatePageMetadata({ pageId: status.pageId, metadata: metadataUpdate })
        }
        if (status.localPropertiesChanged === true) {
          yield* gateway.updatePageProperties({
            pageId: status.pageId,
            properties: yield* encodeWritableProperties({
              path,
              properties: local.frontmatter.notion_md.properties,
            }),
          })
        }
        /*
         * Body unchanged locally but the remote body changed concurrently:
         * adopt the freshly re-pulled remote body as the new local baseline
         * (a pull), rather than re-asserting the stale desired body.
         */
        yield* opts.persist.persist({
          pushedBody: local.desiredBody,
          status,
          adoptRemoteBody: true,
        })
        return { path, pageId: status.pageId, pushed: true, status }
      }

      if (mergedBody !== undefined) {
        yield* Effect.annotateCurrentSpan({ 'notion_md.push.decision': 'auto_merge' })
        const command = planMarkdownUpdate({
          baseBody: baseSnapshot.body,
          remoteBody: remoteForStatus.markdown.markdown,
          desiredBody: mergedBody,
        })
        yield* Effect.annotateCurrentSpan({ 'notion_md.push.markdown_command': command._tag })
        yield* gateway.updateMarkdown({
          pageId: status.pageId,
          command,
          allowDeletingContent: options.allowDeletingUnknownBlocks === true,
        })
        if (status.localPropertiesChanged === true) {
          yield* gateway.updatePageProperties({
            pageId: status.pageId,
            properties: yield* encodeWritableProperties({
              path,
              properties: local.frontmatter.notion_md.properties,
            }),
          })
        }
        if (hasPageMetadataUpdate(metadataUpdate) === true) {
          yield* gateway.updatePageMetadata({ pageId: status.pageId, metadata: metadataUpdate })
        }
        yield* opts.persist.persist({ pushedBody: mergedBody, status })
        return { path, pageId: status.pageId, pushed: true, status }
      }

      const conflictPath = yield* writeRoughdraftConflict({
        path,
        pageId: status.pageId,
        baseBody: baseSnapshot.body,
        localBody: local.desiredBody,
        remoteBody: remoteForStatus.markdown.markdown,
      })
      yield* Effect.annotateCurrentSpan({ 'notion_md.push.decision': 'body_conflict' })
      return yield* new NmdConflictError({
        path,
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
          path: statePath,
          syncState: local.syncState,
        })
        const remote = yield* gateway.pullPage({ pageId: status.pageId })
        if (
          options.force !== true &&
          sha256Digest(remote.markdown.markdown) !== status.remoteBodyHash
        ) {
          return yield* new NmdConflictError({
            path,
            page_id: status.pageId,
            local_changed: status.localChanged,
            remote_changed: true,
            message: 'Remote page changed while preparing guarded Markdown push',
          })
        }
        const command =
          options.force === true
            ? ({ _tag: 'replace_content', markdown: local.desiredBody } as const)
            : planMarkdownUpdate({
                baseBody: baseSnapshot.body,
                remoteBody: remote.markdown.markdown,
                desiredBody: local.desiredBody,
              })
        yield* Effect.annotateCurrentSpan({
          'notion_md.push.decision': options.force === true ? 'force_replace' : 'guarded_update',
          'notion_md.push.markdown_command': command._tag,
        })
        yield* gateway.updateMarkdown({
          pageId: status.pageId,
          command,
          allowDeletingContent: options.allowDeletingUnknownBlocks === true,
        })
      })
    }
    if (status.localPropertiesChanged === true) {
      yield* gateway.updatePageProperties({
        pageId: status.pageId,
        properties: yield* encodeWritableProperties({
          path,
          properties: local.frontmatter.notion_md.properties,
        }),
      })
    }
    if (hasPageMetadataUpdate(metadataUpdate) === true) {
      yield* gateway.updatePageMetadata({ pageId: status.pageId, metadata: metadataUpdate })
    }
    /*
     * If only properties/metadata changed (the body was not pushed), adopt the
     * re-pulled remote body — it may have raced ahead during the property
     * update. When the body WAS pushed, round-trip the pushed body.
     */
    yield* opts.persist.persist({
      pushedBody: local.desiredBody,
      status,
      adoptRemoteBody: status.localChanged === false,
    })

    return { path, pageId: status.pageId, pushed: true, status }
  })

/** Push local `.nmd` edits to Notion after conflict, unknown-block, and review-markup checks. */
export const pushPage = (
  opts: PushOptions,
): Effect.Effect<PushResult, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const local = yield* readNmd(opts.path)
    const gateway = yield* NotionMdGateway
    const remoteForStatus = yield* gateway.pullPage({ pageId: local.pageId })
    return yield* pushGuarded({
      local,
      remoteForStatus,
      options: opts,
      persist: singlePagePersist({
        path: opts.path,
        expectedFileBodyHash: sha256Digest(local.body),
      }),
    })
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
