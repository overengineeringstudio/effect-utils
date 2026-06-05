import { basename, dirname, extname, join, relative, resolve } from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { compactNotionUuid, type NmdFrontmatterV2 } from '@overeng/notion-effect-client'
import { titleSlug } from '@overeng/utils'

import { NmdCliError, NmdFileSystemError, type NmdError } from './errors.ts'
import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { sha256Digest } from './hash.ts'
import { NotionMdGateway, type RemotePageSnapshot } from './model.ts'
import {
  NmdStateStore,
  readSyncStateOptional,
  writeBaseSnapshot,
  writeSyncState,
} from './state-store.ts'

/**
 * Unified directory-tree ↔ Notion-subtree reconcile.
 *
 * The local directory tree is the source of truth for hierarchy: each `.nmd`
 * file is a page, directory nesting is page nesting. Binding/identity lives IN
 * the file (frontmatter `page_id`); an unbound file (`page_id: null`) is a
 * to-be-created page. This folds the proven #745 subtree mechanism into the
 * existing engine's primitives — canonical `parseNmdFile`/`renderNmdFile`, the
 * `NmdStateStore` sidecar baseline, the gateway's create/move/archive verbs —
 * rather than a parallel `subtree.json` subsystem.
 *
 * Load-bearing invariants (verified against Notion in #745, kept verbatim):
 *  - the noop/diff oracle is the hash of the last PUSHED body (recorded in the
 *    sidecar sync state), NOT a re-pull — Notion's markdown GET merges
 *    blockquote-adjacent blocks, so a re-pull is a lying oracle;
 *  - the parent's child index is DERIVED and re-emitted on every parent push
 *    (creating a child auto-appends a `<page>` anchor; `replace_content`
 *    trashes any child whose anchor is absent — the full anchor set must
 *    always be re-emitted);
 *  - child `<page>` anchors must be blank-line-separated (consecutive ones
 *    merge and trash siblings);
 *  - inline cross-refs must be markdown links `[label](url)` (inline `<page>`
 *    corrupts on Notion's endpoint); only block-level `<page>` (own line) is a
 *    valid child anchor;
 *  - a renamed/moved file keeps its page id (rebind / move), never trash+recreate.
 *
 * Hierarchy convention:
 *  - `<root>/index.nmd` is the root page (its parent is read from Notion, not
 *    reconciled — like single-page sync, the parent edge stays remote).
 *  - any other `<dir>/<name>.nmd` is a child of the page anchoring `<dir>`.
 *  - a subdirectory `<dir>/<sub>/` is anchored by `<dir>/<sub>/index.nmd`.
 */

const ROOT_SLUG = 'index'
const NMD_EXT = '.nmd'

