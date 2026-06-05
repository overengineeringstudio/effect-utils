import { basename, dirname, extname, join, relative, resolve } from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import type { NmdFrontmatterV2 } from '@overeng/notion-effect-client'
import { titleSlug } from '@overeng/utils'

import { pageUrl, resolveCrossRefs, validateCrossRefTargets } from './cross-refs.ts'
import { NmdCliError, NmdFileSystemError, type NmdError } from './errors.ts'
import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import { NotionMdGateway, type RemotePageSnapshot } from './model.ts'
import {
  NmdStateStore,
  readSyncStateOptional,
  writeBaseSnapshot,
  writeSyncState,
} from './state-store.ts'
import {
  buildTreeNodeLocalState,
  pullPage,
  pushGuarded,
  statusPage,
  treeNodePersist,
  type PushOptions,
} from './sync.ts'

export { pageUrl, resolveCrossRefs, validateCrossRefTargets } from './cross-refs.ts'

/**
 * Unified directory-tree ↔ Notion-subtree reconcile.
 *
 * The local directory tree is the source of truth for hierarchy: each `.nmd`
 * file is a page, directory nesting is page nesting. Binding/identity lives IN
 * the file (frontmatter `page_id`); an unbound file (`page_id: null`) is a
 * to-be-created page.
 *
 * `tree.ts` is a pure ORCHESTRATOR: it computes hierarchy, the slug→id map, and
 * the composed body per node, then delegates every per-node create/update to
 * the ONE guarded engine in `sync.ts` (`pushGuarded`). It never issues a blind
 * `replace_content`; the same 3-way merge, remote-changed conflict
 * (`.conflict.roughdraft.md`), storage policy, unknown-block guard,
 * review-markup guard and TOCTOU that protect single-page sync protect every
 * tree node. There is one reconcile engine, not two.
 *
 * Load-bearing invariants (verified against Notion in #745):
 *  - the noop/diff oracle is the hash of the last PUSHED *composed* body
 *    (recorded in the sidecar), NOT a re-pull — Notion's markdown GET merges
 *    blockquote-adjacent blocks, so a re-pull is a lying oracle;
 *  - the parent's child index is DERIVED and re-emitted on every parent push
 *    (creating a child auto-appends a `<page>` anchor; the guarded push trashes
 *    any child whose anchor is absent — the full set must always be re-emitted);
 *  - child `<page>` anchors must be blank-line-separated (consecutive ones
 *    merge and trash siblings);
 *  - inline cross-refs are markdown links `[label](url)`; only block-level
 *    `<page>` (own line) is a valid child anchor;
 *  - a renamed/moved file keeps its page id (rebind / move), never trash+recreate.
 *
 * Hierarchy convention:
 *  - the tree root file (`index.nmd` or `README.nmd`, detected, or `--root-file`)
 *    is the root page (its parent is read from Notion, not reconciled);
 *  - any other `<dir>/<name>.nmd` is a child of the page anchoring `<dir>`;
 *  - a subdirectory `<dir>/<sub>/` is anchored by `<dir>/<sub>/<root-file>`.
 */

const NMD_EXT = '.nmd'

/** Default root-file candidates in priority order, when not explicitly given. */
const ROOT_FILE_CANDIDATES = ['index.nmd', 'README.nmd'] as const

/** Regenerable path↔id index for a synced tree (NOT the source of identity). */
const TreeIndex = Schema.Struct({
  version: Schema.Literal(1),
  root_page_id: Schema.String,
  /** Root-file basename, so a later run reconstructs the same layout. */
  root_file: Schema.String,
  /** posix relativePath (from root) → page_id; derived from frontmatter each run. */
  pages: Schema.Record({ key: Schema.String, value: Schema.String }),
}).annotations({ identifier: 'NotionMd.TreeIndex' })

type TreeIndex = typeof TreeIndex.Type

const encodeTreeIndexJson = Schema.encodeSync(Schema.parseJson(TreeIndex, { space: 2 }))
const decodeTreeIndexJson = Schema.decodeUnknown(Schema.parseJson(TreeIndex), {
  errors: 'all',
  onExcessProperty: 'error',
} as const)

const treeIndexPath = (root: string): string => join(root, '.notion-md', 'workspace.json')

/**
 * Sentinel "file path" inside the tree root used for all `.notion-md/` state
 * operations. The state-store derives the `.notion-md/` directory by stripping
 * the basename of the path it is given (it was designed for a `.nmd` FILE
 * path); passing the bare directory would strip the root's own name and place
 * state in the PARENT. This anchor makes `stateRootPath` resolve to
 * `<root>/.notion-md/` so all tree sidecars share one root, keyed by page id.
 */
const treeStateAnchor = (root: string): string => join(root, '.tree')

