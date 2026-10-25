import { realpathSync } from 'node:fs'
import path from 'node:path'

import { ByteSize, Effect, Option } from 'effect'
import type { FileSystem, PlatformError } from 'effect'

import {
  canonicalJson,
  digestBytes,
  missingObservation,
  retainObservation,
} from '../runtime/node/input-observations.ts'
import type { InputReason } from '../runtime/node/input-observations.ts'
import {
  getInputRecording,
  inputStatSync,
  isReadSetRecording,
  recordInput,
  recordInputReason,
} from '../runtime/node/inputs.ts'

const matchesBytes = ({ input, bytes }: { input: string; bytes: string | Uint8Array }): boolean => {
  const observation = getInputRecording()?.evidence?.files.get(path.resolve(input))
  return observation?.state === 'present' && digestBytes(bytes) === observation.digest
}

/** Mediated engine reads; all recording remains at the existing input boundary. */
export const inputEngineFileSystem = ({
  fs,
  source,
}: {
  fs: FileSystem.FileSystem
  source: InputReason['source']
}): FileSystem.FileSystem => {
  if (isReadSetRecording() === false) return fs
  const unaccounted = ({ operation, input }: { operation: string; input: string }): void =>
    recordInputReason({
      code: 'unmediated-fs',
      operation: `engine FileSystem.${operation}`,
      detail: `This filesystem operation has no complete recorded input contract: ${input}`,
      source,
      generators: [],
      evidence: 'observed',
    })
  const unstable = ({ operation, input }: { operation: string; input: string }): void =>
    recordInputReason({
      code: 'unstable-observation',
      operation: `engine FileSystem.${operation}`,
      detail: `Consumed engine outcome disagrees with its recorded observation: ${input}`,
      source,
      generators: [],
      evidence: 'observed',
    })
  // Effects are lazy: sample only after consumption, then verify any richer Node
  // metadata against the returned outcome. A disagreement can never prove completeness.
  const observe = <A, E extends PlatformError.PlatformError, R>({
    input,
    operation,
    effect,
    matches,
  }: {
    input: string
    operation: string
    effect: Effect.Effect<A, E, R>
    matches: (result: A) => boolean
  }): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (operation === 'stat') {
            try {
              inputStatSync(input, { bigint: true })
            } catch {
              // The actual Effect outcome below, not this enrichment, controls the result.
            }
          } else recordInput(input)
          if (matches(result) === false) unstable({ operation, input })
        }),
      ),
      Effect.tapError((error) =>
        Effect.sync(() => {
          recordInput(input)
          const recording = getInputRecording()
          const evidence = recording?.evidence
          const missing = missingObservation(error.reason.cause)
          if (recording === undefined || evidence === undefined) return
          const absolute = path.resolve(input)
          if (missing === undefined) {
            unaccounted({ operation, input: `${input} (${error.message})` })
          } else if (operation === 'readDirectory')
            retainObservation({
              recording,
              map: evidence.directories,
              key: absolute,
              observation: { path: absolute, by: [], ...missing },
            })
          else if (operation === 'readLink')
            retainObservation({
              recording,
              map: evidence.symlinks,
              key: absolute,
              observation: { path: absolute, by: [], ...missing },
            })
          else if (operation === 'stat')
            retainObservation({
              recording,
              map: evidence.stats,
              key: canonicalJson([absolute, true]),
              observation: { path: absolute, followSymlinks: true, by: [], ...missing },
            })
          else
            retainObservation({
              recording,
              map: evidence.files,
              key: absolute,
              observation: { path: absolute, by: [], ...missing },
            })
        }),
      ),
    )
  return {
    ...fs,
    access: (...args) => {
      unaccounted({ operation: 'access', input: args[0] })
      return fs.access(...args)
    },
    open: (...args) => {
      unaccounted({ operation: 'open', input: args[0] })
      return fs.open(...args)
    },
    stream: (...args) => {
      unaccounted({ operation: 'stream', input: args[0] })
      return fs.stream(...args)
    },
    watch: (...args) => {
      unaccounted({ operation: 'watch', input: args[0] })
      return fs.watch(...args)
    },
    readFile: (...args) =>
      observe({
        input: args[0],
        operation: 'readFile',
        effect: fs.readFile(...args),
        matches: (bytes) => matchesBytes({ input: args[0], bytes }),
      }),
    readFileString: (...args) =>
      observe({
        input: args[0],
        operation: 'readFileString',
        effect: fs.readFileString(...args),
        matches: (bytes) => matchesBytes({ input: args[0], bytes }),
      }),
    exists: (...args) =>
      observe({
        input: args[0],
        operation: 'exists',
        effect: fs.exists(...args),
        matches: (exists) => {
          const evidence = getInputRecording()?.evidence
          const input = path.resolve(args[0])
          const file = evidence?.files.get(input)
          return exists === true
            ? file?.state === 'present' ||
                evidence?.directories.get(input)?.state === 'present' ||
                evidence?.symlinks.get(input)?.state === 'present'
            : file?.state === 'absent'
        },
      }),
    readDirectory: (...args) =>
      observe({
        input: args[0],
        operation: 'readDirectory',
        effect: fs.readDirectory(...args),
        matches: (names) => {
          const observation = getInputRecording()?.evidence?.directories.get(path.resolve(args[0]))
          return (
            observation?.state === 'present' &&
            canonicalJson(names.toSorted()) ===
              canonicalJson(observation.entries.map((entry) => entry.name).toSorted())
          )
        },
      }),
    readLink: (...args) =>
      observe({
        input: args[0],
        operation: 'readLink',
        effect: fs.readLink(...args),
        matches: (target) => {
          const observation = getInputRecording()?.evidence?.symlinks.get(path.resolve(args[0]))
          return observation?.state === 'present' && observation.target === target
        },
      }),
    realPath: (...args) =>
      observe({
        input: args[0],
        operation: 'realPath',
        effect: fs.realPath(...args),
        matches: (physical) => {
          try {
            return realpathSync(args[0]) === physical
          } catch {
            return false
          }
        },
      }),
    stat: (...args) =>
      observe({
        input: args[0],
        operation: 'stat',
        effect: fs.stat(...args),
        matches: (info) => {
          const observation = getInputRecording()?.evidence?.stats.get(
            canonicalJson([path.resolve(args[0]), true]),
          )
          if (observation?.state !== 'present') return false
          const types: Readonly<Record<FileSystem.File.Type, string>> = {
            File: 'file',
            Directory: 'directory',
            SymbolicLink: 'symlink',
            BlockDevice: 'block-device',
            CharacterDevice: 'character-device',
            FIFO: 'fifo',
            Socket: 'socket',
            Unknown: 'unknown',
          }
          const optionalNumber = ({
            value,
            key,
          }: {
            value: Option.Option<number>
            key: string
          }): boolean => Option.isNone(value) || String(value.value) === observation.values[key]
          const optionalTime = ({
            value,
            key,
          }: {
            value: Option.Option<Date>
            key: string
          }): boolean =>
            Option.isNone(value) ||
            BigInt(value.value.getTime()) === BigInt(observation.values[key]!) / 1_000_000n
          return (
            observation.type === types[info.type] &&
            String(info.dev) === observation.values.dev &&
            String(info.mode) === observation.values.mode &&
            String(ByteSize.toBigInt(info.size)) === observation.values.size &&
            optionalNumber({ value: info.ino, key: 'ino' }) &&
            optionalNumber({ value: info.nlink, key: 'nlink' }) &&
            optionalNumber({ value: info.uid, key: 'uid' }) &&
            optionalNumber({ value: info.gid, key: 'gid' }) &&
            optionalNumber({ value: info.rdev, key: 'rdev' }) &&
            optionalNumber({ value: info.blocks, key: 'blocks' }) &&
            (Option.isNone(info.blksize) ||
              String(ByteSize.toBigInt(info.blksize.value)) === observation.values.blksize) &&
            optionalTime({ value: info.mtime, key: 'mtimeNs' }) &&
            optionalTime({ value: info.atime, key: 'atimeNs' }) &&
            optionalTime({ value: info.birthtime, key: 'birthtimeNs' })
          )
        },
      }),
  }
}

