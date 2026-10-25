import * as fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  addReason, canonicalJson, captureFault, capturePath, compareUtf8, digestBytes,
  entryType, environmentDigest, makeInputRecording, missingObservation, retainObservation, statValues,
} from './input-observations.ts'
import type { GeneratorResult, InputReason, InputRecording, ResolutionObservation } from './input-observations.ts'

// Staged generators and the engine can load separate copies of this module. Share the
// recorder through the process global, not module identity. The engine serializes sessions.
const state = Symbol.for('@overeng/genie/input-recorder')
const globalState = globalThis as typeof globalThis & { [state]?: InputRecording }
/** Return the active process-wide input recording, if any. */
export const getInputRecording = (): InputRecording | undefined => globalState[state]
/** Whether an input recording session is active. */
export const isInputRecording = (): boolean => globalState[state] !== undefined
/** Whether the active session captures read-set evidence. */
export const isReadSetRecording = (): boolean => globalState[state]?.evidence !== undefined
/** Retain a reason that prevents proving the input closure complete. */
export const recordInputReason = (reason: InputReason): void => {
  const recording = globalState[state]
  if (recording !== undefined) addReason({ recording: recording, reason: reason })
}
/** Unknown attribution is expanded after discovery, never silently discarded. */
export const setInputGenerators = (generators: readonly string[]): void => {
  const recording = globalState[state]
  if (recording !== undefined) recording.generators = [...new Set(generators)].toSorted(compareUtf8)
}
/** Mark the active session's source closure as unproven. */
export const markInputRecordingIncomplete = (): void => recordInputReason({
  code: 'unknown-capability', operation: 'source closure', detail: 'The influencing source closure is not accounted for',
  source: { module: '@overeng/genie/src/core/input-manifest.ts', line: null }, generators: [], evidence: 'unproven',
})
/** Whether the active recording has no incompleteness reasons. */
export const isInputRecordingComplete = (): boolean => globalState[state]?.reasons.length === 0

const normalizeInputPath = ({ recording, input }: { recording: InputRecording; input: fs.PathLike }): string | undefined => {
  try {
    const value = input instanceof URL ? fileURLToPath(input) : input.toString()
    if (value.isWellFormed() === false || (Buffer.isBuffer(input) === true && Buffer.from(value).equals(input) === false)) {
      captureFault({ recording: recording, operation: 'normalize non-Unicode input path', module: '@overeng/genie/src/runtime/node/inputs.ts' })
      return undefined
    }
    return path.resolve(value)
  } catch {
    captureFault({ recording: recording, operation: 'normalize input path', module: '@overeng/genie/src/runtime/node/inputs.ts' })
    return undefined
  }
}
/** Explicitly declared dependencies are observed before their consumer runs. */
export const recordInput = (input: fs.PathLike): void => {
  const recording = globalState[state]
  if (recording === undefined) return
  const normalized = normalizeInputPath({ recording: recording, input: input })
  if (normalized !== undefined) capturePath({ recording: recording, input: normalized })
}
/** No state, hashing, or filesystem work exists until an output requests a session. */
export const beginInputRecording = (options: { digests?: boolean; exclude?: readonly string[] } = {}): Set<string> => {
  const recording = makeInputRecording(options)
  globalState[state] = recording
  return recording.paths
}
/** Release the active process-wide input recording. */
export const endInputRecording = (): void => { delete globalState[state] }