/** Regenerable path↔id index for a synced tree (not the source of identity). */
const TreeIndex = Schema.Struct({
  version: Schema.Literal(1),
  root_page_id: Schema.String,
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
 * Canonical Notion page URL form proven to round-trip through the enhanced
 * Markdown endpoint both as an INLINE link `[label](url)` and as a block-level
 * `<page url>` anchor. Only the `app.notion.com/p/<dashless-id>` form is
 * verified to resolve to a live page link rather than dead `(#)` text.
 */
export const pageUrl = (pageId: string): string =>
  `https://app.notion.com/p/${compactNotionUuid(pageId)}`

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
  /** Parsed frontmatter, re-rendered (with the real id) on create. */
  readonly frontmatter: NmdFrontmatterV2
}

/** Tagged reconcile operation for one tree pass. */
export type TreeOp =
  | { readonly _tag: 'create'; readonly relPath: string; readonly title: string }
  | { readonly _tag: 'update'; readonly relPath: string; readonly pageId: string }
  | { readonly _tag: 'move'; readonly relPath: string; readonly pageId: string }
  | { readonly _tag: 'noop'; readonly relPath: string; readonly pageId: string }
  | { readonly _tag: 'trash'; readonly relPath: string; readonly pageId: string }

/** Result envelope for a tree sync (or plan) pass. */
export interface TreeSyncResult {
  readonly _tag: 'tree'
  readonly root: string
  readonly rootPageId: string
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

/** Slug for a relative path: directory segments + filename stem, joined by `/`. */
export const slugForRelPath = (relPath: string): string => {
  const noExt = relPath.slice(0, relPath.length - NMD_EXT.length)
  const segments = noExt.split('/').filter((segment) => segment.length > 0)
  // index files identify their containing directory
  const effective = segments.at(-1) === ROOT_SLUG ? segments.slice(0, -1) : segments
  if (effective.length === 0) return ROOT_SLUG
  return effective.map(titleSlug).join('/')
}

const humanizeStem = (stem: string): string =>
  stem
    .split(/[-_]/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

/** Resolve the parent relPath for a given file relPath under the directory model. */
export const parentRelPathFor = (relPath: string): string | undefined => {
  const stem = basename(relPath, NMD_EXT)
  const dir = dirname(relPath)

  // root index has no parent
  if (dir === '.' && stem === ROOT_SLUG) return undefined

  if (stem === ROOT_SLUG) {
    // a sub/index.nmd: parent is the index of the grandparent dir
    const parentDir = dirname(dir)
    return parentDir === '.' ? `${ROOT_SLUG}${NMD_EXT}` : `${parentDir}/${ROOT_SLUG}${NMD_EXT}`
  }

  // a normal file: parent is the index of its own directory
  return dir === '.' ? `${ROOT_SLUG}${NMD_EXT}` : `${dir}/${ROOT_SLUG}${NMD_EXT}`
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

/** Read + parse all local pages, sorted so parents precede children. */
const scanLocalPages = (opts: {
  readonly root: string
}): Effect.Effect<readonly LocalTreePage[], NmdError, FileSystem.FileSystem | NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const files = yield* walkNmdFiles(opts.root)
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
              stem === ROOT_SLUG && dirStem !== '.' && relPath.includes('/') === true
                ? dirStem
                : stem,
            )
      pages.push({
        path,
        relPath,
        slug: slugForRelPath(relPath),
        title: effectiveTitle,
        body: parsed.body,
        parentRelPath: parentRelPathFor(relPath),
        boundPageId: parsed.frontmatter.notion_md.page_id,
        frontmatter: parsed.frontmatter,
      })
    }
    /*
     * Topological order so every page's parent precedes it:
     *  - by depth (segments) ascending — a `<dir>/index.nmd` parent of
     *    `<parentdir>/index.nmd` is shallower;
     *  - within the same depth, `index.nmd` first — `<dir>/index.nmd` is the
     *    parent of its same-depth siblings `<dir>/<file>.nmd`, so it must come
     *    before them (a plain depth sort leaves siblings unordered and a child
     *    could precede its anchor).
     */
    return pages.slice().toSorted((a, b) => {
      const depthDelta = a.relPath.split('/').length - b.relPath.split('/').length
      if (depthDelta !== 0) return depthDelta
      const aIndex = basename(a.relPath, NMD_EXT) === ROOT_SLUG ? 0 : 1
      const bIndex = basename(b.relPath, NMD_EXT) === ROOT_SLUG ? 0 : 1
      if (aIndex !== bIndex) return aIndex - bIndex
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
 * Resolve `[[slug]]` and `[text](./rel.nmd)` cross-refs to inline Notion page
 * links. Hard-fails on any ref that does not resolve to a known local page
 * with an assigned id. Returns the rewritten body.
 *
 * Factored as a standalone step so it can be lifted into the shared sync spine
 * (the prototype of effect-utils #744's resolver) without dragging the tree
 * engine along.
 */
/**
 * Validate that every `[[slug]]` / `[..](./rel.nmd)` cross-ref in a page
 * resolves to a known local target. This is the side-effect-free half of
 * `resolveCrossRefs` (no id needed), run up front so a dangling ref fails the
 * whole sync before any remote create/move/trash.
 */
const validateCrossRefTargets = (opts: {
  readonly page: LocalTreePage
  readonly slugToRelPath: ReadonlyMap<string, string>
  readonly localRelPaths: ReadonlySet<string>
}): Effect.Effect<void, NmdError> =>
  Effect.gen(function* () {
    const body = opts.page.body
    for (const match of body.matchAll(/\[\[([^\]]+)\]\]/gu)) {
      const raw = match[1] ?? ''
      const slug = (raw.includes('|') === true ? (raw.split('|', 2)[0] ?? raw) : raw).trim()
      if (opts.slugToRelPath.has(slug) === false) {
        return yield* new NmdCliError({
          message: `Dangling cross-ref [[${raw}]] in ${opts.page.relPath}: no page with slug "${slug}"`,
        })
      }
    }
    const pageDir = dirname(opts.page.relPath)
    for (const match of body.matchAll(/\[([^\]]*)\]\((\.{0,2}\/?[^)\s]+\.nmd)\)/gu)) {
      const href = match[2] ?? ''
      const normalizedRel = toPosix(join(pageDir === '.' ? '' : pageDir, href))
      if (opts.localRelPaths.has(normalizedRel) === false) {
        return yield* new NmdCliError({
          message: `Dangling cross-ref [${match[1] ?? ''}](${href}) in ${opts.page.relPath}: no local page at "${normalizedRel}"`,
        })
      }
    }
  })

export const resolveCrossRefs = (opts: {
  readonly page: LocalTreePage
  readonly slugToRelPath: ReadonlyMap<string, string>
  readonly idForRelPath: ReadonlyMap<string, string>
}): Effect.Effect<string, NmdError> =>
  Effect.gen(function* () {
    const urlFor = (relPath: string): string | undefined => {
      const id = opts.idForRelPath.get(relPath)
      return id === undefined ? undefined : pageUrl(id)
    }

    let body = opts.page.body

    // [[slug]] or [[slug|label]] → [label](url)
    const wikiRefs = [...body.matchAll(/\[\[([^\]]+)\]\]/gu)]
    for (const match of wikiRefs) {
      const raw = match[1] ?? ''
      const [slug, label] = raw.includes('|') === true ? raw.split('|', 2) : [raw, raw]
      const targetRel = opts.slugToRelPath.get((slug ?? '').trim())
      if (targetRel === undefined) {
        return yield* new NmdCliError({
          message: `Dangling cross-ref [[${raw}]] in ${opts.page.relPath}: no page with slug "${(slug ?? '').trim()}"`,
        })
      }
      const url = urlFor(targetRel)
      if (url === undefined) {
        return yield* new NmdCliError({
          message: `Cross-ref [[${raw}]] in ${opts.page.relPath} targets ${targetRel} which has no page id yet`,
        })
      }
      body = body.replace(match[0], `[${(label ?? slug ?? '').trim()}](${url})`)
    }

    // [text](./rel.nmd) or [text](rel.nmd) → [text](url), resolved relative to
    // the page's own directory then matched against tree relPaths.
    const pageDir = dirname(opts.page.relPath)
    const linkRefs = [...body.matchAll(/\[([^\]]*)\]\((\.{0,2}\/?[^)\s]+\.nmd)\)/gu)]
    for (const match of linkRefs) {
      const text = match[1] ?? ''
      const href = match[2] ?? ''
      const normalizedRel = toPosix(join(pageDir === '.' ? '' : pageDir, href))
      const url = urlFor(normalizedRel)
      if (url === undefined) {
        return yield* new NmdCliError({
          message: `Dangling cross-ref [${text}](${href}) in ${opts.page.relPath}: no local page at "${normalizedRel}"`,
        })
      }
      body = body.replace(match[0], `[${text}](${url})`)
    }

    return body
  })

