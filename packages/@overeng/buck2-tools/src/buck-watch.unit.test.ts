import * as ChildProcess from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  affectedPackagePaths,
  buildTargetsFor,
  CommandFailure,
  exitCodeOf,
  reconcileBuckViews as reconcileBuckViewsUnscoped,
  runCommand,
  runBuckWatchLoop,
  type BuckReconcileTiming,
  type BuckWatchPlan,
  type WatchChangeSource,
  type WatchLoopStatus,
} from './buck-watch.ts'
import { editorViewTestDataRoot } from './editor-view-test-filesystem.ts'
import {
  scopeEditorViewTestProcesses,
  trackEditorViewTestSpawn,
} from './editor-view-test-processes.ts'

const fixtureProcessIds = new Set([process.pid])
const reconcileBuckViews = scopeEditorViewTestProcesses({
  processIds: fixtureProcessIds,
  operation: reconcileBuckViewsUnscoped,
})

// Stable forwarding exports observe the named imports used by Bun's native modules.
const nativeChildProcess = {
  ...ChildProcess,
  spawn: trackEditorViewTestSpawn({
    processIds: fixtureProcessIds,
    spawnProcess: ChildProcess.spawn,
  }),
}
const childProcessMocks = { spawn: vi.fn(nativeChildProcess.spawn) }
vi.mock('node:child_process', () => ({ ...nativeChildProcess, ...childProcessMocks }))

const savedWatchTraceContext = {
  TRACEPARENT: process.env.TRACEPARENT,
  OTEL_TASK_TRACEPARENT: process.env.OTEL_TASK_TRACEPARENT,
}
const savedHostBudgetState = process.env.EDITOR_VIEW_HOST_BUDGET_STATE
const savedContentStore = process.env.EDITOR_VIEW_CONTENT_STORE
let hostBudgetState: string

/** Unlock directories only: immutable snapshot files may share CAS inodes. */
const unlockFixtureDirectories = (path: string): void => {
  const status = lstatSync(path)
  if (status.isDirectory() === false || status.isSymbolicLink() === true) return
  chmodSync(path, (status.mode & 0o777) | 0o700)
  for (const name of readdirSync(path)) unlockFixtureDirectories(join(path, name))
}
beforeAll(() => {
  // Only explicit telemetry fixtures may consume the process-wide exporter slots.
  delete process.env.TRACEPARENT
  delete process.env.OTEL_TASK_TRACEPARENT
  hostBudgetState = realpathSync(mkdtempSync(join(editorViewTestDataRoot(), 'buck-watch-budget-')))
  process.env.EDITOR_VIEW_HOST_BUDGET_STATE = hostBudgetState
  process.env.EDITOR_VIEW_CONTENT_STORE = join(hostBudgetState, 'content')
})
afterAll(() => {
  for (const [key, value] of Object.entries(savedWatchTraceContext))
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  if (savedHostBudgetState === undefined) delete process.env.EDITOR_VIEW_HOST_BUDGET_STATE
  else process.env.EDITOR_VIEW_HOST_BUDGET_STATE = savedHostBudgetState
  if (savedContentStore === undefined) delete process.env.EDITOR_VIEW_CONTENT_STORE
  else process.env.EDITOR_VIEW_CONTENT_STORE = savedContentStore
  unlockFixtureDirectories(hostBudgetState)
  rmSync(hostBudgetState, { recursive: true, force: true })
})

/** Every gate input the OTEL helpers read; tests pin each one explicitly. */
type OtelGateEnvironment = Record<
  | 'OTEL_TASK_TRACEPARENT'
  | 'OTEL_SPAN_BIN'
  | 'OTELITE_HTTP_ENDPOINT'
  | 'OTEL_EXPORTER_OTLP_ENDPOINT',
  string | undefined
>

/** Clears inherited gate inputs, keeps PATH/spool/traceparent from the test itself. */
const hermeticOtelGate = (): OtelGateEnvironment => {
  const saved: OtelGateEnvironment = {
    OTEL_TASK_TRACEPARENT: process.env.OTEL_TASK_TRACEPARENT,
    OTEL_SPAN_BIN: process.env.OTEL_SPAN_BIN,
    OTELITE_HTTP_ENDPOINT: process.env.OTELITE_HTTP_ENDPOINT,
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  }
  delete process.env.OTEL_TASK_TRACEPARENT
  delete process.env.OTEL_SPAN_BIN
  delete process.env.OTELITE_HTTP_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  return saved
}

