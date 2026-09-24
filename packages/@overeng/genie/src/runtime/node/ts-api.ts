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

import { once } from 'node:events'
import path from 'node:path'

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
  readonly client?: { readonly process?: JoinableChildProcess | undefined } | undefined
}

/**
 * The minimal child surface the joined shutdown needs: liveness plus the exit event. A real
 * `ChildProcess` satisfies this; the unit test fakes it with an `EventEmitter` and an `exitCode`.
 */
export type JoinableChildProcess = NodeJS.EventEmitter & { readonly exitCode: number | null }

/**
 * Close an API session and do not resolve until its `tsgo` child has actually exited.
 *
 * `API.close()` ends the child's stdin but returns without awaiting child exit (about 1 ms while
 * the child is still alive), leaving unjoined process lifetime behind every session. Harmless on
 * Linux, where the child exits within milliseconds, but on macOS the lingering stdio handles stall
 * Vitest's close phase past its deadline. The client offers no public join surface (`Client` is
 * not exported from `typescript/unstable/async`), so the boundary reads the erased
 * `client.process` field structurally and joins it. Pinned to `typescript@7.0.2`: if a bump
 * reshapes the client, the lookup yields `undefined` and shutdown degrades to plain `close()`.
 *
 * Deliberately no timeout: a child that never exits is a real hang and must surface loudly,
 * not be masked by a deadline.
 */
export const closeApi = async (api: API | ClosableTsApi): Promise<void> => {
  const child = (api as unknown as ClosableTsApi).client?.process
  await api.close()
  // The check and the listener attach run synchronously after `close()` resolves, before the event
  // loop can deliver the child's exit — so `exitCode === null` means the `exit` event is still to
  // come and `once` cannot miss it.
  if (child !== undefined && child.exitCode === null) {
    await once(child, 'exit')
  }
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
}: {
  /** Working directory the compiler resolves relative paths and ancestor configs against. */
  cwd: string
  /** Files to open in the first snapshot so a multi-root walk does not rebuild projects per root. */
  initialFiles?: readonly string[]
  use: (session: TsFileAnalysisSession) => A | Promise<A>
}): Promise<A> => {
  const api = new API(apiSpawnOptions(cwd))
  try {
    const opened = new Set(initialFiles)
    // Seed multi-root walks in one snapshot. Subsequent snapshots retain every open file so
    // analyzing a newly discovered edge does not evict and rebuild the roots' projects.
    let snapshot =
      opened.size === 0
        ? await api.updateSnapshot()
        : await api.updateSnapshot({ openFiles: [...opened] })

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
        snapshot = await api.updateSnapshot({ openFiles: [...opened] })
        await superseded.dispose()
      }
      const project = await snapshot.getDefaultProjectForFile(file)
      if (project === undefined) return { kind: 'failed', reason: 'no project found for file' }
      const sourceFile = await project.program.getSourceFile(file)
      if (sourceFile === undefined) {
        return { kind: 'failed', reason: 'the owning project has no source file for it' }
      }
      return {
        kind: 'analyzed',
        analysis: {
          sourceFile,
          resolveModuleSpecifier: async (moduleSpecifier) =>
            (await project.checker.getSymbolAtLocation(moduleSpecifier))?.declarations[0]?.path,
        },
      }
    }

    return await run({ analyze })
  } finally {
    await closeApi(api)
  }
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
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [configPath] })
    const project = snapshot.getProject(configPath)
    if (project === undefined) {
      throw new Error(`TypeScript API did not open the synthesized project ${configPath}`)
    }
    return await run({
      diagnosticMessages: async () =>
        (
          await Promise.all([
            project.program.getConfigFileParsingDiagnostics(),
            project.program.getProgramDiagnostics(),
            project.program.getSyntacticDiagnostics(),
            project.program.getSemanticDiagnostics(),
            // Project-wide semantic errors (a missing lib, an unresolvable global type) belong to no
            // file, so `getSemanticDiagnostics` never reports them — dropping this call is what makes
            // a broken lib pass vacuously.
            project.program.getGlobalDiagnostics(),
          ])
        )
          .flat()
          .map(formatDiagnostic),
    })
  } finally {
    await closeApi(api)
  }
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
