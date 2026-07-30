import { join } from 'node:path'

import { ChildProcess as PlatformCommand, type ChildProcessSpawner as CommandExecutor } from 'effect/unstable/process'
import { FileSystem } from 'effect/FileSystem'
import { Console, Effect } from 'effect'

import { describeBodyLossyRefusal } from '@overeng/notion-core'
import type { Sha256Digest } from '@overeng/notion-effect-client'

import {
  observeRemoteEditorPage,
  replaceRemoteBodyForced,
  replaceRemoteBodyVerified,
} from './body-facade.ts'
import { semanticEquivalent } from './canonical-markdown.ts'
import { editorBaseHash, parseTitleBody, serializeTitleBody } from './editor-surface.ts'
import {
  NmdConflictError,
  NmdEditorAbortedError,
  NmdGatewayError,
  NmdInvalidDocumentError,
  NmdPartialWriteError,
  NmdPostPushGateError,
  NmdRemoteBodyLossyError,
  type NmdError,
} from './errors.ts'
import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import { NotionMdGateway } from './model.ts'
import {
  annotateAttrs,
  CatSpan,
  EditSpan,
  editResultAttrs,
  PutSpan,
  putResultAttrs,
  withRootOperation,
} from './observability.ts'
import { reportNote } from './progress.ts'
import type { NmdStateStore } from './state-store.ts'
import { buildFrontmatterV2, pullPage, syncPageReplacingBody } from './sync.ts'

/** Editor representation mode for `cat` / `put` / `edit`. */
export type EditorMode = 'default' | 'frontmatter'

// ---------------------------------------------------------------------------
// cat
// ---------------------------------------------------------------------------

/** Inputs for the `cat` editor projection of a Notion page. */
export interface CatOptions {
  readonly pageId: string
  readonly mode: EditorMode
  /** Sink for the base-hash stderr line (decision 0002). Overridable for tests. */
  readonly writeStderr?: (line: string) => Effect.Effect<void>
  /** Sink for the Markdown / envelope stdout. Overridable for tests. */
  readonly writeStdout?: (value: string) => Effect.Effect<void>
}

/** Outcome of a `cat` invocation (base hash present only in default mode). */
export interface CatResult {
  readonly pageId: string
  readonly mode: EditorMode
  readonly baseHash?: Sha256Digest
}

/** A projected editor buffer for a page (base hash present only in default mode). */
interface ProjectedPageBuffer {
  readonly pageId: string
  readonly buffer: string
  readonly baseHash?: Sha256Digest
}

/**
 * Project a Notion page into the editor buffer for the active mode, refusing a
 * lossy page (exit 3) at observe/pull time. The single source of truth for the
 * `cat` / read-only `edit` presentation: default mode is `# title` + body (via
 * `observeRemoteEditorPage`), `--frontmatter` is the full strict `.nmd` envelope
 * (via the engine pull). Pure projection — no stdout/stderr side effects — so
 * each caller owns its own sinks (`cat`'s `base-hash:` line, the byte-exact pipe
 * output) without duplicating the lossy-refusal logic.
 */
const projectPageBuffer = (opts: {
  readonly pageId: string
  readonly mode: EditorMode
}): Effect.Effect<ProjectedPageBuffer, NmdError, NotionMdGateway> =>
  Effect.gen(function* () {
    if (opts.mode === 'frontmatter') {
      const gateway = yield* NotionMdGateway
      const pulled = yield* gateway.pullPage({ pageId: opts.pageId })
      const completeness = pulled.markdown.completeness
      if (completeness !== undefined && completeness._tag !== 'complete') {
        return yield* new NmdRemoteBodyLossyError({
          operation: 'cat_frontmatter',
          page_id: pulled.page.id,
          reasons: [...completeness.reasons],
          message: describeBodyLossyRefusal({
            pageId: pulled.page.id,
            completeness,
            context: 'refusing to dump a lossy page envelope',
          }),
        })
      }
      return {
        pageId: pulled.page.id,
        buffer: renderNmdFile({
          frontmatter: buildFrontmatterV2({ page: pulled.page }),
          body: pulled.markdown.markdown,
        }),
      }
    }

    const snapshot = yield* observeRemoteEditorPage({ pageId: opts.pageId })
    return {
      pageId: snapshot.pageId,
      buffer: serializeTitleBody({ title: snapshot.title, body: snapshot.body }),
      baseHash: snapshot.baseHash,
    }
  })

