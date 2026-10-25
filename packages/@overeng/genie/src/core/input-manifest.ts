import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Effect, Exit, Schema, Semaphore } from 'effect'

import {
  canonicalJson,
  compareUtf8,
  isCanonicalNodeBuiltin,
} from '../runtime/node/input-observations.ts'
import type { InputReason } from '../runtime/node/input-observations.ts'
import {
  beginInputRecording,
  endInputRecording,
  getInputRecording,
  inputFileSystem,
  inputReadFileSync,
  isInputRecording,
  isInputRecordingComplete,
  isReadSetRecording,
  markInputRecordingIncomplete,
  recordInput,
  recordInputReason,
  recordInputResolution,
  setInputGenerators,
} from '../runtime/node/inputs.ts'
import type {
  ClosureAnalyzer,
  createClosureAnalyzer,
  matchDependencyAllowlist,
} from './closure-analyzer.ts'
import { GenieGenerationFailedError } from './errors.ts'
import { resolveImportMapSpecifierForImporterSync } from './import-map/sync-resolver.ts'

const recordingPermit = Semaphore.makeUnsafe(1)

type SourceReason = Omit<Parameters<typeof recordInputReason>[0], 'generators'>
type SourceModule = {
  module: string
  children: Array<string>
  reasons: Array<SourceReason>
  legacyChildren?: Array<string>
  legacyFailure?: boolean
}

/** Expand callers over cached edges, including cycles, without rereading source bytes. */
export const accountSourceGraph = ({
  entries,
  graph,
}: {
  entries: ReadonlyArray<{ module: string; generator: string }>
  graph: ReadonlyMap<string, SourceModule>
}): Array<Parameters<typeof recordInputReason>[0]> => {
  const callers = new Map<string, Set<string>>()
  const pending = [...entries]
  while (pending.length > 0) {
    const { module, generator } = pending.pop()!
    const affected = callers.get(module) ?? new Set<string>()
    if (affected.has(generator) === true) continue
    affected.add(generator)
    callers.set(module, affected)
    for (const child of graph.get(module)?.children ?? []) {
      pending.push({ module: child, generator })
    }
  }
  const reasons: Array<Parameters<typeof recordInputReason>[0]> = []
  for (const [key, node] of graph) {
    const generators = [...(callers.get(key) ?? [])].toSorted(compareUtf8)
    if (generators.length === 0) continue
    for (const reason of node.reasons) reasons.push({ ...reason, generators })
  }
  return reasons
}