const restoreOtelGate = (saved: OtelGateEnvironment): void => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
}

/** Observe real exporter requests and reaping; no runtime caller joins these children. */
const observeExporters = (bin: string) => {
  const children: ChildProcess.ChildProcess[] = []
  const exits: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>[] =
    []
  const spawned = childProcessMocks.spawn.mockImplementation((...args) => {
    const child = Reflect.apply(
      nativeChildProcess.spawn,
      ChildProcess,
      args,
    ) as ChildProcess.ChildProcess
    if (String(args[0]) === bin) {
      children.push(child)
      const exited = Promise.withResolvers<{
        readonly code: number | null
        readonly signal: NodeJS.Signals | null
      }>()
      child.once('close', (code, signal) => exited.resolve({ code, signal }))
      exits.push(exited.promise)
    }
    return child
  })
  return {
    children,
    settle: async () => {
      const turn = Promise.withResolvers<void>()
      setImmediate(turn.resolve)
      await turn.promise
      return Promise.all(exits)
    },
    restore: () => spawned.mockReset().mockImplementation(nativeChildProcess.spawn),
  }
}

const plan: BuckWatchPlan = {
  reloadPaths: ['genie/buck2'],
  reloadSuffixes: ['BUCK.genie.ts'],
  globalPaths: ['buck2', 'packages/shared/package-tree.ts', 'pnpm-lock.yaml'],
  packages: [
    {
      packagePath: 'packages/core',
      sourceRoots: ['src'],
      workspaceDependencies: [],
      targets: {
        dist: '//packages/core:dist',
        packageTree: '//packages/core:package_tree',
        typecheck: '//packages/core:typecheck',
      },
    },
    {
      packagePath: 'packages/app',
      sourceFiles: ['vite.config.ts'],
      sourceRoots: ['src', 'tests'],
      workspaceDependencies: ['packages/core'],
      targets: {
        packageTree: '//packages/app:package_tree',
        typecheck: '//packages/app:typecheck',
      },
      editor: {
        cell: 'effect_utils',
        consumerCache: '.devenv/vite-cache/app',
        inputsManifestTarget: '//packages/app:editor_view_inputs',
        target: '//packages/app:editor_inputs',
        viewName: 'app',
      },
    },
  ],
}

class ControlledChanges implements WatchChangeSource {
  readonly #batches: string[][] = []
  readonly #waiters: Array<(result: IteratorResult<readonly string[]>) => void> = []
  #closed = false

  emit(paths: readonly string[]): void {
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#batches.push([...paths])
    else waiter({ done: false, value: paths })
  }

  close(): Promise<void> {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
    return Promise.resolve()
  }

  [Symbol.asyncIterator](): AsyncIterator<readonly string[]> {
    return {
      next: () => {
        const batch = this.#batches.shift()
        if (batch !== undefined) return Promise.resolve({ done: false, value: batch })
        if (this.#closed === true) return Promise.resolve({ done: true, value: undefined })
        const pending = Promise.withResolvers<IteratorResult<readonly string[]>>()
        this.#waiters.push(pending.resolve)
        return pending.promise
      },
    }
  }
}

const until = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate() === true) return
    await Promise.resolve()
  }
  throw new Error('condition was not reached')
}