/**
 * `cat <page> [--frontmatter]` — emit the editor projection of a Notion page.
 *
 * Default mode prints `# <title>` + body to stdout and the title+body base hash
 * (decisions 0001/0002/0006) to **stderr** (`base-hash: sha256:…`), keeping
 * stdout pure Markdown for clean piping. `--frontmatter` is a read-only dump of
 * the full strict `.nmd` envelope (no store written, decision 0017). Both modes
 * refuse a lossy page (exit 3) at observe time.
 */
export const catEditorPage = (
  opts: CatOptions,
): Effect.Effect<CatResult, NmdError, NotionMdGateway> =>
  Effect.gen(function* () {
    // Byte-exact stdout (no trailing newline added): `serializeTitleBody` /
    // `renderNmdFile` already end in `\n`, and the exact bytes are load-bearing
    // for the cross-machine base hash an independent implementation reproduces.
    const writeStdout =
      opts.writeStdout ?? ((value: string) => Effect.sync(() => void process.stdout.write(value)))
    const writeStderr = opts.writeStderr ?? Console.error

    const projected = yield* projectPageBuffer({ pageId: opts.pageId, mode: opts.mode })
    yield* writeStdout(projected.buffer)
    if (projected.baseHash !== undefined) {
      yield* writeStderr(`base-hash: ${projected.baseHash}`)
    }
    return {
      pageId: projected.pageId,
      mode: opts.mode,
      ...(projected.baseHash === undefined ? {} : { baseHash: projected.baseHash }),
    }
  }).pipe(
    withRootOperation({ operation: CatSpan, attributes: { pageId: opts.pageId, mode: opts.mode } }),
  )

// ---------------------------------------------------------------------------
// put
// ---------------------------------------------------------------------------

/** Inputs for a guarded `put` title+body write. */
export interface PutOptions {
  readonly pageId: string
  /** Default-mode editor buffer: `# <title>` + body. */
  readonly buffer: string
  /** Optimistic-concurrency token from a prior `cat` (decision 0002). */
  readonly baseHash?: Sha256Digest
  /** Concurrency-only override (decision 0009): bypass the exit-7 guard, nothing else. */
  readonly force: boolean
}

/** Outcome of a completed `put`: which surfaces were written and the new base hash. */
export interface PutResult {
  readonly pageId: string
  readonly bodyWritten: boolean
  readonly titleWritten: boolean
  readonly forced: boolean
  readonly baseHash: Sha256Digest
}

/**
 * `put <page> (--base-hash <h> | --force)` — guarded title+body write.
 *
 * Two writes, body first (decision 0012): the body via `replaceRemoteBodyVerified`
 * (a `replace_content` that can never destroy an opaque block, since the page is
 * representable), then the title via the typed page API. A partial failure (one
 * write landed, the other failed) reports which landed and exits 10. The default
 * guard re-reads the remote, recomputes the title+body hash, and refuses with
 * exit 7 on drift; `--force` bypasses only that guard (decision 0009). There is
 * no `--frontmatter` write (decision 0017).
 */
export const putEditorPage = (
  opts: PutOptions,
): Effect.Effect<
  PutResult,
  | NmdError
  | NmdInvalidDocumentError
  | NmdConflictError
  | NmdPartialWriteError
  | NmdPostPushGateError,
  NotionMdGateway
