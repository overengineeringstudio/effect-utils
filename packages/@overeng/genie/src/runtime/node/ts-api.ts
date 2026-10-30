/**
 * Node-only boundary over the TypeScript 7 compiler API (`typescript/unstable/*`).
 *
 * TypeScript 7 ships the Go compiler as the only implementation: the npm package's `.` entry carries
 * version metadata alone, and the classic in-process API (`ts.createSourceFile`, `ts.createProgram`,
 * `ts.transpileModule`, `ts.preProcessFile`, `ts.resolveModuleName`, `ts.sys`) no longer exists. The
 * replacement is a session against the bundled `tsgo` binary: `new API(...)` spawns it, snapshots hold
 * projects, and `Program.getSourceFile` returns a real AST decoded locally, so `node.forEachChild` and
 * the `typescript/unstable/ast` type guards still do the walking in-process.
 *
 * Two shapes cover every first-party consumer:
 *
 * - {@link runTsFileAnalysis} — analyze files that live on disk and belong to no project we control
 *   (`.genie.ts` sources, published `dist` closures). Files are opened LSP-style, so the server picks
 *   the ancestor `tsconfig.json` when there is one and an inferred project otherwise, and module
 *   specifiers resolve exactly as the compiler resolves them for that file.
 * - {@link runTsVirtualProject} — type-check in-memory sources against a synthesized config, replacing
 *   the old `createCompilerHost`/`createProgram` override dance.
 *
 * Both own the session lifetime: the `tsgo` child process is always closed, including on throw.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import type { Writable } from 'node:stream'

import type { SourceFile, StringLiteral } from 'typescript/unstable/ast'
import type { Diagnostic } from 'typescript/unstable/async'
import { API } from 'typescript/unstable/async'

const analyzableSourceExtensions: Record<string, true> = {
  '.ts': true,
  '.tsx': true,
  '.mts': true,
  '.cts': true,
  '.js': true,
  '.jsx': true,
  '.mjs': true,
  '.cjs': true,
}

/**
 * Whether {@link TsFileAnalysisSession.analyze} can open `file` at all. Assets such as `.json`
 * or `.css` carry no TypeScript program, so callers that need analysis must route around them
 * rather than fail on the session's `unsupported-extension` outcome.
 */
export const isAnalyzableSourcePath = (file: string): boolean =>
  analyzableSourceExtensions[path.extname(file)] === true

/**
 * The server the session spawns.
 *
 * The API client's JSON-RPC protocol is versioned with the compiler binary, so the ONLY server
 * guaranteed to speak it is the `@typescript/typescript-<platform>` executable published alongside the
 * `typescript` package we import — which the client resolves itself when no path is configured. A
 * `tsgo` on `PATH` is deliberately NOT considered: the dev shell exposes the Effect-TS fork, whose
 * revision differs from the npm client and answers `updateSnapshot` with zero projects (surfacing as
 * `no project found for file`). `GENIE_TYPESCRIPT_API_SERVER` remains the explicit override, and the
 * Nix packages set it: a `bun build --compile` bundle resolves the client's own files inside `/$bunfs`
 * and therefore cannot find the platform package on disk at all.
 */
const apiSpawnOptions = (cwd: string) => {
  // The upstream client pins stdio to three slots and offers no spawn hook.
  // Install the verified bootstrap descriptor mapper before constructing the API,
  // including compiled Bun products that do not honor runtime preload flags.
  // The actual compiler child owns duplicates until close/exit; parent death
  // cannot release its leases. Never import a lease implementation from a view.
  if (process.env.EDITOR_VIEW_LEASE_ACTIVE === '1') {
    const preload = process.env.EDITOR_VIEW_LEASE_PRELOAD
    if (preload === undefined || path.isAbsolute(preload) === false) {
      throw new Error('TypeScript API requires the bootstrap-safe editor-view lease preload')
    }
    createRequire(path.join(cwd, 'package.json'))(preload)
  }
  const configured = process.env.GENIE_TYPESCRIPT_API_SERVER
  return configured === undefined || configured === '' ? { cwd } : { cwd, tsserverPath: configured }
}

