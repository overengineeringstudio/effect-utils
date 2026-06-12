import { basename } from 'node:path'

import type { Path } from '@effect/platform'
import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'

import {
  gateNmdLocalState,
  NOTION_API_VERSION,
  type NmdFrontmatterV2,
  type NmdLocalState,
  type NmdParentRef,
  type NmdSyncStateV1,
} from '@overeng/notion-effect-client'

import { runBatch, type BatchResult } from './batch.ts'
import { canonicalize } from './canonicalizer.ts'
import { NmdCliError, NmdConflictError, NmdFrontmatterError, type NmdError } from './errors.ts'
import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import { NotionMdGateway, type RemotePageSnapshot } from './model.ts'
import {
  decideReconcile,
  porcelainStatus,
  type PorcelainStatus,
  type ReconcileDecision,
} from './reconcile-core.ts'
import { decideShared, sharedPorcelain, type SharedOutcome } from './reconcile-shared.ts'
import { NmdStateStore, readBaseSnapshot, readSyncStateOptional } from './state-store.ts'

/*
 * Source-aware reconcile engine (spec "Internal layering").
 *
 * `statusFile` is read-only and safe by construction: it never reaches an apply
 * path. `reconcileFile` dispatches per file on frontmatter `source` (R34) —
 * never on flags or arity — and moves the file toward in-sync.
 *
 * The single-source path (`local`/`remote`) is stateless: it compares
 * `render(local)` against `read(current remote)` under the R33 relation with no
 * stored base. The `shared` path is the only one that touches the base+merge
 * leaf.
 */

/** Read a `.nmd` file and pair it with its (optional) sidecar via the R31/R32 gate. */
const readGatedLocalState = (path: string): Effect.Effect<NmdLocalState, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const content = yield* store.readNmdFile({ path })
    const parsed = yield* parseNmdFile({ path, content })
    const pageId = parsed.frontmatter.notion_md.page_id
    const syncState = pageId === null ? undefined : yield* readSyncStateOptional({ path, pageId })
    const gated = gateNmdLocalState({ frontmatter: parsed.frontmatter, syncState })
    if (gated instanceof Error) {
      return yield* new NmdFrontmatterError({
        path,
        message: gated.message,
      })
    }
    return gated
  })

/** The local body for a `.nmd` file, in canonical R33 form. */
const localBody = (path: string): Effect.Effect<string, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const content = yield* store.readNmdFile({ path })
    const parsed = yield* parseNmdFile({ path, content })
    return parsed.body
  })

/** Result of a read-only status pass over one self-describing `.nmd` file. */
export interface ReconcileStatus {
  readonly path: string
  readonly source: NmdLocalState['_tag']
  readonly pageId: string | undefined
  /** git-porcelain word: in-sync / local-ahead / remote-ahead / diverged / unbound. */
  readonly status: PorcelainStatus
}

/** Tagged result of one `reconcileFile` pass. */
export type ReconcileResult =
  | {
      readonly _tag: 'noop'
      readonly path: string
      readonly pageId: string
      readonly dryRun?: true
    }
  | { readonly _tag: 'created'; readonly path: string; readonly pageId: string }
  | {
      readonly _tag: 'created'
      readonly path: string
      readonly pageId: undefined
      readonly parentPageId: string
      readonly dryRun: true
    }
  | {
      readonly _tag: 'pushed'
      readonly path: string
      readonly pageId: string
      readonly dryRun?: true
    }
  | {
      readonly _tag: 'pulled'
      readonly path: string
      readonly pageId: string
      readonly dryRun?: true
    }
  | {
      readonly _tag: 'shared-merged'
      readonly path: string
      readonly pageId: string
      readonly dryRun?: true
    }
  | {
      readonly _tag: 'shared-conflict'
      readonly path: string
      readonly pageId: string
      readonly conflictPath: string
      readonly dryRun?: true
    }

/** Construct a `ReconcileResult` with literal `_tag` discrimination preserved. */
const result = (r: ReconcileResult): ReconcileResult => r

/** Construct a `ReconcileStatus` with literal discrimination preserved. */
const statusResult = (s: ReconcileStatus): ReconcileStatus => s