> =>
  Effect.gen(function* () {
    const gateway = yield* NotionMdGateway
    const doc = yield* parseTitleBody({ buffer: opts.buffer, pageId: opts.pageId })

    // Observe the current remote title+body (refuses a lossy page, exit 3) and
    // form the guard base.
    const current = yield* observeRemoteEditorPage({ pageId: opts.pageId })

    if (opts.force === false) {
      if (opts.baseHash === undefined) {
        // Defensive: the CLI enforces --base-hash | --force, but keep the engine honest.
        return yield* new NmdInvalidDocumentError({
          page_id: opts.pageId,
          message:
            'put requires either --base-hash <hash> (guarded) or --force (concurrency override).',
        })
      }
      if (current.baseHash !== opts.baseHash) {
        return yield* new NmdConflictError({
          path: opts.pageId,
          page_id: opts.pageId,
          local_changed: true,
          remote_changed: true,
          message:
            `Remote page ${opts.pageId} moved since the supplied --base-hash ` +
            `(expected ${opts.baseHash}, current ${current.baseHash}). Re-cat and retry, or --force.`,
        })
      }
    }

    // --- Write 1: body (replace_content). ---
    // Guarded: `current.body` is the facade-normalized remote body, so its digest
    // is exactly the body-only base hash `replaceRemoteBodyVerified` expects; a
    // remote change between this observe and the facade's internal re-pull trips
    // the inner guard and maps to exit 7 (a correct bonus TOCTOU catch). Force:
    // skip the pre-write compare entirely (last-writer-wins, decision 0009) — the
    // verified path would *die* on a concurrent change rather than overwrite.
    const replaced =
      opts.force === true
        ? yield* replaceRemoteBodyForced({ pageId: opts.pageId, markdown: doc.body })
        : yield* replaceRemoteBodyVerified({
            pageId: opts.pageId,
            baseBodyHash: sha256Digest(normalizeMarkdownLineEndings(current.body)),
            markdown: doc.body,
          }).pipe(
            Effect.catchTag(
              'NotionMdBodyConflictError',
              () =>
                new NmdConflictError({
                  path: opts.pageId,
                  page_id: opts.pageId,
                  local_changed: true,
                  remote_changed: true,
                  message: `Remote body for page ${opts.pageId} changed before verified replace; re-cat and retry, or --force.`,
                }),
            ),
          )

    // --- Write 2: title (typed page API). A failure here is a partial write. ---
    if (doc.title !== current.title) {
      yield* gateway
        .updatePageMetadata({
          pageId: opts.pageId,
          metadata: { title: { key: current.titlePropertyKey, value: doc.title } },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new NmdPartialWriteError({
                page_id: opts.pageId,
                body_written: true,
                title_written: false,
                message:
                  `put landed the body write but the title write failed for page ${opts.pageId}; ` +
                  'the page is in a mixed state with a stale base hash. Re-cat to recover.',
                cause,
              }),
          ),
        )
    }

    // --- Post-push semantic-equivalence gate (decision 0012; exit 9). ---
    if (semanticEquivalent({ a: replaced.markdown, b: doc.body }) === false) {
      return yield* new NmdPostPushGateError({
        page_id: opts.pageId,
        message:
          `Post-push gate rejected the result for page ${opts.pageId}: the stored body is not ` +
          'semantically equivalent to what was sent. The page may be mutated; re-cat to inspect.',
      })
    }

    const finalBaseHash = editorBaseHash({ title: doc.title, body: replaced.markdown })
    return {
      pageId: opts.pageId,
      bodyWritten: true,
      titleWritten: doc.title !== current.title,
      forced: opts.force,
      baseHash: finalBaseHash,
    }
  }).pipe(
    Effect.tap((result) =>
      annotateAttrs({
        attributes: putResultAttrs,
        value: {
          bodyWritten: result.bodyWritten,
          titleWritten: result.titleWritten,
        },
      }),
    ),
    withRootOperation({
      operation: PutSpan,
      attributes: { pageId: opts.pageId, force: opts.force },
    }),
  )

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

/** Inputs for an ephemeral `edit` editor session. */
export interface EditOptions {
  readonly pageId: string
  readonly mode: EditorMode
  /** Original `<page>` token, used to name the durable conflict sibling. */
  readonly pageRef: string
  /**
   * Launch the editor on the buffer file. Defaults to spawning
   * `$VISUAL`→`$EDITOR`→`vi` and returning its exit code. Overridable for tests
   * (a scripted non-interactive editor).
   */
  readonly runEditor?: (opts: {
    readonly filePath: string
  }) => Effect.Effect<
    number,
    NmdGatewayError,
    CommandExecutor.CommandExecutor | FileSystem.FileSystem
  >
}

/** Outcome of an `edit` session: pushed, no-op, or relocated-conflict. */
export interface EditResult {
  readonly pageId: string
  readonly outcome: 'pushed' | 'noop' | 'conflict'
  readonly conflictPath?: string
}

const resolveEditorCommand = (): string => process.env['VISUAL'] ?? process.env['EDITOR'] ?? 'vi'