/**
 * The structural equivalent of an `API` session: `close` plus the spawned child, if any.
 *
 * A real `API` cannot be typed as this directly — its `client` field is compile-time `private`
 * (erased at runtime), and a private source property never satisfies a public target one. So
 * `closeApi` accepts the union and performs the single contained structural read itself; tests
 * pass fakes of this shape with no casts.
 */
export type ClosableTsApi = {
  readonly close: () => Promise<void>
  readonly client?:
    | {
        readonly process?: JoinableChildProcess | undefined
        readonly close: () => Promise<void>
      }
    | undefined
}

/** The child surface needed to join and, on a stalled RPC, terminate the server. */
export type JoinableChildProcess = NodeJS.EventEmitter & {
  readonly exitCode: number | null
  readonly signalCode?: NodeJS.Signals | null
  readonly stdin?: Writable | null
  readonly kill: (signal: NodeJS.Signals) => boolean
}

// Repo cold p-max 649/673 ms, all-call max 4.73 s (sync-proof blocking): 20 s gives >4x headroom below Vitest's 30 s.
const apiRequestTimeoutMs = 20_000
const terminationGraceMs = 250
const terminationJoinMs = 1_000

/** A bounded compiler operation that did not respond before its deadline. */
export class TsApiTimeoutError extends Error {
  readonly _tag = 'TsApiTimeoutError'
  readonly stage: string
  readonly timeoutMs: number

  constructor({ stage, timeoutMs }: { stage: string; timeoutMs: number }) {
    super(`TypeScript API stalled at ${stage} for ${timeoutMs} ms`)
    this.name = 'TsApiTimeoutError'
    this.stage = stage
    this.timeoutMs = timeoutMs
  }
}

const apiClient = (api: API | ClosableTsApi) => (api as unknown as ClosableTsApi).client

const childIsAlive = (child: JoinableChildProcess) =>
  child.exitCode === null && child.signalCode == null

const withDeadline = async <A>({
  stage,
  timeoutMs,
  run,
}: {
  stage: string
  timeoutMs: number
  run: () => A | Promise<A>
}): Promise<A> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TsApiTimeoutError({ stage, timeoutMs })), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Attach before closing/signalling: even a synchronous exit cannot be missed. */
const joinChild = async ({
  child,
  timeoutMs,
  initiate,
}: {
  child: JoinableChildProcess
  timeoutMs: number
  initiate: () => void | Promise<void>
}): Promise<void> => {
  let onExit: (() => void) | undefined
  try {
    await withDeadline({
      stage: 'close',
      timeoutMs,
      run: async () => {
        const exited =
          childIsAlive(child) === false
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                onExit = resolve
                child.once('exit', resolve)
              })
        await initiate()
        await exited
      },
    })
  } finally {
    if (onExit !== undefined) child.removeListener('exit', onExit)
  }
}

const terminateApi = async (child: JoinableChildProcess | undefined): Promise<void> => {
  if (child === undefined || childIsAlive(child) === false) return
  try {
    await joinChild({
      child,
      timeoutMs: terminationGraceMs,
      initiate: () => {
        child.kill('SIGTERM')
      },
    })
  } catch (error) {
    if (!(error instanceof TsApiTimeoutError)) throw error
    await joinChild({
      child,
      timeoutMs: terminationJoinMs,
      initiate: () => {
        child.kill('SIGKILL')
      },
    })
  }
}

const withCleanupCause = ({
  error,
  cleanupError,
}: {
  error: unknown
  cleanupError: unknown
}): Error => {
  if (!(error instanceof Error)) {
    return new AggregateError([error, cleanupError], 'TypeScript operation and cleanup failed')
  }
  error.cause =
    error.cause === undefined
      ? cleanupError
      : new AggregateError([error.cause, cleanupError], 'TypeScript cleanup failed')
  return error
}

const apiRequest = async <A>({
  api,
  stage,
  timeoutMs,
  run,
}: {
  api: API
  stage: string
  timeoutMs: number
  run: () => A | Promise<A>
}): Promise<A> => {
  try {
    return await withDeadline({ stage, timeoutMs, run })
  } catch (error) {
    if (error instanceof TsApiTimeoutError) {
      try {
        await terminateApi(apiClient(api)?.process)
      } catch (cleanupError) {
        throw withCleanupCause({ error, cleanupError })
      }
    }
    throw error
  }
}