/**
 * Compose the body to PUSH for a page: resolved cross-refs + DERIVED child
 * index. Re-emits one `<page url>` anchor per ordered child so
 * `replace_content` preserves (rather than trashes) the real child pages.
 */
export const composePushBody = (opts: {
  readonly resolvedBody: string
  readonly children: readonly { readonly title: string; readonly pageId: string }[]
}): string => {
  const trimmed = opts.resolvedBody.replace(/\n+$/u, '')
  if (opts.children.length === 0) return `${trimmed}\n`
  /*
   * Block-level `<page url>` anchors MUST be blank-line-separated. Without the
   * blank line between them, Notion's enhanced-markdown parser treats the run
   * of anchors as lazy continuation of a single block and only the first
   * anchor is recognized as a child-page reference — the remaining children
   * are then trashed by `replace_content`'s child-deletion guard.
   */
  const anchors = opts.children
    .map((child) => `<page url="${pageUrl(child.pageId)}">${child.title}</page>`)
    .join('\n\n')
  return `${trimmed}\n\n${anchors}\n`
}

/** Normalize a body for stable hashing across canonicalization round-trips. */
const normalizeForHash = (value: string): string =>
  value
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()

/** Hash of the last-pushed composed body, used as the noop oracle (never re-pulled). */
const pushBodyHash = (pushBody: string): string => sha256Digest(normalizeForHash(pushBody))

