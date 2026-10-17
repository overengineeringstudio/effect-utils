import { EventEmitter } from 'node:events'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ClosableTsApi, JoinableChildProcess } from './ts-api.ts'
import { closeApi, runTsVirtualProject } from './ts-api.ts'

/** A structural stand-in for the spawned child: liveness plus the exit event, no process. */
const fakeChild = (exitCode: number | null): JoinableChildProcess =>
  Object.assign(new EventEmitter(), { exitCode }) as JoinableChildProcess

describe('closeApi', () => {
  it('does not resolve until the child has exited', async () => {
    const calls: Array<string> = []
    const child = fakeChild(null)
    const api: ClosableTsApi = {
      close: async () => {
        calls.push('close')
      },
      client: { process: child },
    }

    let resolved = false
    const closed = closeApi(api).then(() => {
      resolved = true
    })
    // `close()` resolved but the child is still alive: the join must still be pending, and the
    // listener must already be attached so the exit cannot slip through.
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['close'])
    expect(resolved).toBe(false)
    expect(child.listenerCount('exit')).toBe(1)

    // Mirror real child semantics: the code flips before the event is emitted.
    Object.assign(child, { exitCode: 0 })
    child.emit('exit', 0, null)
    await closed
    expect(resolved).toBe(true)
  })

  it('returns once close resolves when the child already exited', async () => {
    const api: ClosableTsApi = {
      close: async () => {},
      client: { process: fakeChild(0) },
    }

    // No `exit` event will ever fire: resolving proves no listener was awaited.
    await closeApi(api)
  })

  it('closes sessions without a spawned child', async () => {
    let closed = false
    const api: ClosableTsApi = {
      close: async () => {
        closed = true
      },
    }

    await closeApi(api)
    expect(closed).toBe(true)
  })
})

const root = path.resolve('/genie-virtual/ts-api')
const entry = path.resolve(root, 'entry.ts')

describe('runTsVirtualProject', () => {
  it('reports project-wide diagnostics that belong to no file', async () => {
    // `noLib` removes the global types the checker needs but pins the failure to the PROJECT, not to
    // any source position: TypeScript reports it only through `getGlobalDiagnostics`. Collecting just
    // config/program/syntactic/semantic diagnostics makes a broken lib or global-type resolution pass
    // vacuously, which would silently hollow out every proof built on this helper.
    const messages = await runTsVirtualProject({
      root,
      files: new Map([[entry, 'export const answer = 42\n']]),
      rootFiles: [entry],
      compilerOptions: { noEmit: true, noLib: true, strict: true, target: 'es2024' },
      use: async (project) => project.diagnosticMessages(),
    })

    expect(messages.some((message) => message.includes("Cannot find global type 'Array'"))).toBe(
      true,
    )
  })

  it('reports no diagnostics for a project that compiles', async () => {
    const messages = await runTsVirtualProject({
      root,
      files: new Map([[entry, 'export const answer: number = 42\n']]),
      rootFiles: [entry],
      compilerOptions: { noEmit: true, strict: true, target: 'es2024' },
      use: async (project) => project.diagnosticMessages(),
    })

    expect(messages).toEqual([])
  })
})
