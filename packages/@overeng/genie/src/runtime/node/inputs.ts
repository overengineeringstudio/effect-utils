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
export const getInputRecording = (): InputRecording | undefined => globalState[state]
export const isInputRecording = (): boolean => globalState[state] !== undefined
export const isReadSetRecording = (): boolean => globalState[state]?.evidence !== undefined
export const recordInputReason = (reason: InputReason): void => {
  const recording = globalState[state]
  if (recording !== undefined) addReason(recording, reason)
}
/** Unknown attribution is expanded after discovery, never silently discarded. */
export const setInputGenerators = (generators: readonly string[]): void => {
  const recording = globalState[state]
  if (recording !== undefined) recording.generators = [...new Set(generators)].sort(compareUtf8)
}
export const markInputRecordingIncomplete = (): void => recordInputReason({
  code: 'unknown-capability', operation: 'source closure', detail: 'The influencing source closure is not accounted for',
  source: { module: '@overeng/genie/src/core/input-manifest.ts', line: null }, generators: [], evidence: 'unproven',
})
export const isInputRecordingComplete = (): boolean => globalState[state]?.reasons.length === 0

const normalizeInputPath = (recording: InputRecording, input: fs.PathLike): string | undefined => {
  try {
    const value = input instanceof URL ? fileURLToPath(input) : input.toString()
    if (!value.isWellFormed() || (Buffer.isBuffer(input) && !Buffer.from(value).equals(input))) {
      captureFault(recording, 'normalize non-Unicode input path', '@overeng/genie/src/runtime/node/inputs.ts')
      return undefined
    }
    return path.resolve(value)
  } catch {
    captureFault(recording, 'normalize input path', '@overeng/genie/src/runtime/node/inputs.ts')
    return undefined
  }
}
/** Explicitly declared dependencies are observed before their consumer runs. */
export const recordInput = (input: fs.PathLike): void => {
  const recording = globalState[state]
  if (recording === undefined) return
  const normalized = normalizeInputPath(recording, input)
  if (normalized !== undefined) capturePath(recording, normalized)
}
/** No state, hashing, or filesystem work exists until an output requests a session. */
export const beginInputRecording = (options: { digests?: boolean; exclude?: readonly string[] } = {}): Set<string> => {
  const recording = makeInputRecording(options)
  globalState[state] = recording
  return recording.paths
}
export const endInputRecording = (): void => { delete globalState[state] }

export const recordInputEnvironment = (name: string): string | undefined => {
  const value = process.env[name]
  const recording = globalState[state]
  const evidence = recording?.evidence
  if (recording !== undefined && evidence !== undefined) {
    try {
      retainObservation(recording, evidence.environment, name, value === undefined
        ? { name, by: [], present: false }
        : { name, by: [], present: true, digest: environmentDigest(evidence.envSalt, name, value) })
    } catch { captureFault(recording, 'read environment', '@overeng/genie/src/runtime/node/inputs.ts') }
  }
  return value
}
export const recordInputCwd = (cwd: string): void => {
  const recording = globalState[state]
  const evidence = recording?.evidence
  if (recording === undefined || evidence === undefined) return
  try {
    const lexical = path.resolve(cwd)
    recordInput(lexical)
    retainObservation(recording, evidence.cwd, lexical, { lexical, physical: fs.realpathSync(lexical), by: [] })
  } catch { captureFault(recording, 'read cwd', '@overeng/genie/src/runtime/node/inputs.ts') }
}
export const recordGeneratorResult = (generator: string, target: string, moduleFiles: readonly string[], checkedContent: string): void => {
  const recording = globalState[state]
  const evidence = recording?.evidence
  if (recording === undefined || evidence === undefined) return
  try {
    recordInput(target)
    const result: GeneratorResult = {
      generator, target: path.resolve(target),
      module: { version: '', files: [...new Set(moduleFiles)].sort((left, right) => compareUtf8(canonicalJson(left), canonicalJson(right))).map((file) => {
        const observation = evidence.files.get(file)
        if (observation?.state !== 'present') throw new Error('Generator source bytes were not recorded')
        return { path: file, digest: observation.digest }
      }) },
      outputDigest: digestBytes(checkedContent),
    }
    evidence.generatorResults.set(canonicalJson([generator, result.target]), result)
  } catch { captureFault(recording, 'record checked output', '@overeng/genie/src/runtime/node/inputs.ts') }
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
  retainObservation(recording, evidence.resolutions, canonicalJson([importer, specifier]), {
    importer, specifier, outcome, by: [], candidates: [], contextEnv: [], resolverCode: [],
  })
}