/** A local source page discovered in the directory tree. */
interface LocalTreePage {
  /** Absolute path to the `.nmd` file. */
  readonly path: string
  /** Posix-relative path from the tree root (index key + ref target). */
  readonly relPath: string
  /** Stable slug used for `[[slug]]` cross-refs (unique within the tree). */
  readonly slug: string
  /** Page title (frontmatter `page.title`). */
  readonly title: string
  /** Body markdown with frontmatter stripped (cross-refs still unresolved). */
  readonly body: string
  /** relPath of the parent page, or undefined for the root. */
  readonly parentRelPath: string | undefined
  /** Durable page id bound in frontmatter (`page_id`), or null when unbound. */
  readonly boundPageId: string | null
  /** Parsed frontmatter (re-rendered with the real id on create). */
  readonly frontmatter: NmdFrontmatterV2
}

/** Tagged reconcile operation for one tree pass. */
export type TreeOp =
  | { readonly _tag: 'create'; readonly relPath: string; readonly title: string }
  | { readonly _tag: 'update'; readonly relPath: string; readonly pageId: string }
  | { readonly _tag: 'move'; readonly relPath: string; readonly pageId: string }
  | { readonly _tag: 'noop'; readonly relPath: string; readonly pageId: string }
  | { readonly _tag: 'trash'; readonly relPath: string; readonly pageId: string }
  | { readonly _tag: 'conflict'; readonly relPath: string; readonly pageId: string }
  | { readonly _tag: 'materialize'; readonly relPath: string; readonly pageId: string }

/** Result envelope for a tree sync (or plan) pass. */
export interface TreeSyncResult {
  readonly _tag: 'tree'
  readonly root: string
  readonly rootPageId: string
  readonly rootFile: string
  readonly direction: 'local' | 'from-remote'
  readonly plan: boolean
  readonly ops: readonly TreeOp[]
}

const makeFsError = (opts: {
  readonly operation: string
  readonly path: string
  readonly cause: unknown
}): NmdFileSystemError =>
  new NmdFileSystemError({
    operation: opts.operation,
    path: opts.path,
    cause: opts.cause,
    message: `notion-md tree ${opts.operation} failed for ${opts.path}`,
  })

const toPosix = (value: string): string => value.split('\\').join('/')

/** True when `relPath`'s basename is the tree's root-file (an anchor for its dir). */
const isRootFile = (opts: { readonly relPath: string; readonly rootFile: string }): boolean =>
  basename(opts.relPath) === opts.rootFile

/**
 * Slug for a relative path: directory segments + (non-root) filename stem,
 * joined by `/`. A root-file identifies its containing directory, not itself.
 */
export const slugForRelPath = (opts: {
  readonly relPath: string
  readonly rootFile: string
}): string => {
  const rootStem = basename(opts.rootFile, NMD_EXT)
  const noExt = opts.relPath.slice(0, opts.relPath.length - NMD_EXT.length)
  const segments = noExt.split('/').filter((segment) => segment.length > 0)
  const effective = segments.at(-1) === rootStem ? segments.slice(0, -1) : segments
  if (effective.length === 0) return rootStem
  return effective.map(titleSlug).join('/')
}

const humanizeStem = (stem: string): string =>
  stem
    .split(/[-_]/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

/** Resolve the parent relPath for a given file relPath under the directory model. */
export const parentRelPathFor = (opts: {
  readonly relPath: string
  readonly rootFile: string
}): string | undefined => {
  const dir = dirname(opts.relPath)
  const rootAt = (segments: string): string =>
    segments === '.' ? opts.rootFile : `${segments}/${opts.rootFile}`

  // the root-file at the tree root has no parent
  if (dir === '.' && isRootFile({ relPath: opts.relPath, rootFile: opts.rootFile }) === true) {
    return undefined
  }
  if (isRootFile({ relPath: opts.relPath, rootFile: opts.rootFile }) === true) {
    // a sub/<root-file>: parent is the root-file of the grandparent dir
    return rootAt(dirname(dir))
  }
  // a normal file: parent is the root-file of its own directory
  return rootAt(dir)
}

/** Recursively walk a directory for `.nmd` files (skips dotdirs). */
const walkNmdFiles = (
  dir: string,
): Effect.Effect<readonly string[], NmdFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'read_dir', path: dir, cause })))
    const found: string[] = []
    for (const entry of entries) {
      if (entry.startsWith('.') === true) continue
      const full = join(dir, entry)
      const info = yield* fs
        .stat(full)
        .pipe(Effect.mapError((cause) => makeFsError({ operation: 'stat', path: full, cause })))
      if (info.type === 'Directory') {
        found.push(...(yield* walkNmdFiles(full)))
      } else if (extname(full) === NMD_EXT) {
        found.push(full)
      }
    }
    return found
  })