/**
 * Record the pushed-body baseline for a tree page in the canonical sidecar:
 *  - base snapshot = the composed push body (content-addressed object);
 *  - sidecar `body.hash` = hash of that body — the noop oracle for next pass.
 * Both are keyed by the immutable page id, so a renamed file keeps its baseline.
 */
const writeTreePushState = (opts: {
  readonly path: string
  readonly page: RemotePageSnapshot
  readonly pushBody: string
}): Effect.Effect<void, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
    const normalized = normalizeForHash(opts.pushBody)
    const base = yield* writeBaseSnapshot({
      path: opts.path,
      pageId: opts.page.id,
      body: normalized,
    })
    yield* writeSyncState({
      path: opts.path,
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

/** Re-render a freshly-created file with the real `page_id`/`url` bound in. */
const bindFrontmatter = (opts: {
  readonly page: LocalTreePage
  readonly pageId: string
  readonly url: string | undefined
}): string =>
  renderNmdFile({
    frontmatter: {
      notion_md: {
        ...opts.page.frontmatter.notion_md,
        page_id: opts.pageId,
        ...(opts.url === undefined ? {} : { url: opts.url }),
        page: { ...opts.page.frontmatter.notion_md.page, title: opts.page.title },
      },
    },
    body: opts.page.body,
  })

/**
 * Reconcile a local directory tree against a Notion subtree.
 *
 * When `plan` is true, computes the create/update/move/trash/noop diff WITHOUT
 * applying anything (dry run). Otherwise applies it in two passes:
 *  (1) create every unbound page (parent-before-child) to obtain ids;
 *  (2) resolve cross-refs against the now-complete id map and push every body
 *      (with derived child anchors). Then trash index pages with no local file.
 */
export const syncTree = (opts: {
  readonly root: string
  readonly rootPageId?: string
  readonly plan?: boolean
}): Effect.Effect<
  TreeSyncResult,
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const root = resolve(opts.root)
    const plan = opts.plan === true
    const previous = yield* readTreeIndexOptional(root)

    const pages = yield* scanLocalPages({ root })
    const rootRel = `${ROOT_SLUG}${NMD_EXT}`
    const rootPage = pages.find((page) => page.relPath === rootRel)
    if (rootPage === undefined) {
      return yield* new NmdCliError({
        message: `Tree root ${root} must contain ${rootRel} (the root page)`,
      })
    }

    const rootPageId =
      opts.rootPageId ?? rootPage.boundPageId ?? previous?.root_page_id ?? undefined
    if (rootPageId === undefined) {
      return yield* new NmdCliError({
        message: `No Notion root configured for tree ${root}; bind ${rootRel} or pass --root on first sync`,
      })
    }

    const slugToRelPath = new Map<string, string>()
    for (const page of pages) {
      if (slugToRelPath.has(page.slug) === true) {
        return yield* new NmdCliError({
          message: `Duplicate page slug "${page.slug}" (${slugToRelPath.get(page.slug)} and ${page.relPath})`,
        })
      }
      slugToRelPath.set(page.slug, page.relPath)
    }

    /*
     * Fail CLOSED on a dangling cross-ref BEFORE any remote mutation. Dangling
     * is a property of the local target set (slug / relPath), independent of
     * whether the target has a Notion id yet — so it can be fully validated up
     * front. Resolving lazily in pass 2 would leave pass-1 creates/moves
     * already applied when a dangling ref aborts the run; validating here keeps
     * the trash-capable engine's "nothing pushed on a dangling ref" promise.
     */
    const localRelPathSet = new Set(pages.map((page) => page.relPath))
    for (const page of pages) {
      yield* validateCrossRefTargets({ page, slugToRelPath, localRelPaths: localRelPathSet })
    }

    /*
     * Identity is read from frontmatter `page_id` (durable, survives renames /
     * `git mv`). The tree index is only a regenerable path→id hint used to
     * recover a moved page's previous body hash and to detect deletions.
     */
    const idForRelPath = new Map<string, string>([[rootRel, rootPageId]])
    for (const page of pages) {
      if (page.boundPageId === null) continue
      idForRelPath.set(page.relPath, page.boundPageId)
    }

    const ops: TreeOp[] = []
    // freshly-created files whose real id must be written back into the file.
    const needsWriteback = new Map<
      string,
      { readonly pageId: string; readonly url: string | undefined }
    >()
    // RemotePageSnapshot captured at create/move/update time, keyed by relPath,
    // so the pushed-body baseline can be recorded without a re-pull.
    const snapshotForRelPath = new Map<string, RemotePageSnapshot>()
    const localRelPaths = new Set(pages.map((page) => page.relPath))

    // PASS 1 — create unbound pages (parent-before-child); move bound pages
    // whose Notion parent differs from the local parent. (root never moves.)
    for (const page of pages) {
      const parentRel = page.parentRelPath ?? rootRel
      const parentId = idForRelPath.get(parentRel)
      if (parentId === undefined) {
        /*
         * In a real sync the parent always has an id by now (parents precede
         * children in scan order and were just created). In `plan` mode pending
         * creates have no id yet, so a missing parent id is fine as long as the
         * parent is itself a local page that will be created; only a parent that
         * does not exist locally at all is a genuinely orphaned tree.
         */
        if (plan === true && localRelPaths.has(parentRel) === true) {
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
            const moved = yield* gateway.movePage({ pageId: existingId, parentPageId: parentId })
            snapshotForRelPath.set(page.relPath, moved)
            ops.push({ _tag: 'move', relPath: page.relPath, pageId: existingId })
          }
        }
        continue
      }
      if (plan === true) {
        ops.push({ _tag: 'create', relPath: page.relPath, title: page.title })
        continue
      }
      // create with a stub body first; pass 2 pushes the resolved body so
      // cross-refs (which may point at other freshly-created pages) resolve.
      const created = yield* gateway.createPage({
        parentPageId: parentId,
        title: page.title,
        markdown: `# ${page.title}\n`,
      })
      idForRelPath.set(page.relPath, created.id)
      snapshotForRelPath.set(page.relPath, created)
      needsWriteback.set(page.relPath, { pageId: created.id, url: created.url })
      ops.push({ _tag: 'create', relPath: page.relPath, title: page.title })
    }

    if (plan === true) {
      // children map for noop classification (without ids for unbound pages).
      yield* classifyPlan({ pages, rootRel, idForRelPath, slugToRelPath, ops })
      // trash detection: index pages whose id no longer maps to a local file.
      const liveIds = new Set(idForRelPath.values())
      for (const [relPath, pageId] of Object.entries(previous?.pages ?? {})) {
        if (liveIds.has(pageId) === false) ops.push({ _tag: 'trash', relPath, pageId })
      }
      return { _tag: 'tree', root, rootPageId, plan: true, ops } as const
    }

    /*
     * Bind the root id back into `index.nmd` too when it was supplied out of
     * band (`--root` / a regenerable index) rather than in the file. Identity
     * must live IN the file for fresh-clone durability — a clone without the
     * `.notion-md/` index must still know the root page.
     */
    if (rootPage.boundPageId === null) {
      needsWriteback.set(rootRel, { pageId: rootPageId, url: undefined })
    }

    // write the real id back into freshly-created files via the canonical renderer.
    const store = yield* NmdStateStore
    for (const [relPath, binding] of needsWriteback) {
      const page = pages.find((candidate) => candidate.relPath === relPath)
      if (page === undefined) continue
      yield* store.writeNmdFile({
        path: page.path,
        content: bindFrontmatter({ page, pageId: binding.pageId, url: binding.url }),
      })
    }

    // children map: parentRel → ordered [{title,pageId}]
    const childrenOf = new Map<string, { readonly title: string; readonly pageId: string }[]>()
    for (const page of pages) {
      const parentRel = page.parentRelPath
      if (parentRel === undefined) continue
      const id = idForRelPath.get(page.relPath)
      if (id === undefined) continue
      const list = childrenOf.get(parentRel) ?? []
      list.push({ title: page.title, pageId: id })
      childrenOf.set(parentRel, list)
    }

    // PASS 2 — push resolved bodies (with derived child anchors) for every page.
    for (const page of pages) {
      const pageId = idForRelPath.get(page.relPath)
      if (pageId === undefined) continue
      const resolvedBody = yield* resolveCrossRefs({ page, slugToRelPath, idForRelPath })
      const pushBody = composePushBody({
        resolvedBody,
        children: childrenOf.get(page.relPath) ?? [],
      })
      const bodyHash = pushBodyHash(pushBody)
      const wasCreated = ops.some((op) => op._tag === 'create' && op.relPath === page.relPath)
      const path = filePathFor({ root, page })

      if (wasCreated === false) {
        // noop oracle: compare against the last-pushed body hash in the sidecar.
        const prevState = yield* readSyncStateOptional({ path, pageId })
        if (prevState !== undefined && prevState.body.hash === bodyHash) {
          ops.push({ _tag: 'noop', relPath: page.relPath, pageId })
          continue
        }
      }

      const updated = yield* gateway.updateMarkdown({
        pageId,
        command: { _tag: 'replace_content', markdown: pushBody },
        // child anchors are always re-emitted, so deleting content is safe:
        // the only blocks replace_content removes are stale anchors / old body.
        allowDeletingContent: true,
      })
      const snapshot =
        snapshotForRelPath.get(page.relPath) ?? (yield* gateway.pullPage({ pageId })).page
      yield* writeTreePushState({ path, page: snapshot, pushBody })
      void updated
      if (wasCreated === false) {
        ops.push({ _tag: 'update', relPath: page.relPath, pageId })
      }
    }

    /*
     * RECONCILE — trash index pages whose page id no longer maps to any local
     * file (guarded). Keyed by page_id, so a renamed file (same id, new path)
     * is NOT mistaken for a deletion.
     */
    const liveIds = new Set(
      pages
        .map((page) => idForRelPath.get(page.relPath))
        .filter((id): id is string => id !== undefined),
    )
    for (const [relPath, pageId] of Object.entries(previous?.pages ?? {})) {
      if (liveIds.has(pageId) === true) continue
      /*
       * The page may already be in trash: re-pushing the parent body omits a
       * deleted child's `<page>` anchor, and `replace_content` trashes it as a
       * side effect. Skip the explicit archive in that case so the guarded
       * deletion stays idempotent rather than failing on an archived block.
       */
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
      index: { version: 1, root_page_id: rootPageId, pages: indexPages },
    })

    return { _tag: 'tree', root, rootPageId, plan: false, ops } as const
  }).pipe(
    Effect.withSpan('notion-md.sync-tree', {
      attributes: {
        'span.label': basename(opts.root),
        'notion_md.tree.plan': opts.plan === true,
      },
    }),
  )