const remoteBodyFor = (pageId: string) =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const pulled = yield* gateway.pullPage({ pageId })
    return { pulled, body: normalizeMarkdownLineEndings(pulled.markdown.markdown) }
  })

/**
 * Read-only status (R30/R36 safe-by-construction): there is no write path in
 * this call graph. Reports the live in-sync decision per file in git-porcelain
 * vocabulary.
 */
export const statusFile = (opts: {
  readonly path: string
}): Effect.Effect<
  ReconcileStatus,
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const local = yield* readGatedLocalState(opts.path)

    if (local._tag === 'local-unbound') {
      return statusResult({
        path: opts.path,
        source: local._tag,
        pageId: undefined,
        status: 'unbound',
      })
    }

    const pageId = local.pageId
    const { body: remote } = yield* remoteBodyFor(pageId)
    const rendered = yield* localBody(opts.path)

    if (local._tag === 'shared-bound') {
      const base = yield* readBaseSnapshot({ path: opts.path, syncState: local.syncState })
      const outcome = decideShared({ baseBody: base.body, localBody: rendered, remoteBody: remote })
      return statusResult({
        path: opts.path,
        source: local._tag,
        pageId,
        status: sharedPorcelain(outcome),
      })
    }

    const decision = decideReconcile({
      local,
      compare: { renderedLocal: rendered, currentRemote: remote },
    })
    return statusResult({
      path: opts.path,
      source: local._tag,
      pageId,
      status: porcelainStatus(decision),
    })
  }).pipe(
    Effect.withSpan('notion-md.status-file', {
      attributes: { 'span.label': basename(opts.path) },
    }),
  )

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

const boundFrontmatter = (opts: {
  readonly frontmatter: NmdFrontmatterV2
  readonly page: RemotePageSnapshot
}): NmdFrontmatterV2 => ({
  notion_md: {
    ...opts.frontmatter.notion_md,
    page_id: opts.page.id,
    ...(opts.page.url === undefined ? {} : { url: opts.page.url }),
  },
})

const remoteFrontmatter = (opts: {
  readonly source: NmdFrontmatterV2['notion_md']['source']
  readonly page: RemotePageSnapshot
}): NmdFrontmatterV2 => ({
  notion_md: {
    version: 2,
    api_version: NOTION_API_VERSION,
    object: 'page',
    source: opts.source,
    page_id: opts.page.id,
    ...(opts.page.url === undefined ? {} : { url: opts.page.url }),
    parent: toParentRef(opts.page),
    page: {
      title: opts.page.title,
      icon: opts.page.icon,
      cover: opts.page.cover,
      in_trash: opts.page.in_trash,
      is_locked: opts.page.is_locked,
    },
    properties: {},
  },
})

const parentPageIdOf = (parent: NmdParentRef): string | undefined =>
  parent._tag === 'page' ? parent.id : undefined

const writeFile = (opts: {
  readonly path: string
  readonly frontmatter: NmdFrontmatterV2
  readonly body: string
}) =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    yield* store.writeNmdFile({
      path: opts.path,
      content: renderNmdFile({ frontmatter: opts.frontmatter, body: opts.body }),
    })
  })

/** Roughdraft conflict artifact path beside the `.nmd` file. */
const conflictPathFor = (path: string): string => `${path}.conflict.roughdraft.md`