/**
 * Detect the tree's root-file basename. Honors an explicit choice; otherwise
 * picks the first existing default candidate at the tree root, or a previously
 * recorded one. Fails loud if none is found.
 */
const detectRootFile = (opts: {
  readonly root: string
  readonly explicit: string | undefined
  readonly previous: TreeIndex | undefined
}): Effect.Effect<string, NmdError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = (name: string) =>
      fs
        .exists(join(opts.root, name))
        .pipe(Effect.mapError((cause) => makeFsError({ operation: 'exists', path: name, cause })))
    if (opts.explicit !== undefined) {
      if ((yield* exists(opts.explicit)) === false) {
        return yield* new NmdCliError({
          message: `Tree root ${opts.root} has no root file ${opts.explicit}`,
        })
      }
      return opts.explicit
    }
    if (opts.previous !== undefined && (yield* exists(opts.previous.root_file)) === true) {
      return opts.previous.root_file
    }
    for (const candidate of ROOT_FILE_CANDIDATES) {
      if ((yield* exists(candidate)) === true) return candidate
    }
    return yield* new NmdCliError({
      message: `Tree root ${opts.root} must contain a root file (${ROOT_FILE_CANDIDATES.join(' or ')}), or pass --root-file`,
    })
  })

/** Read + parse all local pages, sorted so parents precede children. */
const scanLocalPages = (opts: {
  readonly root: string
  readonly rootFile: string
}): Effect.Effect<readonly LocalTreePage[], NmdError, FileSystem.FileSystem | NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const files = yield* walkNmdFiles(opts.root)
    const rootStem = basename(opts.rootFile, NMD_EXT)
    const pages: LocalTreePage[] = []
    for (const path of files) {
      const relPath = toPosix(relative(opts.root, path))
      const content = yield* store.readNmdFile({ path })
      const parsed = yield* parseNmdFile({ path, content })
      const stem = basename(path, NMD_EXT)
      const dirStem = basename(dirname(relPath))
      const frontmatterTitle = parsed.frontmatter.notion_md.page.title
      const effectiveTitle =
        frontmatterTitle.length > 0
          ? frontmatterTitle
          : humanizeStem(
              stem === rootStem && dirStem !== '.' && relPath.includes('/') === true
                ? dirStem
                : stem,
            )
      pages.push({
        path,
        relPath,
        slug: slugForRelPath({ relPath, rootFile: opts.rootFile }),
        title: effectiveTitle,
        body: parsed.body,
        parentRelPath: parentRelPathFor({ relPath, rootFile: opts.rootFile }),
        boundPageId: parsed.frontmatter.notion_md.page_id,
        frontmatter: parsed.frontmatter,
      })
    }
    /*
     * Topological order so every page's parent precedes it: by depth ascending,
     * and within a depth the root-file first (it anchors its same-depth
     * siblings), then lexicographic for determinism.
     */
    return pages.slice().toSorted((a, b) => {
      const depthDelta = a.relPath.split('/').length - b.relPath.split('/').length
      if (depthDelta !== 0) return depthDelta
      const aRoot = isRootFile({ relPath: a.relPath, rootFile: opts.rootFile }) === true ? 0 : 1
      const bRoot = isRootFile({ relPath: b.relPath, rootFile: opts.rootFile }) === true ? 0 : 1
      if (aRoot !== bRoot) return aRoot - bRoot
      return a.relPath.localeCompare(b.relPath)
    })
  })

const readTreeIndexOptional = (
  root: string,
): Effect.Effect<TreeIndex | undefined, NmdError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = treeIndexPath(root)
    const exists = yield* fs
      .exists(path)
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'exists', path, cause })))
    if (exists === false) return undefined
    const content = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'read', path, cause })))
    return yield* decodeTreeIndexJson(content).pipe(
      Effect.mapError(
        (cause) => new NmdCliError({ message: `Invalid tree index ${path}: ${String(cause)}` }),
      ),
    )
  })

const writeTreeIndex = (opts: {
  readonly root: string
  readonly index: TreeIndex
}): Effect.Effect<void, NmdFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = treeIndexPath(opts.root)
    yield* fs
      .makeDirectory(dirname(path), { recursive: true })
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'mkdir', path, cause })))
    yield* fs
      .writeFileString(path, `${encodeTreeIndexJson(opts.index).trimEnd()}\n`)
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'write', path, cause })))
  })

/**
 * Compose the body to PUSH for a page: resolved cross-refs + DERIVED child
 * index. Re-emits one `<page url>` anchor per ordered child (blank-line
 * separated) so the guarded push preserves (rather than trashes) the children.
 */