/**
 * Close the client and join its child; a stalled shutdown is terminated and reported, not hidden.
 * The structural child lookup is pinned to typescript@7.0.2, whose public close() does not join.
 */
export const closeApi = async ({
  api,
  timeoutMs = apiRequestTimeoutMs,
}: {
  api: API | ClosableTsApi
  timeoutMs?: number
}): Promise<void> => {
  const client = apiClient(api)
  const child = client?.process
  const stdin = child?.stdin
  const streamErrors: Error[] = []
  const onStreamError = (error: Error) => {
    streamErrors.push(error)
  }
  // Own errors until stream close, not just child exit: end() can fail asynchronously afterwards.
  const streamClosed =
    stdin === undefined || stdin === null || stdin.closed === true
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          stdin.on('error', onStreamError)
          stdin.once('close', () => {
            stdin.removeListener('error', onStreamError)
            resolve()
          })
        })
  let failure: { error: unknown } | undefined
  try {
    if (child === undefined) {
      await withDeadline({ stage: 'close', timeoutMs, run: () => api.close() })
    } else {
      // Process exit releases every snapshot. API.close() instead sends release RPCs, which race
      // killed stdin and trigger an unhandled rejection in vscode-jsonrpc's async Promise executor.
      await joinChild({ child, timeoutMs, initiate: () => client?.close() })
    }
  } catch (error) {
    failure = { error }
    try {
      await terminateApi(child)
    } catch (cleanupError) {
      failure.error = withCleanupCause({ error, cleanupError })
    }
  }
  // Socket-only sessions still need transport disposal if graceful snapshot release failed.
  try {
    if (child === undefined) {
      await withDeadline({
        stage: 'close',
        timeoutMs: terminationJoinMs,
        run: () => client?.close(),
      })
    }
    await withDeadline({
      stage: 'close',
      timeoutMs: terminationJoinMs,
      run: () => streamClosed,
    })
  } catch (cleanupError) {
    failure = {
      error:
        failure === undefined
          ? cleanupError
          : withCleanupCause({ error: failure.error, cleanupError }),
    }
    stdin?.destroy()
    try {
      await withDeadline({
        stage: 'close',
        timeoutMs: terminationJoinMs,
        run: () => streamClosed,
      })
    } catch (streamCloseError) {
      failure.error = withCleanupCause({ error: failure.error, cleanupError: streamCloseError })
    }
  }
  for (const cleanupError of streamErrors) {
    failure = {
      error:
        failure === undefined
          ? cleanupError
          : withCleanupCause({ error: failure.error, cleanupError }),
    }
  }
  if (failure !== undefined) throw failure.error
}

const withApiSession = async <A>({
  api,
  timeoutMs,
  run,
}: {
  api: API
  timeoutMs: number
  run: () => Promise<A>
}): Promise<A> => {
  let outcome: { ok: true; value: A } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await run() }
  } catch (error) {
    outcome = { ok: false, error }
  }
  try {
    await closeApi({ api, timeoutMs })
  } catch (cleanupError) {
    outcome = {
      ok: false,
      error:
        outcome.ok === true
          ? cleanupError
          : withCleanupCause({ error: outcome.error, cleanupError }),
    }
  }
  if (outcome.ok === false) throw outcome.error
  return outcome.value
}

/** A file opened for analysis: its AST plus the module resolution of the project that owns it. */
export type TsFileAnalysis = {
  /** The parsed source file. */
  readonly sourceFile: SourceFile
  /**
   * Absolute path the given module specifier resolves to, or `undefined` when it does not resolve
   * (an unresolvable bare specifier, or an ambient/virtual module with no declaration file).
   */
  readonly resolveModuleSpecifier: (moduleSpecifier: StringLiteral) => Promise<string | undefined>
}

/**
 * What opening a file produced. "Nothing to analyze" and "the session could not open it" are
 * deliberately distinct: the first is normal (an asset the compiler owns no program for), the second
 * means the walk saw NO code and must fail closed instead of reporting a clean file.
 */
