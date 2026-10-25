import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Effect, Exit, Schema, Semaphore } from 'effect'

import { canonicalJson, compareUtf8 } from '../runtime/node/input-observations.ts'
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
  recordInput,
  recordInputReason,
  recordInputResolution,
  setInputGenerators,
} from '../runtime/node/inputs.ts'
import { GenieGenerationFailedError } from './errors.ts'
import { resolveImportMapSpecifierForImporterSync } from './import-map/sync-resolver.ts'

const recordingPermit = Semaphore.makeUnsafe(1)

type SourceReason = Omit<Parameters<typeof recordInputReason>[0], 'generators'>
type SourceModule = {
  module: string
  children: Array<string>
  reasons: Array<SourceReason>
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
    reasons.push({
      code: 'unknown-capability',
      operation: 'module-closure',
      detail: 'Unrestricted module input closure is not accounted for.',
      source: { module: node.module, line: null },
      evidence: 'unproven',
      generators,
    })
    for (const reason of node.reasons) reasons.push({ ...reason, generators })
  }
  return reasons
}

/** Presence is not execution: these diagnostics never account for a module's closure. */
const sourceCapabilities = ({
  source,
  module,
}: {
  source: string
  module: string
}): Array<SourceReason> => {
  const reasons: Array<SourceReason> = []
  // Skip comments and quoted/generated text, notably shell commands emitted into YAML.
  // This is only a diagnostic inventory, not a purity analyzer; unknown remains mandatory.
  const tokens =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|\b(?:Bun\s*\.\s*(?:file|spawnSync|spawn|connect|listen|dlopen)|process\s*\.\s*(?:env|cwd|platform|arch|dlopen)|Deno\s*\.\s*\w+|globalThis\s*\[|realpathSync|realpath|fetch|WebSocket|XMLHttpRequest|import\s*\(|require\s*\(|import\s*\.\s*meta\s*\.\s*resolve|Date\s*\.\s*now|Math\s*\.\s*random|eval\s*\(|Function\s*\()/g
  for (const match of source.matchAll(tokens)) {
    const operation = match[0]
    if (/^(?:\/|'|"|`)/.test(operation) === true) continue
    const code: SourceReason['code'] =
      /^Bun\s*\.\s*file$/.test(operation) === true
        ? 'unmediated-fs'
        : operation.startsWith('realpath') === true
          ? 'unmediated-realpath'
          : /^Bun\s*\.\s*spawn/.test(operation) === true
            ? 'subprocess'
            : /^(?:fetch|WebSocket|XMLHttpRequest|Bun\s*\.\s*(?:connect|listen))$/.test(
                  operation,
                ) === true
              ? 'network'
              : operation.endsWith('dlopen') === true
                ? 'native-addon'
                : /^process\s*\./.test(operation) === true
                  ? 'ambient-env'
                  : /^(?:import|require)/.test(operation) === true
                    ? 'dynamic-import'
                    : 'unknown-capability'
    reasons.push({
      code,
      operation: operation.replace(/\s+/g, ''),
      detail: 'Static capability presence; execution and influencing inputs are unproven.',
      source: { module, line: source.slice(0, match.index).split('\n').length },
      evidence: 'unproven',
    })
  }
  return reasons
}

/** Record and attribute the source graph even when Bun has cached imported modules. */
export const recordGeneratorSourceGraph = ({
  entries,
  cwd,
}: {
  entries: ReadonlyArray<string>
  cwd: string
}): void => {
  if (isInputRecording() === false) return
  const relative = (sourcePath: string): string =>
    path.relative(cwd, sourcePath).split(path.sep).join('/')
  const sourceEntries = entries.map((entry) => path.resolve(cwd, entry))
  const generators = sourceEntries.map(relative).toSorted(compareUtf8)
  setInputGenerators(generators)
  const pending = [...sourceEntries]
  const graph = new Map<string, SourceModule>()
  const opaqueModules = new Set<string>()
  const recordedScopes = new Set<string>()
  const packageNames = new Map<string, string>()
  const decodePackageName = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
  )
  const transpilers = {
    ts: new Bun.Transpiler({ loader: 'ts' }),
    tsx: new Bun.Transpiler({ loader: 'tsx' }),
  }
  while (pending.length > 0) {
    const sourcePath = pending.pop()!
    if (graph.has(sourcePath) === true) continue
    let module = path.isAbsolute(sourcePath) === true ? relative(sourcePath) : sourcePath
    const node: SourceModule = { module, children: [], reasons: [] }
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
    if (opaqueModules.has(sourcePath) === true || path.isAbsolute(sourcePath) === false) continue
    recordInput(sourcePath)
    let scope = path.dirname(sourcePath)
    while (true) {
      if (recordedScopes.has(scope) === false) {
        recordedScopes.add(scope)
        const packagePath = path.join(scope, 'package.json')
        recordInput(packagePath)
        if (isReadSetRecording() === true) {
          try {
            packageNames.set(scope, decodePackageName(inputReadFileSync(packagePath, 'utf8')).name)
          } catch {
            /* Missing/unnamed scopes remain recorded inputs. */
          }
        }
      }
      if (module.startsWith('../') === true && packageNames.has(scope) === true) {
        module = `${packageNames.get(scope)!}/${path.relative(scope, sourcePath).split(path.sep).join('/')}`
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
    let imports: ReadonlyArray<{ path: string; line: number | null }>
    try {
      const source = inputReadFileSync(sourcePath, 'utf8')
      if (isReadSetRecording() === true)
        node.reasons.push(...sourceCapabilities({ source: source, module: module }))
      // Generic arrow functions in .ts are ambiguous JSX, while .tsx needs JSX parsing.
      const transpiler = /\.[jt]sx$/.test(sourcePath) === true ? transpilers.tsx : transpilers.ts
      imports = transpiler.scanImports(source).map((entry) => {
        // Bun does not expose import offsets. Only use an unambiguous literal location.
        const offset = source.indexOf(entry.path)
        const line =
          offset >= 0 && offset === source.lastIndexOf(entry.path)
            ? source.slice(0, offset).split('\n').length
            : null
        return { path: entry.path, line }
      })
    } catch {
      reason({
        code: 'unknown-capability',
        operation: 'source-scan',
        detail: 'Source could not be read or scanned.',
      })
      continue
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
        if (
          isReadSetRecording() === true &&
          specifier !== 'bun' &&
          specifier.startsWith('bun:') === false
        )
          recordInputResolution({
            importer: sourcePath,
            specifier,
            outcome: { kind: 'builtin', name: `node:${builtin}` },
          })
        const code =
          /^(?:fs|fs\/promises)$/.test(builtin) === true
            ? 'unmediated-fs'
            : /^(?:child_process|worker_threads|cluster)$/.test(builtin) === true
              ? 'subprocess'
              : /^(?:net|http|https|http2|tls|dgram|dns|dns\/promises)$/.test(builtin) === true
                ? 'network'
                : /^(?:process|os)$/.test(builtin) === true
                  ? 'ambient-env'
                  : 'unknown-capability'
        reason({
          code: code,
          operation: `import:${specifier}`,
          detail: 'Builtin capability imported; execution and inputs are unproven.',
          line: line,
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
      // Installed dependencies remain opaque; attribute their unaccounted closure by specifier.
      const child =
        canonical.includes(`${path.sep}node_modules${path.sep}`) === true ? specifier : canonical
      if (child === canonical) {
        recordInput(resolved)
      } else {
        opaqueModules.add(child)
      }
      node.children.push(child)
      pending.push(child)
    }
  }
  for (const reason of accountSourceGraph({
    entries: sourceEntries.map((module) => ({ module, generator: relative(module) })),
    graph: graph,
  })) {
    recordInputReason(reason)
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
                    complete: recordingComplete,
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