export const composePushBody = (opts: {
  readonly resolvedBody: string
  readonly children: readonly { readonly title: string; readonly pageId: string }[]
}): string => {
  const trimmed = opts.resolvedBody.replace(/\n+$/u, '')
  if (opts.children.length === 0) return normalizeMarkdownLineEndings(`${trimmed}\n`)
  const anchors = opts.children
    .map((child) => `<page url="${pageUrl(child.pageId)}">${child.title}</page>`)
    .join('\n\n')
  return normalizeMarkdownLineEndings(`${trimmed}\n\n${anchors}\n`)
}

/** Re-render a file with the real `page_id`/`url` bound in (keeps body + title). */
const bindFrontmatter = (opts: {
  readonly frontmatter: NmdFrontmatterV2
  readonly title: string
  readonly pageId: string
  readonly url: string | undefined
  readonly body: string
}): string =>
  renderNmdFile({
    frontmatter: {
      notion_md: {
        ...opts.frontmatter.notion_md,
        page_id: opts.pageId,
        ...(opts.url === undefined ? {} : { url: opts.url }),
        page: { ...opts.frontmatter.notion_md.page, title: opts.title },
      },
    },
    body: opts.body,
  })

/**
 * Establish an initial sidecar baseline for a page whose remote body equals
 * `baselineBody`. Used right after `createPage` (the stub) and when first
 * materializing a remote page, so the guarded push in pass 2 has a base
 * snapshot to 3-way merge against.
 */
const establishBaseline = (opts: {
  /** Tree root where the shared `.notion-md/` state lives. */
  readonly statePath: string
  readonly page: RemotePageSnapshot
  readonly baselineBody: string
}): Effect.Effect<void, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
    const normalized = normalizeMarkdownLineEndings(opts.baselineBody)
    const base = yield* writeBaseSnapshot({
      path: opts.statePath,
      pageId: opts.page.id,
      body: normalized,
    })
    yield* writeSyncState({
      path: opts.statePath,
      syncState: {
        version: 1,
        page_id: opts.page.id,
        body: {
          format: 'notion-enhanced-markdown',
          hash: sha256Digest(normalized),
          base,
          last_pulled_at: new Date().toISOString(),
          remote_last_edited_time: opts.page.last_edited_time,
          truncated: false,
          unknown_block_ids: [],
        },
        storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
        read_only_properties: {},
        data_source: null,
      },
    })
  })

const filePathFor = (opts: { readonly root: string; readonly relPath: string }): string =>
  resolve(opts.root, opts.relPath)

/** Build the slug→relPath map (fails on a duplicate slug). */
const buildSlugMap = (
  pages: readonly LocalTreePage[],
): Effect.Effect<ReadonlyMap<string, string>, NmdError> =>
  Effect.gen(function* () {
    const slugMap = new Map<string, string>()
    for (const page of pages) {
      if (slugMap.has(page.slug) === true) {
        return yield* new NmdCliError({
          message: `Duplicate page slug "${page.slug}" (${slugMap.get(page.slug)} and ${page.relPath})`,
        })
      }
      slugMap.set(page.slug, page.relPath)
    }
    return slugMap
  })

/** ordered children per parent relPath, from the resolved id map. */
const childrenByParent = (opts: {
  readonly pages: readonly LocalTreePage[]
  readonly idForRelPath: ReadonlyMap<string, string>
}): Map<string, { readonly title: string; readonly pageId: string }[]> => {
  const childrenOf = new Map<string, { readonly title: string; readonly pageId: string }[]>()
  for (const page of opts.pages) {
    const parentRel = page.parentRelPath
    if (parentRel === undefined) continue
    const id = opts.idForRelPath.get(page.relPath)
    if (id === undefined) continue
    const list = childrenOf.get(parentRel) ?? []
    list.push({ title: page.title, pageId: id })
    childrenOf.set(parentRel, list)
  }
  return childrenOf
}

/**
 * Reconcile a local directory tree against a Notion subtree (local-authoritative).
 *
 * `plan` true → dry-run diff, nothing applied. Otherwise:
 *  (1) create unbound pages (parent-before-child); each create writes its id
 *      back to the file AND establishes an initial sidecar immediately (a crash
 *      mid-run never leaves a created page unbound → no duplicate on re-run);
 *  (2) for every node, compose the body (cross-refs + derived child anchors)
 *      and route it through the ONE guarded engine (`pushGuarded`) — full merge,
 *      conflict, storage, unknown-block, review-markup, TOCTOU. Then guarded-trash
 *      index pages with no local file.
 */