export type TsFileAnalysisOutcome =
  | { readonly kind: 'analyzed'; readonly analysis: TsFileAnalysis }
  /** The extension carries no TypeScript program (assets such as `.css` or `.json`). */
  | { readonly kind: 'unsupported-extension' }
  /** The session declined the file: no project owns it, or its program has no source file for it. */
  | { readonly kind: 'failed'; readonly reason: string }

/** Analysis session over files that are opened one at a time, LSP-style. */
export type TsFileAnalysisSession = {
  /** Open `file` (idempotent) and return its AST plus resolver, or why no analysis was produced. */
  readonly analyze: (file: string) => Promise<TsFileAnalysisOutcome>
}

/** Run `use` against a TypeScript 7 session that analyzes on-disk files, closing the compiler process afterwards. */
export const runTsFileAnalysis = async <A>({
  cwd,
  initialFiles = [],
  use: run,
  requestTimeoutMs = apiRequestTimeoutMs,
}: {
  /** Working directory the compiler resolves relative paths and ancestor configs against. */
  cwd: string
  /** Files to open in the first snapshot so a multi-root walk does not rebuild projects per root. */
  initialFiles?: readonly string[]
  use: (session: TsFileAnalysisSession) => A | Promise<A>
  /** Internal deadline injection for exercising stalled servers without a long-running test. */
  requestTimeoutMs?: number
}): Promise<A> => {
  const api = new API(apiSpawnOptions(cwd))
  return withApiSession({
    api,
    timeoutMs: requestTimeoutMs,
    run: async () => {
      const opened = new Set(initialFiles)
      // Seed multi-root walks in one snapshot. Subsequent snapshots retain every open file so
      // analyzing a newly discovered edge does not evict and rebuild the roots' projects.
      let snapshot = await apiRequest({
        api,
        stage: 'updateSnapshot',
        timeoutMs: requestTimeoutMs,
        run: () =>
          opened.size === 0 ? api.updateSnapshot() : api.updateSnapshot({ openFiles: [...opened] }),
      })

      const analyze = async (file: string): Promise<TsFileAnalysisOutcome> => {
        // The unstable API does not infer a ScriptKind for assets such as CSS and panics if they are opened.
        if (isAnalyzableSourcePath(file) === false) {
          return { kind: 'unsupported-extension' }
        }
        if (opened.has(file) === false) {
          const superseded = snapshot
          opened.add(file)
          // A snapshot pins its server-side projects, programs and ASTs until it is disposed, so every
          // superseded one is released — but only AFTER its replacement exists, so a failed open leaves
          // the current snapshot (and the files already opened in it) intact and usable.
          snapshot = await apiRequest({
            api,
            stage: 'updateSnapshot',
            timeoutMs: requestTimeoutMs,
            run: () => api.updateSnapshot({ openFiles: [...opened] }),
          })
          await apiRequest({
            api,
            stage: 'disposeSnapshot',
            timeoutMs: requestTimeoutMs,
            run: () => superseded.dispose(),
          })
        }
        const project = await apiRequest({
          api,
          stage: 'getDefaultProjectForFile',
          timeoutMs: requestTimeoutMs,
          run: () => snapshot.getDefaultProjectForFile(file),
        })
        if (project === undefined) return { kind: 'failed', reason: 'no project found for file' }
        const sourceFile = await apiRequest({
          api,
          stage: 'getSourceFile',
          timeoutMs: requestTimeoutMs,
          run: () => project.program.getSourceFile(file),
        })
        if (sourceFile === undefined) {
          return { kind: 'failed', reason: 'the owning project has no source file for it' }
        }
        return {
          kind: 'analyzed',
          analysis: {
            sourceFile,
            resolveModuleSpecifier: async (moduleSpecifier) =>
              (
                await apiRequest({
                  api,
                  stage: 'symbol lookup',
                  timeoutMs: requestTimeoutMs,
                  run: () => project.checker.getSymbolAtLocation(moduleSpecifier),
                })
              )?.declarations[0]?.path,
          },
        }
      }

      return await run({ analyze })
    },
  })
}