type AnalysisApi = {
  createClosureAnalyzer: typeof createClosureAnalyzer
  matchDependencyAllowlist: typeof matchDependencyAllowlist
}
/** The parser/cache is not loaded for ordinary checks or legacy manifest recording. */
const readSetAnalysis = (): AnalysisApi => require('./closure-analyzer.ts')
/** Record and attribute the source graph even when Bun has cached imported modules. */
export const recordGeneratorSourceGraph = async ({
  entries,
  cwd,
}: {
  entries: ReadonlyArray<string>
  cwd: string
}): Promise<void> => {
  if (isInputRecording() === false) return
  const relative = (sourcePath: string): string =>
    path.relative(cwd, sourcePath).split(path.sep).join('/')
  const sourceEntries = entries.map((entry) => path.resolve(cwd, entry))
  const generators = sourceEntries.map(relative).toSorted(compareUtf8)
  setInputGenerators(generators)
  const engineMode = getInputRecording()?.evidence?.engineMode
  const accountEngine = isReadSetRecording() === true && engineMode !== undefined
  if (accountEngine === true && engineMode !== 'source') {
    for (const [operation, module] of [
      ['engine-analysis-unavailable', '@overeng/genie'],
      ['validator-analysis-unavailable', '@overeng/genie/src/core/validation.ts'],
    ])
      recordInputReason({
        code: 'unknown-capability',
        operation: operation!,
        detail: `Engine execution mode ${engineMode} has no proven source closure for data-capability accounting.`,
        source: { module: module!, line: null },
        evidence: 'unproven',
        generators,
      })
  }
  const engineEntries =
    accountEngine === true && engineMode === 'source'
      ? ['../../bin/genie.tsx', './core.ts', './generation.ts', './validation.ts'].map((entry) =>
          fileURLToPath(new URL(entry, import.meta.url)),
        )
      : []
  const accountingEntries = [
    ...sourceEntries.map((module) => ({ module, generator: relative(module) })),
    ...engineEntries.flatMap((module) => generators.map((generator) => ({ module, generator }))),
  ]
  const pending = [...sourceEntries, ...engineEntries]
  const graph = new Map<string, SourceModule>()
  const opaqueModules = new Set<string>()
  const recordedScopes = new Set<string>()
  const packageMetadata =
    isReadSetRecording() === true
      ? new Map<string, { name: string; version?: string }>()
      : undefined
  const decodePackageMetadata =
    isReadSetRecording() === true
      ? Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              name: Schema.String,
              version: Schema.optionalKey(Schema.String),
            }),
          ),
        )
      : undefined
  let lockPackages: Readonly<Record<string, { resolution?: { integrity?: string } }>> | undefined
  if (isReadSetRecording() === true) {
    const decodeLock = Schema.decodeUnknownSync(
      Schema.Struct({
        packages: Schema.Record(
          Schema.String,
          Schema.Struct({
            resolution: Schema.optionalKey(
              Schema.Struct({
                integrity: Schema.optionalKey(Schema.String),
              }),
            ),
          }),
        ),
      }),
    )
    try {
      lockPackages = decodeLock(
        Bun.YAML.parse(inputReadFileSync(path.join(cwd, 'pnpm-lock.yaml'), 'utf8')),
      ).packages
    } catch {
      // A missing/unrecognized integrity can never match an approval.
    }
  }
  const transpilers = {
    ts: new Bun.Transpiler({ loader: 'ts' }),
    tsx: new Bun.Transpiler({ loader: 'tsx' }),
  }
  let analysisApi: AnalysisApi | undefined
  let analyzer: ClosureAnalyzer | undefined
  const analysisFailure = (): void =>
    recordInputReason({
      code: 'unknown-capability',
      operation: 'analysis-unavailable',
      detail: 'Static closure analyzer lifecycle failed; legacy scanning remains independent.',
      source: { module: '@overeng/genie', line: null },
      evidence: 'unproven',
      generators,
    })
  if (isReadSetRecording() === true) {
    try {
      analysisApi = readSetAnalysis()
      analyzer = analysisApi.createClosureAnalyzer({ cwd })
    } catch {
      analysisFailure()
    }
  }
  const reviewedBoundaries =
    isReadSetRecording() === true
      ? [
          '../runtime/node/inputs.ts',
          '../runtime/node/input-observations.ts',
          './input-manifest.ts',
          './read-set.ts',
          './closure-analyzer.ts',
          './engine-inputs.ts',
        ].map((entry) => fileURLToPath(new URL(entry, import.meta.url)))
      : undefined
  try {
    while (pending.length > 0) {
      const sourcePath = pending.pop()!
      if (graph.has(sourcePath) === true) continue
      let module = path.isAbsolute(sourcePath) === true ? relative(sourcePath) : sourcePath
      const node: SourceModule = { module, children: [], reasons: [], legacyChildren: [] }
      graph.set(sourcePath, node)
      const reason = ({
        code,
        operation,
        detail,
        line = null,
      }: Omit<SourceReason, 'source' | 'evidence'> & { line?: number | null }): void => {
        node.reasons.push({
          code,
          operation,
          detail,
          source: { module, line },
          evidence: 'unproven',
        })
      }
      if (opaqueModules.has(sourcePath) === true || path.isAbsolute(sourcePath) === false) {
        reason({
          code: 'unknown-capability',
          operation: 'module-closure',
          detail: 'Runtime module bytes are unavailable for analysis.',
        })
        continue
      }
      recordInput(sourcePath)
      let scope = path.dirname(sourcePath)
      let dependency: { name: string; version?: string } | undefined
      let dependencyScope: string | undefined
      while (true) {
        if (recordedScopes.has(scope) === false) {
          recordedScopes.add(scope)
          const packagePath = path.join(scope, 'package.json')
          recordInput(packagePath)
          if (packageMetadata !== undefined && decodePackageMetadata !== undefined) {
            try {
              packageMetadata.set(
                scope,
                decodePackageMetadata(inputReadFileSync(packagePath, 'utf8')),
              )
            } catch {
              /* Missing/unnamed scopes remain recorded inputs. */
            }
          }
        }
        if (dependency === undefined && packageMetadata?.has(scope) === true) {
          dependency = packageMetadata.get(scope)
          dependencyScope = scope
        }
        if (module.startsWith('../') === true && packageMetadata?.has(scope) === true) {
          module = `${packageMetadata.get(scope)!.name}/${path.relative(scope, sourcePath).split(path.sep).join('/')}`
          node.module = module
        }
        const parent = path.dirname(scope)
        if (parent === scope) break
        scope = parent
      }
      if (module.startsWith('../') === true) {
        module = pathToFileURL(sourcePath).href
        node.module = module
      }
      if (/\.[cm]?[jt]sx?$/.test(sourcePath) === false) {
        if (sourcePath.endsWith('.node') === true) {
          reason({
            code: 'native-addon',
            operation: 'native-module',
            detail: 'Native module input capabilities are unproven.',
          })
        }
        continue
      }
      let source: string
      let imports: ReadonlyArray<{ path: string; line: number | null }>
      const legacySpecifiers = new Set<string>()
      try {
        source = inputReadFileSync(sourcePath, 'utf8')
        const transpiler = /\.[jt]sx$/.test(sourcePath) === true ? transpilers.tsx : transpilers.ts
        imports = transpiler.scanImports(source).map((entry) => ({ path: entry.path, line: null }))
        for (const entry of imports) legacySpecifiers.add(entry.path)
      } catch {
        node.legacyFailure = true
        reason({
          code: 'unknown-capability',
          operation: 'source-scan',
          detail: 'Source could not be read or scanned.',
        })
        continue
      }
      try {
        if (analyzer !== undefined) {
          // Graph discovery and native-session snapshots mutate shared state in dependency order.
          // oxlint-disable-next-line no-await-in-loop
          const analysis = await analyzer.analyze({ source, filename: sourcePath })
          if (
            analysis.reasons.every(
              (capability) => capability.operation !== 'analysis-unavailable',
            ) === true
          )
            imports = analysis.imports
          const integrity =
            dependency?.version === undefined
              ? undefined
              : lockPackages?.[`${dependency.name}@${dependency.version}`]?.resolution?.integrity
          const observed = getInputRecording()?.evidence?.files.get(sourcePath)
          const approved =
            dependency?.version !== undefined &&
            integrity !== undefined &&
            dependencyScope !== undefined &&
            observed?.state === 'present' &&
            analysisApi?.matchDependencyAllowlist({
              identity: {
                name: dependency.name,
                version: dependency.version,
                integrity,
                files: [
                  {
                    path: path.relative(dependencyScope, sourcePath).split(path.sep).join('/'),
                    digest: observed.digest.slice('sha256:'.length),
                  },
                ],
              },
            }) !== undefined
          for (const capability of analysis.reasons) {
            if (
              capability.operation === 'analysis-unavailable' ||
              (approved === false && reviewedBoundaries?.includes(sourcePath) !== true)
            )
              reason({ code: 'unknown-capability', ...capability })
          }
        }
      } catch {
        reason({
          code: 'unknown-capability',
          operation: 'analysis-unavailable',
          detail: 'Static closure analysis failed; legacy source scanning succeeded.',
        })
      }
      for (const { path: specifier, line } of imports) {
        if (specifier.endsWith('.node') === true) {
          reason({
            code: 'native-addon',
            operation: 'native-module-import',
            detail: 'Native module capability is unproven.',
            line: line,
          })
        }
        if (isBuiltin(specifier) === true) {
          const builtin = specifier.replace(/^node:/, '')
          if (isReadSetRecording() === true && isCanonicalNodeBuiltin(`node:${builtin}`) === true)
            recordInputResolution({
              importer: sourcePath,
              specifier,
              outcome: { kind: 'builtin', name: `node:${builtin}` },
            })
          else if (isReadSetRecording() === true)
            reason({
              code: 'unknown-capability',
              operation: `runtime-builtin:${specifier}`,
              detail:
                'This runtime builtin has no supported canonical Node resolution observation.',
              line,
            })
          continue
        }
        let mapped: string | undefined
        try {
          mapped =
            specifier.startsWith('#') === true
              ? resolveImportMapSpecifierForImporterSync({
                  specifier,
                  importerPath: sourcePath,
                  workspaceRoot: cwd,
                  fs: inputFileSystem,
                })
              : undefined
        } catch {
          if (legacySpecifiers.has(specifier) === true) node.legacyFailure = true
          reason({
            code: 'unknown-capability',
            operation: 'import-map-resolution',
            detail: 'Import-map resolution closure is unknown.',
            line: line,
          })
          reason({
            code: 'dynamic-import',
            operation: `resolve:${specifier}`,
            detail: 'Import-map resolution could not be recorded.',
            line: line,
          })
          continue
        }
        const base = mapped ?? specifier
        if (
          base.startsWith('.') === false &&
          base.startsWith('#') === false &&
          path.isAbsolute(base) === false
        ) {
          const packageName = base
            .split('/')
            .slice(0, base.startsWith('@') === true ? 2 : 1)
            .join('/')
          let directory = path.dirname(sourcePath)
          while (true) {
            recordInput(path.join(directory, 'node_modules', packageName))
            recordInput(path.join(directory, 'node_modules', packageName, 'package.json'))
            const parent = path.dirname(directory)
            if (parent === directory) break
            directory = parent
          }
        }
        // Retain the existing candidate-directory observations in the same scan.
        if (base.startsWith('.') === true || path.isAbsolute(base) === true) {
          const absolute = path.resolve(path.dirname(sourcePath), base)
          recordInput(path.dirname(absolute))
          recordInput(absolute)
        }
        reason({
          code: 'dynamic-import',
          operation: `resolve:${specifier}`,
          detail: 'Resolver alternatives and influencing context are unproven.',
          line: line,
        })
        reason({
          code: 'unmediated-realpath',
          operation: `realpath:${specifier}`,
          detail: 'Source resolution uses raw physical-path lookup.',
          line: line,
        })
        let resolved: string
        let canonical: string
        try {
          resolved = Bun.resolveSync(base, path.dirname(sourcePath))
          canonical = realpathSync(resolved)
        } catch {
          if (legacySpecifiers.has(specifier) === true) node.legacyFailure = true
          reason({
            code: 'unknown-capability',
            operation: `resolve:${specifier}`,
            detail: 'Optional import target and resolution closure are unknown.',
            line: line,
          })
          continue
        }
        if (isReadSetRecording() === true)
          recordInputResolution({
            importer: sourcePath,
            specifier,
            outcome: { kind: 'file', lexical: resolved, physical: canonical },
          })
        // The read-set accounts for installed runtime code too; the legacy scan stays opaque.
        const child =
          isReadSetRecording() === false &&
          canonical.includes(`${path.sep}node_modules${path.sep}`) === true
            ? specifier
            : canonical
        if (child === canonical) recordInput(resolved)
        else opaqueModules.add(child)
        node.children.push(child)
        if (
          legacySpecifiers.has(specifier) === true &&
          canonical.includes(`${path.sep}node_modules${path.sep}`) === false
        )
          node.legacyChildren!.push(child)
        pending.push(child)
      }
    }
    // Additional engine/dependency analysis cannot change the legacy generation-cache contract.
    const legacyPending = [...sourceEntries]
    const legacyVisited = new Set<string>()
    while (legacyPending.length > 0) {
      const module = legacyPending.pop()!
      if (legacyVisited.has(module) === true) continue
      legacyVisited.add(module)
      const node = graph.get(module)
      if (node?.legacyFailure === true) markInputRecordingIncomplete()
      for (const child of node?.legacyChildren ?? []) legacyPending.push(child)
    }
    if (engineEntries.length > 0) {
      // Match publication's lazy opt-in boundary: ordinary/legacy recording never loads schemas.
      const { recordEngineIdentityFiles } = await import('./read-set.ts')
      const engineClosure = new Set<string>()
      const enginePending = [...engineEntries]
      while (enginePending.length > 0) {
        const module = enginePending.pop()!
        if (engineClosure.has(module) === true) continue
        engineClosure.add(module)
        for (const child of graph.get(module)?.children ?? []) enginePending.push(child)
      }
      recordEngineIdentityFiles([...engineClosure].filter((module) => path.isAbsolute(module)))
    }
    for (const reason of accountSourceGraph({
      entries: accountingEntries,
      graph: graph,
    })) {
      recordInputReason(reason)
    }
  } finally {
    try {
      await analyzer?.close()
    } catch {
      analysisFailure()
    }
  }
}