/**
 * Audit the engine's Effect filesystem boundary. A code identity does not account
 * for data: a read must have an explicit observation before it is consumed.
 * This proxy is absent from ordinary (including legacy-manifest) invocations.
 */
export const auditEngineFileSystem = ({
  fs,
  source,
}: {
  fs: FileSystem.FileSystem
  source: InputReason['source']
}): FileSystem.FileSystem => {
  if (isReadSetRecording() === false) return fs
  const reads: Record<string, true> = {
    access: true,
    exists: true,
    open: true,
    readDirectory: true,
    readFile: true,
    readFileString: true,
    readLink: true,
    realPath: true,
    stat: true,
    stream: true,
    watch: true,
  }
  return new Proxy(fs, {
    get: (target, operation, receiver) => {
      const method: unknown = Reflect.get(target, operation, receiver)
      if (
        typeof operation !== 'string' ||
        reads[operation] !== true ||
        typeof method !== 'function'
      )
        return method
      return (...args: unknown[]) => {
        const recording = getInputRecording()
        const input = typeof args[0] === 'string' ? path.resolve(args[0]) : undefined
        const evidence = recording?.evidence
        const recorded =
          input !== undefined &&
          evidence !== undefined &&
          (operation === 'readFile' || operation === 'readFileString'
            ? evidence.files.has(input)
            : operation === 'readDirectory'
              ? evidence.directories.has(input)
              : operation === 'readLink'
                ? evidence.symlinks.has(input)
                : operation === 'stat'
                  ? evidence.stats.has(canonicalJson([input, true]))
                  : operation === 'exists' || operation === 'realPath'
                    ? recording?.paths.has(input) === true
                    : false)
        const frame = new Error().stack
          ?.split('\n')
          .find((line) => line.includes(source.module.replace('@overeng/genie/', '')))
        const line = frame?.match(/:(\d+):\d+\)?$/)?.[1]
        if (evidence !== undefined && recorded === false)
          recordInputReason({
            code: operation === 'realPath' ? 'unmediated-realpath' : 'unmediated-fs',
            operation: `engine FileSystem.${operation}`,
            detail: `Engine consumed an input without a recorded observation: ${input ?? 'unknown path'}`,
            source: {
              module: source.module,
              line: line === undefined ? source.line : Number(line),
            },
            generators: [],
            evidence: 'observed',
          })
        if (
          (operation === 'readFile' || operation === 'readFileString') &&
          input !== undefined &&
          typeof args[0] === 'string' &&
          (args[1] === undefined || typeof args[1] === 'string')
        ) {
          const checkBytes = <TBytes extends string | Uint8Array>(bytes: TBytes): TBytes => {
            const observation = evidence?.files.get(input)
            if (observation?.state === 'present' && digestBytes(bytes) !== observation.digest)
              recordInputReason({
                code: 'unstable-observation',
                operation: `engine FileSystem.${operation}`,
                detail: `Consumed engine input bytes disagreed with the recorded observation: ${input}`,
                source: {
                  module: source.module,
                  line: line === undefined ? source.line : Number(line),
                },
                generators: [],
                evidence: 'observed',
              })
            return bytes
          }
          return operation === 'readFile'
            ? Effect.map(target.readFile(args[0]), checkBytes)
            : Effect.map(target.readFileString(args[0], args[1]), checkBytes)
        }
        return Reflect.apply(method, target, args)
      }
    },
  })
}