const defaultRunEditor = (opts: {
  readonly filePath: string
}): Effect.Effect<number, NmdGatewayError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const editor = resolveEditorCommand()
    // Split a possibly-flagged editor command (e.g. `code --wait`) on whitespace.
    // oxlint-disable-next-line unicorn/prefer-array-find -- tokenizing into ALL non-empty parts (bin + ...args), not finding one element
    const [bin, ...args] = editor.split(/\s+/u).filter((part) => part.length > 0)
    const command = PlatformCommand.make(bin ?? 'vi', ...args, opts.filePath).pipe(
      PlatformCommand.stdin('inherit'),
      PlatformCommand.stdout('inherit'),
      PlatformCommand.stderr('inherit'),
    )
    return yield* PlatformCommand.exitCode(command).pipe(
      Effect.mapError(
        (cause) =>
          new NmdGatewayError({
            operation: 'edit_spawn_editor',
            message: `Failed to launch editor \`${editor}\`: ${String(cause)}`,
            cause,
          }),
      ),
    )
  })

/**
 * `edit <page> [--frontmatter]` — ephemeral file-engine editor session
 * (decision 0017). Not a second push engine: pull the page into a `.nmd` +
 * `.notion-md/` under `$TMPDIR`, present the body in `$EDITOR`, splice the edit
 * back, push through the engine's guarded `syncPage` (forcing a full-body
 * `replace_content`), relocate any `.conflict.roughdraft.md` out of `$TMPDIR` to
 * a durable `<page>.conflict.md`, and scope-clean the temp tree on every path
 * (success / conflict / abort / interrupt). A non-zero editor exit aborts with
 * exit 8 and nothing is pushed; an unchanged buffer is a no-op.
 */
export const editEditorPage = (
  opts: EditOptions,
): Effect.Effect<
  EditResult,
  NmdError | NmdInvalidDocumentError | NmdEditorAbortedError,
  FileSystem.FileSystem | NotionMdGateway | NmdStateStore | CommandExecutor.CommandExecutor
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const runEditor = opts.runEditor ?? defaultRunEditor
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'notion-md-edit-' }).pipe(
        Effect.mapError(
          (cause) =>
            new NmdGatewayError({
              operation: 'edit_mktemp',
              page_id: opts.pageId,
              message: `Failed to create editor session temp dir: ${String(cause)}`,
              cause,
            }),
        ),
      )
      const nmdPath = join(dir, 'page.nmd')

      // 1. Pull into the ephemeral session (refuses a lossy page here, exit 3).
      yield* pullPage({ pageId: opts.pageId, outPath: nmdPath })

      // 2. Project the editor buffer (default: # title + body; frontmatter: envelope).
      const original = yield* fs
        .readFileString(nmdPath)
        .pipe(Effect.mapError(editorIoError({ pageId: opts.pageId, path: nmdPath })))
      const buffer = yield* projectEditorBuffer({ mode: opts.mode, envelope: original })
      const bufferPath = join(dir, opts.mode === 'frontmatter' ? 'page.nmd' : 'page.md')
      yield* fs
        .writeFileString(bufferPath, buffer)
        .pipe(Effect.mapError(editorIoError({ pageId: opts.pageId, path: bufferPath })))

      // 3. Launch the editor.
      const exitCode = yield* runEditor({ filePath: bufferPath })
      if (exitCode !== 0) {
        return yield* new NmdEditorAbortedError({
          page_id: opts.pageId,
          editor: resolveEditorCommand(),
          exit_code: exitCode,
          message: `Editor exited with code ${exitCode}; nothing was pushed for page ${opts.pageId}.`,
        })
      }

      const edited = yield* fs
        .readFileString(bufferPath)
        .pipe(Effect.mapError(editorIoError({ pageId: opts.pageId, path: bufferPath })))

      // 4. Unchanged buffer → no-op.
      if (edited === buffer) {
        return { pageId: opts.pageId, outcome: 'noop' as const }
      }

      // 5. Splice the edit back into the envelope and write the temp .nmd.
      const reattached = yield* reattachEditorBuffer({
        mode: opts.mode,
        envelope: original,
        edited,
        pageId: opts.pageId,
        path: nmdPath,
      })
      yield* fs
        .writeFileString(nmdPath, reattached)
        .pipe(Effect.mapError(editorIoError({ pageId: opts.pageId, path: nmdPath })))

      // 6. Push through the engine (full-body replace_content, decision 0017).
      return yield* syncPageReplacingBody({ path: nmdPath }).pipe(
        Effect.as<EditResult>({ pageId: opts.pageId, outcome: 'pushed' }),
        Effect.catchTag('NmdConflictError', (error) =>
          relocateConflict({ fs, error, pageRef: opts.pageRef, pageId: opts.pageId }),
        ),
      )
    }),
  ).pipe(
    Effect.tap((result) =>
      annotateAttrs({ attributes: editResultAttrs, value: { outcome: result.outcome } }),
    ),
    Effect.catchTag('NmdEditorAbortedError', (error) =>
      annotateAttrs({ attributes: editResultAttrs, value: { outcome: 'aborted' } }).pipe(
        Effect.zipRight(Effect.fail(error)),
      ),
    ),
    withRootOperation({
      operation: EditSpan,
      attributes: { pageId: opts.pageId, mode: opts.mode },
    }),
  )

