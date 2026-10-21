import * as fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Staged generators and the engine can load separate copies of this module. Share the
// recorder through the process global, not module identity. The engine serializes sessions.
const state = Symbol.for('@overeng/genie/input-recorder')
const globalState = globalThis as typeof globalThis & { [state]?: Set<string> }
const history = Symbol.for('@overeng/genie/input-history')
const globalHistory = globalThis as typeof globalThis & { [history]?: Set<string> }
const completeness = Symbol.for('@overeng/genie/input-completeness')
const globalCompleteness = globalThis as typeof globalThis & { [completeness]?: boolean }

/** Source analysis must fail closed without changing optional import runtime semantics. */
export const markInputRecordingIncomplete = (): void => {
  if (isInputRecording()) globalCompleteness[completeness] = false
}

export const isInputRecordingComplete = (): boolean => globalCompleteness[completeness] === true

export const isInputRecording = (): boolean => globalState[state] !== undefined

/** Record a consulted path, including a missing optional input, before inspecting it. */
export const recordInput = (input: fs.PathLike): void => {
  const inputs = globalState[state]
  if (inputs === undefined) return
  inputs.add(path.resolve(input instanceof URL ? fileURLToPath(input) : input.toString()))
}

/** Engine session lifecycle. Not needed by generators using the input-aware readers. */
export const beginInputRecording = (): Set<string> => {
  const inputs = globalHistory[history] ?? new Set<string>()
  globalHistory[history] = inputs
  globalState[state] = inputs
  globalCompleteness[completeness] = true
  return inputs
}

export const endInputRecording = (): void => {
  delete globalState[state]
  delete globalCompleteness[completeness]
}

// Proxies preserve Node's overloads and error semantics, including file descriptors.
export const inputReadFileSync: typeof fs.readFileSync = new Proxy(fs.readFileSync, {
  apply: (target, receiver, args: Parameters<typeof fs.readFileSync>) => {
    if (typeof args[0] !== 'number') recordInput(args[0])
    return Reflect.apply(target, receiver, args)
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
    recordInput(args[0])
    return Reflect.apply(target, receiver, args)
  },
})
export const inputReaddirSync: typeof fs.readdirSync = new Proxy(fs.readdirSync, {
  apply: (target, receiver, args: Parameters<typeof fs.readdirSync>) => {
    recordInput(args[0])
    const entries: Array<string | Buffer | fs.Dirent<string | Buffer>> = Reflect.apply(
      target,
      receiver,
      args,
    )
    const options = args[1]
    if (
      isInputRecording() === true &&
      typeof options === 'object' &&
      options !== null &&
      options.recursive === true
    ) {
      const root = args[0] instanceof URL ? fileURLToPath(args[0]) : args[0].toString()
      // Recursive readdir includes directories, even empty ones. Record every returned
      // path so an immediate-entry directory hash also catches nested additions.
      for (const entry of entries) {
        recordInput(
          typeof entry === 'string' || Buffer.isBuffer(entry)
            ? path.resolve(root, entry.toString())
            : path.resolve(entry.parentPath, entry.name.toString()),
        )
      }
    }
    return entries
  },
})

/** Bootstrap resolver filesystem capabilities. */
export const inputFileSystem = {
  realpathSync: fs.realpathSync,
  readFileSync: inputReadFileSync,
  existsSync: inputExistsSync,
}