/** Group diagnostic occurrences by reason code and exact source, retaining affected generators. */
export const summarizeInputReasons = (
  reasons: readonly InputReason[],
): Array<{
  code: InputReason['code']
  source: InputReason['source']
  occurrences: number
  generators: string[]
}> => {
  const groups = new Map<
    string,
    {
      code: InputReason['code']
      source: InputReason['source']
      occurrences: number
      generators: Set<string>
    }
  >()
  for (const reason of reasons) {
    const key = canonicalJson([reason.code, reason.source])
    const group = groups.get(key) ?? {
      code: reason.code,
      source: reason.source,
      occurrences: 0,
      generators: new Set<string>(),
    }
    group.occurrences++
    for (const generator of reason.generators) group.generators.add(generator)
    groups.set(key, group)
  }
  return [...groups]
    .toSorted(([left], [right]) => compareUtf8(left, right))
    .map(([, group]) => ({
      code: group.code,
      source: group.source,
      occurrences: group.occurrences,
      generators: [...group.generators].toSorted(compareUtf8),
    }))
}

const failure = (cause: unknown) => {
  recordInputReason({
    code: 'capture-error',
    operation: 'publish input evidence',
    detail: 'Input evidence publication failed',
    source: { module: '@overeng/genie/src/core/input-manifest.ts', line: null },
    generators: [],
    evidence: 'observed',
  })
  return new GenieGenerationFailedError({
    failedCount: 1,
    message: `Failed to publish generator input evidence: ${String(cause)}`,
    files: [],
  })
}