const syncTreeLocal = (opts: {
  readonly root: string
  readonly rootFile: string
  readonly rootPageId: string
  readonly pages: readonly LocalTreePage[]
  readonly previous: TreeIndex | undefined
  readonly plan: boolean
  readonly pushOptions: PushOptions
}): Effect.Effect<
  readonly TreeOp[],
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const store = yield* NmdStateStore
    const { root, rootFile, rootPageId, pages, previous, plan } = opts
    const stateAnchor = treeStateAnchor(root)
    const rootRel = rootFile
    const rootPage = pages.find((page) => page.relPath === rootRel)
    if (rootPage === undefined) {
      return yield* new NmdCliError({
        message: `Tree root ${root} must contain ${rootRel} (the root page)`,
      })
    }

    const slugMap = yield* buildSlugMap(pages)
    const relPaths = new Set(pages.map((page) => page.relPath))

    /*
     * Fail CLOSED on a dangling cross-ref BEFORE any remote mutation — dangling
     * is a property of the local target set, independent of assigned ids.
     */
    for (const page of pages) {
      yield* validateCrossRefTargets({ body: page.body, relPath: page.relPath, slugMap, relPaths })
    }

    const idForRelPath = new Map<string, string>([[rootRel, rootPageId]])
    for (const page of pages) {
      if (page.boundPageId !== null) idForRelPath.set(page.relPath, page.boundPageId)
    }

    const ops: TreeOp[] = []
    const createdRelPaths = new Set<string>()

    /*
     * Persist the root binding + tree index BEFORE creating any child, so a
     * crash mid-create is recoverable: the root id is the entry point for the
     * next run. Without this, an interrupt before the (previously end-of-run)
     * index write would orphan every created child (no known root).
     */
    if (plan === false) {
      if (rootPage.boundPageId === null) {
        yield* store.writeNmdFile({
          path: rootPage.path,
          content: bindFrontmatter({
            frontmatter: rootPage.frontmatter,
            title: rootPage.title,
            pageId: rootPageId,
            url: undefined,
            body: rootPage.body,
          }),
        })
      }
      yield* writeTreeIndex({
        root,
        index: { version: 1, root_page_id: rootPageId, root_file: rootFile, pages: {} },
      })
    }

    // PASS 1 — create unbound pages; move bound pages whose Notion parent differs.
    for (const page of pages) {
      const parentRel = page.parentRelPath ?? rootRel
      const parentId = idForRelPath.get(parentRel)
      if (parentId === undefined) {
        if (plan === true && relPaths.has(parentRel) === true) {
          ops.push({ _tag: 'create', relPath: page.relPath, title: page.title })
          continue
        }
        return yield* new NmdCliError({
          message: `Cannot place ${page.relPath}: parent ${parentRel} has no page id (out-of-order tree)`,
        })
      }
      const existingId = idForRelPath.get(page.relPath)
      if (existingId !== undefined) {
        if (page.relPath !== rootRel && page.boundPageId !== null && plan === false) {
          const remote = yield* gateway.pullPage({ pageId: existingId })
          const remoteParent =
            remote.page.parent.type === 'page_id' ? remote.page.parent.page_id : undefined
          if (remoteParent !== undefined && remoteParent !== parentId) {
            yield* gateway.movePage({ pageId: existingId, parentPageId: parentId })
            ops.push({ _tag: 'move', relPath: page.relPath, pageId: existingId })
          }
        }
        continue
      }
      if (plan === true) {
        ops.push({ _tag: 'create', relPath: page.relPath, title: page.title })
        continue
      }
      const created = yield* gateway.createPage({
        parentPageId: parentId,
        title: page.title,
        markdown: `# ${page.title}\n`,
      })
      idForRelPath.set(page.relPath, created.id)
      createdRelPaths.add(page.relPath)
      /*
       * Write the real id back + establish the initial sidecar IMMEDIATELY, so
       * a crash before pass 2 leaves the file bound (re-run finds it bound, no
       * duplicate create). Baseline = the stub markdown we just created.
       */
      yield* store.writeNmdFile({
        path: page.path,
        content: bindFrontmatter({
          frontmatter: page.frontmatter,
          title: page.title,
          pageId: created.id,
          url: created.url,
          body: page.body,
        }),
      })
      yield* establishBaseline({
        statePath: stateAnchor,
        page: created,
        baselineBody: `# ${page.title}\n`,
      })
      ops.push({ _tag: 'create', relPath: page.relPath, title: page.title })
    }

    if (plan === true) {
      yield* classifyPlan({ root, pages, idForRelPath, slugMap, ops })
      const liveIds = new Set(idForRelPath.values())
      for (const [relPath, pageId] of Object.entries(previous?.pages ?? {})) {
        if (liveIds.has(pageId) === false) ops.push({ _tag: 'trash', relPath, pageId })
      }
      return ops
    }

    /*
     * Establish the root baseline if absent (the root file was already bound
     * early, above). Pass 2's self-heal would also do this, but doing it here
     * keeps the root's first push on the clean local-changed path.
     */
    const rootHasBaseline =
      (yield* readSyncStateOptional({ path: stateAnchor, pageId: rootPageId })) !== undefined
    if (rootHasBaseline === false) {
      const rootRemote = yield* gateway.pullPage({ pageId: rootPageId })
      yield* establishBaseline({
        statePath: stateAnchor,
        page: rootRemote.page,
        baselineBody: rootRemote.markdown.markdown,
      })
    }

    const childrenOf = childrenByParent({ pages, idForRelPath })

    // PASS 2 — compose each node's body and push it through the GUARDED engine.
    for (const page of pages) {
      const pageId = idForRelPath.get(page.relPath)
      if (pageId === undefined) continue
      const resolvedBody = yield* resolveCrossRefs({
        body: page.body,
        relPath: page.relPath,
        slugMap,
        idMap: idForRelPath,
      })
      const composedBody = composePushBody({
        resolvedBody,
        children: childrenOf.get(page.relPath) ?? [],
      })
      const path = filePathFor({ root, relPath: page.relPath })
      const remoteForStatus = yield* gateway.pullPage({ pageId })
      /*
       * Self-heal a missing baseline (fresh clone without `.notion-md/`, or a
       * root bound only in the file): establish it from the live remote body
       * so the guarded merge has a base. Keyed by page id at the tree root.
       */
      let syncState = yield* readSyncStateOptional({ path: stateAnchor, pageId })
      if (syncState === undefined) {
        yield* establishBaseline({
          statePath: stateAnchor,
          page: remoteForStatus.page,
          baselineBody: remoteForStatus.markdown.markdown,
        })
        syncState = yield* readSyncStateOptional({ path: stateAnchor, pageId })
        if (syncState === undefined) {
          return yield* new NmdCliError({
            message: `Failed to establish baseline for ${page.relPath} (page ${pageId})`,
          })
        }
      }
      /*
       * The node's bound frontmatter (real id/url + local title). The file may
       * already carry this from a pass-1 writeback, but the original scanned
       * frontmatter is unbound — so persist must write the BOUND one or it would
       * clobber the just-bound id back to null.
       */
      const boundFrontmatter: NmdFrontmatterV2 = {
        notion_md: {
          ...page.frontmatter.notion_md,
          page_id: pageId,
          ...(remoteForStatus.page.url === undefined ? {} : { url: remoteForStatus.page.url }),
          page: { ...page.frontmatter.notion_md.page, title: page.title },
        },
      }
      const local = buildTreeNodeLocalState({
        path,
        statePath: stateAnchor,
        pageId,
        frontmatter: boundFrontmatter,
        bareBody: page.body,
        composedBody,
        syncState,
      })
      /*
       * Route the composed body through the ONE guarded engine. A remote-edit
       * conflict writes `.conflict.roughdraft.md` and surfaces here as
       * `NmdConflictError`; we record a `conflict` op and continue reconciling
       * the rest of the tree rather than clobbering or aborting the whole run.
       */
      const pushed = yield* pushGuarded({
        local,
        remoteForStatus,
        /*
         * Tree nodes push via `replace_content`: a parent's body is volatile
         * (Notion auto-appends a `<page>` anchor on each child create), so a
         * search-replace would miss; the full body — bare + derived anchors —
         * is always re-emitted, so a full replace is the safe operation.
         */
        options: { ...opts.pushOptions, path, replaceContent: true },
        persist: treeNodePersist({
          path,
          statePath: stateAnchor,
          frontmatter: boundFrontmatter,
          bareBody: page.body,
          expectedFileBodyHash: sha256Digest(page.body),
        }),
      }).pipe(
        Effect.map((result) => ({ ok: true as const, result })),
        Effect.catchTag('NmdConflictError', (error) =>
          Effect.as(
            Effect.logWarning(`notion-md tree conflict on ${page.relPath}: ${error.message}`),
            { ok: false as const },
          ),
        ),
      )
      if (pushed.ok === false) {
        ops.push({ _tag: 'conflict', relPath: page.relPath, pageId })
      } else if (createdRelPaths.has(page.relPath) === true) {
        // create already recorded in pass 1
      } else if (pushed.result.pushed === true) {
        ops.push({ _tag: 'update', relPath: page.relPath, pageId })
      } else {
        ops.push({ _tag: 'noop', relPath: page.relPath, pageId })
      }
    }

    // RECONCILE — guarded-trash index pages whose id no longer maps to a file.
    const liveIds = new Set(
      pages
        .map((page) => idForRelPath.get(page.relPath))
        .filter((id): id is string => id !== undefined),
    )
    for (const [relPath, pageId] of Object.entries(previous?.pages ?? {})) {
      if (liveIds.has(pageId) === true) continue
      const remote = yield* gateway.pullPage({ pageId })
      if (remote.page.in_trash === false) {
        yield* gateway.archivePage({ pageId })
      }
      ops.push({ _tag: 'trash', relPath, pageId })
    }

    // regenerate the path→id index (pure derived hint; never the identity).
    const indexPages: Record<string, string> = {}
    for (const page of pages) {
      if (page.relPath === rootRel) continue
      const id = idForRelPath.get(page.relPath)
      if (id !== undefined) indexPages[page.relPath] = id
    }
    yield* writeTreeIndex({
      root,
      index: { version: 1, root_page_id: rootPageId, root_file: rootFile, pages: indexPages },
    })

    return ops
  })