// Proxies preserve Node overloads, return values, and original IO errors.
export const inputReadFileSync: typeof fs.readFileSync = new Proxy(fs.readFileSync, {
  apply: (target, receiver, args: Parameters<typeof fs.readFileSync>) => {
    if (typeof args[0] !== 'number') recordInput(args[0])
    else if (isInputRecording()) recordInputReason({ code: 'unknown-capability', operation: 'readFileSync(fd)', detail: 'File descriptor origin is not modeled', source: { module: '@overeng/genie/src/runtime/node/inputs.ts', line: null }, generators: [], evidence: 'observed' })
    const recording = globalState[state]
    let before: fs.BigIntStats | undefined
    if (recording?.evidence !== undefined && typeof args[0] !== 'number') {
      try { before = fs.statSync(args[0], { bigint: true }) } catch { /* The path observation retains missing/error state. */ }
    }
    let result: string | Buffer
    try { result = Reflect.apply(target, receiver, args) } catch (cause) {
      if (recording?.evidence !== undefined && missingObservation(cause) === undefined) captureFault(recording, 'readFileSync', '@overeng/genie/src/runtime/node/inputs.ts')
      throw cause
    }
    if (recording?.evidence !== undefined && typeof args[0] !== 'number') {
      const input = normalizeInputPath(recording, args[0])
      if (input === undefined) return result
      // A decoded string can be lossy; compare raw bytes captured around the read too.
      if (Buffer.isBuffer(result)) retainObservation(recording, recording.evidence.files, input, { path: input, by: [], state: 'present', digest: digestBytes(result), byteLength: result.byteLength })
      recordInput(args[0])
      try {
        const after = fs.statSync(args[0], { bigint: true })
        if (before === undefined || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => Reflect.get(before!, key) !== Reflect.get(after, key))) recordInputReason({
          code: 'unstable-observation', operation: 'readFileSync', detail: `File state changed around the consumed read: ${input}`,
          source: { module: '@overeng/genie/src/runtime/node/inputs.ts', line: null }, generators: [], evidence: 'observed',
        })
      } catch { captureFault(recording, 'associate consumed file bytes', '@overeng/genie/src/runtime/node/inputs.ts') }
    }
    return result
  },
})
export const inputExistsSync: typeof fs.existsSync = new Proxy(fs.existsSync, {
  apply: (target, receiver, args: Parameters<typeof fs.existsSync>) => {
    recordInput(args[0])
    return Reflect.apply(target, receiver, args)
  },
})
export const inputStatSync: typeof fs.statSync = new Proxy(fs.statSync, {
  apply: (target, receiver, args: Parameters<typeof fs.statSync>) => {
    const recording = globalState[state]
    if (recording?.evidence === undefined) recordInput(args[0])
    else {
      const input = normalizeInputPath(recording, args[0])
      if (input === undefined) return Reflect.apply(target, receiver, args)
      recording.paths.add(input)
      try {
        const stat = fs.statSync(args[0], { bigint: true })
        retainObservation(recording, recording.evidence.stats, canonicalJson([input, true]), { path: input, followSymlinks: true, by: [], state: 'present', type: entryType(stat), values: statValues(stat) })
      } catch (cause) {
        const missing = missingObservation(cause)
        if (missing === undefined) captureFault(recording, 'statSync', '@overeng/genie/src/runtime/node/inputs.ts')
        else retainObservation(recording, recording.evidence.stats, canonicalJson([input, true]), { path: input, followSymlinks: true, by: [], ...missing })
      }
    }
    return Reflect.apply(target, receiver, args)
  },
})
export const inputReaddirSync: typeof fs.readdirSync = new Proxy(fs.readdirSync, {
  apply: (target, receiver, args: Parameters<typeof fs.readdirSync>) => {
    recordInput(args[0])
    const entries: Array<string | Buffer | fs.Dirent<string | Buffer>> = Reflect.apply(target, receiver, args)
    const options = args[1]
    if (isInputRecording() && typeof options === 'object' && options !== null && options.recursive === true) {
      const root = normalizeInputPath(globalState[state]!, args[0])
      if (root === undefined) return entries
      for (const entry of entries) recordInput(typeof entry === 'string' || Buffer.isBuffer(entry)
        ? path.resolve(root, entry.toString()) : path.resolve(entry.parentPath, entry.name.toString()))
    }
    if (isReadSetRecording()) recordInput(args[0])
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
export const inputFileSystem = {
  realpathSync: inputRealpathSync,
  readFileSync: inputReadFileSync,
  existsSync: inputExistsSync,
}
