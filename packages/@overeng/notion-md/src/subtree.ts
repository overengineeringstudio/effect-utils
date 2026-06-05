import { basename, dirname, extname, join, relative, resolve } from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { compactNotionUuid } from '@overeng/notion-effect-schema'
import { titleSlug } from '@overeng/utils'

import { NmdCliError, NmdFileSystemError, type NmdError } from './errors.ts'
import { sha256Digest } from './hash.ts'
import { NotionMdGateway } from './model.ts'

/**
 * Canonical Notion page URL form proven to round-trip through the enhanced
 * Markdown endpoint both as an INLINE link `[label](url)` and as a block-level
 * `<page url>` anchor. `notion.so/<id>` is *not* used here: only the
 * `app.notion.com/p/<dashless-id>` form is verified to resolve to a live page
 * link rather than dead `(#)` text.
 */
export const pageUrl = (pageId: string): string =>
  `https://app.notion.com/p/${compactNotionUuid(pageId)}`

/**
 * Native directory-tree ↔ Notion-subtree sync.
 *
 * The local directory tree is the source of truth for hierarchy. Each `.nmd`
 * file is a page; directory nesting is page nesting. A `subtree.json` manifest
 * binds `relativePath ↔ page_id` (durable identity that survives renames).
 *
 * This subsumes the four pain points of single-page sync:
 *  - create-missing: unbound local files (no manifest entry) are created.
 *  - child-anchoring: Notion auto-appends a `<page url>` child block to the
 *    parent on create; we must *re-emit those anchors* on every parent push so
 *    `replace_content` does not trash the real children. The child index is
 *    therefore DERIVED from the ordered children, never hand-authored.
 *  - link-resolution: `[[slug]]` / `[text](./file.nmd)` refs are rewritten to
 *    the target page URL (Notion stores it as a live page link). Dangling refs
 *    HARD-FAIL the whole sync.
 *  - reconcile: bound files whose body changed are updated; manifest entries
 *    with no local file are trashed (guarded).
 *
 * Hierarchy convention (prototype):
 *  - `<root>/index.nmd` is the root page (bound to `root_page_id`).
 *  - any other `<dir>/<name>.nmd` is a child of the page anchoring `<dir>`.
 *  - a subdirectory `<dir>/<sub>/` is anchored by `<dir>/<sub>/index.nmd`; the
 *    files inside `<sub>/` are its children. The anchor's own parent is the
 *    page anchoring `<dir>`.
 */

const ROOT_SLUG = 'index'
const NMD_EXT = '.nmd'
const SUBTREE_MANIFEST = 'subtree.json'

/**
 * Per-page binding: durable page id + a hash of the last body we PUSHED.
 *
 * The hash is taken over the composed push body (resolved cross-refs + child
 * anchors), not the re-pulled remote markdown. Notion's enhanced-markdown GET
 * corrupts blockquote-adjacent paragraphs (the documented merge bug), so a
 * re-pull cannot be used as the noop oracle; the locally-pushed body can.
 */
const SubtreePageBinding = Schema.Struct({
  page_id: Schema.String,
  body_hash: Schema.String,
}).annotations({ identifier: 'NotionMd.SubtreePageBinding' })

const SubtreeManifest = Schema.Struct({
  version: Schema.Literal(1),
  root_page_id: Schema.String,
  /** root page binding (kept so root body noop works like any other page) */
  root_body_hash: Schema.optional(Schema.String),
  /** relativePath (posix, from root) → binding */
  pages: Schema.Record({ key: Schema.String, value: SubtreePageBinding }),
}).annotations({ identifier: 'NotionMd.SubtreeManifest' })

type SubtreeManifest = typeof SubtreeManifest.Type

const encodeManifestJson = Schema.encodeSync(Schema.parseJson(SubtreeManifest, { space: 2 }))
const decodeManifestJson = Schema.decodeUnknown(Schema.parseJson(SubtreeManifest), {
  errors: 'all',
  onExcessProperty: 'error',
} as const)