/**
 * Classify create/update/noop for a dry-run plan. Unbound pages are already
 * recorded as create in pass 1; a bound page is `update` unless its composed
 * body matches the recorded baseline (the noop oracle).
 */
const classifyPlan = (opts: {
  readonly root: string
  readonly pages: readonly LocalTreePage[]
  readonly idForRelPath: ReadonlyMap<string, string>
  readonly slugMap: ReadonlyMap<string, string>
  readonly ops: TreeOp[]
}): Effect.Effect<void, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
    const childrenOf = childrenByParent({ pages: opts.pages, idForRelPath: opts.idForRelPath })
    for (const page of opts.pages) {
      const pageId = opts.idForRelPath.get(page.relPath)
      if (pageId === undefined) continue
      if (opts.ops.some((op) => op.relPath === page.relPath && op._tag === 'move') === true)
        continue
      const resolved = yield* resolveCrossRefs({
        body: page.body,
        relPath: page.relPath,
        slugMap: opts.slugMap,
        idMap: opts.idForRelPath,
      }).pipe(Effect.orElseSucceed(() => page.body))
      const composed = composePushBody({
        resolvedBody: resolved,
        children: childrenOf.get(page.relPath) ?? [],
      })
      const prevState = yield* readSyncStateOptional({ path: opts.root, pageId })
      if (prevState !== undefined && prevState.body.hash === sha256Digest(composed)) {
        opts.ops.push({ _tag: 'noop', relPath: page.relPath, pageId })
      } else {
        opts.ops.push({ _tag: 'update', relPath: page.relPath, pageId })
      }
    }
  })