// ---------------------------------------------------------------------------
// edit --read-only
// ---------------------------------------------------------------------------

/** Inputs for a read-only `edit --read-only` inspection session. */
export interface ReadOnlyEditOptions {
  readonly pageId: string
  readonly mode: EditorMode
  /**
   * Sink for the `read-only: changes were not synced` note. Defaults to
   * `Console.error` (stderr); overridable for tests.
   */
  readonly writeStderr?: (line: string) => Effect.Effect<void>
  /**
   * Launch the editor on the buffer file. Same default as `edit`
   * (`$VISUAL`→`$EDITOR`→`vi`); overridable for tests.
   */
  readonly runEditor?: (opts: {
    readonly filePath: string
  }) => Effect.Effect<
    number,
    NmdGatewayError,
    CommandExecutor.CommandExecutor | FileSystem.FileSystem
  >
}

/** Outcome of a read-only `edit --read-only` session (always a discarding no-op). */
export interface ReadOnlyEditResult {
  readonly pageId: string
  readonly outcome: 'read-only'
}

/**
 * `edit <page> --read-only [--frontmatter]` — open the page in `$EDITOR` for
 * inspection only (the terminal analogue of `vim -R` / `git show`).
 *
 * Reuses the exact `cat` presentation via `projectPageBuffer` (default `# title`
 * + body, or the full `.nmd` envelope with `--frontmatter`), refusing a lossy
 * page (exit 3) at observe/pull time just like `edit`/`cat`. Unlike `edit`, this
 * is a deliberately lighter path: a single observe/pull into a `$TMPDIR` temp
 * file (no engine round-trip, no `NmdStateStore`). On editor exit — **regardless
 * of the exit code** — nothing is ever pushed or written remotely (no
 * `syncPage`, no `replaceRemoteBodyVerified`, no metadata/property writes); every
 * edit is discarded, the scoped temp tree is reaped, a `read-only: changes were
 * not synced` note is printed to stderr, and the session exits 0. There is no
 * base-hash/guard machinery because nothing is written.
 */
export const editReadOnlyPage = (
  opts: ReadOnlyEditOptions,
): Effect.Effect<
  ReadOnlyEditResult,
  NmdError,
  FileSystem.FileSystem | NotionMdGateway | CommandExecutor.CommandExecutor
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const runEditor = opts.runEditor ?? defaultRunEditor
      const writeStderr = opts.writeStderr ?? Console.error

      // 1. Observe/pull the page projection (refuses a lossy page here, exit 3).
      const projected = yield* projectPageBuffer({ pageId: opts.pageId, mode: opts.mode })

      // 2. Materialize the buffer in a scoped temp tree (reaped on every path).
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'notion-md-view-' }).pipe(
        Effect.mapError(
          (cause) =>
            new NmdGatewayError({
              operation: 'edit_read_only_mktemp',
              page_id: opts.pageId,
              message: `Failed to create read-only session temp dir: ${String(cause)}`,
              cause,
            }),
        ),
      )
      const bufferPath = join(dir, opts.mode === 'frontmatter' ? 'page.nmd' : 'page.md')
      yield* fs
        .writeFileString(bufferPath, projected.buffer)
        .pipe(Effect.mapError(editorIoError({ pageId: opts.pageId, path: bufferPath })))

      // 3. Launch the editor for inspection. The exit code is irrelevant: there
      // is nothing to push, so a non-zero exit is just a clean no-op too.
      yield* runEditor({ filePath: bufferPath })

      // 4. Always discard. Never push, never write anything remote.
      yield* writeStderr('read-only: changes were not synced')
      return { pageId: opts.pageId, outcome: 'read-only' as const }
    }),
  ).pipe(
    Effect.tap((result) =>
      annotateAttrs({ attributes: editResultAttrs, value: { outcome: result.outcome } }),
    ),
    withRootOperation({
      operation: EditSpan,
      attributes: { pageId: opts.pageId, mode: opts.mode },
    }),
  )