const writeSharedConflict = (opts: {
  readonly path: string
  readonly pageId: string
  readonly outcome: Extract<SharedOutcome, { _tag: 'conflict' }>
}): Effect.Effect<string, NmdError, NmdStateStore> =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const conflictPath = conflictPathFor(opts.path)
    const fence = '`'.repeat(4)
    yield* store
      .writeConflictFile({
        path: conflictPath,
        content: `# notion-md body conflict

Page: ${opts.pageId}

## Base body

${fence}markdown
${opts.outcome.baseBody}
${fence}

## Local body

${fence}markdown
${opts.outcome.localBody}
${fence}

## Remote body

${fence}markdown
${opts.outcome.remoteBody}
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

/**
 * Reconcile one self-describing `.nmd` file (R34). Dispatches per file on
 * `source`; always moves toward in-sync. `--force` (single-source: inert;
 * shared: local-wins override) is threaded via `force`.
 */
export const reconcileFile = (opts: {
  readonly path: string
  readonly force?: boolean
  readonly dryRun?: boolean
}): Effect.Effect<
  ReconcileResult,
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore
> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const local = yield* readGatedLocalState(opts.path)
    const rendered = yield* localBody(opts.path)

    // source: local, unbound — create the remote page under `parent`.
    if (local._tag === 'local-unbound') {
      const parentPageId = parentPageIdOf(local.frontmatter.notion_md.parent)
      if (parentPageId === undefined) {
        return yield* new NmdFrontmatterError({
          path: opts.path,
          message:
            'Unbound source: local file needs a page parent to create under (parent must be { _tag: "page", id }).',
        })
      }
      if (opts.dryRun === true) {
        return result({
          _tag: 'created',
          path: opts.path,
          pageId: undefined,
          parentPageId,
          dryRun: true,
        })
      }
      const page = yield* gateway.createPage({
        parentPageId,
        title: local.frontmatter.notion_md.page.title,
        markdown: canonicalize(rendered),
      })
      yield* writeFile({
        path: opts.path,
        frontmatter: boundFrontmatter({ frontmatter: local.frontmatter, page }),
        body: rendered,
      })
      return result({ _tag: 'created', path: opts.path, pageId: page.id })
    }

    const pageId = local.pageId
    const { pulled, body: remote } = yield* remoteBodyFor(pageId)

    if (local._tag === 'shared-bound') {
      return yield* reconcileSharedFile({
        path: opts.path,
        pageId,
        syncState: local.syncState,
        frontmatter: local.frontmatter,
        rendered,
        remote,
        page: pulled.page,
        force: opts.force === true,
        dryRun: opts.dryRun === true,
      })
    }

    const decision: ReconcileDecision = decideReconcile({
      local,
      compare: { renderedLocal: rendered, currentRemote: remote },
    })

    switch (decision._tag) {
      case 'noop':
        return result({
          _tag: 'noop',
          path: opts.path,
          pageId,
          ...(opts.dryRun === true ? { dryRun: true } : {}),
        })
      case 'push': {
        if (opts.dryRun === true) {
          return result({ _tag: 'pushed', path: opts.path, pageId, dryRun: true })
        }
        yield* gateway.updateMarkdown({
          pageId,
          command: { _tag: 'replace_content', markdown: canonicalize(rendered) },
          allowDeletingContent: false,
        })
        return result({ _tag: 'pushed', path: opts.path, pageId })
      }
      case 'pull': {
        if (opts.dryRun === true) {
          return result({ _tag: 'pulled', path: opts.path, pageId, dryRun: true })
        }
        yield* writeFile({
          path: opts.path,
          frontmatter: remoteFrontmatter({
            source: local.frontmatter.notion_md.source,
            page: pulled.page,
          }),
          body: remote,
        })
        return result({ _tag: 'pulled', path: opts.path, pageId })
      }
      case 'refuse':
        return yield* new NmdConflictError({
          path: opts.path,
          page_id: pageId,
          local_changed: false,
          remote_changed: true,
          message: decision.reason,
        })
      // `create`/`shared-defer` are handled above; unreachable here.
      case 'create':
      case 'shared-defer':
        return result({
          _tag: 'noop',
          path: opts.path,
          pageId,
          ...(opts.dryRun === true ? { dryRun: true } : {}),
        })
    }
  }).pipe(
    Effect.withSpan('notion-md.reconcile-file', {
      attributes: { 'span.label': basename(opts.path) },
    }),
  )

/** Apply the `source: shared` 3-way outcome (the only base/merge path). */
const reconcileSharedFile = (opts: {
  readonly path: string
  readonly pageId: string
  readonly syncState: NmdSyncStateV1
  readonly frontmatter: NmdFrontmatterV2
  readonly rendered: string
  readonly remote: string
  readonly page: RemotePageSnapshot
  readonly force: boolean
  readonly dryRun: boolean
}): Effect.Effect<ReconcileResult, NmdError, NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const base = yield* readBaseSnapshot({ path: opts.path, syncState: opts.syncState })

    // --force overrides a shared divergence with a local-wins replace.
    if (opts.force === true) {
      if (opts.dryRun === true) {
        return result({
          _tag: 'shared-merged',
          path: opts.path,
          pageId: opts.pageId,
          dryRun: true,
        })
      }
      yield* gateway.updateMarkdown({
        pageId: opts.pageId,
        command: { _tag: 'replace_content', markdown: canonicalize(opts.rendered) },
        allowDeletingContent: false,
      })
      yield* settleSharedBase({
        path: opts.path,
        pageId: opts.pageId,
        syncState: opts.syncState,
        body: opts.rendered,
      })
      return result({ _tag: 'shared-merged', path: opts.path, pageId: opts.pageId })
    }

    const outcome = decideShared({
      baseBody: base.body,
      localBody: opts.rendered,
      remoteBody: opts.remote,
    })

    switch (outcome._tag) {
      case 'noop':
        return result({
          _tag: 'noop',
          path: opts.path,
          pageId: opts.pageId,
          ...(opts.dryRun === true ? { dryRun: true } : {}),
        })
      case 'merge': {
        if (opts.dryRun === true) {
          return result({
            _tag: 'shared-merged',
            path: opts.path,
            pageId: opts.pageId,
            dryRun: true,
          })
        }
        yield* gateway.updateMarkdown({
          pageId: opts.pageId,
          command: { _tag: 'replace_content', markdown: canonicalize(outcome.merged) },
          allowDeletingContent: false,
        })
        yield* writeFile({ path: opts.path, frontmatter: opts.frontmatter, body: outcome.merged })
        yield* settleSharedBase({
          path: opts.path,
          pageId: opts.pageId,
          syncState: opts.syncState,
          body: outcome.merged,
        })
        return result({ _tag: 'shared-merged', path: opts.path, pageId: opts.pageId })
      }
      case 'conflict': {
        if (opts.dryRun === true) {
          return result({
            _tag: 'shared-conflict',
            path: opts.path,
            pageId: opts.pageId,
            conflictPath: conflictPathFor(opts.path),
            dryRun: true,
          })
        }
        const conflictPath = yield* writeSharedConflict({
          path: opts.path,
          pageId: opts.pageId,
          outcome,
        })
        return result({
          _tag: 'shared-conflict',
          path: opts.path,
          pageId: opts.pageId,
          conflictPath,
        })
      }
    }
  })

/**
 * Re-settle a fresh base snapshot after a clean `shared` apply and repoint the
 * sidecar `body.base` ref/hash at it, so the next reconcile 3-way-merges
 * against the newly-converged body — not the stale base.
 */
const settleSharedBase = (opts: {
  readonly path: string
  readonly pageId: string
  readonly syncState: NmdSyncStateV1
  readonly body: string
}) =>
  Effect.gen(function* () {
    const store = yield* NmdStateStore
    const body = normalizeMarkdownLineEndings(opts.body)
    const base = yield* store.writeBaseSnapshot({ path: opts.path, pageId: opts.pageId, body })
    yield* store.writeSyncState({
      path: opts.path,
      syncState: {
        ...opts.syncState,
        body: {
          ...opts.syncState.body,
          hash: sha256Digest(body),
          base,
          last_pulled_at: new Date().toISOString(),
        },
      },
    })
  })

/** Result of tracking an existing Notion page as a local file. */
export interface TrackResult {
  readonly path: string
  readonly pageId: string
  readonly source: NmdFrontmatterV2['notion_md']['source']
  readonly dryRun?: true
}

/**
 * `track <id|url> [path]` — bootstrap a local `.nmd` file from an existing
 * Notion page (spec). The ONLY operation that takes a page id. Writes
 * self-describing frontmatter with the chosen `source` (default `remote` — you
 * tracked existing Notion state). Fail-closed on a lossy/truncated remote observation: no
 * clean base from a lossy body. For `--as shared` it also establishes the base
 * sidecar so the file is a valid `shared-bound` from the first sync.
 */
export const trackPage = (opts: {
  readonly pageId: string
  readonly outPath: string
  readonly source: NmdFrontmatterV2['notion_md']['source']
  readonly dryRun?: boolean
}): Effect.Effect<TrackResult, NmdError, FileSystem.FileSystem | NotionMdGateway | NmdStateStore> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(opts.outPath).pipe(Effect.orElseSucceed(() => false))
    if (exists === true) {
      // refuse to overwrite a file already bound to a different page
      const store = yield* NmdStateStore
      const existing = yield* store.readNmdFile({ path: opts.outPath }).pipe(Effect.either)
      if (existing._tag === 'Right') {
        const parsed = yield* parseNmdFile({ path: opts.outPath, content: existing.right })
        const boundId = parsed.frontmatter.notion_md.page_id
        if (boundId !== null && boundId !== opts.pageId) {
          return yield* new NmdFrontmatterError({
            path: opts.outPath,
            message: `${opts.outPath} is already bound to a different page (${boundId}); refusing to overwrite with ${opts.pageId}`,
          })
        }
      }
    }

    const pulled = yield* gateway.pullPage({ pageId: opts.pageId })
    const completeness = pulled.markdown.completeness
    if (completeness !== undefined && completeness._tag !== 'complete') {
      return yield* new NmdFrontmatterError({
        path: opts.outPath,
        message: `Refusing to track a lossy remote body for ${opts.pageId} (${completeness.reasons.join(', ')}); no clean base from a truncated observation`,
      })
    }
    const body = normalizeMarkdownLineEndings(pulled.markdown.markdown)
    if (opts.dryRun === true) {
      return { path: opts.outPath, pageId: opts.pageId, source: opts.source, dryRun: true as const }
    }
    yield* writeFile({
      path: opts.outPath,
      frontmatter: remoteFrontmatter({ source: opts.source, page: pulled.page }),
      body,
    })

    if (opts.source === 'shared') {
      const store = yield* NmdStateStore
      const base = yield* store.writeBaseSnapshot({
        path: opts.outPath,
        pageId: opts.pageId,
        body,
      })
      yield* store.writeSyncState({
        path: opts.outPath,
        syncState: {
          version: 1,
          page_id: opts.pageId,
          body: {
            format: 'notion-enhanced-markdown',
            hash: sha256Digest(body),
            base,
            last_pulled_at: new Date().toISOString(),
            remote_last_edited_time: pulled.page.last_edited_time,
            truncated: pulled.markdown.truncated,
            unknown_block_ids: [...pulled.markdown.unknown_block_ids],
          },
          storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
          read_only_properties: {},
          data_source: null,
        },
      })
    }

    return { path: opts.outPath, pageId: opts.pageId, source: opts.source }
  }).pipe(
    Effect.withSpan('notion-md.track-page', {
      attributes: { 'span.label': opts.pageId.slice(0, 8), 'notion_md.track.source': opts.source },
    }),
  )

/*
 * Tree orchestration (spec "Internal layering"): discover `.nmd` files,
 * duplicate-`page_id` preflight (reject before any mutation), bounded
 * concurrency, per-file result aggregation. Direction-agnostic — it maps the
 * source-aware per-page core over each file via `runBatch`.
 */

/** Read-only status over a file or a recursive directory of `.nmd` files. */
export const statusTree = (opts: {
  readonly targets: readonly string[]
  readonly recursive?: boolean
  readonly concurrency?: number
}): Effect.Effect<
  BatchResult<ReconcileStatus>,
  NmdCliError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  runBatch({
    operation: 'status',
    targets: opts.targets,
    ...(opts.recursive === undefined ? {} : { recursive: opts.recursive }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    run: (path) => statusFile({ path }),
  })

/** Reconcile a file or a recursive directory of `.nmd` files toward in-sync. */
export const reconcileTree = (opts: {
  readonly targets: readonly string[]
  readonly recursive?: boolean
  readonly concurrency?: number
  readonly force?: boolean
  readonly dryRun?: boolean
}): Effect.Effect<
  BatchResult<ReconcileResult>,
  NmdCliError,
  FileSystem.FileSystem | Path.Path | NotionMdGateway | NmdStateStore
> =>
  runBatch({
    operation: 'sync',
    targets: opts.targets,
    ...(opts.recursive === undefined ? {} : { recursive: opts.recursive }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    run: (path) =>
      reconcileFile({
        path,
        ...(opts.force === undefined ? {} : { force: opts.force }),
        ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
      }),
  })
