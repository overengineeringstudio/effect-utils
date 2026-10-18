import { EventEmitter, once } from 'node:events'
import path from 'node:path'
import { Writable } from 'node:stream'

import { API } from 'typescript/unstable/async'
import { describe, expect, it } from 'vitest'

import type { ClosableTsApi, JoinableChildProcess } from './ts-api.ts'
import { closeApi, runTsVirtualProject, TsApiTimeoutError } from './ts-api.ts'

/** A structural stand-in for the spawned child: liveness plus the exit event, no process. */
const fakeChild = (exitCode: number | null): JoinableChildProcess =>
  Object.assign(new EventEmitter(), { exitCode, kill: () => true })

describe('closeApi', () => {
  it('does not resolve until the child has exited', async () => {
    const calls: Array<string> = []
    const child = fakeChild(null)
    const api: ClosableTsApi = {
      close: async () => {
        throw new Error('Owned child must not receive snapshot release RPCs')
      },
      client: {
        process: child,
        close: async () => {
          calls.push('close')
        },
      },
    }

    let resolved = false
    const closed = closeApi({ api }).then(() => {
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
      client: { process: fakeChild(0), close: async () => {} },
    }

    // No `exit` event will ever fire: resolving proves no listener was awaited.
    await closeApi({ api })
  })

  it('closes sessions without a spawned child', async () => {
    let closed = false
    const api: ClosableTsApi = {
      close: async () => {
        closed = true
      },
    }

    await closeApi({ api })
    expect(closed).toBe(true)
  })

  it('terminates a child when closing the client never resolves', async () => {
    const signals: NodeJS.Signals[] = []
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal)
        child.signalCode = signal
        child.emit('exit', null, signal)
        return true
      },
    })
    await expect(
      closeApi({
        api: {
          close: async () => {},
          client: { process: child, close: () => new Promise<void>(() => {}) },
        },
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ _tag: 'TsApiTimeoutError', stage: 'close', timeoutMs: 10 })
    expect(signals).toEqual(['SIGTERM'])
    expect(child.listenerCount('exit')).toBe(0)
  })

  it('does not wait for another exit event after a signal exit', async () => {
    const child = Object.assign(fakeChild(null), { signalCode: 'SIGTERM' as const })
    let closed = false
    await closeApi({
      api: {
        close: async () => {},
        client: {
          process: child,
          close: async () => {
            closed = true
          },
        },
      },
    })
    expect(closed).toBe(true)
    expect(child.listenerCount('exit')).toBe(0)
  })

  it('closes the transport even when snapshot release rejects', async () => {
    const releaseError = new Error('snapshot release failed')
    let transportClosed = false
    await expect(
      closeApi({
        api: {
          close: async () => {
            throw releaseError
          },
          client: {
            close: async () => {
              transportClosed = true
            },
          },
        },
      }),
    ).rejects.toBe(releaseError)
    expect(transportClosed).toBe(true)
  })

  it('retains a transport cleanup defect as the snapshot failure cause', async () => {
    const releaseError = new Error('snapshot release failed')
    const transportError = new Error('transport cleanup failed')
    await expect(
      closeApi({
        api: {
          close: async () => {
            throw releaseError
          },
          client: {
            close: async () => {
              throw transportError
            },
          },
        },
      }),
    ).rejects.toBe(releaseError)
    expect(releaseError.cause).toBe(transportError)
  })

  it('does not send snapshot release to an initialized server with destroyed stdin', async () => {
    const api = new API({ cwd: process.cwd() })
    await api.updateSnapshot()
    const client = (api as unknown as ClosableTsApi).client
    const stdin = client?.process?.stdin
    if (stdin === undefined || stdin === null) throw new Error('Expected spawned server stdin')
    const closed = once(stdin, 'close')
    stdin.destroy()
    await closed

    await expect(closeApi({ api, timeoutMs: 500 })).resolves.toBeUndefined()
    expect(client?.process).toBeUndefined()
  })

  it('accumulates asynchronous destroyed-stdin errors after terminating the child', async () => {
    const streamError = Object.assign(new Error('Cannot call write after a stream was destroyed'), {
      code: 'ERR_STREAM_DESTROYED',
    })
    const stdin = new Writable({
      write: (_chunk, _encoding, callback) => callback(),
      final: (callback) => {
        queueMicrotask(() => callback(streamError))
      },
    })
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      stdin,
      kill: (signal: NodeJS.Signals) => {
        child.signalCode = signal
        child.emit('exit', null, signal)
        return true
      },
    })
    const failure = new TsApiTimeoutError({ stage: 'close', timeoutMs: 10 })
    await expect(
      closeApi({
        api: {
          close: async () => {
            throw new Error('Owned child must not receive snapshot release RPCs')
          },
          client: {
            process: child,
            close: async () => {
              stdin.end()
              throw failure
            },
          },
        },
      }),
    ).rejects.toBe(failure)
    expect(failure.cause).toBe(streamError)
    expect(stdin.closed).toBe(true)
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