const editorIoError =
  (ctx: { readonly pageId: string; readonly path: string }) =>
  (cause: unknown): NmdGatewayError =>
    new NmdGatewayError({
      operation: 'edit_session_io',
      page_id: ctx.pageId,
      message: `Editor session IO failed for ${ctx.path}: ${String(cause)}`,
      cause,
    })

/** Project the temp `.nmd` envelope into the editor buffer for the active mode. */
const projectEditorBuffer = (opts: {
  readonly mode: EditorMode
  readonly envelope: string
}): Effect.Effect<string, NmdError | NmdInvalidDocumentError> =>
  Effect.gen(function* () {
    if (opts.mode === 'frontmatter') return opts.envelope
    const parsed = yield* parseNmdFile({ path: 'edit-session', content: opts.envelope })
    return serializeTitleBody({ title: parsed.frontmatter.notion_md.page.title, body: parsed.body })
  })

/** Splice the edited buffer back into the temp `.nmd` envelope for the active mode. */
const reattachEditorBuffer = (opts: {
  readonly mode: EditorMode
  readonly envelope: string
  readonly edited: string
  readonly pageId: string
  readonly path: string
}): Effect.Effect<string, NmdError | NmdInvalidDocumentError> =>
  Effect.gen(function* () {
    if (opts.mode === 'frontmatter') return opts.edited
    const parsed = yield* parseNmdFile({ path: opts.path, content: opts.envelope })
    const doc = yield* parseTitleBody({ buffer: opts.edited, pageId: opts.pageId })
    return renderNmdFile({
      frontmatter: {
        notion_md: {
          ...parsed.frontmatter.notion_md,
          page: { ...parsed.frontmatter.notion_md.page, title: doc.title },
        },
      },
      body: doc.body,
    })
  })

/**
 * Copy the engine's `.conflict.roughdraft.md` (written inside `$TMPDIR`, which is
 * reaped on scope close) to a durable `<page>.conflict.md` sibling in the cwd so
 * a conflicted edit is recoverable, and return a conflict outcome.
 */
const relocateConflict = (opts: {
  readonly fs: FileSystem.FileSystem
  readonly error: NmdConflictError
  readonly pageRef: string
  readonly pageId: string
}): Effect.Effect<EditResult, NmdError> =>
  Effect.gen(function* () {
    const source = opts.error.conflict_path
    const durable = `${sanitizePageRef(opts.pageRef)}.conflict.md`
    if (source !== undefined) {
      const contents = yield* opts.fs
        .readFileString(source)
        .pipe(Effect.mapError(editorIoError({ pageId: opts.pageId, path: source })))
      yield* opts.fs
        .writeFileString(durable, contents)
        .pipe(Effect.mapError(editorIoError({ pageId: opts.pageId, path: durable })))
    }
    /*
     * Surface the conflict on stderr with the DURABLE path (not the engine's
     * $TMPDIR roughdraft, which `relocateConflict` has just reaped). The note is
     * emitted here, after relocation, so the path it names still exists.
     */
    yield* reportNote(
      `remote changed and overlaps your edit — wrote conflict draft to ${durable}; nothing pushed`,
    )
    return { pageId: opts.pageId, outcome: 'conflict', conflictPath: durable }
  })

/** Turn an arbitrary `<page>` token into a filesystem-safe basename. */
const sanitizePageRef = (pageRef: string): string =>
  pageRef.replace(/^https?:\/\//u, '').replace(/[^A-Za-z0-9._-]/gu, '_') || 'page'