/** A remote page discovered while walking a Notion subtree top-down. */
interface RemoteTreeNode {
  readonly pageId: string
  readonly title: string
  /** posix relPath in the materialized layout (`<dir>/<root-file>` for anchors). */
  readonly relPath: string
  readonly parentPageId: string | undefined
}

/** Walk the remote Notion subtree under `rootPageId` into materialize relPaths. */
const buildRemoteTree = (opts: {
  readonly rootPageId: string
  readonly rootFile: string
}): Effect.Effect<readonly RemoteTreeNode[], NmdError, NotionMdGateway> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const root = yield* gateway.pullPage({ pageId: opts.rootPageId })
    const nodes: RemoteTreeNode[] = [
      {
        pageId: opts.rootPageId,
        title: root.page.title,
        relPath: opts.rootFile,
        parentPageId: undefined,
      },
    ]
    const usedDirs = new Set<string>()
    const visit = (visitOpts: {
      readonly pageId: string
      readonly parentDir: string
    }): Effect.Effect<void, NmdError, NotionMdGateway> =>
      Effect.gen(function* () {
        const children = yield* gateway.listChildPages({ pageId: visitOpts.pageId })
        for (const child of children) {
          const slug = titleSlug(child.title)
          // Each child becomes `<dir>/<slug>.nmd`; if it has its own children we
          // anchor it as `<dir>/<slug>/<root-file>` so the subtree nests.
          const grandchildren = yield* gateway.listChildPages({ pageId: child.pageId })
          const baseDir = visitOpts.parentDir === '' ? '' : `${visitOpts.parentDir}/`
          if (grandchildren.length > 0) {
            const subDir = `${baseDir}${slug}`
            usedDirs.add(subDir)
            nodes.push({
              pageId: child.pageId,
              title: child.title,
              relPath: `${subDir}/${opts.rootFile}`,
              parentPageId: visitOpts.pageId,
            })
            yield* visit({ pageId: child.pageId, parentDir: subDir })
          } else {
            nodes.push({
              pageId: child.pageId,
              title: child.title,
              relPath: `${baseDir}${slug}.nmd`,
              parentPageId: visitOpts.pageId,
            })
          }
        }
      })
    yield* visit({ pageId: opts.rootPageId, parentDir: '' })
    return nodes
  })