/** Absolute `.nmd` file path for a page under the tree root. */
const filePathFor = (opts: { readonly root: string; readonly page: LocalTreePage }): string =>
  resolve(opts.root, opts.page.relPath)

/**
 * Classify create/update/noop ops for a dry-run plan. For unbound pages the
 * id is unknown (would be assigned on apply), so cross-refs cannot be resolved;
 * a bound page is `update` unless its composed push body matches the sidecar.
 */
const classifyPlan = (opts: {
  readonly pages: readonly LocalTreePage[]
  readonly rootRel: string
  readonly idForRelPath: ReadonlyMap<string, string>
  readonly slugToRelPath: ReadonlyMap<string, string>
  readonly ops: TreeOp[]
}): Effect.Effect<void, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
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
    for (const page of opts.pages) {
      const pageId = opts.idForRelPath.get(page.relPath)
      // unbound → already recorded as create in pass 1; skip.
      if (pageId === undefined) continue
      if (opts.ops.some((op) => op.relPath === page.relPath && op._tag === 'move') === true)
        continue
      const resolved = yield* resolveCrossRefs({
        page,
        slugToRelPath: opts.slugToRelPath,
        idForRelPath: opts.idForRelPath,
      }).pipe(Effect.orElseSucceed(() => page.body))
      const pushBody = composePushBody({
        resolvedBody: resolved,
        children: childrenOf.get(page.relPath) ?? [],
      })
      const bodyHash = pushBodyHash(pushBody)
      const path = resolve(page.path)
      const prevState = yield* readSyncStateOptional({ path, pageId })
      if (prevState !== undefined && prevState.body.hash === bodyHash) {
        opts.ops.push({ _tag: 'noop', relPath: page.relPath, pageId })
      } else {
        opts.ops.push({ _tag: 'update', relPath: page.relPath, pageId })
      }
    }
  })
