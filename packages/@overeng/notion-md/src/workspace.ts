import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import type { Path } from '@effect/platform'
import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { NmdCliError, NmdFileSystemError, type NmdError } from './errors.ts'
import { parseNmdFile } from './frontmatter.ts'
import { NotionMdGateway } from './model.ts'
import { NmdStateStore } from './state-store.ts'
import {
  pullPage,
  statusPage,
  syncPage,
  type PullResult,
  type StatusResult,
  type SyncOptions,
  type SyncResult,
} from './sync.ts'

const WorkspaceManifest = Schema.Struct({
  version: Schema.Literal(1),
  root_page_id: Schema.String,
  pages: Schema.Record({ key: Schema.String, value: Schema.String }),
}).annotations({ identifier: 'NotionMd.WorkspaceManifest' })

type WorkspaceManifest = typeof WorkspaceManifest.Type

const encodeManifestJson = Schema.encodeSync(Schema.parseJson(WorkspaceManifest, { space: 2 }))
const decodeManifestJson = Schema.decodeUnknown(Schema.parseJson(WorkspaceManifest), {
  errors: 'all',
  onExcessProperty: 'error',
} as const)

/** Result envelope for establishing or syncing a managed notion-md workspace. */
export interface WorkspaceSyncResult {
  readonly _tag: 'workspace'
  readonly path: string
  readonly rootPageId: string
  readonly materialized: readonly PullResult[]
  readonly synced: readonly SyncResult[]
  readonly pageCount: number
}

/** Read-only status envelope for a managed notion-md workspace. */
export interface WorkspaceStatusResult {
  readonly _tag: 'workspace_status'
  readonly path: string
  readonly rootPageId: string
  readonly pageCount: number
  readonly missing: readonly { readonly pageId: string; readonly path: string }[]
  readonly statuses: readonly StatusResult[]
}

interface RemoteTreePage {
  readonly pageId: string
  readonly title: string
  readonly segments: readonly string[]
}

const workspaceManifestPath = (root: string): string => join(root, '.notion-md', 'workspace.json')

const makeFsError = (opts: {
  readonly operation: string
  readonly path: string
  readonly cause: unknown
  readonly message: string
}): NmdFileSystemError =>
  new NmdFileSystemError({
    operation: opts.operation,
    path: opts.path,
    cause: opts.cause,
    message: opts.message,
  })

const slugify = (title: string): string => {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
  return slug === '' ? 'untitled' : slug
}

const shortPageId = (pageId: string): string => pageId.replaceAll('-', '').slice(-6)

const uniquePath = (opts: {
  readonly root: string
  readonly used: Set<string>
  readonly segments: readonly string[]
  readonly pageId: string
}): string => {
  const parentSegments = opts.segments.slice(0, -1).map(slugify)
  const base = slugify(opts.segments.at(-1) ?? 'index')
  const candidate = resolve(opts.root, ...parentSegments, `${base}.nmd`)
  if (opts.used.has(candidate) === false) {
    opts.used.add(candidate)
    return candidate
  }
  const suffix = shortPageId(opts.pageId)
  for (let index = 0; ; index += 1) {
    const suffixPart = index === 0 ? suffix : `${suffix}-${index}`
    const suffixed = resolve(opts.root, ...parentSegments, `${base}-${suffixPart}.nmd`)
    if (opts.used.has(suffixed) === false) {
      opts.used.add(suffixed)
      return suffixed
    }
  }
}

const manifestPagePath = (opts: {
  readonly root: string
  readonly manifest: WorkspaceManifest
  readonly pageId: string
}): string | undefined => {
  const relativePath = opts.manifest.pages[opts.pageId]
  return relativePath === undefined ? undefined : resolve(opts.root, relativePath)
}

const isWithinRoot = (opts: { readonly root: string; readonly path: string }): boolean => {
  const relativePath = relative(resolve(opts.root), resolve(opts.path))
  return (
    relativePath === '' ||
    (relativePath.startsWith('..') === false && isAbsolute(relativePath) === false)
  )
}