const manifestPath = (root: string): string => join(root, SUBTREE_MANIFEST)

/** A local source page discovered in the directory tree. */
interface LocalPage {
  /** Absolute path to the `.nmd` file. */
  readonly path: string
  /** Posix-relative path from the workspace root (manifest key + ref target). */
  readonly relPath: string
  /** Stable slug used for `[[slug]]` cross-refs (unique within the tree). */
  readonly slug: string
  /** Page title (frontmatter `title:` or humanized filename). */
  readonly title: string
  /** Body markdown with frontmatter stripped (cross-refs still unresolved). */
  readonly body: string
  /** relPath of the parent page, or undefined for the root. */
  readonly parentRelPath: string | undefined
  /** Durable page id bound in frontmatter (`notion_page_id:`), if any. */
  readonly boundPageId: string | undefined
}

/** Tagged plan operation for one reconcile pass. */
export type SubtreeOp =
  | { readonly _tag: 'create'; readonly relPath: string; readonly title: string }
  | { readonly _tag: 'update'; readonly relPath: string; readonly pageId: string }
  | { readonly _tag: 'move'; readonly relPath: string; readonly pageId: string }
  | { readonly _tag: 'noop'; readonly relPath: string; readonly pageId: string }
  | { readonly _tag: 'trash'; readonly relPath: string; readonly pageId: string }

/** Result envelope for a subtree sync pass. */
export interface SubtreeSyncResult {
  readonly _tag: 'subtree'
  readonly root: string
  readonly rootPageId: string
  readonly ops: readonly SubtreeOp[]
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
    message: `notion-md subtree ${opts.operation} failed for ${opts.path}`,
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

const unquote = (value: string): string => value.trim().replace(/^["']|["']$/gu, '')

/**
 * Strip a leading `--- ... ---` frontmatter block, returning the user-editable
 * `title`, the tool-managed `notion_page_id` (durable identity that survives
 * renames / `git mv`), and the body.
 */
export const splitFrontmatter = (
  content: string,
): { readonly title?: string; readonly pageId?: string; readonly body: string } => {
  const normalized = content.replace(/\r\n/gu, '\n')
  if (normalized.startsWith('---\n') === false) return { body: normalized }
  const end = normalized.indexOf('\n---\n', 4)
  if (end === -1) return { body: normalized }
  const front = normalized.slice(4, end)
  const body = normalized.slice(end + '\n---\n'.length).replace(/^\n/u, '')
  const title = front.match(/^title:\s*(.+)$/mu)?.[1]
  const pageId = front.match(/^notion_page_id:\s*(.+)$/mu)?.[1]
  return {
    ...(title === undefined ? {} : { title: unquote(title) }),
    ...(pageId === undefined ? {} : { pageId: unquote(pageId) }),
    body,
  }
}

/** Re-render a source file with the tool-managed `notion_page_id` bound in. */
const renderWithPageId = (opts: {
  readonly title: string
  readonly pageId: string
  readonly body: string
}): string =>
  `---\ntitle: ${opts.title}\nnotion_page_id: ${opts.pageId}\n---\n\n${opts.body.replace(/\n+$/u, '')}\n`

/** Resolve the parent relPath for a given file relPath under the directory model. */
export const parentRelPathFor = (relPath: string): string | undefined => {
  const segments = relPath.split('/')
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
  return dir === '.'
    ? `${ROOT_SLUG}${NMD_EXT}`
    : segments.length > 1
      ? `${dir}/${ROOT_SLUG}${NMD_EXT}`
      : `${ROOT_SLUG}${NMD_EXT}`
}

/** Recursively walk a directory for `.nmd` files (skips the manifest + dotdirs). */
const walkNmdFiles = (opts: {
  readonly root: string
  readonly dir: string
}): Effect.Effect<readonly string[], NmdFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* fs
      .readDirectory(opts.dir)
      .pipe(
        Effect.mapError((cause) => makeFsError({ operation: 'read_dir', path: opts.dir, cause })),
      )
    const found: string[] = []
    for (const entry of entries) {
      if (entry.startsWith('.') === true) continue
      const full = join(opts.dir, entry)
      const info = yield* fs
        .stat(full)
        .pipe(Effect.mapError((cause) => makeFsError({ operation: 'stat', path: full, cause })))
      if (info.type === 'Directory') {
        found.push(...(yield* walkNmdFiles({ root: opts.root, dir: full })))
      } else if (extname(full) === NMD_EXT) {
        found.push(full)
      }
    }
    return found
  })

/** Read + parse all local pages, sorted so parents precede children. */
const scanLocalPages = (opts: {
  readonly root: string
}): Effect.Effect<readonly LocalPage[], NmdError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const files = yield* walkNmdFiles({ root: opts.root, dir: opts.root })
    const pages: LocalPage[] = []
    for (const path of files) {
      const relPath = toPosix(relative(opts.root, path))
      const content = yield* fs
        .readFileString(path)
        .pipe(Effect.mapError((cause) => makeFsError({ operation: 'read', path, cause })))
      const { title, pageId, body } = splitFrontmatter(content)
      const stem = basename(path, NMD_EXT)
      const dirStem = basename(dirname(relPath))
      const effectiveTitle =
        title ??
        humanizeStem(
          stem === ROOT_SLUG && dirStem !== '.' && relPath.includes('/') === true ? dirStem : stem,
        )
      pages.push({
        path,
        relPath,
        slug: slugForRelPath(relPath),
        title: effectiveTitle,
        body,
        parentRelPath: parentRelPathFor(relPath),
        boundPageId: pageId,
      })
    }
    // topological-ish: shorter rel paths (closer to root) first
    return pages
      .slice()
      .toSorted((a, b) => a.relPath.split('/').length - b.relPath.split('/').length)
  })