/** Read an environment variable and retain its salted presence/value evidence. */
export const recordInputEnvironment = (name: string): string | undefined => {
  const value = process.env[name]
  const recording = globalState[state]
  const evidence = recording?.evidence
  if (recording !== undefined && evidence !== undefined) {
    try {
      retainObservation({ recording: recording, map: evidence.environment, key: name, observation: value === undefined
        ? { name, by: [], present: false }
        : { name, by: [], present: true, digest: environmentDigest({ salt: evidence.envSalt, name: name, value: value }) } })
    } catch { captureFault({ recording: recording, operation: 'read environment', module: '@overeng/genie/src/runtime/node/inputs.ts' }) }
  }
  return value
}
/** Retain the lexical and physical working-directory identities. */
export const recordInputCwd = (cwd: string): void => {
  const recording = globalState[state]
  const evidence = recording?.evidence
  if (recording === undefined || evidence === undefined) return
  try {
    const lexical = path.resolve(cwd)
    recordInput(lexical)
    retainObservation({ recording: recording, map: evidence.cwd, key: lexical, observation: { lexical, physical: fs.realpathSync(lexical), by: [] } })
  } catch { captureFault({ recording: recording, operation: 'read cwd', module: '@overeng/genie/src/runtime/node/inputs.ts' }) }
}
/** Retain a generator's source identity and checked output digest. */
export const recordGeneratorResult = ({ generator, target, moduleFiles, checkedContent }: {
  generator: string
  target: string
  moduleFiles: readonly string[]
  checkedContent: string
}): void => {
  const recording = globalState[state]
  const evidence = recording?.evidence
  if (recording === undefined || evidence === undefined) return
  try {
    recordInput(target)
    const result: GeneratorResult = {
      generator, target: path.resolve(target),
      module: { version: '', files: [...new Set(moduleFiles)].toSorted((left, right) => compareUtf8(canonicalJson(left), canonicalJson(right))).map((file) => {
        const observation = evidence.files.get(file)
        if (observation?.state !== 'present') throw new Error('Generator source bytes were not recorded')
        return { path: file, digest: observation.digest }
      }) },
      outputDigest: digestBytes(checkedContent),
    }
    evidence.generatorResults.set(canonicalJson([generator, result.target]), result)
  } catch { captureFault({ recording: recording, operation: 'record checked output', module: '@overeng/genie/src/runtime/node/inputs.ts' }) }
}

/** Retain the observed outcome; unmediated resolver alternatives remain explicit reasons. */
export const recordInputResolution = ({ importer, specifier, outcome }: Pick<ResolutionObservation, 'importer' | 'specifier' | 'outcome'>): void => {
  const recording = globalState[state]
  const evidence = recording?.evidence
  if (recording === undefined || evidence === undefined) return
  if (outcome.kind === 'file') {
    recordInput(outcome.lexical)
    recordInput(outcome.physical)
  }
  retainObservation({ recording: recording, map: evidence.resolutions, key: canonicalJson([importer, specifier]), observation: {
    importer, specifier, outcome, by: [], candidates: [], contextEnv: [], resolverCode: [],
  } })
}