const toManifestRelativePath = (opts: { readonly root: string; readonly path: string }): string => {
  const relativePath = relative(resolve(opts.root), resolve(opts.path))
  return relativePath === '' ? '.' : relativePath.split('\\').join('/')
}

const isNmdFileTarget = (path: string): boolean => extname(path) === '.nmd'

/** True when a local directory has notion-md workspace metadata. */
export const isManagedWorkspace = (
  path: string,
): Effect.Effect<boolean, NmdFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const targetInfo = yield* fs.stat(path).pipe(Effect.either)
    if (targetInfo._tag === 'Right' && targetInfo.right.type !== 'Directory') return false
    return yield* fs.exists(workspaceManifestPath(path)).pipe(
      Effect.mapError((cause) =>
        makeFsError({
          operation: 'exists',
          path: workspaceManifestPath(path),
          cause,
          message: `Failed to inspect notion-md workspace at ${path}`,
        }),
      ),
    )
  })

const readManifest = (
  root: string,
): Effect.Effect<WorkspaceManifest, NmdError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const manifestPath = workspaceManifestPath(root)
    const content = yield* fs.readFileString(manifestPath).pipe(
      Effect.mapError((cause) =>
        makeFsError({
          operation: 'read_workspace',
          path: manifestPath,
          cause,
          message: `Failed to read notion-md workspace ${manifestPath}`,
        }),
      ),
    )
    const manifest = yield* decodeManifestJson(content).pipe(
      Effect.mapError(
        (cause) =>
          new NmdCliError({
            message: `Invalid notion-md workspace manifest ${manifestPath}: ${String(cause)}`,
          }),
      ),
    )
    for (const [pageId, pagePath] of Object.entries(manifest.pages)) {
      if (
        isAbsolute(pagePath) === true ||
        isWithinRoot({ root, path: resolve(root, pagePath) }) === false
      ) {
        return yield* new NmdCliError({
          message: `Invalid notion-md workspace manifest ${manifestPath}: page ${pageId} path ${pagePath} escapes the workspace root`,
        })
      }
    }
    return manifest
  })

const readManifestOptional = (
  root: string,
): Effect.Effect<WorkspaceManifest | undefined, NmdError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const manifestPath = workspaceManifestPath(root)
    const exists = yield* fs.exists(manifestPath).pipe(
      Effect.mapError((cause) =>
        makeFsError({
          operation: 'exists',
          path: manifestPath,
          cause,
          message: `Failed to inspect notion-md workspace ${manifestPath}`,
        }),
      ),
    )
    if (exists === false) return undefined
    return yield* readManifest(root)
  })

const writeManifest = (opts: {
  readonly root: string
  readonly manifest: WorkspaceManifest
}): Effect.Effect<void, NmdFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const manifestPath = workspaceManifestPath(opts.root)
    yield* fs.makeDirectory(dirname(manifestPath), { recursive: true }).pipe(
      Effect.mapError((cause) =>
        makeFsError({
          operation: 'write_workspace',
          path: dirname(manifestPath),
          cause,
          message: `Failed to create notion-md workspace directory ${dirname(manifestPath)}`,
        }),
      ),
    )
    yield* fs
      .writeFileString(manifestPath, `${encodeManifestJson(opts.manifest).trimEnd()}\n`)
      .pipe(
        Effect.mapError((cause) =>
          makeFsError({
            operation: 'write_workspace',
            path: manifestPath,
            cause,
            message: `Failed to write notion-md workspace ${manifestPath}`,
          }),
        ),
      )
  })

const listRemoteTree = (opts: {
  readonly rootPageId: string
}): Effect.Effect<readonly RemoteTreePage[], NmdError, NotionMdGateway> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const root = yield* gateway.pullPage({ pageId: opts.rootPageId })
    const pages: RemoteTreePage[] = [
      { pageId: root.page.id, title: root.page.title, segments: ['index'] },
    ]

    const visit = (visitOpts: {
      readonly pageId: string
      readonly parentSegments: readonly string[]
    }): Effect.Effect<void, NmdError> =>
      gateway.listChildPages({ pageId: visitOpts.pageId }).pipe(
        Effect.flatMap((children) =>
          Effect.forEach(
            children,
            (child) => {
              const segments = [...visitOpts.parentSegments, child.title]
              pages.push({ pageId: child.pageId, title: child.title, segments })
              return visit({ pageId: child.pageId, parentSegments: segments })
            },
            { discard: true },
          ),
        ),
      )

    yield* visit({ pageId: opts.rootPageId, parentSegments: [] })
    return pages
  })

