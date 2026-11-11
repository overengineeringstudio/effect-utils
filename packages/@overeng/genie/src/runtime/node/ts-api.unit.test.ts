import { EventEmitter, once } from 'node:events'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'

import { API } from 'typescript/unstable/async'
import { describe, expect, it, vi } from 'vitest'

import type { ClosableTsApi, JoinableChildProcess } from './ts-api.ts'
import {
  closeApi,
  darwinTsgoRealpathWorkaround,
  realpathThroughName,
  runTsFileAnalysis,
  runTsVirtualProject,
  TsApiTimeoutError,
} from './ts-api.ts'

/** A structural stand-in for the spawned child: liveness plus the exit event, no process. */
const fakeChild = (exitCode: number | null): JoinableChildProcess =>
  Object.assign(new EventEmitter(), { exitCode, kill: () => true })

describe('TypeScript API source-reader launch boundary', () => {
  it('refuses to construct the API without its packaged descriptor mapper', async () => {
    const active = process.env.EDITOR_VIEW_LEASE_ACTIVE
    const preload = process.env.EDITOR_VIEW_LEASE_PRELOAD
    process.env.EDITOR_VIEW_LEASE_ACTIVE = '1'
    delete process.env.EDITOR_VIEW_LEASE_PRELOAD
    try {
      await expect(
        runTsFileAnalysis({
          cwd: process.cwd(),
          use: () => {
            throw new Error('An unprotected compiler must never become usable')
          },
        }),
      ).rejects.toThrow('bootstrap-safe editor-view lease preload')
    } finally {
      if (active === undefined) delete process.env.EDITOR_VIEW_LEASE_ACTIVE
      else process.env.EDITOR_VIEW_LEASE_ACTIVE = active
      if (preload === undefined) delete process.env.EDITOR_VIEW_LEASE_PRELOAD
      else process.env.EDITOR_VIEW_LEASE_PRELOAD = preload
    }
  })
})

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

describe('TypeScript API server death', () => {
  it.each([
    ['exit 23', 'code 23 / signal null'],
    ['kill -KILL $$', 'code null / signal SIGKILL'],
  ])(
    'fails fast with bounded stderr when the server runs %s',
    async (exit, status) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'genie-ts-api-test-'))
      const executable = path.join(directory, 'fake-server')
      const previous = process.env.GENIE_TYPESCRIPT_API_SERVER
      writeFileSync(
        executable,
        // EOF must fail distinctly: the former dash wrapper incorrectly handed the server /dev/null.
        `#!/bin/sh\nIFS= read -r request || exit 91\nprintf '%s' '${'x'.repeat(5000)}panic-tail' >&2\n${exit}\n`,
        { mode: 0o700 },
      )
      process.env.GENIE_TYPESCRIPT_API_SERVER = executable
      const started = performance.now()
      try {
        const error = await runTsFileAnalysis({ cwd: directory, use: () => undefined }).catch(
          (error: unknown) => error,
        )
        expect(error).toBeInstanceOf(Error)
        const message = error instanceof Error ? error.message : ''
        const prefix = `TypeScript API server exited at updateSnapshot (${status}): `
        expect(message.startsWith(prefix)).toBe(true)
        expect(message).toContain('panic-tail')
        expect(Buffer.byteLength(message.slice(prefix.length))).toBeLessThanOrEqual(4096)
        expect(performance.now() - started).toBeLessThan(5000)
      } finally {
        if (previous === undefined) delete process.env.GENIE_TYPESCRIPT_API_SERVER
        else process.env.GENIE_TYPESCRIPT_API_SERVER = previous
        rmSync(directory, { recursive: true, force: true })
      }
    },
    5000,
  )

  it.each([
    ['EPIPE', 'exit 23'],
    ['ECONNRESET', 'exit 23'],
    ['ERR_STREAM_DESTROYED', 'exit 23'],
    ['ERR_STREAM_PREMATURE_CLOSE', 'exit 23'],
    ['ERR_STREAM_WRITE_AFTER_END', 'exit 23'],
    [undefined, 'exit 23'],
    ['EPIPE', 'while IFS= read -r _; do :; done'],
  ])('classifies transport error %s before child exit (%s)', async (code, exit) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'genie-ts-api-test-'))
    const executable = path.join(directory, 'fake-server')
    const previous = process.env.GENIE_TYPESCRIPT_API_SERVER
    const transportError = Object.assign(new Error(code ?? 'Stream is closed'), { code })
    writeFileSync(
      executable,
      `#!/bin/sh\nIFS= read -r request || exit 91\nprintf panic-tail >&2\n${exit}\n`,
      { mode: 0o700 },
    )
    process.env.GENIE_TYPESCRIPT_API_SERVER = executable
    // Reject in the same turn that unblocks the server: Node cannot dispatch its exit first.
    // This deterministically covers the ordering that a real JSON-RPC write only sometimes hits.
    const update = vi
      .spyOn(API.prototype, 'updateSnapshot')
      .mockImplementation(function (this: API) {
        const child = (this as unknown as ClosableTsApi).client?.process
        expect(child?.exitCode).toBeNull()
        child?.stdin?.write('request\n')
        return Promise.reject(transportError)
      })
    try {
      const error = await runTsFileAnalysis({
        cwd: directory,
        requestTimeoutMs: 1000,
        use: () => undefined,
      }).catch((error: unknown) => error)
      if (exit === 'exit 23') {
        expect(error).toBeInstanceOf(Error)
        expect(error instanceof Error ? error.message : '').toBe(
          'TypeScript API server exited at updateSnapshot (code 23 / signal null): panic-tail',
        )
      } else {
        // A transport failure is not proof of death: preserve it if the join deadline expires.
        expect(error).toBe(transportError)
      }
    } finally {
      update.mockRestore()
      if (previous === undefined) delete process.env.GENIE_TYPESCRIPT_API_SERVER
      else process.env.GENIE_TYPESCRIPT_API_SERVER = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('darwinTsgoRealpathWorkaround', () => {
  it('does not install a realpath callback on other platforms', () => {
    expect(darwinTsgoRealpathWorkaround('linux')).toBeUndefined()
    expect(darwinTsgoRealpathWorkaround('win32')).toBeUndefined()
  })

  it('retains the reached hardlink name through symlinked node_modules', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genie-realpath-')))
    try {
      const target = path.join(root, 'packages', 'effect')
      mkdirSync(target, { recursive: true })
      const store = path.join(root, 'sha256-0444')
      writeFileSync(store, 'export declare const value: number')
      const reached = path.join(target, 'index.d.ts')
      linkSync(store, reached)
      symlinkSync(path.dirname(target), path.join(root, 'node_modules'))
      symlinkSync('index.d.ts', path.join(target, 'alias.d.ts'))
      const fs = darwinTsgoRealpathWorkaround('darwin')!
      expect(fs.realpath(path.join(root, 'node_modules', 'effect', 'index.d.ts'))).toBe(reached)
      expect(fs.realpath(path.join(root, 'node_modules', 'effect', 'alias.d.ts'))).toBe(reached)
      expect(fs.realpath(path.join(root, 'missing.ts'))).toBeUndefined()
      expect(realpathThroughName(`${root}/node_modules/effect/../effect/index.d.ts`)).toBe(reached)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