/**
 * Pull/mirror direction within the ONE tree engine: walk the remote subtree and
 * materialize/reconcile each page into the SAME `<root-file>` / `<dir>/<root-file>`
 * layout and the SAME index file the forward path uses, so pull→edit→push
 * round-trips. Missing files are materialized; existing ones are reconciled via
 * the single-page guarded `statusPage`/`pullPage` (remote-authoritative pull).
 */
const syncTreeFromRemote = (opts: {
  readonly root: string
  readonly rootFile: string
  readonly rootPageId: string
  readonly plan: boolean
}): Effect.Effect<
  readonly TreeOp[],
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { root, rootFile, rootPageId, plan } = opts
    yield* fs
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'mkdir', path: root, cause })))

    const remoteNodes = yield* buildRemoteTree({ rootPageId, rootFile })
    const ops: TreeOp[] = []
    const indexPages: Record<string, string> = {}

    for (const node of remoteNodes) {
      const path = filePathFor({ root, relPath: node.relPath })
      if (node.relPath !== rootFile) indexPages[node.relPath] = node.pageId
      const exists = yield* fs
        .exists(path)
        .pipe(Effect.mapError((cause) => makeFsError({ operation: 'exists', path, cause })))
      if (plan === true) {
        ops.push(
          exists === true
            ? { _tag: 'update', relPath: node.relPath, pageId: node.pageId }
            : { _tag: 'materialize', relPath: node.relPath, pageId: node.pageId },
        )
        continue
      }
      yield* fs
        .makeDirectory(dirname(path), { recursive: true })
        .pipe(Effect.mapError((cause) => makeFsError({ operation: 'mkdir', path, cause })))
      if (exists === true) {
        const status = yield* statusPage({ path })
        if (status.remoteChanged === true) {
          yield* pullPage({ pageId: node.pageId, outPath: path })
          ops.push({ _tag: 'update', relPath: node.relPath, pageId: node.pageId })
        } else {
          ops.push({ _tag: 'noop', relPath: node.relPath, pageId: node.pageId })
        }
      } else {
        yield* pullPage({ pageId: node.pageId, outPath: path })
        ops.push({ _tag: 'materialize', relPath: node.relPath, pageId: node.pageId })
      }
    }

    if (plan === false) {
      yield* writeTreeIndex({
        root,
        index: { version: 1, root_page_id: rootPageId, root_file: rootFile, pages: indexPages },
      })
    }
    return ops
  })

/**
 * Reconcile a directory tree against a Notion subtree. Forward (local-as-desired)
 * by default; `fromRemote` mirrors Notion into the same layout/index. Both
 * directions are this one engine — there is no separate workspace materializer.
 */
export const syncTree = (opts: {
  readonly root: string
  readonly rootPageId?: string
  readonly rootFile?: string
  readonly plan?: boolean
  readonly fromRemote?: boolean
  readonly pushOptions?: PushOptions
}): Effect.Effect<
  TreeSyncResult,
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const root = resolve(opts.root)
    const plan = opts.plan === true
    const fromRemote = opts.fromRemote === true
    const previous = yield* readTreeIndexOptional(root)

    if (fromRemote === true) {
      const rootFile = opts.rootFile ?? previous?.root_file ?? ROOT_FILE_CANDIDATES[0]
      const rootPageId = opts.rootPageId ?? previous?.root_page_id
      if (rootPageId === undefined) {
        return yield* new NmdCliError({
          message: `--from-remote needs a Notion root page id; pass --root on first mirror`,
        })
      }
      const ops = yield* syncTreeFromRemote({ root, rootFile, rootPageId, plan })
      return {
        _tag: 'tree',
        root,
        rootPageId,
        rootFile,
        direction: 'from-remote',
        plan,
        ops,
      } as const
    }

    const rootFile = yield* detectRootFile({ root, explicit: opts.rootFile, previous })
    const pages = yield* scanLocalPages({ root, rootFile })
    const rootPage = pages.find((page) => page.relPath === rootFile)
    const rootPageId =
      opts.rootPageId ?? rootPage?.boundPageId ?? previous?.root_page_id ?? undefined
    if (rootPageId === undefined) {
      return yield* new NmdCliError({
        message: `No Notion root configured for tree ${root}; bind ${rootFile} or pass --root on first sync`,
      })
    }
    const ops = yield* syncTreeLocal({
      root,
      rootFile,
      rootPageId,
      pages,
      previous,
      plan,
      pushOptions: opts.pushOptions ?? { path: root },
    })
    return { _tag: 'tree', root, rootPageId, rootFile, direction: 'local', plan, ops } as const
  }).pipe(
    Effect.withSpan('notion-md.sync-tree', {
      attributes: {
        'span.label': basename(opts.root),
        'notion_md.tree.plan': opts.plan === true,
        'notion_md.tree.from_remote': opts.fromRemote === true,
      },
    }),
  )