/** Run `use` against a project synthesized from in-memory sources, closing the compiler process afterwards. */
export const runTsVirtualProject = async <A>({
  root,
  files,
  compilerOptions,
  rootFiles,
  use: run,
}: {
  /** Absolute directory the synthesized config lives in; `files` keys are resolved against it. */
  root: string
  /** In-memory sources keyed by path (absolute, or relative to `root`). */
  files: ReadonlyMap<string, string>
  /** `compilerOptions` for the synthesized config, in tsconfig (string-enum) spelling. */
  compilerOptions: Readonly<Record<string, unknown>>
  /** Root file paths of the synthesized project, in the same spelling as the `files` keys. */
  rootFiles: ReadonlyArray<string>
  use: (project: TsVirtualProject) => A | Promise<A>
}): Promise<A> => {
  const absolute = (file: string): string => path.resolve(root, file)
  const overlay = new Map([...files].map(([file, text]) => [absolute(file), text]))
  const configPath = absolute('tsconfig.genie-virtual.json')
  const configText = JSON.stringify({ compilerOptions, files: rootFiles.map(absolute) })
  const overlayDirectories = new Set(
    [configPath, ...overlay.keys()].map((file) => path.dirname(file)),
  )

  const api = new API({
    ...apiSpawnOptions(root),
    // `undefined` means "fall through to the real filesystem", which is what the bundled `lib.*.d.ts`
    // files and any real dependency of an in-memory source need.
    fs: {
      readFile: (file) => (file === configPath ? configText : overlay.get(file)),
      fileExists: (file) => (file === configPath || overlay.has(file) === true ? true : undefined),
      directoryExists: (directory) =>
        overlayDirectories.has(directory) === true ? true : undefined,
    },
  })
  return withApiSession({
    api,
    timeoutMs: apiRequestTimeoutMs,
    run: async () => {
      const snapshot = await apiRequest({
        api,
        stage: 'updateSnapshot',
        timeoutMs: apiRequestTimeoutMs,
        run: () => api.updateSnapshot({ openProjects: [configPath] }),
      })
      const project = snapshot.getProject(configPath)
      if (project === undefined) {
        throw new Error(`TypeScript API did not open the synthesized project ${configPath}`)
      }
      return await run({
        diagnosticMessages: async () =>
          (
            await Promise.all([
              apiRequest({
                api,
                stage: 'getConfigFileParsingDiagnostics',
                timeoutMs: apiRequestTimeoutMs,
                run: () => project.program.getConfigFileParsingDiagnostics(),
              }),
              apiRequest({
                api,
                stage: 'getProgramDiagnostics',
                timeoutMs: apiRequestTimeoutMs,
                run: () => project.program.getProgramDiagnostics(),
              }),
              apiRequest({
                api,
                stage: 'getSyntacticDiagnostics',
                timeoutMs: apiRequestTimeoutMs,
                run: () => project.program.getSyntacticDiagnostics(),
              }),
              apiRequest({
                api,
                stage: 'getSemanticDiagnostics',
                timeoutMs: apiRequestTimeoutMs,
                run: () => project.program.getSemanticDiagnostics(),
              }),
              // Project-wide semantic errors (a missing lib, an unresolvable global type) belong to no
              // file, so `getSemanticDiagnostics` never reports them — dropping this call is what makes
              // a broken lib pass vacuously.
              apiRequest({
                api,
                stage: 'getGlobalDiagnostics',
                timeoutMs: apiRequestTimeoutMs,
                run: () => project.program.getGlobalDiagnostics(),
              }),
            ])
          )
            .flat()
            .map(formatDiagnostic),
      })
    },
  })
}

/** A synthesized in-memory project. */
export type TsVirtualProject = {
  /** Config, program-wide, syntactic, semantic and global diagnostics as flattened messages. */
  readonly diagnosticMessages: () => Promise<ReadonlyArray<string>>
}

/**
 * Flatten a diagnostic and its message chain into one newline-joined message — the TypeScript 7
 * equivalent of `ts.flattenDiagnosticMessageText`, which took the classic `messageText` union.
 */
export const formatDiagnostic = (diagnostic: Diagnostic): string =>
  [
    diagnostic.text,
    ...(diagnostic.messageChain ?? []).map((nested) => formatDiagnostic(nested)),
  ].join('\n')