/** Real finite immutable inputs: both external roots must survive snapshot relocation. */
const makePublicationFixture = () => {
  const requireTool = (name: string): string => {
    const value = process.env[name]
    if (value === undefined || value === '')
      throw new Error(`declared test tool is unavailable: ${name}`)
    return value
  }
  const cp = requireTool('CP_BIN')
  const mv = requireTool('MV_BIN')
  const fingerprintTool = requireTool('FINGERPRINT_BIN')
  const root = realpathSync(mkdtempSync(join(editorViewTestDataRoot(), 'buck-watch-')))
  const manifest = join(root, 'editor-inputs.json')
  const nodeModules = join(root, 'inputs/app/node_modules')
  const packageTree = join(root, 'inputs/app/package_tree')
  const dependency = join(root, 'inputs/store/dep')
  const workspaceAuthority = join(root, 'authority.json')
  mkdirSync(join(root, 'packages/app'), { recursive: true })
  writeFileSync(join(root, 'packages/app/package.json'), '{}\n')
  for (const path of [nodeModules, packageTree, dependency]) mkdirSync(path, { recursive: true })
  writeFileSync(join(packageTree, 'index.js'), 'export const workspace = "λ"\n')
  writeFileSync(join(dependency, 'index.js'), 'export const dependency = "雪"\n')
  symlinkSync('../package_tree', join(nodeModules, 'workspace'))
  symlinkSync('../../store/dep', join(nodeModules, 'dep'))
  writeFileSync(
    manifest,
    JSON.stringify({
      schema: 'effect-utils/editor-view-inputs/v1',
      editorInputs: nodeModules,
      packageTree,
      readRoots: [packageTree, dependency],
    }),
  )
  writeFileSync(
    workspaceAuthority,
    JSON.stringify({
      schema: 'effect-utils/workspace-dependency-authority/v1',
      requiredPackages: ['packages/app'],
      ownedPackages: ['packages/app'],
    }),
  )
  const current = join(root, '.editor-view/app')
  const options = {
    plan,
    mode: 'publish' as const,
    repoRoot: root,
    workspaceRoot: root,
    buck2: '/tools/buck2',
    workspaceAuthority,
    cp,
    mv,
    fingerprintTool,
    snapshotRetention: 3,
    run: async (_command: Parameters<typeof runCommand>[0]) => {
      return { stdout: `//packages/app:editor_view_inputs ${manifest}\n`, stderr: '' }
    },
  }
  const record = () =>
    JSON.parse(readFileSync(join(current, 'editor-view.json'), 'utf8')) as {
      package: string
      cell: string
      target: string
      snapshot: string
      normalizedStoreDigest: string
    }
  const cleanup = () => {
    unlockFixtureDirectories(root)
    rmSync(root, { recursive: true, force: true })
  }
  return { root, manifest, nodeModules, packageTree, dependency, current, options, record, cleanup }
}

const publicationRequest = {
  packagePaths: ['packages/app'],
  changedPaths: ['packages/app/src/main.ts'],
  buildTargets: ['//packages/app:editor_view_inputs', '//packages/app:typecheck'],
}