// Proxies preserve Node overloads, return values, and original IO errors.
/** Node-compatible file reads that retain consumed input evidence. */
export const inputReadFileSync: typeof fs.readFileSync = new Proxy(fs.readFileSync, {
  apply: (target, receiver, args: Parameters<typeof fs.readFileSync>) => {
    if (typeof args[0] !== 'number') recordInput(args[0])
    else if (isInputRecording() === true) recordInputReason({ code: 'unknown-capability', operation: 'readFileSync(fd)', detail: 'File descriptor origin is not modeled', source: { module: '@overeng/genie/src/runtime/node/inputs.ts', line: null }, generators: [], evidence: 'observed' })
    const recording = globalState[state]
    let before: fs.BigIntStats | undefined
    if (recording?.evidence !== undefined && typeof args[0] !== 'number') {
      try { before = fs.statSync(args[0], { bigint: true }) } catch { /* The path observation retains missing/error state. */ }
    }
    let result: string | Buffer
    try { result = Reflect.apply(target, receiver, args) } catch (cause) {
      if (recording?.evidence !== undefined && missingObservation(cause) === undefined) captureFault({ recording: recording, operation: 'readFileSync', module: '@overeng/genie/src/runtime/node/inputs.ts' })
      throw cause
    }
    if (recording?.evidence !== undefined && typeof args[0] !== 'number') {
      const input = normalizeInputPath({ recording: recording, input: args[0] })
      if (input === undefined) return result
      // A decoded string can be lossy; compare raw bytes captured around the read too.
      if (Buffer.isBuffer(result) === true) retainObservation({ recording: recording, map: recording.evidence.files, key: input, observation: { path: input, by: [], state: 'present', digest: digestBytes(result), byteLength: result.byteLength } })
      recordInput(args[0])
      try {
        const after = fs.statSync(args[0], { bigint: true })
        if (before === undefined || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => Reflect.get(before!, key) !== Reflect.get(after, key)) === true) recordInputReason({
          code: 'unstable-observation', operation: 'readFileSync', detail: `File state changed around the consumed read: ${input}`,
          source: { module: '@overeng/genie/src/runtime/node/inputs.ts', line: null }, generators: [], evidence: 'observed',
        })
      } catch { captureFault({ recording: recording, operation: 'associate consumed file bytes', module: '@overeng/genie/src/runtime/node/inputs.ts' }) }
    }
    return result
  },
})
/** Node-compatible existence checks that retain input observations. */
export const inputExistsSync: typeof fs.existsSync = new Proxy(fs.existsSync, {
  apply: (target, receiver, args: Parameters<typeof fs.existsSync>) => {
    recordInput(args[0])
    return Reflect.apply(target, receiver, args)
  },
})