const readLocalPageIds = (opts: {
  readonly paths: readonly string[]
}): Effect.Effect<Map<string, string>, never, NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const entries = yield* Effect.forEach(opts.paths, (path) =>
      store.readNmdFile({ path }).pipe(
        Effect.flatMap((content) => parseNmdFile({ path, content })),
        Effect.either,
        Effect.map((result) => ({ path, result })),
      ),
    )
    const pageIds = new Map<string, string>()
    for (const entry of entries) {
      if (entry.result._tag === 'Left') continue
      const pageId = entry.result.right.frontmatter.notion_md.page_id
      if (pageId !== null) pageIds.set(pageId, entry.path)
    }
    return pageIds
  })

const buildManifestForTree = (opts: {
  readonly root: string
  readonly rootPageId: string
  readonly remotePages: readonly RemoteTreePage[]
  readonly previousManifest?: WorkspaceManifest
  readonly localPageIds?: Map<string, string>
}): WorkspaceManifest => {
  const used = new Set<string>([
    ...Object.values(opts.previousManifest?.pages ?? {}).map((relativePath) =>
      resolve(opts.root, relativePath),
    ),
    ...Array.from(opts.localPageIds?.values() ?? []).map((path) => resolve(path)),
  ])
  const pages: Record<string, string> = {}
  for (const page of opts.remotePages) {
    const previous =
      opts.localPageIds?.get(page.pageId) ??
      (opts.previousManifest === undefined
        ? undefined
        : manifestPagePath({
            root: opts.root,
            manifest: opts.previousManifest,
            pageId: page.pageId,
          }))
    const path =
      previous ??
      uniquePath({
        root: opts.root,
        used,
        segments: page.segments,
        pageId: page.pageId,
      })
    used.add(resolve(path))
    pages[page.pageId] = toManifestRelativePath({ root: opts.root, path })
  }
  return {
    version: 1,
    root_page_id: opts.rootPageId,
    pages,
  }
}

/** Read managed workspace status without creating files or updating the manifest. */
export const statusWorkspace = (opts: {
  readonly root: string
}): Effect.Effect<
  WorkspaceStatusResult,
  NmdError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = resolve(opts.root)
    const manifest = yield* readManifest(root)
    const rootPageId = manifest.root_page_id

    const remotePages = yield* listRemoteTree({ rootPageId })
    const localPaths = Object.values(manifest.pages).map((relativePath) =>
      resolve(root, relativePath),
    )
    const localPageIds = yield* readLocalPageIds({ paths: localPaths })
    const planned = buildManifestForTree({
      root,
      rootPageId,
      remotePages,
      previousManifest: manifest,
      localPageIds,
    })

    const missing: Array<{ readonly pageId: string; readonly path: string }> = []
    const statuses: StatusResult[] = []
    for (const page of remotePages) {
      const path = resolve(root, planned.pages[page.pageId] ?? `${slugify(page.title)}.nmd`)
      const exists = yield* fs.exists(path).pipe(
        Effect.mapError((cause) =>
          makeFsError({
            operation: 'exists',
            path,
            cause,
            message: `Failed to inspect notion-md page ${path}`,
          }),
        ),
      )
      if (exists === true) {
        statuses.push(yield* statusPage({ path }))
      } else {
        missing.push({ pageId: page.pageId, path: toManifestRelativePath({ root, path }) })
      }
    }

    return {
      _tag: 'workspace_status',
      path: root,
      rootPageId,
      pageCount: remotePages.length,
      missing,
      statuses,
    } as const
  })