describe('Buck watch reconciliation', () => {
  it('calculates the reverse affected set and the smallest unique target set', () => {
    expect(affectedPackagePaths({ plan, changedPaths: ['packages/core/src/value.ts'] })).toEqual([
      'packages/app',
      'packages/core',
    ])
    expect(
      buildTargetsFor({
        plan,
        packagePaths: ['packages/app'],
      }),
    ).toEqual(['//packages/app:editor_view_inputs', '//packages/app:typecheck'])
    expect(affectedPackagePaths({ plan, changedPaths: ['packages/app/vite.config.ts'] })).toEqual([
      'packages/app',
    ])
    expect(affectedPackagePaths({ plan, changedPaths: ['docs/guide.txt'] })).toEqual([])
    expect(affectedPackagePaths({ plan, changedPaths: ['pnpm-lock.yaml'] })).toEqual([
      'packages/app',
      'packages/core',
    ])
    expect(
      affectedPackagePaths({ plan, changedPaths: ['packages/shared/package-tree.ts'] }),
    ).toEqual(['packages/app', 'packages/core'])
  })

  it('subscribes before startup reconciliation and reconciles every package', async () => {
    const source = new ControlledChanges()
    const calls: string[][] = []
    let opened = false
    const abort = new AbortController()
    const running = runBuckWatchLoop({
      plan,
      signal: abort.signal,
      openChanges: async () => {
        opened = true
        return source
      },
      reconcile: async ({ packagePaths }) => {
        expect(opened).toBe(true)
        calls.push([...packagePaths])
        abort.abort()
      },
      writeStatus: async () => {},
    })
    await running
    expect(calls).toEqual([['packages/app', 'packages/core']])
  })

  it('publishes failed status when subscription startup fails', async () => {
    const statuses: WatchLoopStatus[] = []
    await expect(
      runBuckWatchLoop({
        plan,
        signal: new AbortController().signal,
        openChanges: async () => {
          throw new Error('watch-project failed')
        },
        reconcile: async () => {},
        writeStatus: async (status) => {
          statuses.push(status)
        },
      }),
    ).rejects.toThrow('watch-project failed')
    expect(statuses.at(-1)).toMatchObject({
      error: 'watch-project failed',
      phase: 'failed',
    })
  })

  it('fails with a restart requirement instead of reconciling stale topology', async () => {
    const source = new ControlledChanges()
    const statuses: WatchLoopStatus[] = []
    const calls: string[][] = []
    const running = runBuckWatchLoop({
      plan,
      signal: new AbortController().signal,
      openChanges: async () => source,
      reconcile: async ({ packagePaths }) => {
        calls.push([...packagePaths])
      },
      writeStatus: async (status) => {
        statuses.push(status)
      },
    })
    await until(() => statuses.some((status) => status.phase === 'idle'))
    source.emit(['packages/app/BUCK.genie.ts'])
    await expect(running).rejects.toThrow('regenerate and restart')
    expect(calls).toEqual([['packages/app', 'packages/core']])
    expect(statuses.at(-1)).toMatchObject({
      affectedPackages: [],
      phase: 'failed',
    })
  })

  it('coalesces changes received during a reconciliation cycle', async () => {
    const source = new ControlledChanges()
    const calls: string[][] = []
    const startup = Promise.withResolvers<void>()
    const abort = new AbortController()
    const running = runBuckWatchLoop({
      plan,
      signal: abort.signal,
      openChanges: async () => source,
      reconcile: async ({ packagePaths }) => {
        calls.push([...packagePaths])
        if (calls.length === 1) await startup.promise
        else abort.abort()
      },
      writeStatus: async () => {},
    })
    await until(() => calls.length === 1)
    source.emit(['packages/core/src/one.ts'])
    source.emit(['packages/core/src/two.ts', 'packages/app/src/main.ts'])
    startup.resolve()
    await running
    expect(calls).toEqual([
      ['packages/app', 'packages/core'],
      ['packages/app', 'packages/core'],
    ])
  })

  it('preserves the last successful generation after failure and reports the failure', async () => {
    const source = new ControlledChanges()
    const statuses: WatchLoopStatus[] = []
    let calls = 0
    const abort = new AbortController()
    const running = runBuckWatchLoop({
      plan,
      signal: abort.signal,
      openChanges: async () => source,
      reconcile: async () => {
        calls++
        if (calls === 2) throw new Error('buck build failed')
      },
      writeStatus: async (status) => {
        statuses.push(status)
        if (status.phase === 'failed') abort.abort()
      },
    })
    await until(() => statuses.some((status) => status.phase === 'idle'))
    source.emit(['packages/app/src/main.ts'])
    await running
    const failed = statuses.find((status) => status.phase === 'failed')
    expect(failed).toMatchObject({
      error: 'buck build failed',
      generation: 1,
      phase: 'failed',
    })
    expect(failed?.lastSuccessfulAt).toEqual(expect.any(String))
  })

  it.each([false, true])(
    'publishes every provider read root and never publishes after a failed build (batch=%s)',
    async (batchPublication) => {
      const fixture = makePublicationFixture()
      const shutdown = new AbortController()
      const invocations: Parameters<typeof runCommand>[0][] = []
      try {
        await reconcileBuckViews({
          request: publicationRequest,
          options: {
            ...fixture.options,
            batchPublication,
            signal: shutdown.signal,
            run: async (command) => {
              invocations.push(command)
              // Authority is process-local, never a numeric FD or argv/environment payload.
              expect(command).not.toHaveProperty('editorPublicationOwnerFd')
              expect(command.args.some((arg) => arg.includes('owner-fd'))).toBe(false)
              return fixture.options.run(command)
            },
          },
        })
        // Publisher argv capture disappeared with the subprocess. Assert the real parsed
        // identities and relocated provider bytes instead of pretending a tool path ran it.
        expect(invocations).toHaveLength(1)
        expect(invocations[0]?.command).toBe('/tools/buck2')
        expect(invocations[0]?.args).toEqual([
          'build',
          ...publicationRequest.buildTargets,
          '--show-full-output',
          '--event-log',
          expect.stringMatching(/editor-view-.*\.pb\.zst$/u),
        ])
        expect(invocations[0]?.signal).toBe(shutdown.signal)
        expect(invocations[0]?.detached).toBeUndefined()
        const first = fixture.record()
        expect(first).toMatchObject({
          package: 'packages/app',
          cell: 'effect_utils',
          target: '//packages/app:editor_inputs',
        })
        expect(readFileSync(join(fixture.current, 'node_modules/workspace/index.js'), 'utf8')).toBe(
          'export const workspace = "λ"\n',
        )
        expect(readFileSync(join(fixture.current, 'node_modules/dep/index.js'), 'utf8')).toBe(
          'export const dependency = "雪"\n',
        )
        expect(existsSync(join(fixture.current, 'editor-view-sources-v1.json'))).toBe(true)
        writeFileSync(join(fixture.dependency, 'index.js'), 'export const dependency = "changed"\n')
        await reconcileBuckViews({
          request: publicationRequest,
          options: { ...fixture.options, batchPublication },
        })
        const second = fixture.record()
        expect(second.normalizedStoreDigest).not.toBe(first.normalizedStoreDigest)
        expect(second.snapshot).not.toBe(first.snapshot)

        const failedInvocations: string[] = []
        await expect(
          reconcileBuckViews({
            request: publicationRequest,
            options: {
              ...fixture.options,
              batchPublication,
              run: async ({ command }) => {
                failedInvocations.push(command)
                throw new Error('stale build')
              },
            },
          }),
        ).rejects.toThrow('stale build')
        expect(failedInvocations).toEqual(['/tools/buck2'])
        expect(fixture.record()).toEqual(second)
      } finally {
        fixture.cleanup()
      }
    },
  )

  it.each([
    [false, 'budget'],
    [true, 'budget'],
    [false, 'payload'],
    [true, 'payload'],
  ] as const)(
    'emits real publisher diagnostics before reconciliation completes (batch=%s, prefix=%s)',
    async (batchPublication, diagnosticPrefix) => {
      const fixture = makePublicationFixture()
      const observed: string[] = []
      const onTiming = vi.fn<(timing: BuckReconcileTiming) => void>()
      let completed = false
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
        if (typeof line === 'string' && line.startsWith(`[editor-view-${diagnosticPrefix}] `)) {
          expect(completed).toBe(false)
          observed.push(line)
        }
        return true
      })
      try {
        // No pipe decoder remains between publisher and watch. Real diagnostics now
        // arrive as in-process writes; arbitrary subprocess chunk boundaries and the
        // former batch stderr replay duplicate are no longer part of this contract.
        await reconcileBuckViews({
          request: publicationRequest,
          options: { ...fixture.options, batchPublication, onTiming },
        })
        completed = true
        expect(observed.length).toBeGreaterThan(0)
        for (const line of observed) {
          expect(line.endsWith('\n')).toBe(true)
          expect(() => JSON.parse(line.slice(line.indexOf(' ') + 1))).not.toThrow()
        }
        expect(onTiming).toHaveBeenCalledWith({
          phase: 'editor-view',
          packagePath: 'packages/app',
          durationMs: expect.any(Number),
        })
        const publicationTimings = onTiming.mock.calls
          .map(([timing]) => timing)
          .filter((timing) => timing.phase === 'editor-view')
        expect(publicationTimings).toHaveLength(1)
        expect(publicationTimings[0]?.durationMs).toBeGreaterThanOrEqual(0)
        expect(fixture.record().package).toBe('packages/app')
      } finally {
        stderr.mockRestore()
        fixture.cleanup()
      }
    },
  )

  it('emits command spans for the build and real view validation without wrapping commands', async () => {
    const fixture = makePublicationFixture()
    await reconcileBuckViews({ request: publicationRequest, options: fixture.options })
    const otelDirectory = mkdtempSync(join(tmpdir(), 'otel-span-cli-'))
    const otelSpan = join(otelDirectory, 'otel-span')
    const capture = join(otelDirectory, 'captured.txt')
    writeFileSync(otelSpan, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(capture)}\n`)
    chmodSync(otelSpan, 0o755)
    const savedPath = process.env.PATH
    const savedTraceparent = process.env.TRACEPARENT
    const savedSpool = process.env.OTEL_SPAN_SPOOL_DIR
    process.env.PATH = `${otelDirectory}:${savedPath ?? ''}`
    process.env.TRACEPARENT = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
    process.env.OTEL_SPAN_SPOOL_DIR = otelDirectory
    const savedEnvironment = hermeticOtelGate()
    const telemetry = observeExporters(otelSpan)
    try {
      // Seed publication before enabling telemetry: this isolates command spans from
      // the real publisher's independent phase/host-budget exporter traffic.
      const invocations: { command: string; args: readonly string[] }[] = []
      await reconcileBuckViews({
        request: {
          packagePaths: ['packages/app'],
          changedPaths: [],
          buildTargets: ['//packages/app:editor_view_inputs'],
        },
        options: {
          ...fixture.options,
          mode: 'check',
          run: async (invocation) => {
            invocations.push(invocation)
            return fixture.options.run(invocation)
          },
        },
      })
      // Buck runs unwrapped; the dispatcher validates the real published snapshot.
      expect(invocations[0]?.command).toBe('/tools/buck2')
      expect(invocations[0]?.args[0]).toBe('build')
      expect(invocations).toHaveLength(1)
      expect(fixture.record().package).toBe('packages/app')
      await telemetry.settle()
      expect(telemetry.children).toHaveLength(2)
      const captured = readFileSync(capture, 'utf8')
      expect(captured).toContain('emit-span effect-utils-devenv buck2.build')
      expect(captured).toContain('--attr-int buck2.targets=1')
      expect(captured).toContain('emit-span effect-utils-devenv editor-view.publish')
      expect(captured).toContain('--attr-string package.path=packages/app')
      expect(captured).toContain('--attr-int exit.code=0')
      expect(captured).toContain('--status-code ok')
    } finally {
      await telemetry.settle()
      telemetry.restore()
      process.env.PATH = savedPath
      if (savedTraceparent === undefined) delete process.env.TRACEPARENT
      else process.env.TRACEPARENT = savedTraceparent
      if (savedSpool === undefined) delete process.env.OTEL_SPAN_SPOOL_DIR
      else process.env.OTEL_SPAN_SPOOL_DIR = savedSpool
      restoreOtelGate(savedEnvironment)
      rmSync(otelDirectory, { recursive: true, force: true })
      fixture.cleanup()
    }
  })

  it.each(['fails', 'hangs'])('keeps watch cycles green when telemetry %s', async (delivery) => {
    const fixture = makePublicationFixture()
    await reconcileBuckViews({ request: publicationRequest, options: fixture.options })
    const otelDirectory = mkdtempSync(join(tmpdir(), 'otel-span-cli-'))
    const otelSpan = join(otelDirectory, 'otel-span')
    writeFileSync(
      otelSpan,
      delivery === 'hangs'
        ? `#!${process.execPath}\nimport { watch } from 'node:fs'\nwatch(${JSON.stringify(otelSpan)}, () => {})\nawait Promise.withResolvers().promise\n`
        : '#!/bin/sh\nexit 3\n',
    )
    chmodSync(otelSpan, 0o755)
    const savedPath = process.env.PATH
    const savedTraceparent = process.env.TRACEPARENT
    const savedSpool = process.env.OTEL_SPAN_SPOOL_DIR
    process.env.PATH = `${otelDirectory}:${savedPath ?? ''}`
    process.env.TRACEPARENT = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
    process.env.OTEL_SPAN_SPOOL_DIR = otelDirectory
    const savedEnvironment = hermeticOtelGate()
    const telemetry = observeExporters(otelSpan)
    try {
      // Validation emits the same command spans without consuming slots for the
      // publisher's separate phase/budget spans; all publisher work above was real.
      const commands: string[] = []
      const source = new ControlledChanges()
      const abort = new AbortController()
      const statuses: WatchLoopStatus[] = []
      await runBuckWatchLoop({
        plan,
        signal: abort.signal,
        openChanges: async () => source,
        reconcile: (request) =>
          reconcileBuckViews({
            request,
            options: {
              ...fixture.options,
              mode: 'check',
              run: async (invocation) => {
                commands.push(invocation.command)
                return fixture.options.run(invocation)
              },
            },
          }),
        writeStatus: async (status) => {
          statuses.push(status)
          if (status.phase !== 'idle') return
          if (status.generation === 1) source.emit(['packages/app/src/main.ts'])
          else abort.abort()
        },
      })
      expect(commands).toEqual(['/tools/buck2', '/tools/buck2'])
      expect(fixture.record().package).toBe('packages/app')
      expect(
        statuses.filter((status) => status.phase === 'idle').map(({ generation }) => generation),
      ).toEqual([1, 2])
      const turn = Promise.withResolvers<void>()
      setImmediate(turn.resolve)
      await turn.promise
      expect(telemetry.children).toHaveLength(4)
      expect(telemetry.children.map((child) => child.spawnargs[3])).toEqual([
        'buck2.build',
        'editor-view.publish',
        'buck2.build',
        'editor-view.publish',
      ])
      for (const child of telemetry.children) {
        expect(child.spawnargs).toEqual(expect.arrayContaining(['exit.code=0', 'ok']))
        if (delivery === 'hangs') {
          expect(child.exitCode).toBeNull()
          expect(child.signalCode).toBeNull()
        }
      }
      expect(await telemetry.settle()).toEqual(
        Array.from({ length: 4 }, () =>
          delivery === 'hangs' ? { code: null, signal: 'SIGKILL' } : { code: 3, signal: null },
        ),
      )
    } finally {
      await telemetry.settle()
      telemetry.restore()
      process.env.PATH = savedPath
      if (savedTraceparent === undefined) delete process.env.TRACEPARENT
      else process.env.TRACEPARENT = savedTraceparent
      if (savedSpool === undefined) delete process.env.OTEL_SPAN_SPOOL_DIR
      else process.env.OTEL_SPAN_SPOOL_DIR = savedSpool
      restoreOtelGate(savedEnvironment)
      rmSync(otelDirectory, { recursive: true, force: true })
      fixture.cleanup()
    }
  })

  it('streams request bodies larger than the single-argument limit without argv payloads', async () => {
    const input = 'x'.repeat(256 * 1024)
    const result = await runCommand({
      command: process.execPath,
      args: ['-e', 'console.log((await Bun.stdin.text()).length)'],
      cwd: tmpdir(),
      input,
    })
    expect(result.stdout.trim()).toBe(String(input.length))
  })

  it('records signaled command termination as a failed nonzero exit', async () => {
    const error = await runCommand({
      command: process.execPath,
      args: ['-e', 'console.error("exited 0"); process.kill(process.pid, "SIGTERM")'],
      cwd: tmpdir(),
    }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    )
    expect(error).toBeInstanceOf(CommandFailure)
    expect((error as CommandFailure).exitCode).toBeUndefined()
    expect((error as CommandFailure).signal).toBe('SIGTERM')
    // The signal kill must not be marked ok even though stderr contains "exited 0".
    expect(exitCodeOf(error)).toBe(1)
  })

  it('retains signaled child status when stdin fails before close', async () => {
    const inputError = new Error('EPIPE: broken pipe, write')
    const spawned = childProcessMocks.spawn.mockImplementationOnce((...args) => {
      const child = Reflect.apply(
        nativeChildProcess.spawn,
        ChildProcess,
        args,
      ) as ChildProcess.ChildProcess
      child.stderr?.once('data', () => {
        child.stdin?.emit('error', inputError)
        child.kill('SIGTERM')
      })
      return child
    })
    try {
      const error = await runCommand({
        command: process.execPath,
        args: ['-e', 'require("node:net").createServer().listen(0, () => console.error("ready"))'],
        cwd: tmpdir(),
        input: '',
      }).then(
        () => undefined,
        (rejection: unknown) => rejection,
      )
      expect(error).toBeInstanceOf(CommandFailure)
      expect((error as CommandFailure).signal).toBe('SIGTERM')
    } finally {
      spawned.mockReset().mockImplementation(nativeChildProcess.spawn)
    }
  })

  it('keeps embedded command output from forging an exit status', async () => {
    const error = await runCommand({
      command: process.execPath,
      args: ['-e', 'console.error("nested tool exited 0"); process.exit(5)'],
      cwd: tmpdir(),
    }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    )
    expect((error as CommandFailure).exitCode).toBe(5)
    expect(exitCodeOf(error)).toBe(5)
    expect(exitCodeOf(new Error('unrelated failure'))).toBe(1)
  })

  it('closes the subscription and publishes stopped status on shutdown', async () => {
    const source = new ControlledChanges()
    const statuses: WatchLoopStatus[] = []
    const abort = new AbortController()
    const running = runBuckWatchLoop({
      plan,
      signal: abort.signal,
      openChanges: async () => source,
      reconcile: async () => {},
      writeStatus: async (status) => {
        statuses.push(status)
      },
    })
    await until(() => statuses.some((status) => status.phase === 'idle'))
    abort.abort()
    await running
    expect(statuses.at(-1)?.phase).toBe('stopped')
    await expect(source[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })
})