const readManifestOptional = (
  root: string,
): Effect.Effect<SubtreeManifest | undefined, NmdError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = manifestPath(root)
    const exists = yield* fs
      .exists(path)
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'exists', path, cause })))
    if (exists === false) return undefined
    const content = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'read', path, cause })))
    return yield* decodeManifestJson(content).pipe(
      Effect.mapError(
        (cause) =>
          new NmdCliError({ message: `Invalid subtree manifest ${path}: ${String(cause)}` }),
      ),
    )
  })

const writeManifest = (opts: {
  readonly root: string
  readonly manifest: SubtreeManifest
}): Effect.Effect<void, NmdFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = manifestPath(opts.root)
    yield* fs
      .writeFileString(path, `${encodeManifestJson(opts.manifest).trimEnd()}\n`)
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'write', path, cause })))
  })

/**
 * Resolve `[[slug]]` and `[text](./rel.nmd)` cross-refs to Notion page URLs.
 *
 * Hard-fails on any ref that does not resolve to a known local page. Returns
 * the rewritten body. Bound pages use their real page id; unbound pages must
 * already have been assigned an id in `idForRelPath` (two-pass create).
 */
const resolveCrossRefs = (opts: {
  readonly page: LocalPage
  readonly slugToRelPath: ReadonlyMap<string, string>
  readonly idForRelPath: ReadonlyMap<string, string>
}): Effect.Effect<string, NmdError> =>
  Effect.gen(function* () {
    const urlFor = (relPath: string): string | undefined => {
      const id = opts.idForRelPath.get(relPath)
      return id === undefined ? undefined : pageUrl(id)
    }

    let body = opts.page.body

    // [[slug]] → [Title](url)
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

    // [text](./rel.nmd) or [text](rel.nmd) → [text](url).
    // The href is resolved relative to the page's own directory, then matched
    // against manifest relPaths (which are posix-relative to the workspace root).
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
 * index. The child index re-emits one `<page url>` anchor per ordered child so
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

/**
 * Reconcile a local directory tree against a Notion subtree.
 *
 * Two-pass: (1) create every unbound page (bottom-anchored by parent order)
 * to obtain page ids; (2) resolve cross-refs against the now-complete id map
 * and push every page body (with derived child anchors). Then trash manifest
 * pages with no local file.
 */
export const syncSubtree = (opts: {
  readonly root: string
  readonly rootPageId?: string
}): Effect.Effect<SubtreeSyncResult, NmdError, FileSystem.FileSystem | NotionMdGateway> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const fs = yield* FileSystem.FileSystem
    const root = resolve(opts.root)
    const previous = yield* readManifestOptional(root)
    const rootPageId = opts.rootPageId ?? previous?.root_page_id
    if (rootPageId === undefined) {
      return yield* new NmdCliError({
        message: `No Notion root configured for subtree ${root}; pass a root page id on first sync`,
      })
    }

    const pages = yield* scanLocalPages({ root })
    const rootRel = `${ROOT_SLUG}${NMD_EXT}`
    if (pages.some((page) => page.relPath === rootRel) === false) {
      return yield* new NmdCliError({
        message: `Subtree root ${root} must contain ${rootRel} (the root page)`,
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
     * Identity resolution order (most → least durable):
     *  1. `notion_page_id:` frontmatter — survives renames / `git mv`.
     *  2. manifest binding keyed by relPath — survives if the path is stable.
     * relPath is only an *index*, never the identity. This is what lets a
     * renamed file keep its Notion page (rebind) instead of trash+recreate.
     */
    const idForRelPath = new Map<string, string>([[rootRel, rootPageId]])
    const lastBodyHash = new Map<string, string>()
    if (previous?.root_body_hash !== undefined) lastBodyHash.set(rootRel, previous.root_body_hash)
    // index previous bindings by page_id so a moved file can recover its hash.
    const prevHashByPageId = new Map<string, string>()
    for (const [relPath, binding] of Object.entries(previous?.pages ?? {})) {
      prevHashByPageId.set(binding.page_id, binding.body_hash)
      // only seed by path when the file at that path is still unbound
      const localAtPath = pages.find((page) => page.relPath === relPath)
      if (localAtPath?.boundPageId === undefined) {
        idForRelPath.set(relPath, binding.page_id)
        lastBodyHash.set(relPath, binding.body_hash)
      }
    }
    for (const page of pages) {
      if (page.boundPageId === undefined) continue
      idForRelPath.set(page.relPath, page.boundPageId)
      const hash = prevHashByPageId.get(page.boundPageId)
      if (hash !== undefined) lastBodyHash.set(page.relPath, hash)
    }

    const ops: SubtreeOp[] = []
    // relPaths whose binding came from frontmatter id but is new to this path
    // (rename) need their id written back into the file at the new location.
    const needsWriteback = new Map<string, string>()

    // PASS 1 — create unbound pages in parent-before-child order; rebind/move
    // pages that carry a durable id but landed under a different parent.
    for (const page of pages) {
      const parentRel = page.parentRelPath ?? rootRel
      const parentId = idForRelPath.get(parentRel)
      if (parentId === undefined) {
        return yield* new NmdCliError({
          message: `Cannot place ${page.relPath}: parent ${parentRel} has no page id (out-of-order tree)`,
        })
      }
      const existingId = idForRelPath.get(page.relPath)
      if (existingId !== undefined) {
        // already bound — if its frontmatter id exists but the Notion parent
        // differs from the local parent, move it. (root never moves.)
        if (page.relPath !== rootRel && page.boundPageId !== undefined) {
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
      // create with a stub body first; pass 2 pushes the resolved body so
      // cross-refs (which may point at other freshly-created pages) resolve.
      const created = yield* gateway.createPage({
        parentPageId: parentId,
        title: page.title,
        markdown: `# ${page.title}\n`,
      })
      idForRelPath.set(page.relPath, created.id)
      needsWriteback.set(page.relPath, created.id)
      ops.push({ _tag: 'create', relPath: page.relPath, title: page.title })
    }

    // write the durable `notion_page_id:` back into freshly-created files so
    // future renames are detectable. (Bound files already carry their id.)
    for (const [relPath, pageId] of needsWriteback) {
      const page = pages.find((candidate) => candidate.relPath === relPath)
      if (page === undefined) continue
      yield* fs
        .writeFileString(
          page.path,
          renderWithPageId({ title: page.title, pageId, body: page.body }),
        )
        .pipe(
          Effect.mapError((cause) => makeFsError({ operation: 'write', path: page.path, cause })),
        )
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
    // pushedHash records the body hash actually on Notion, written to the
    // manifest so the next run can noop without re-pulling (pull is lossy).
    const pushedHash = new Map<string, string>()
    for (const page of pages) {
      const pageId = idForRelPath.get(page.relPath)
      if (pageId === undefined) continue
      const resolvedBody = yield* resolveCrossRefs({ page, slugToRelPath, idForRelPath })
      const pushBody = composePushBody({
        resolvedBody,
        children: childrenOf.get(page.relPath) ?? [],
      })
      const bodyHash = sha256Digest(normalizeForHash(pushBody))
      const wasCreated = ops.some((op) => op._tag === 'create' && op.relPath === page.relPath)
      if (wasCreated === false && lastBodyHash.get(page.relPath) === bodyHash) {
        pushedHash.set(page.relPath, bodyHash)
        ops.push({ _tag: 'noop', relPath: page.relPath, pageId })
        continue
      }
      yield* gateway.updateMarkdown({
        pageId,
        command: { _tag: 'replace_content', markdown: pushBody },
        // child anchors are always re-emitted, so deleting content is safe:
        // the only blocks replace_content removes are stale anchors / old body.
        allowDeletingContent: true,
      })
      pushedHash.set(page.relPath, bodyHash)
      if (wasCreated === false) {
        ops.push({ _tag: 'update', relPath: page.relPath, pageId })
      }
    }

    /*
     * RECONCILE — trash manifest pages whose page id no longer maps to any
     * local file (guarded). Keyed by page_id, not relPath, so a *renamed* file
     * (same id, new path) is NOT mistaken for a deletion.
     */
    const livePageIds = new Set(
      pages
        .map((page) => idForRelPath.get(page.relPath))
        .filter((id): id is string => id !== undefined),
    )
    for (const [relPath, binding] of Object.entries(previous?.pages ?? {})) {
      if (livePageIds.has(binding.page_id) === true) continue
      /*
       * The page may already be in trash: re-pushing the parent body omits a
       * deleted child's `<page>` anchor, and `replace_content` trashes it as a
       * side effect. Skip the explicit archive in that case so the guarded
       * deletion stays idempotent rather than failing on an archived block.
       */
      const remote = yield* gateway.pullPage({ pageId: binding.page_id })
      if (remote.page.in_trash === false) {
        yield* gateway.archivePage({ pageId: binding.page_id })
      }
      ops.push({ _tag: 'trash', relPath, pageId: binding.page_id })
    }

    // write the refreshed manifest (relPath → {page_id, body_hash}); the root
    // binding rides in root_page_id + root_body_hash.
    const manifestPages: Record<string, typeof SubtreePageBinding.Type> = {}
    for (const page of pages) {
      if (page.relPath === rootRel) continue
      const id = idForRelPath.get(page.relPath)
      const hash = pushedHash.get(page.relPath)
      if (id !== undefined && hash !== undefined) {
        manifestPages[page.relPath] = { page_id: id, body_hash: hash }
      }
    }
    yield* writeManifest({
      root,
      manifest: {
        version: 1,
        root_page_id: rootPageId,
        ...(pushedHash.get(rootRel) === undefined
          ? {}
          : { root_body_hash: pushedHash.get(rootRel) }),
        pages: manifestPages,
      },
    })

    return { _tag: 'subtree', root, rootPageId, ops } as const
  }).pipe(
    Effect.withSpan('notion-md.sync-subtree', {
      attributes: { 'span.label': basename(opts.root) },
    }),
  )

/** Normalize a body for stable hashing across canonicalization round-trips. */
const normalizeForHash = (value: string): string =>
  value
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