/**
 * One optional recording, projected to both artifacts. Unflagged dispatch returns the
 * original effect before allocating state, scanning inputs, or computing any digest.
 */
export const withInputManifest = <TOutput, TError, TRequirements>({
  effect,
  complete,
  readSet,
}: {
  effect: Effect.Effect<TOutput, TError, TRequirements>
  complete: boolean
  readSet?: { path: string; cwd: string; argv: readonly string[] } | undefined
}): Effect.Effect<TOutput, TError | GenieGenerationFailedError, TRequirements> => {
  const destination = process.env.GENIE_INPUT_MANIFEST
  if (
    complete === false ||
    (readSet === undefined && (destination === undefined || destination === ''))
  )
    return effect
  const manifestPath =
    destination === undefined || destination === '' ? undefined : path.resolve(destination)
  const readSetPath = readSet === undefined ? undefined : path.resolve(readSet.path)
  const metadataPath = manifestPath === undefined ? undefined : `${manifestPath}.meta.json`
  const reportPath = readSetPath === undefined ? undefined : `${readSetPath}.reasons.json`
  const destinations = [manifestPath, readSetPath, metadataPath, reportPath].filter(
    (value): value is string => value !== undefined,
  )
  const publishPrivate = Effect.fn('genie/publishInputEvidence')(function* (
    output: string,
    content: string,
    invocationId: string,
  ) {
    const temporary = `${output}.${invocationId}.tmp`
    yield* Effect.tryPromise(async () => {
      try {
        await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
        await fs.rename(temporary, output)
      } finally {
        await fs.rm(temporary, { force: true })
      }
    })
  })
  const discard = Effect.tryPromise({
    try: () => Promise.all(destinations.map((output) => fs.rm(output, { force: true }))),
    catch: failure,
  })
  return recordingPermit.withPermits(1)(
    Effect.acquireUseRelease(
      discard.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            // Even invalid output combinations must discard only their requested artifacts and companions.
            if (new Set(destinations).size !== destinations.length)
              return yield* failure('Output destinations must be distinct')
            beginInputRecording({ digests: readSet !== undefined, exclude: destinations })
            if (readSet === undefined) return undefined
            const api = yield* Effect.tryPromise({
              try: () => import('./read-set.ts'),
              catch: failure,
            })
            yield* api.initializeReadSet(readSet.cwd).pipe(Effect.mapError(failure))
            return api
          }),
        ),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) === true ? Effect.sync(endInputRecording) : Effect.void,
        ),
      ),
      (api) =>
        effect.pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              const recording = getInputRecording()!
              const artifact =
                readSet === undefined
                  ? undefined
                  : yield* Effect.try({
                      try: () =>
                        api!.buildReadSet({ recording, cwd: readSet.cwd, argv: readSet.argv }),
                      catch: failure,
                    })
              const invocationId = artifact?.invocationId ?? randomUUID()
              const recordingComplete = isInputRecordingComplete()
              const inputs =
                artifact === undefined
                  ? [...recording.paths].toSorted(compareUtf8)
                  : [
                      ...new Set(
                        [...artifact.files, ...artifact.directories].map((entry) => entry.path),
                      ),
                    ].toSorted(compareUtf8)
              if (
                manifestPath !== undefined &&
                inputs.some((input) => /[\r\n]/.test(input)) === true
              )
                return yield* failure('Generator input paths cannot contain newlines')
              if (artifact !== undefined && readSetPath !== undefined) {
                yield* publishPrivate(
                  readSetPath,
                  `${canonicalJson(artifact)}\n`,
                  invocationId,
                ).pipe(Effect.mapError(failure))
                yield* publishPrivate(
                  reportPath!,
                  `${canonicalJson({
                    schema: 'genie-check-read-set-reasons',
                    schemaVersion: 1,
                    invocationId,
                    complete: artifact.complete,
                    reasons: artifact.reasons,
                    groups: summarizeInputReasons(artifact.reasons),
                  })}\n`,
                  invocationId,
                ).pipe(Effect.mapError(failure))
              }
              if (manifestPath !== undefined) {
                yield* publishPrivate(
                  manifestPath,
                  `${recordingComplete === true ? 'genie-inputs-v1' : 'genie-inputs-incomplete'}\n${inputs.map((input) => `${input}\n`).join('')}`,
                  invocationId,
                ).pipe(Effect.mapError(failure))
                yield* publishPrivate(
                  metadataPath!,
                  `${canonicalJson({
                    schema: 'genie-input-manifest-metadata',
                    schemaVersion: 1,
                    invocationId,
                    legacyComplete: recordingComplete,
                    readSetComplete: artifact?.complete ?? null,
                    digestEvidence: artifact !== undefined,
                  })}\n`,
                  invocationId,
                ).pipe(Effect.mapError(failure))
              }
            }),
          ),
          Effect.onExit((exit) => (Exit.isFailure(exit) === true ? discard : Effect.void)),
        ),
      () => Effect.sync(endInputRecording),
    ),
  )
}