type StatSample = { state: 'present'; stat: fs.Stats | fs.BigIntStats } | { state: 'absent'; error: 'ENOENT' | 'ENOTDIR' } | undefined
const fingerprint = (observation: StatSample) => observation?.state === 'present'
  ? canonicalJson({ type: entryType(observation.stat), values: Object.fromEntries(
    ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks',
      ...(typeof observation.stat.size === 'bigint' ? ['atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] : ['atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs']),
    ].map((key) => [key, String(Reflect.get(observation.stat, key))]),
  ) })
  : canonicalJson(observation ?? null)

/** Node-compatible stat calls that retain followed-path metadata. */
export const inputStatSync: typeof fs.statSync = new Proxy(fs.statSync, {
  apply: (target, receiver, args: Parameters<typeof fs.statSync>) => {
    const recording = globalState[state]
    if (recording?.evidence === undefined) {
      recordInput(args[0])
      return Reflect.apply(target, receiver, args)
    }
    const input = normalizeInputPath({ recording: recording, input: args[0] })
    if (input === undefined) return Reflect.apply(target, receiver, args)
    recording.paths.add(input)
    const sample = ({ bigint }: { bigint: boolean }) => {
      try {
        const stat = Reflect.apply(target, receiver, [args[0], { bigint, throwIfNoEntry: true }])
        if (stat === undefined) throw new Error('Exact stat probe returned no result')
        return { state: 'present' as const, stat }
      } catch (cause) {
        const missing = missingObservation(cause)
        if (missing === undefined) captureFault({ recording: recording, operation: 'statSync', module: '@overeng/genie/src/runtime/node/inputs.ts' })
        return missing
      }
    }
    const bigint = args[1]?.bigint === true
    const before = sample({ bigint: true })
    const numericBefore = bigint === false ? sample({ bigint: false }) : undefined
    let result: fs.Stats | fs.BigIntStats | undefined
    let callerError: unknown
    let threw = false
    try { result = Reflect.apply(target, receiver, args) } catch (cause) {
      callerError = cause
      threw = true
    }
    // Compare the consumed result, not just probes: an A -> B -> A race must
    // remain incomplete even when later revalidation sees the original state.
    try {
      const numericAfter = bigint === false ? sample({ bigint: false }) : undefined
      const after = sample({ bigint: true })
      const consumed = result === undefined
        ? threw === true ? missingObservation(callerError) : before?.state === 'absent' ? before : undefined
        : { state: 'present' as const, stat: result }
      let stable = before !== undefined && after !== undefined && fingerprint(before) === fingerprint(after)
      if (bigint === true) stable = stable === true && fingerprint(consumed) === fingerprint(before)
      else {
        stable = stable === true && numericBefore !== undefined && numericAfter !== undefined
          && fingerprint(consumed) === fingerprint(numericBefore) && fingerprint(consumed) === fingerprint(numericAfter)
        if (result !== undefined && before?.state === 'present') {
          // Only exact probes supply nanoseconds. Never invent ns by multiplying
          // the caller's rounded milliseconds; compare their numeric projections.
          for (const [key, value] of Object.entries(statValues(before.stat as fs.BigIntStats))) {
            const exact = BigInt(value)
            if (key.endsWith('Ns') === true) {
              const milliseconds: unknown = Reflect.get(result, `${key.slice(0, -2)}Ms`)
              stable = stable === true && (milliseconds === Number(exact) / 1_000_000
                || milliseconds === Number(exact / 1_000_000n) + Number(exact % 1_000_000n) / 1_000_000
                || milliseconds === Number(exact / 1_000_000_000n) * 1_000 + Number(exact % 1_000_000_000n) / 1_000_000)
            } else stable = stable === true && Number.isSafeInteger(Number(exact)) === true && Reflect.get(result, key) === Number(exact)
          }
        }
      }
      if (stable === false) recordInputReason({
        code: 'unstable-observation', operation: 'statSync', detail: `Stat result disagreed with surrounding observations: ${input}`,
        source: { module: '@overeng/genie/src/runtime/node/inputs.ts', line: null }, generators: [], evidence: 'observed',
      })
      const exact = bigint === true ? consumed : before
      if (exact?.state === 'present') retainObservation({ recording: recording, map: recording.evidence.stats, key: canonicalJson([input, true]), observation: {
        path: input, followSymlinks: true, by: [], state: 'present', type: entryType(exact.stat), values: statValues(exact.stat as fs.BigIntStats),
      } })
      else if (exact?.state === 'absent') retainObservation({ recording: recording, map: recording.evidence.stats, key: canonicalJson([input, true]), observation: { path: input, followSymlinks: true, by: [], ...exact } })
    } catch { captureFault({ recording: recording, operation: 'associate consumed stat', module: '@overeng/genie/src/runtime/node/inputs.ts' }) }
    if (threw === true) throw callerError
    return result
  },
})
/** Node-compatible directory reads that retain directory input evidence. */
export const inputReaddirSync: typeof fs.readdirSync = new Proxy(fs.readdirSync, {
  apply: (target, receiver, args: Parameters<typeof fs.readdirSync>) => {
    recordInput(args[0])
    const entries: Array<string | Buffer | fs.Dirent<string | Buffer>> = Reflect.apply(target, receiver, args)
    const options = args[1]
    if (isInputRecording() === true && typeof options === 'object' && options !== null && options.recursive === true) {
      const root = normalizeInputPath({ recording: globalState[state]!, input: args[0] })
      if (root === undefined) return entries
      for (const entry of entries) recordInput(typeof entry === 'string' || Buffer.isBuffer(entry) === true
        ? path.resolve(root, entry.toString()) : path.resolve(entry.parentPath, entry.name.toString()))
    }
    if (isReadSetRecording() === true) recordInput(args[0])
    return entries
  },
})
/** Physical resolution is accompanied by the traversed symlink observations. */
export const inputRealpathSync: typeof fs.realpathSync = new Proxy(fs.realpathSync, {
  apply: (target, receiver, args: Parameters<typeof fs.realpathSync>) => {
    recordInput(args[0])
    return Reflect.apply(target, receiver, args)
  },
})
/** Observed filesystem operations supplied to module resolution. */
export const inputFileSystem = {
  realpathSync: inputRealpathSync,
  readFileSync: inputReadFileSync,
  existsSync: inputExistsSync,
}