/** Establish or refresh a managed workspace from a Notion page tree. */
export const syncRemoteToTarget = (opts: {
  readonly pageId: string
  readonly target: string
  readonly syncOptions?: Omit<SyncOptions, 'path'>
}): Effect.Effect<
  PullResult | WorkspaceSyncResult,
  NmdError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  isNmdFileTarget(opts.target) === true
    ? pullPage({ pageId: opts.pageId, outPath: opts.target })
    : syncWorkspace({
        root: opts.target,
        rootPageId: opts.pageId,
        ...(opts.syncOptions === undefined ? {} : { syncOptions: opts.syncOptions }),
      })

/** Sync a managed workspace, materializing remote child pages that are missing locally. */
export const syncWorkspace = (opts: {
  readonly root: string
  readonly rootPageId?: string
  readonly syncOptions?: Omit<SyncOptions, 'path'>
}): Effect.Effect<
  WorkspaceSyncResult,
  NmdError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = resolve(opts.root)
    const previousManifest = yield* readManifestOptional(root)
    const rootPageId = opts.rootPageId ?? previousManifest?.root_page_id
    if (rootPageId === undefined) {
      return yield* new NmdCliError({
        message: `No Notion root configured for workspace ${root}`,
      })
    }
    yield* fs.makeDirectory(root, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        makeFsError({
          operation: 'create_workspace',
          path: root,
          cause,
          message: `Failed to create notion-md workspace ${root}`,
        }),
      ),
    )

    const remotePages = yield* listRemoteTree({ rootPageId })
    const localPaths =
      previousManifest === undefined
        ? []
        : Object.values(previousManifest.pages).map((relativePath) => resolve(root, relativePath))
    const localPageIds = yield* readLocalPageIds({ paths: localPaths })
    const manifest = buildManifestForTree({
      root,
      rootPageId,
      remotePages,
      ...(previousManifest === undefined ? {} : { previousManifest }),
      localPageIds,
    })
    if (previousManifest === undefined) {
      for (const page of remotePages) {
        const path = resolve(root, manifest.pages[page.pageId] ?? `${slugify(page.title)}.nmd`)
        const exists = yield* fs.exists(path).pipe(
          Effect.mapError((cause) =>
            makeFsError({
              operation: 'exists',
              path,
              cause,
              message: `Failed to inspect notion-md page ${path}`,
            }),
          ),
        )
        if (exists === true) {
          return yield* new NmdCliError({
            message: `Refusing to establish notion-md workspace at ${root}: planned page path ${path} already exists`,
          })
        }
      }
    }
    yield* writeManifest({ root, manifest })

    const materialized: PullResult[] = []
    const synced: SyncResult[] = []
    for (const page of remotePages) {
      const path = resolve(root, manifest.pages[page.pageId] ?? `${slugify(page.title)}.nmd`)
      const exists = yield* fs.exists(path).pipe(
        Effect.mapError((cause) =>
          makeFsError({
            operation: 'exists',
            path,
            cause,
            message: `Failed to inspect notion-md page ${path}`,
          }),
        ),
      )
      if (exists === true) {
        synced.push(
          yield* syncPage({
            path,
            ...(opts.syncOptions?.force === undefined ? {} : { force: opts.syncOptions.force }),
            ...(opts.syncOptions?.allowDeletingUnknownBlocks === undefined
              ? {}
              : { allowDeletingUnknownBlocks: opts.syncOptions.allowDeletingUnknownBlocks }),
            ...(opts.syncOptions?.allowReviewMarkup === undefined
              ? {}
              : { allowReviewMarkup: opts.syncOptions.allowReviewMarkup }),
          }),
        )
      } else {
        materialized.push(yield* pullPage({ pageId: page.pageId, outPath: path }))
      }
    }

    return {
      _tag: 'workspace',
      path: root,
      rootPageId,
      materialized,
      synced,
      pageCount: remotePages.length,
    } as const
  }).pipe(
    Effect.withSpan('notion-md.sync-workspace', {
      attributes: {
        'span.label': basename(opts.root),
        'notion_md.workspace.root_page_id': opts.rootPageId ?? '',
      },
    }),
  )
