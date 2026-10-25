import path from 'node:path'

import { Effect } from 'effect'
import type { FileSystem } from 'effect'

import { canonicalJson, digestBytes } from '../runtime/node/input-observations.ts'
import type { InputReason } from '../runtime/node/input-observations.ts'
import {
  getInputRecording,
  inputStatSync,
  isReadSetRecording,
  recordInput,
  recordInputReason,
} from '../runtime/node/inputs.ts'
/** Mediated engine reads; all recording remains at the existing input boundary. */
export const inputEngineFileSystem = ({
  fs,
  source,
}: {
  fs: FileSystem.FileSystem
  source: InputReason['source']
}): FileSystem.FileSystem => {
  if (isReadSetRecording() === false) return fs
  const consumed = <TBytes extends string | Uint8Array>({
    input,
    bytes,
  }: {
    input: string
    bytes: TBytes
  }): TBytes => {
    const observation = getInputRecording()?.evidence?.files.get(path.resolve(input))
    if (observation?.state !== 'present' || digestBytes(bytes) !== observation.digest)
      recordInputReason({
        code: 'unstable-observation',
        operation: 'engine readFile',
        detail: `Consumed engine bytes disagree with the recorded observation: ${input}`,
        source,
        generators: [],
        evidence: 'observed',
      })
    return bytes
  }
  const unaccounted = ({ operation, input }: { operation: string; input: string }): void =>
    recordInputReason({
      code: 'unmediated-fs',
      operation: `engine FileSystem.${operation}`,
      detail: `This filesystem operation has no complete recorded input contract: ${input}`,
      source,
      generators: [],
      evidence: 'observed',
    })
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
    readFile: (...args) => {
      recordInput(args[0])
      return fs.readFile(...args).pipe(Effect.map((bytes) => consumed({ input: args[0], bytes })))
    },
    readFileString: (...args) => {
      recordInput(args[0])
      return fs
        .readFileString(...args)
        .pipe(Effect.map((bytes) => consumed({ input: args[0], bytes })))
    },
    exists: (...args) => {
      recordInput(args[0])
      return fs.exists(...args)
    },
    readDirectory: (...args) => {
      recordInput(args[0])
      return fs.readDirectory(...args)
    },
    readLink: (...args) => {
      recordInput(args[0])
      return fs.readLink(...args)
    },
    realPath: (...args) => {
      recordInput(args[0])
      return fs.realPath(...args)
    },
    stat: (...args) => {
      try {
        inputStatSync(args[0], { bigint: true })
      } catch {
        // Keep the Effect service's own error result; the recorder retains absence.
      }
      return fs.stat(...args)
    },
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
