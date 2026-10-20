import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as ChildProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import * as Fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  cancelEditorViewBudgetReservation,
  editorViewHostBudgetStateDirectory,
  makeEditorViewBudgetCensusSession,
  reserveEditorViewBudget,
} from './editor-view-budget.ts'
import { shareSnapshotFiles } from './editor-view-sharing.ts'
import {
  pinEditorView,
  publishEditorView,
  releaseEditorViewRoot,
  type EditorViewOptions,
  type EditorViewRecord,
} from './editor-view.ts'
import { emitCompletedSpanAsync } from './otel-span-cli.ts'

// Stable forwarding exports observe the named imports used by Bun's native modules.
const nativeChildProcess = { ...ChildProcess }
const childProcessMocks = {
  spawn: vi.fn(nativeChildProcess.spawn),
  spawnSync: vi.fn(nativeChildProcess.spawnSync),
}
vi.mock('node:child_process', () => ({ ...nativeChildProcess, ...childProcessMocks }))
const nativeFs = { ...Fs }
const fsMocks = { readlinkSync: vi.fn(nativeFs.readlinkSync) }
vi.mock('node:fs', () => ({ ...nativeFs, ...fsMocks }))

/** Match the publisher's integration fixtures: tools never resolve through ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const cp = requireTool('CP_BIN')
const mv = requireTool('MV_BIN')
const fingerprintTool = requireTool('FINGERPRINT_BIN')
const bun = requireTool('BUN_BIN')
const ps = requireTool('PS_BIN')
const payloadBytes = 1_048_576
const hostGraceMs = 300_000
const hostRecencyMs = 86_400_000
const setupBudgetBytes = 40_000_000_000

const savedBudgetTraceContext = {
  TRACEPARENT: process.env.TRACEPARENT,
  OTEL_TASK_TRACEPARENT: process.env.OTEL_TASK_TRACEPARENT,
}
beforeAll(() => {
  // Phase spans also share the bound; ambient CI tracing must not compete with capture fixtures.
  delete process.env.TRACEPARENT
  delete process.env.OTEL_TASK_TRACEPARENT
})
afterAll(() => {
  for (const [key, value] of Object.entries(savedBudgetTraceContext))
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
})

const pathExists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/** Cleanup changes directory permissions only, never permissions on shared CAS payload inodes. */
const removeOwnedTree = (root: string): void => {
  if (pathExists(root) === false) return
  const unlockDirectories = (path: string): void => {
    const status = lstatSync(path)
    if (status.isDirectory() === false || status.isSymbolicLink() === true) return
    chmodSync(path, (status.mode & 0o777) | 0o700)
    for (const name of readdirSync(path)) unlockDirectories(join(path, name))
  }
  unlockDirectories(root)
  rmSync(root, { recursive: true, force: true })
}

type Fixture = {
  readonly root: string
  readonly editorRoot: string
  readonly firstHop: string
  readonly payload: string
  readonly options: EditorViewOptions
}

type Reader = {
  readonly child: ChildProcessWithoutNullStreams
  readonly ready: Promise<void>
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
  readonly stop: () => Promise<void>
}

type Host = {
  readonly root: string
  readonly contentStore: string
  readonly budgetState: string
  readonly readers: Reader[]
  readonly fixture: (name: string, byte: number, size?: number, contentStore?: string) => Fixture
  readonly gate: () => PromiseWithResolvers<void>
  readonly track: <TValue>(operation: Promise<TValue>) => Promise<TValue>
  readonly age: (fixture: Fixture, record: EditorViewRecord) => void
  readonly advance: (milliseconds: number) => void
  readonly publish: (
    fixture: Fixture,
    overrides?: Partial<EditorViewOptions>,
  ) => Promise<EditorViewRecord>
  readonly cleanup: () => Promise<void>
}

const makeHost = (): Host => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-view-host-budget-')))
  const contentStore = join(root, 'shared-content', 'v1')
  const budgetState = join(root, 'host-budget')
  const savedBudgetState = process.env.EDITOR_VIEW_HOST_BUDGET_STATE
  process.env.EDITOR_VIEW_HOST_BUDGET_STATE = budgetState
  const savedRecency = process.env.EDITOR_VIEW_HOST_RECENCY_MS
  process.env.EDITOR_VIEW_HOST_RECENCY_MS = String(hostRecencyMs)
  const pending: Promise<unknown>[] = []
  const releases: (() => void)[] = []
  const readers: Reader[] = []
  // Only the wall-clock policy input is controlled. Filesystems, readers, copies and flocks are real.
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const track = <TValue>(operation: Promise<TValue>): Promise<TValue> => {
    pending.push(operation)
    void operation.catch(() => undefined)
    return operation
  }
  const fixture = (
    name: string,
    byte: number,
    size = payloadBytes,
    store = contentStore,
  ): Fixture => {
    const repoRoot = join(root, name)
    const packagePath = 'packages/@overeng/budget-view'
    const packageDir = join(repoRoot, packagePath)
    const editorRoot = join(repoRoot, 'packages', '.editor-view')
    const editorInputs = join(repoRoot, 'inputs', 'editor_inputs')
    const nodeModules = join(repoRoot, 'inputs', 'node_modules')
    const workspaceAuthority = join(repoRoot, 'workspace-authority.json')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), '{}\n')
    mkdirSync(editorInputs, { recursive: true })
    writeFileSync(join(editorInputs, 'install-descriptor.json'), '{"revision":1}\n')
    mkdirSync(join(nodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep'), { recursive: true })
    const payload = join(nodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep', 'payload.bin')
    writeFileSync(payload, Buffer.alloc(size, byte))
    symlinkSync('.pnpm/dep@1/node_modules/dep', join(nodeModules, 'dep'))
    writeFileSync(
      workspaceAuthority,
      `${JSON.stringify({
        schema: 'effect-utils/workspace-dependency-authority/v1',
        requiredPackages: [packagePath],
        ownedPackages: [packagePath],
      })}\n`,
    )
    return {
      root: repoRoot,
      editorRoot,
      firstHop: join(packageDir, 'node_modules'),
      payload,
      options: {
        repoRoot,
        package: packagePath,
        viewName: 'budget-view',
        cell: 'budget-view',
        target: `//${packagePath}:editor_inputs`,
        editorInputs,
        backingRoots: [editorInputs],
        nodeModules,
        workspaceAuthority,
        consumerCache: join(repoRoot, '.devenv', 'vite-cache', 'budget-view'),
        cp,
        mv,
        fingerprintTool,
        contentStore: store,
        hostBudgetBytes: setupBudgetBytes,
        snapshotRetention: 32,
      },
    }
  }
  const gate = () => {
    const barrier = Promise.withResolvers<void>()
    releases.push(() => barrier.resolve())
    return barrier
  }
  const age = (fixture: Fixture, record: EditorViewRecord): void => {
    const path = join(fixture.editorRoot, record.snapshot)
    // Keep the equal directory mtimes below every last-use timestamp, preserving the LRU order.
    utimesSync(path, lstatSync(path).atime, new Date(now - (hostRecencyMs + hostGraceMs) * 2 - 1))
  }
  return {
    root,
    contentStore,
    budgetState,
    readers,
    fixture,
    gate,
    track,
    age,
    advance: (milliseconds: number): void => {
      now += milliseconds
    },
    publish: (fixture: Fixture, overrides: Partial<EditorViewOptions> = {}) =>
      track(publishEditorView({ ...fixture.options, ...overrides })),
    cleanup: async (): Promise<void> => {
      for (const release of releases) release()
      try {
        try {
          await Promise.all(readers.map((reader) => reader.stop()))
        } finally {
          // A failed reader assertion must not delete a still-running publisher's root.
          await Promise.allSettled(pending)
        }
      } finally {
        clock.mockRestore()
        if (savedRecency === undefined) delete process.env.EDITOR_VIEW_HOST_RECENCY_MS
        else process.env.EDITOR_VIEW_HOST_RECENCY_MS = savedRecency
        if (savedBudgetState === undefined) delete process.env.EDITOR_VIEW_HOST_BUDGET_STATE
        else process.env.EDITOR_VIEW_HOST_BUDGET_STATE = savedBudgetState
        removeOwnedTree(root)
      }
    },
  }
}

type BudgetEvent = {
  readonly event: string
  readonly budgetBytes: number
  readonly usedBytes: number
  readonly protectedBytes: number
  readonly reservationBytes: number
  readonly reservedBytes: number
  readonly pendingEstimateBytes: number
  readonly topHolders: readonly unknown[]
  readonly message: string
}

const budgetEvents = (stderr: string): readonly BudgetEvent[] =>
  stderr.split('\n').flatMap((line) => {
    if (line.startsWith('{') === false) return []
    const value: unknown = JSON.parse(line)
    if (
      typeof value !== 'object' ||
      value === null ||
      'event' in value === false ||
      typeof value.event !== 'string' ||
      value.event.startsWith('editor-view.host-budget.') === false
    )
      return []
    if (
      'budgetBytes' in value === false ||
      typeof value.budgetBytes !== 'number' ||
      'usedBytes' in value === false ||
      typeof value.usedBytes !== 'number' ||
      'protectedBytes' in value === false ||
      typeof value.protectedBytes !== 'number' ||
      'reservationBytes' in value === false ||
      typeof value.reservationBytes !== 'number' ||
      'reservedBytes' in value === false ||
      typeof value.reservedBytes !== 'number' ||
      'pendingEstimateBytes' in value === false ||
      typeof value.pendingEstimateBytes !== 'number' ||
      'topHolders' in value === false ||
      Array.isArray(value.topHolders) === false ||
      'message' in value === false ||
      typeof value.message !== 'string'
    )
      throw new Error(`incomplete structured host-budget event: ${line}`)
    return [
      {
        event: value.event,
        budgetBytes: value.budgetBytes,
        usedBytes: value.usedBytes,
        protectedBytes: value.protectedBytes,
        reservationBytes: value.reservationBytes,
        reservedBytes: value.reservedBytes,
        pendingEstimateBytes: value.pendingEstimateBytes,
        topHolders: value.topHolders,
        message: value.message,
      },
    ]
  })

const captureStderr = async <TValue>(run: () => Promise<TValue>) => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const value = await run()
    return { value, stderr: stderr.mock.calls.map(([chunk]) => String(chunk)).join('') }
  } finally {
    stderr.mockRestore()
  }
}

type OverBudgetPublication = {
  readonly event: BudgetEvent
  readonly record: EditorViewRecord
  readonly message: string
  readonly stderr: string
}

const overBudgetPublication = async (
  host: Host,
  fixture: Fixture,
  budgetBytes: number,
): Promise<OverBudgetPublication> => {
  let materialized = false
  const captured = await captureStderr(() =>
    host.publish(fixture, {
      hostBudgetBytes: budgetBytes,
      beforeMaterialize: () => {
        materialized = true
      },
    }),
  )
  expect(materialized).toBe(true)
  expectCurrent(fixture, captured.value)
  expect(
    readdirSync(join(fixture.editorRoot, '.store')).filter((name) =>
      name.startsWith('.candidate-'),
    ),
  ).toEqual([])
  const events = budgetEvents(captured.stderr).filter(
    ({ event }) => event === 'editor-view.host-budget.over-budget',
  )
  expect(events).toHaveLength(1)
  const event = events[0]
  if (event === undefined) throw new Error('publisher emitted no structured over-budget alert')
  expect(event.budgetBytes).toBe(budgetBytes)
  expect(event.reservationBytes).toBeGreaterThan(0)
  return { event, record: captured.value, message: event.message, stderr: captured.stderr }
}

type BudgetReservation = {
  readonly token: string
  readonly pid: number
  readonly process: string
  readonly editorRoot: string
  readonly bytes: number
  readonly contentStore: string
  readonly budgetBytes: number
}

type BudgetLedger = {
  readonly epoch: number
  readonly journal: readonly { readonly epoch: number; readonly estimatedBytes: number }[]
  readonly reservations: readonly BudgetReservation[]
  readonly usedBytes: number
  readonly protectedBytes: number
  readonly contentStores: readonly string[]
  readonly generations: Readonly<Record<string, unknown>>
}

/** Inspect real persistent admission records without changing them or bypassing their flock. */
const readBudgetLedger = (host: Host): BudgetLedger => {
  const value: unknown = JSON.parse(readFileSync(join(host.budgetState, 'state-v1.json'), 'utf8'))
  if (
    typeof value !== 'object' ||
    value === null ||
    'schema' in value === false ||
    value.schema !== 'effect-utils/editor-view-host-budget/v1' ||
    'epoch' in value === false ||
    typeof value.epoch !== 'number' ||
    'journal' in value === false ||
    Array.isArray(value.journal) === false ||
    'reservations' in value === false ||
    typeof value.reservations !== 'object' ||
    value.reservations === null ||
    Array.isArray(value.reservations) === true ||
    'usage' in value === false ||
    typeof value.usage !== 'object' ||
    value.usage === null ||
    'usedBytes' in value.usage === false ||
    typeof value.usage.usedBytes !== 'number' ||
    'protectedBytes' in value.usage === false ||
    typeof value.usage.protectedBytes !== 'number' ||
    'contentStores' in value === false ||
    Array.isArray(value.contentStores) === false ||
    value.contentStores.some((store: unknown) => typeof store !== 'string') === true ||
    'generations' in value === false ||
    typeof value.generations !== 'object' ||
    value.generations === null ||
    Array.isArray(value.generations) === true
  )
    throw new Error('host-budget ledger lacks structured reservations or measured usage')
  const reservations = Object.entries(value.reservations).map(
    ([token, entry]: [string, unknown]) => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        'token' in entry === false ||
        entry.token !== token ||
        'pid' in entry === false ||
        typeof entry.pid !== 'number' ||
        'process' in entry === false ||
        typeof entry.process !== 'string' ||
        'editorRoot' in entry === false ||
        typeof entry.editorRoot !== 'string' ||
        'bytes' in entry === false ||
        typeof entry.bytes !== 'number' ||
        'budgetBytes' in entry === false ||
        typeof entry.budgetBytes !== 'number' ||
        'contentStore' in entry === false ||
        typeof entry.contentStore !== 'string'
      )
        throw new Error(
          `host-budget reservation lacks owner incarnation or byte accounting: ${token}`,
        )
      return {
        token,
        pid: entry.pid,
        process: entry.process,
        editorRoot: entry.editorRoot,
        bytes: entry.bytes,
        budgetBytes: entry.budgetBytes,
        contentStore: entry.contentStore,
      }
    },
  )
  const journal = value.journal.map((entry: unknown) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      'epoch' in entry === false ||
      typeof entry.epoch !== 'number' ||
      'estimatedBytes' in entry === false ||
      typeof entry.estimatedBytes !== 'number'
    )
      throw new Error('host-budget journal mixes measured usage with an invalid estimate')
    return { epoch: entry.epoch, estimatedBytes: entry.estimatedBytes }
  })
  return {
    epoch: value.epoch,
    journal,
    reservations,
    usedBytes: value.usage.usedBytes,
    protectedBytes: value.usage.protectedBytes,
    contentStores: value.contentStores,
    generations: Object.fromEntries(Object.entries(value.generations)),
  }
}

/** A real child keeps a snapshot or canonical CAS descriptor open until explicit release. */
const openReader = (
  host: Host,
  fixture: Fixture,
  record: EditorViewRecord,
  { fromContentStore = false }: { readonly fromContentStore?: boolean } = {},
): Reader => {
  const path = join(
    fixture.editorRoot,
    record.snapshot,
    'node_modules',
    '.pnpm',
    'dep@1',
    'node_modules',
    'dep',
    'payload.bin',
  )
  let openedPath = path
  if (fromContentStore === true) {
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
    openedPath = join(
      fixture.options.contentStore ?? host.contentStore,
      digest.slice(0, 2),
      `${digest}-0444`,
    )
    const snapshot = lstatSync(path, { bigint: true })
    const blob = lstatSync(openedPath, { bigint: true })
    expect([blob.dev, blob.ino]).toEqual([snapshot.dev, snapshot.ino])
    expect(blob.nlink).toBeGreaterThan(1n)
  }
  const script = join(host.root, 'snapshot-reader.ts')
  writeFileSync(
    script,
    [
      "import { openSync, closeSync } from 'node:fs'",
      'const fd = openSync(process.argv[2], "r")',
      'process.stdin.resume()',
      'process.stdin.once("data", () => { closeSync(fd); process.exit(0) })',
      'process.stdout.write("ready\\n")',
    ].join('\n'),
  )
  const child = spawn(bun, [script, openedPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  const ready = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<{
    readonly code: number | null
    readonly signal: NodeJS.Signals | null
  }>()
  let output = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
    if (output.includes('ready\n') === true) ready.resolve()
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  child.once('error', (error) => {
    ready.reject(error)
    exited.reject(error)
  })
  child.once('exit', (code, signal) => {
    exited.resolve({ code, signal })
    ready.reject(new Error(`snapshot reader exited before readiness: ${code ?? signal}; ${stderr}`))
  })
  void ready.promise.catch(() => undefined)
  void exited.promise.catch(() => undefined)
  const reader: Reader = {
    child,
    ready: ready.promise,
    exited: exited.promise,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end('release\n')
      expect(await exited.promise).toEqual({ code: 0, signal: null })
    },
  }
  host.readers.push(reader)
  return reader
}

const expectRunningReader = (reader: Reader): void => {
  const status = spawnSync(ps, ['-p', String(reader.child.pid), '-o', 'pid='], { encoding: 'utf8' })
  expect({ status: status.status, stderr: status.stderr }).toEqual({ status: 0, stderr: '' })
  expect(status.stdout.trim()).toBe(String(reader.child.pid))
}

/** Record actual otel-span subprocess arguments; forwarding exports preserve native processes. */
const recordTelemetry = async <TValue>(
  root: string,
  run: (children: readonly ChildProcess.ChildProcess[]) => Promise<TValue>,
  { hangBudget = false }: { readonly hangBudget?: boolean } = {},
) => {
  const bin = join(root, 'record-otel-span')
  const capture = join(root, 'otel-spans.jsonl')
  writeFileSync(
    bin,
    `#!${bun}\nimport { appendFileSync, watch } from 'node:fs'\nappendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)) + '\\n')\nif (${hangBudget} && process.argv.includes('editor-view.host-budget')) { watch(${JSON.stringify(capture)}, () => {}); await Promise.withResolvers().promise }\n`,
  )
  chmodSync(bin, 0o755)
  const values = {
    OTEL_SPAN_BIN: bin,
    OTEL_SPAN_SPOOL_DIR: root,
    OTEL_TASK_TRACEPARENT: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    OTELITE_HTTP_ENDPOINT: '',
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
  }
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  const children: ChildProcess.ChildProcess[] = []
  const invocations: (readonly string[])[] = []
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
      invocations.push(child.spawnargs.slice(1))
      const exited = Promise.withResolvers<{
        readonly code: number | null
        readonly signal: NodeJS.Signals | null
      }>()
      child.once('close', (code, signal) => exited.resolve({ code, signal }))
      exits.push(exited.promise)
    }
    return child
  })
  try {
    const value = await run(children)
    // Delivery is deferred; join real exporter close events only in the test fixture.
    const deliveryTurn = Promise.withResolvers<void>()
    setImmediate(deliveryTurn.resolve)
    await deliveryTurn.promise
    const settled = await Promise.all(exits)
    const spans: readonly unknown[] =
      pathExists(capture) === true
        ? readFileSync(capture, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : []
    return { value, spans, invocations, exits: settled }
  } finally {
    const cleanupTurn = Promise.withResolvers<void>()
    setImmediate(cleanupTurn.resolve)
    await cleanupTurn.promise
    await Promise.all(exits)
    spawned.mockReset().mockImplementation(nativeChildProcess.spawn)
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const expectCurrent = (fixture: Fixture, record: EditorViewRecord): void => {
  expect(readlinkSync(join(fixture.editorRoot, fixture.options.viewName))).toBe(record.snapshot)
  expect(readlinkSync(fixture.firstHop)).toBe('../../.editor-view/budget-view/node_modules')
  expect(pathExists(join(fixture.editorRoot, record.snapshot))).toBe(true)
}

describe('host budget evicts unreferenced storage before idle current generations', () => {
  let host: Host
  let oldest: Fixture
  let newer: Fixture
  let superseded: Fixture
  let measurement: Fixture
  let incoming: Fixture
  let nextIncoming: Fixture
  let oldestRecord: EditorViewRecord
  let newerRecord: EditorViewRecord
  let oldRecord: EditorViewRecord
  let supersededRecord: EditorViewRecord
  let incomingRecord: EditorViewRecord
  let probe: BudgetEvent
  let unreferencedBudget: number
  let idleBudget: number
  let orphanBlob: string

  beforeAll(async () => {
    host = makeHost()
    oldest = host.fixture('oldest-current', 11)
    newer = host.fixture('newer-current', 22, payloadBytes, join(host.root, 'other-content', 'v1'))
    superseded = host.fixture('superseded-view', 33)
    measurement = host.fixture('measured-small', 54, 64)
    incoming = host.fixture('incoming-small', 55, 64)
    nextIncoming = host.fixture('incoming-next-', 66, 64)
    oldestRecord = await host.publish(oldest)
  })
  afterAll(async () => {
    if (host !== undefined) await host.cleanup()
  })

  it('registers a more recently used current generation in another worktree', async () => {
    host.advance(1_000)
    newerRecord = await host.publish(newer)
  })

  it('publishes the generation that will become unreferenced', async () => {
    host.advance(1_000)
    oldRecord = await host.publish(superseded)
  })

  it('supersedes that generation without local retention collecting it', async () => {
    host.advance(1_000)
    writeFileSync(superseded.payload, Buffer.alloc(payloadBytes, 44))
    supersededRecord = await host.publish(superseded)
    expect(pathExists(join(superseded.editorRoot, oldRecord.snapshot))).toBe(true)
  })

  it('measures the real incoming reservation while existing generations are grace-protected', async () => {
    probe = (await overBudgetPublication(host, measurement, 1)).event
    expect(probe.protectedBytes).toBeGreaterThanOrEqual(payloadBytes * 4)
    expect(probe.reservationBytes).toBeLessThan(payloadBytes / 4)
    unreferencedBudget = probe.usedBytes + probe.reservationBytes - payloadBytes / 2
    idleBudget = unreferencedBudget - payloadBytes
    expect(editorViewHostBudgetStateDirectory()).toBe(host.budgetState)
    expect(readBudgetLedger(host).contentStores.toSorted()).toEqual(
      [host.contentStore, newer.options.contentStore].toSorted(),
    )
  })

  it('creates a genuine unreferenced CAS payload and ages all eligible generations', async () => {
    const candidate = join(host.root, 'orphan-candidate')
    mkdirSync(candidate)
    const bytes = Buffer.alloc(payloadBytes, 77)
    writeFileSync(join(candidate, 'payload.bin'), bytes)
    await host.track(shareSnapshotFiles({ candidate, contentStore: host.contentStore }))
    const digest = createHash('sha256').update(bytes).digest('hex')
    orphanBlob = join(host.contentStore, digest.slice(0, 2), `${digest}-0444`)
    removeOwnedTree(candidate)
    expect(lstatSync(orphanBlob).nlink).toBe(1)
    host.advance(hostRecencyMs + hostGraceMs + 1)
    for (const [fixture, record] of [
      [oldest, oldestRecord],
      [newer, newerRecord],
      [superseded, oldRecord],
      [superseded, supersededRecord],
    ] as const)
      host.age(fixture, record)
  })

  it('reclaims the orphan CAS payload and old generation without evicting any current view', async () => {
    incomingRecord = await host.publish(incoming, { hostBudgetBytes: unreferencedBudget })
    expect(pathExists(orphanBlob)).toBe(false)
    expect(pathExists(join(superseded.editorRoot, oldRecord.snapshot))).toBe(false)
    expectCurrent(oldest, oldestRecord)
    expectCurrent(newer, newerRecord)
    expectCurrent(superseded, supersededRecord)
    expectCurrent(incoming, incomingRecord)
  })

  it('next evicts only the least-recently-used quiescent current generation', async () => {
    await host.publish(nextIncoming, { hostBudgetBytes: idleBudget })
    expect(pathExists(join(oldest.editorRoot, oldestRecord.snapshot))).toBe(false)
    expectCurrent(newer, newerRecord)
    expectCurrent(superseded, supersededRecord)
    expectCurrent(incoming, incomingRecord)
  })

  it('removes owned current and consumer hops and leaves an actionable eviction marker', () => {
    // lstat, not existsSync: a dangling symlink must not pass this assertion.
    expect(pathExists(join(oldest.editorRoot, oldest.options.viewName))).toBe(false)
    expect(pathExists(oldest.firstHop)).toBe(false)
    const marker: unknown = JSON.parse(
      readFileSync(join(oldest.editorRoot, '.evicted-budget-view.json'), 'utf8'),
    )
    expect(marker).toEqual({
      schema: 'effect-utils/editor-view-evicted/v1',
      snapshot: oldestRecord.snapshot,
      reason: 'host-budget',
      budgetBytes: idleBudget,
      usedBytes: expect.any(Number),
    })
  })

  it('cleanly republishes the evicted view and explains why publication was necessary', async () => {
    const captured = await captureStderr(() => host.publish(oldest))
    expect(captured.stderr).toContain('evicted by host budget')
    expect(captured.stderr).toContain('republishing')
    expect(captured.value.snapshot).toBe(oldestRecord.snapshot)
    expectCurrent(oldest, captured.value)
    expect(pathExists(join(oldest.editorRoot, '.evicted-budget-view.json'))).toBe(false)
    expect(
      readFileSync(
        join(oldest.editorRoot, captured.value.snapshot, 'node_modules', 'dep', 'payload.bin'),
      ),
    ).toEqual(Buffer.alloc(payloadBytes, 11))
  })
})

describe('host budget alerts while publishing protected managed, live, recent and grace-held footprints', () => {
  let host: Host
  let pinned: Fixture
  let live: Fixture
  let recent: Fixture
  let grace: Fixture
  let incoming: Fixture
  let pinnedRecord: EditorViewRecord
  let liveRecord: EditorViewRecord
  let recentRecord: EditorViewRecord
  let graceRecord: EditorViewRecord
  let reader: Reader
  let overBudget: BudgetEvent
  let overflow:
    | {
        readonly value: OverBudgetPublication
        readonly spans: readonly unknown[]
      }
    | undefined

  beforeAll(async () => {
    host = makeHost()
    pinned = host.fixture('managed-reader', 81)
    live = host.fixture('kernel-reader-', 82)
    grace = host.fixture('grace-holder--', 83)
    incoming = host.fixture('admitted-new--', 84, 64)
    recent = host.fixture('recent-holder-', 85)
    pinnedRecord = await host.publish(pinned)
  })
  afterAll(async () => {
    if (host !== undefined) await host.cleanup()
  })

  it('admits a managed reader through the real content-store flock', async () => {
    await host.track(
      pinEditorView({ options: pinned.options, name: 'editor', snapshot: pinnedRecord.snapshot }),
    )
  })

  it('publishes another current generation for a real kernel reader', async () => {
    liveRecord = await host.publish(live)
  })

  it('keeps a canonical CAS descriptor after host grace and root recency have expired', async () => {
    reader = openReader(host, live, liveRecord, { fromContentStore: true })
    await reader.ready
    expectRunningReader(reader)
    host.advance(hostRecencyMs + hostGraceMs + 1)
    host.age(pinned, pinnedRecord)
    host.age(live, liveRecord)
  })

  it('publishes a recently used root outside the later five-minute grace', async () => {
    recentRecord = await host.publish(recent)
    host.advance(hostGraceMs * 2 + 1)
    host.age(recent, recentRecord)
  })

  it('publishes a fresh current view inside the five-minute host grace', async () => {
    graceRecord = await host.publish(grace)
  })

  it('publishes through the single protected-overflow pressure API', async () => {
    overflow = await recordTelemetry(host.root, () => overBudgetPublication(host, incoming, 1))
  })

  it('preserves all protected readers and emits actionable JSON plus a successful OTEL span', () => {
    if (overflow === undefined) throw new Error('protected overflow publication did not complete')
    const captured = overflow
    overBudget = captured.value.event
    expect(overBudget.usedBytes).toBeGreaterThan(1)
    expect(overBudget.protectedBytes).toBeGreaterThanOrEqual(payloadBytes * 4)
    expect(overBudget.topHolders.length).toBeGreaterThanOrEqual(4)
    for (const fixture of [pinned, live, recent, grace]) {
      expect(JSON.stringify(overBudget.topHolders)).toContain(fixture.editorRoot)
      expect(captured.value.message).toContain(fixture.editorRoot)
    }
    expect(captured.value.message).toContain(String(overBudget.budgetBytes))
    expect(captured.value.message).toContain(String(overBudget.usedBytes))
    expect(captured.value.message).toContain('Publishing anyway')
    expectCurrent(pinned, pinnedRecord)
    expectCurrent(live, liveRecord)
    expectCurrent(recent, recentRecord)
    expectCurrent(grace, graceRecord)
    expectRunningReader(reader)
    expect(
      readFileSync(
        join(
          incoming.editorRoot,
          captured.value.record.snapshot,
          'node_modules',
          'dep',
          'payload.bin',
        ),
      ),
    ).toEqual(Buffer.alloc(64, 84))
    const warnings = budgetEvents(captured.value.stderr).filter(
      ({ event }) => event === 'editor-view.host-budget.warning',
    )
    expect(warnings).toHaveLength(1)
    const overBudgetSpans = captured.spans.filter(
      (span): span is string[] =>
        Array.isArray(span) === true &&
        span.every((arg) => typeof arg === 'string') &&
        span.includes('editor-view.host-budget') &&
        span.includes('editor_view.host_budget.event=editor-view.host-budget.over-budget'),
    )
    expect(overBudgetSpans).toHaveLength(1)
    expect(overBudgetSpans[0]).toEqual(
      expect.arrayContaining([
        'emit-span',
        'editor-view.host-budget',
        'exit.code=0',
        '--status-code',
        'ok',
        `editor_view.host_budget.budget_bytes=${overBudget.budgetBytes}`,
        `editor_view.host_budget.used_bytes=${overBudget.usedBytes}`,
        `editor_view.host_budget.protected_bytes=${overBudget.protectedBytes}`,
        `editor_view.host_budget.reserved_bytes=${overBudget.reservedBytes}`,
        `editor_view.host_budget.pending_estimate_bytes=${overBudget.pendingEstimateBytes}`,
      ]),
    )
  })

  it('re-arms the warning threshold with a warm publication under an ample budget', async () => {
    const record = await host.publish(grace)
    expect(record.snapshot).toBe(graceRecord.snapshot)
  })

  it('warns when a warm protected footprint crosses eighty percent of the budget', async () => {
    const budgetBytes = Math.ceil(overBudget.protectedBytes / 0.85)
    const captured = await captureStderr(() =>
      host.publish(grace, { hostBudgetBytes: budgetBytes }),
    )
    expect(captured.value.snapshot).toBe(graceRecord.snapshot)
    const warnings = budgetEvents(captured.stderr).filter(
      ({ event }) => event === 'editor-view.host-budget.warning',
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ budgetBytes })
    expect(warnings[0]?.protectedBytes).toBeGreaterThanOrEqual(budgetBytes * 0.8)
  })

  it('closes and awaits the real reader rather than relying on a sleep or process disappearance', async () => {
    await reader.stop()
  })
})

describe('concurrent advisory host-budget publication and managed pin admission', () => {
  let host: Host
  let pinned: Fixture
  let live: Fixture
  let contenders: readonly Fixture[]
  let pinnedRecord: EditorViewRecord
  let liveRecord: EditorViewRecord
  let reader: Reader
  let admission:
    | {
        readonly baseline: BudgetLedger
        readonly publications: readonly Promise<EditorViewRecord>[]
        readonly admitted: number
        readonly stderr: string
        readonly release: () => void
      }
    | undefined
  let reservationsAsserted = false

  beforeAll(async () => {
    host = makeHost()
    pinned = host.fixture('pinned-existing', 91)
    const otherStore = join(host.root, 'independent-content', 'v1')
    live = host.fixture('opened-existing', 92, payloadBytes, otherStore)
    contenders = [
      host.fixture('concurrent-view-a', 93),
      host.fixture('concurrent-view-b', 94, payloadBytes, otherStore),
    ]
    pinnedRecord = await host.publish(pinned)
  })
  afterAll(async () => {
    if (host !== undefined) await host.cleanup()
  })

  it('pins the existing generation with the production managed-reader API', async () => {
    await host.track(
      pinEditorView({
        options: pinned.options,
        name: 'existing-reader',
        snapshot: pinnedRecord.snapshot,
      }),
    )
  })

  it('publishes the second protected root', async () => {
    liveRecord = await host.publish(live)
  })

  it('holds the second root through a real child descriptor', async () => {
    reader = openReader(host, live, liveRecord)
    await reader.ready
    expectRunningReader(reader)
  })

  it('expires root recency and grace without relinquishing either protected reader', () => {
    host.advance(hostRecencyMs + hostGraceMs + 1)
    host.age(pinned, pinnedRecord)
    host.age(live, liveRecord)
  })

  it('admits a pin and two independent-store publishers to their real reservation barriers', async () => {
    const baseline = readBudgetLedger(host)
    expect(baseline.reservations).toEqual([])
    expect(baseline.contentStores.toSorted()).toEqual(
      contenders.map(({ options }) => options.contentStore).toSorted(),
    )
    const pinEntered = Promise.withResolvers<void>()
    const pinRelease = host.gate()
    const materializeRelease = host.gate()
    const allAdmitted = Promise.withResolvers<void>()
    let admitted = 0
    const pin = host.track(
      pinEditorView({
        options: pinned.options,
        name: 'concurrent-reader',
        snapshot: pinnedRecord.snapshot,
        afterStoreLock: async () => {
          pinEntered.resolve()
          await pinRelease.promise
        },
      }),
    )
    await Promise.race([
      pinEntered.promise,
      pin.then(() => {
        throw new Error('managed pin completed before its CAS barrier')
      }),
    ])
    const captured = await host.track(
      captureStderr(async () => {
        const publications = contenders.map((fixture) =>
          host.publish(fixture, {
            hostBudgetBytes: 1,
            beforeMaterialize: async () => {
              admitted++
              if (admitted === contenders.length) allAdmitted.resolve()
              await materializeRelease.promise
            },
          }),
        )
        // Both own a root while the pin holds CAS; neither may wait on the sibling root.
        pinRelease.resolve()
        await pin
        await Promise.race([
          allAdmitted.promise,
          Promise.race(publications).then(() => {
            throw new Error('publication completed before both reservation barriers were reached')
          }),
        ])
        return { publications, admitted }
      }),
    )
    admission = {
      baseline,
      ...captured.value,
      stderr: captured.stderr,
      release: () => materializeRelease.resolve(),
    }
  })

  it('sums both stores and held reservations in the one host ledger and over-budget JSON', () => {
    if (admission === undefined) throw new Error('concurrent admission did not complete')
    const budgetBytes = 1
    const { baseline, admitted, stderr } = admission
    expect(admitted).toBe(2)
    const held = readBudgetLedger(host)
    // Each new contender registers one root and admits one reservation; both stores
    // were already registered by the protected fixtures before this baseline.
    expect(held.epoch).toBe(baseline.epoch + contenders.length * 2)
    expect(held.reservations).toHaveLength(2)
    expect(new Set(held.reservations.map(({ token }) => token)).size).toBe(2)
    expect(new Set(held.reservations.map(({ process }) => process)).size).toBe(1)
    expect(held.reservations.map(({ editorRoot }) => editorRoot).toSorted()).toEqual(
      contenders.map(({ editorRoot }) => editorRoot).toSorted(),
    )
    expect(held.reservations.map(({ contentStore }) => contentStore).toSorted()).toEqual(
      held.contentStores.toSorted(),
    )
    for (const reservation of held.reservations) {
      expect(reservation.pid).toBe(process.pid)
      expect(reservation.process.length).toBeGreaterThan(0)
      expect(reservation.bytes).toBeGreaterThan(payloadBytes * 2)
      expect(reservation.budgetBytes).toBe(budgetBytes)
    }
    const reservedBytes = held.reservations.reduce((sum, { bytes }) => sum + bytes, 0)
    expect(held.usedBytes + reservedBytes).toBeGreaterThan(budgetBytes)
    expect(held.protectedBytes).toBeGreaterThanOrEqual(payloadBytes * 2)
    for (const fixture of contenders)
      expect(pathExists(join(fixture.editorRoot, fixture.options.viewName))).toBe(false)
    expectCurrent(pinned, pinnedRecord)
    expectCurrent(live, liveRecord)
    expectRunningReader(reader)
    expect(
      JSON.parse(readFileSync(join(pinned.editorRoot, '.pins', 'concurrent-reader.json'), 'utf8')),
    ).toMatchObject({ snapshot: pinnedRecord.snapshot })
    const events = budgetEvents(stderr)
    const overBudget = events.filter(({ event }) => event === 'editor-view.host-budget.over-budget')
    expect(overBudget).toHaveLength(2)
    for (const event of overBudget) {
      expect(event.budgetBytes).toBe(budgetBytes)
      expect(
        event.usedBytes + event.reservedBytes + event.pendingEstimateBytes + event.reservationBytes,
      ).toBeGreaterThan(budgetBytes)
      expect(event.reservedBytes).toBeGreaterThanOrEqual(0)
      expect(event.pendingEstimateBytes).toBe(0)
      expect(event.protectedBytes).toBeGreaterThanOrEqual(payloadBytes * 2)
    }
    const smallestReservation = Math.min(...held.reservations.map(({ bytes }) => bytes))
    expect(
      Math.max(...overBudget.map(({ reservedBytes }) => reservedBytes)),
    ).toBeGreaterThanOrEqual(smallestReservation)
    expect(
      Math.max(
        ...overBudget.map(
          ({ usedBytes, reservedBytes, pendingEstimateBytes }) =>
            usedBytes + reservedBytes + pendingEstimateBytes,
        ),
      ),
    ).toBeGreaterThanOrEqual(held.usedBytes + smallestReservation)
    expect(events.some(({ event }) => event === 'editor-view.host-budget.refused')).toBe(false)
    reservationsAsserted = true
  })

  it('finishes both real publishers and removes their global reservations', async () => {
    if (admission === undefined || reservationsAsserted === false)
      throw new Error('held reservation assertions did not complete')
    admission.release()
    const records = await Promise.all(admission.publications)
    const finished = readBudgetLedger(host)
    expect(finished.reservations).toEqual([])
    expect(finished.usedBytes).toBeGreaterThanOrEqual(admission.baseline.usedBytes)
    const admissionEpoch = admission.baseline.epoch
    const newEstimates = finished.journal.filter(({ epoch }) => epoch > admissionEpoch)
    expect(newEstimates).toHaveLength(2)
    for (const { estimatedBytes } of newEstimates)
      expect(estimatedBytes).toBeGreaterThanOrEqual(payloadBytes)
    expectCurrent(pinned, pinnedRecord)
    expectCurrent(live, liveRecord)
    for (let index = 0; index < contenders.length; index++) {
      const fixture = contenders[index]
      const record = records[index]
      if (fixture === undefined || record === undefined)
        throw new Error('missing concurrent publication record')
      expectCurrent(fixture, record)
      expect(
        readdirSync(join(fixture.editorRoot, '.store')).filter((name) =>
          name.startsWith('.candidate-'),
        ),
      ).toEqual([])
    }
  })

  it('closes and awaits the reader after both publications', async () => {
    await reader.stop()
  })
})

describe('warm publication wins the census-to-victim-lock race', () => {
  let host: Host
  let victim: Fixture
  let victimRecord: EditorViewRecord

  beforeAll(async () => {
    host = makeHost()
    victim = host.fixture('warm-race-victim', 101)
    victimRecord = await host.publish(victim)
  })
  afterAll(async () => {
    if (host !== undefined) await host.cleanup()
  })

  it('makes the unchanged current generation eligible in the initial census', () => {
    host.advance(hostRecencyMs + hostGraceMs + 1)
    host.age(victim, victimRecord)
  })

  it('rechecks actual warm last-use after acquiring the victim publication lock', async () => {
    const incoming = host.fixture('warm-race-incoming', 102, 64)
    mkdirSync(incoming.editorRoot, { recursive: true })
    const heldPath = join(incoming.editorRoot, '.publish.lock')
    mkdirSync(heldPath)
    writeFileSync(
      join(heldPath, 'owner.json'),
      JSON.stringify({
        schema: 'effect-utils/editor-view-lock/v1',
        token: 'incoming-owner',
        pid: process.pid,
      }),
    )
    let warmed = 0
    let acquired = 0
    try {
      const reservation = await host.track(
        reserveEditorViewBudget({
          contentStore: host.contentStore,
          root: { repoRoot: incoming.root, editorRoot: incoming.editorRoot },
          heldEditorRoot: incoming.editorRoot,
          discoverRoots: () => [{ repoRoot: victim.root, editorRoot: victim.editorRoot }],
          reservationBytes: 1,
          budgetBytes: 1,
          tryLockRoot: (root) => {
            expect(root.editorRoot).toBe(victim.editorRoot)
            // The synchronous callback completes a real publisher in the window
            // after census, before this process creates the victim root lock.
            if (warmed === 0) {
              host.advance(1_000)
              const script = [
                `import { publishEditorView } from ${JSON.stringify(new URL('./editor-view.ts', import.meta.url).href)}`,
                `Date.now = () => ${Date.now()}`,
                `const record = await publishEditorView({ ...${JSON.stringify(victim.options)}, beforeMaterialize: () => { throw new Error('expected a real warm publication') } })`,
                `if (record.snapshot !== ${JSON.stringify(victimRecord.snapshot)}) throw new Error('warm generation changed')`,
                'process.stdout.write("warm-complete\\n")',
              ].join('\n')
              const warm = spawnSync(bun, ['--eval', script], { encoding: 'utf8' })
              expect(warm.status).toBe(0)
              const phasePrefix = '[editor-view-phase] '
              const remainingStderr = warm.stderr
                .split('\n')
                .filter((line) => {
                  if (line.startsWith(phasePrefix) === false) return true
                  JSON.parse(line.slice(phasePrefix.length))
                  return false
                })
                .join('\n')
              expect(remainingStderr).toBe('')
              expect(warm.stdout).toContain('warm-complete\n')
              warmed++
            }
            const path = join(root.editorRoot, '.publish.lock')
            mkdirSync(path)
            writeFileSync(
              join(path, 'owner.json'),
              JSON.stringify({
                schema: 'effect-utils/editor-view-lock/v1',
                token: 'warm-race-owner',
                pid: process.pid,
              }),
            )
            acquired++
            return { release: () => rmSync(path, { recursive: true }) }
          },
        }),
      )
      try {
        expect(warmed).toBe(1)
        expect(acquired).toBeGreaterThan(0)
        expectCurrent(victim, victimRecord)
        expect(pathExists(join(victim.editorRoot, '.evicted-budget-view.json'))).toBe(false)
      } finally {
        await host.track(
          cancelEditorViewBudgetReservation({
            contentStore: host.contentStore,
            token: reservation.token,
          }),
        )
      }
    } finally {
      rmSync(heldPath, { recursive: true, force: true })
    }
  })
})

describe('publication waits for a live budget eviction, but not stale publisher locks', () => {
  let host: Host
  let victim: Fixture
  let incoming: Fixture
  let record: EditorViewRecord
  let eviction: Promise<EditorViewRecord> | undefined
  let waiting: Promise<EditorViewRecord> | undefined
  let releaseEviction: (() => void) | undefined

  beforeAll(async () => {
    host = makeHost()
    victim = host.fixture('wait-victim', 111)
    incoming = host.fixture('wait-incoming', 112, 64)
    record = await host.publish(victim)
  })
  afterAll(async () => {
    if (host !== undefined) await host.cleanup()
  })

  it('expires grace and recency without altering the production root lock', () => {
    host.advance(hostRecencyMs + hostGraceMs + 1)
    host.age(victim, record)
  })

  it('starts an actual publisher while pressure eviction holds its live owner lock', async () => {
    const entered = Promise.withResolvers<void>()
    const release = host.gate()
    releaseEviction = () => release.resolve()
    eviction = host.publish(incoming, {
      hostBudgetBytes: 1,
      beforeBudgetEviction: async () => {
        entered.resolve()
        await release.promise
      },
    })
    await Promise.race([
      entered.promise,
      eviction.then(() => {
        throw new Error('pressure publication skipped the victim-lock barrier')
      }),
    ])
    const lockPath = join(victim.editorRoot, '.publish.lock')
    const owner = readFileSync(join(lockPath, 'owner.json'), 'utf8')
    expect(JSON.parse(owner)).toMatchObject({
      schema: 'effect-utils/editor-view-lock/v1',
      kind: 'eviction',
      pid: process.pid,
      process: expect.any(String),
    })
    const attempts = vi.spyOn(Fs, 'mkdirSync')
    const priorImplementation = attempts.getMockImplementation()
    try {
      waiting = host.publish(victim)
      // publishEditorView reaches its first root-lock attempt synchronously. The
      // passive spy confirms arrival during the held barrier, without fake control.
      expect(attempts.mock.calls.some(([path]) => path === lockPath)).toBe(true)
      expect(readFileSync(join(lockPath, 'owner.json'), 'utf8')).toBe(owner)
    } finally {
      attempts.mockRestore()
      // Preserve another test file's shared vi.fn after Bun restores the spy.
      if (priorImplementation !== undefined) attempts.mockImplementation(priorImplementation)
    }
  })

  it('releases eviction and lets the waiting publisher successfully republish', async () => {
    if (eviction === undefined || waiting === undefined || releaseEviction === undefined)
      throw new Error('live eviction contention was not established')
    releaseEviction()
    const [incomingRecord, republished] = await Promise.all([eviction, waiting])
    expectCurrent(incoming, incomingRecord)
    expectCurrent(victim, republished)
    expect(republished.snapshot).toBe(record.snapshot)
    expect(pathExists(join(victim.editorRoot, '.evicted-budget-view.json'))).toBe(false)
    expect(pathExists(join(victim.editorRoot, '.publish.lock'))).toBe(false)
  })

  it.each([
    { name: 'normal-live', pid: process.pid },
    { name: 'dead-eviction', pid: 2_147_483_647, kind: 'eviction', process: 'dead-incarnation' },
    { name: 'unknown-eviction', pid: process.pid, kind: 'eviction', process: 'unknown' },
    { name: 'reused-eviction', pid: process.pid, kind: 'eviction', process: 'wrong-incarnation' },
  ])('keeps explicit recovery for $name locks', async ({ name, ...owner }) => {
    const fixture = host.fixture(name, 113, 64)
    const lockPath = join(fixture.editorRoot, '.publish.lock')
    mkdirSync(lockPath, { recursive: true })
    const serialized = JSON.stringify({
      schema: 'effect-utils/editor-view-lock/v1',
      token: `owner-${name}`,
      ...owner,
    })
    writeFileSync(join(lockPath, 'owner.json'), serialized)
    await expect(host.publish(fixture)).rejects.toThrow('recovery requires explicit:')
    expect(readFileSync(join(lockPath, 'owner.json'), 'utf8')).toBe(serialized)
    expect(pathExists(join(fixture.editorRoot, fixture.options.viewName))).toBe(false)
  })
})

describe('host generation footprint sidecars follow coordinated retirement and root release', () => {
  let host: Host
  let victim: Fixture
  let pressure: Fixture
  let oldRecord: EditorViewRecord
  let currentRecord: EditorViewRecord
  let sidecarsBeforeRetirement: readonly string[]
  let sidecarsBeforeRelease: readonly string[]
  const sidecars = (): readonly string[] => {
    const files = readdirSync(join(host.budgetState, 'footprints')).toSorted()
    expect(files.every((name) => /^[0-9a-f]{64}\.bin$/.test(name))).toBe(true)
    return files
  }

  beforeAll(async () => {
    host = makeHost()
    victim = host.fixture('sidecar-victim', 121)
    pressure = host.fixture('sidecar-pressure', 123, 64)
    oldRecord = await host.publish(victim)
  })
  afterAll(async () => {
    if (host !== undefined) await host.cleanup()
  })

  it('supersedes a real generation and records both footprint sidecars', async () => {
    writeFileSync(victim.payload, Buffer.alloc(payloadBytes, 122))
    currentRecord = await host.publish(victim)
    const ledger = readBudgetLedger(host)
    sidecarsBeforeRetirement = sidecars()
    expect(sidecarsBeforeRetirement).toHaveLength(2)
    expect(sidecarsBeforeRetirement.length).toBe(Object.keys(ledger.generations).length)
    expect(pathExists(join(victim.editorRoot, oldRecord.snapshot))).toBe(true)
  })

  it('pins only the current generation with the production managed-reader API', async () => {
    await host.track(
      pinEditorView({
        options: victim.options,
        name: 'sidecar-current',
        snapshot: currentRecord.snapshot,
      }),
    )
  })

  it('retires the obsolete generation and prunes its sidecar in a coordinated census', async () => {
    host.advance(hostRecencyMs + hostGraceMs + 1)
    host.age(victim, oldRecord)
    host.age(victim, currentRecord)
    // Root recency protects every generation, so expire it completely. The real
    // managed pin retains only current; the superseded generation is eligible.
    await host.publish(pressure, {
      hostBudgetBytes: 1,
      beforeMaterialize: () => {
        // Census has retired the old generation; no new footprint has landed yet.
        const remaining = sidecars()
        expect(remaining).toHaveLength(sidecarsBeforeRetirement.length - 1)
        expect(sidecarsBeforeRetirement.filter((name) => remaining.includes(name))).toHaveLength(1)
      },
    })
    expect(pathExists(join(victim.editorRoot, oldRecord.snapshot))).toBe(false)
    expectCurrent(victim, currentRecord)
    const ledger = readBudgetLedger(host)
    const remaining = sidecars()
    expect(remaining.length).toBe(Object.keys(ledger.generations).length)
    expect(sidecarsBeforeRetirement.filter((name) => remaining.includes(name))).toHaveLength(1)
    sidecarsBeforeRelease = remaining
  })

  it('releases the real root through the production API', async () => {
    await host.track(releaseEditorViewRoot(victim.options))
    expect(pathExists(victim.editorRoot)).toBe(false)
    const remaining = sidecars()
    expect(remaining).toHaveLength(sidecarsBeforeRelease.length - 1)
    expect(sidecarsBeforeRetirement.some((name) => remaining.includes(name))).toBe(false)
  })

  it('drops released-root cached generations and their footprint files at the next census', async () => {
    const lockPath = join(pressure.editorRoot, '.publish.lock')
    mkdirSync(lockPath)
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({
        schema: 'effect-utils/editor-view-lock/v1',
        token: 'sidecar-maintenance-owner',
        pid: process.pid,
      }),
    )
    try {
      // The production reservation census performs maintenance without creating
      // another generation that would mask a leaked sidecar behind a new file.
      const reservation = await host.track(
        reserveEditorViewBudget({
          contentStore: host.contentStore,
          root: { repoRoot: pressure.root, editorRoot: pressure.editorRoot },
          heldEditorRoot: pressure.editorRoot,
          discoverRoots: () => [],
          reservationBytes: 1,
          budgetBytes: setupBudgetBytes,
          tryLockRoot: () => {
            throw new Error('ample-budget maintenance unexpectedly attempted eviction')
          },
        }),
      )
      await host.track(
        cancelEditorViewBudgetReservation({
          contentStore: host.contentStore,
          token: reservation.token,
        }),
      )
    } finally {
      rmSync(lockPath, { recursive: true, force: true })
    }
    const ledger = readBudgetLedger(host)
    expect(
      Object.keys(ledger.generations).some((key) => key.startsWith(`${victim.editorRoot}\0`)),
    ).toBe(false)
    const remaining = sidecars()
    expect(remaining.length).toBe(Object.keys(ledger.generations).length)
    expect(sidecarsBeforeRetirement.some((name) => remaining.includes(name))).toBe(false)
    expect(sidecarsBeforeRelease.filter((name) => remaining.includes(name))).toHaveLength(1)
    expect(remaining).toHaveLength(sidecarsBeforeRelease.length - 1)
  })
})

describe('host-budget reader observations keep a fixed candidate set', () => {
  let host: Host
  let old: Fixture
  let held: Fixture
  let incoming: Fixture
  let oldRecord: EditorViewRecord | undefined
  let heldRecord: EditorViewRecord | undefined
  let reader: Reader | undefined
  let readerReady = false

  beforeAll(() => {
    host = makeHost()
    old = host.fixture('observed-old', 131)
    held = host.fixture('boundary-held', 132)
    incoming = host.fixture('boundary-incoming', 133, 64)
  })
  afterAll(async () => {
    if (host !== undefined) await host.cleanup()
  })

  it('publishes and ages the initially eligible victim', async () => {
    oldRecord = await host.publish(old)
    host.advance(hostRecencyMs + hostGraceMs + 1)
    host.age(old, oldRecord)
  })

  it('publishes the generation whose recency boundary will expire during observation', async () => {
    if (oldRecord === undefined) throw new Error('initial victim publication did not complete')
    heldRecord = await host.publish(held)
  })

  it('holds a real reader just inside the recency boundary', async () => {
    if (heldRecord === undefined)
      throw new Error('boundary generation publication did not complete')
    reader = openReader(host, held, heldRecord)
    await reader.ready
    host.advance(hostRecencyMs - 1)
    host.age(held, heldRecord)
    readerReady = true
  })

  it('never retires a generation whose recency boundary expires during the real process scan', async () => {
    if (
      oldRecord === undefined ||
      heldRecord === undefined ||
      reader === undefined ||
      readerReady === false
    )
      throw new Error('fixed-candidate regression setup did not complete')
    let crossed = false
    const scan = fsMocks.readlinkSync.mockImplementation((...args) => {
      if (crossed === false && /^\/proc\/[0-9]+\/cwd$/.test(String(args[0])) === true) {
        crossed = true
        host.advance(2)
      }
      return nativeFs.readlinkSync(...args)
    })
    const nativeScan = childProcessMocks.spawnSync.mockImplementation((...args) => {
      if (crossed === false && String(args[0]) === '/usr/sbin/lsof') {
        crossed = true
        host.advance(2)
      }
      return nativeChildProcess.spawnSync(...args)
    })
    try {
      expectCurrent(incoming, await host.publish(incoming, { hostBudgetBytes: 1 }))
    } finally {
      scan.mockReset().mockImplementation(nativeFs.readlinkSync)
      nativeScan.mockReset().mockImplementation(nativeChildProcess.spawnSync)
    }
    expect(crossed).toBe(true)
    expect(pathExists(join(old.editorRoot, oldRecord.snapshot))).toBe(false)
    expectCurrent(held, heldRecord)
    expectRunningReader(reader)
  })
})

describe('host-budget eviction tolerates teardown of a held victim root', () => {
  let host: Host
  let victim: Fixture
  let incoming: Fixture
  let victimRecord: EditorViewRecord | undefined

  beforeAll(() => {
    host = makeHost()
    victim = host.fixture('removed-held-victim', 141)
    incoming = host.fixture('removed-held-incoming', 142, 64)
  })
  afterAll(async () => {
    if (host !== undefined) await host.cleanup()
  })

  it('publishes and ages the victim before the held-lock teardown race', async () => {
    victimRecord = await host.publish(victim)
    host.advance(hostRecencyMs + hostGraceMs + 1)
    host.age(victim, victimRecord)
  })

  it('reserves and settles incoming bytes when a held victim root disappears', async () => {
    if (victimRecord === undefined) throw new Error('teardown victim publication did not complete')
    let removed = false
    let admissionEpoch: number | undefined
    const captured = await captureStderr(() =>
      host.publish(incoming, {
        hostBudgetBytes: 1,
        beforeBudgetEviction: () => {
          expect(pathExists(join(victim.editorRoot, '.publish.lock'))).toBe(true)
          removeOwnedTree(victim.editorRoot)
          removed = true
        },
        beforeMaterialize: () => {
          expect(removed).toBe(true)
          const admitted = readBudgetLedger(host)
          expect(admitted.reservations).toHaveLength(1)
          const reservation = admitted.reservations[0]
          expect(reservation).toMatchObject({
            editorRoot: incoming.editorRoot,
            contentStore: host.contentStore,
            pid: process.pid,
            budgetBytes: 1,
          })
          expect(reservation?.token.length).toBeGreaterThan(0)
          expect(reservation?.bytes).toBeGreaterThan(0)
          admissionEpoch = admitted.epoch
        },
      }),
    )
    expect(removed).toBe(true)
    expect(pathExists(victim.editorRoot)).toBe(false)
    expectCurrent(incoming, captured.value)
    expect(pathExists(join(incoming.editorRoot, '.publish.lock'))).toBe(false)
    expect(captured.stderr).not.toContain('editor-view.host-budget.maintenance-error')
    expect(
      budgetEvents(captured.stderr).filter(
        ({ event }) => event === 'editor-view.host-budget.over-budget',
      ),
    ).toHaveLength(1)
    const heldEpoch = admissionEpoch
    if (heldEpoch === undefined) throw new Error('incoming reservation barrier was not reached')
    const finished = readBudgetLedger(host)
    expect(finished.reservations).toEqual([])
    const settled = finished.journal.filter(({ epoch }) => epoch > heldEpoch)
    expect(settled).toHaveLength(1)
    expect(settled[0]?.estimatedBytes).toBeGreaterThan(0)
  })
})

describe('budget telemetry never waits for exporter delivery', () => {
  it('finishes real publication with hung exporters, then kills and reaps them', async () => {
    const host = makeHost()
    try {
      const incoming = host.fixture('hung-exporter-publication', 151, 64)
      const captured = await recordTelemetry(
        host.root,
        async (children) => {
          const publication = await overBudgetPublication(host, incoming, 1)
          const deliveryTurn = Promise.withResolvers<void>()
          setImmediate(deliveryTurn.resolve)
          await deliveryTurn.promise
          const budgetChildren = children.filter((child) =>
            child.spawnargs.includes('editor-view.host-budget'),
          )
          expect(budgetChildren).toHaveLength(2)
          for (const child of budgetChildren) {
            expect(child.exitCode).toBeNull()
            expect(child.signalCode).toBeNull()
            const status = spawnSync(ps, ['-p', String(child.pid), '-o', 'pid='], {
              encoding: 'utf8',
            })
            expect(status.status).toBe(0)
            expect(status.stdout.trim()).toBe(String(child.pid))
          }
          expectCurrent(incoming, publication.record)
          return publication
        },
        { hangBudget: true },
      )
      const budgetExits = captured.exits.filter(
        (_, index) => captured.invocations[index]?.includes('editor-view.host-budget') === true,
      )
      expect(budgetExits).toEqual([
        { code: null, signal: 'SIGKILL' },
        { code: null, signal: 'SIGKILL' },
      ])
      // The one-second deadline may kill Bun before startup: assert the real spawn request.
      expect(captured.invocations).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            'editor-view.host-budget',
            'editor_view.host_budget.event=editor-view.host-budget.over-budget',
            'exit.code=0',
            'ok',
          ]),
        ]),
      )
      expect(captured.invocations).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            'editor-view.phases',
            'snapshot.created=true',
            'exit.code=0',
            'ok',
          ]),
        ]),
      )
    } finally {
      await host.cleanup()
    }
  })

  it('drops delivery on saturation and admits new delivery after children are reaped', async () => {
    const host = makeHost()
    try {
      const options = {
        name: 'editor-view.host-budget',
        label: 'bounded',
        attributes: [],
        startedAtMs: Date.now(),
        endedAtMs: Date.now(),
      }
      const captured = await recordTelemetry(host.root, async () =>
        Array.from({ length: 8 }, () => emitCompletedSpanAsync(options)),
      )
      expect(captured.value).toEqual([true, true, true, true, false, false, false, false])
      expect(captured.exits).toHaveLength(4)
      expect(captured.invocations).toHaveLength(4)
      const next = await recordTelemetry(host.root, async () => emitCompletedSpanAsync(options))
      expect(next.value).toBe(true)
      expect(next.exits).toHaveLength(1)
    } finally {
      await host.cleanup()
    }
  })
})

describe('budget telemetry rate limits across publisher processes per host store', () => {
  let host: Host
  let first: Fixture
  let second: Fixture
  let later: Fixture
  let other: Fixture
  let firstComplete = false
  let secondComplete = false
  let otherComplete = false
  let laterComplete = false
  const invocations: (readonly string[])[] = []

  beforeAll(() => {
    host = makeHost()
    first = host.fixture('rate-first', 161, 64)
    second = host.fixture('rate-second-process', 162, 64)
    later = host.fixture('rate-after-window', 163, 64)
    other = host.fixture('rate-other-store', 164, 64, join(host.root, 'other-store', 'v1'))
  })
  afterAll(async () => {
    if (host !== undefined) await host.cleanup()
  })

  it('publishes the first store overrun and claims its durable delivery permit', async () => {
    const captured = await recordTelemetry(host.root, async () =>
      overBudgetPublication(host, first, 1),
    )
    invocations.push(...captured.invocations)
    firstComplete = true
  })

  it('suppresses the same-store event from a separate real publisher process', async () => {
    if (firstComplete === false) throw new Error('first rate-limit publication did not complete')
    const captured = await recordTelemetry(host.root, async () => {
      const script = [
        `import { publishEditorView } from ${JSON.stringify(new URL('./editor-view.ts', import.meta.url).href)}`,
        `Date.now = () => ${Date.now()}`,
        `await publishEditorView({ ...${JSON.stringify(second.options)}, hostBudgetBytes: 1 })`,
      ].join('\n')
      const child = spawnSync(bun, ['--eval', script], { encoding: 'utf8' })
      expect(child.status).toBe(0)
      const event = budgetEvents(child.stderr).find(
        ({ event }) => event === 'editor-view.host-budget.over-budget',
      )
      expect(event).toBeDefined()
      expect(child.stderr).toContain('"otelSuppressedEvents":1')
    })
    invocations.push(...captured.invocations)
    secondComplete = true
  })

  it('admits delivery from a different content store within the same host interval', async () => {
    if (secondComplete === false) throw new Error('cross-process suppression did not complete')
    const captured = await recordTelemetry(host.root, async () =>
      overBudgetPublication(host, other, 1),
    )
    invocations.push(...captured.invocations)
    otherComplete = true
  })

  it('admits the original store after the window with its durable suppression count', async () => {
    if (otherComplete === false) throw new Error('other-store publication did not complete')
    host.advance(60_001)
    const captured = await recordTelemetry(host.root, async () =>
      overBudgetPublication(host, later, 1),
    )
    invocations.push(...captured.invocations)
    laterComplete = true
  })

  it('preserves all per-store rate and suppressed-event assertions on real delivery requests', () => {
    if (laterComplete === false) throw new Error('post-window publication did not complete')
    const overruns = invocations.filter((span) =>
      span.includes('editor_view.host_budget.event=editor-view.host-budget.over-budget'),
    )
    expect(overruns).toHaveLength(3)
    const sameStore = overruns.filter((span) =>
      span.includes(`editor_view.host_budget.content_store=${host.contentStore}`),
    )
    expect(sameStore).toHaveLength(2)
    expect(sameStore).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['editor_view.host_budget.suppressed_events=1']),
      ]),
    )
    expect(overruns).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          `editor_view.host_budget.content_store=${other.options.contentStore}`,
          'editor_view.host_budget.suppressed_events=0',
        ]),
      ]),
    )
  })
})

describe('budget admission defers reader proof until eviction needs it', () => {
  const readerScans = (): number =>
    fsMocks.readlinkSync.mock.calls.filter(([path]) =>
      /^\/proc\/[0-9]+\/(?:cwd|fd\/)/.test(String(path)),
    ).length +
    childProcessMocks.spawnSync.mock.calls.filter(([command]) => command === '/usr/sbin/lsof')
      .length

  const lockRoot = (root: { readonly editorRoot: string }) => {
    const path = join(root.editorRoot, '.publish.lock')
    mkdirSync(path)
    writeFileSync(
      join(path, 'owner.json'),
      JSON.stringify({
        schema: 'effect-utils/editor-view-lock/v1',
        token: 'admission-test-owner',
        pid: process.pid,
      }),
    )
    return { release: () => rmSync(path, { recursive: true }) }
  }

  it('admits a footprint above the warning ratio without scanning eligible readers', async () => {
    const host = makeHost()
    try {
      const victim = host.fixture('fit-victim', 181)
      const incoming = host.fixture('fit-incoming', 182, 64)
      const victimRecord = await host.publish(victim)
      await host.publish(incoming)
      const incomingLock = lockRoot(incoming)
      host.advance(hostRecencyMs + hostGraceMs + 1)
      host.age(victim, victimRecord)
      const options = {
        contentStore: host.contentStore,
        root: { repoRoot: incoming.root, editorRoot: incoming.editorRoot },
        heldEditorRoot: incoming.editorRoot,
        discoverRoots: () => [{ repoRoot: victim.root, editorRoot: victim.editorRoot }],
        reservationBytes: 1,
        tryLockRoot: () => {
          throw new Error('fitting admission attempted eviction')
        },
      }
      const probe = await host.track(
        reserveEditorViewBudget({ ...options, budgetBytes: setupBudgetBytes }),
      )
      await cancelEditorViewBudgetReservation({
        contentStore: host.contentStore,
        token: probe.token,
      })
      const usedBytes = readBudgetLedger(host).usedBytes
      const budgetBytes = Math.ceil((usedBytes + options.reservationBytes) / 0.9)
      expect(usedBytes + options.reservationBytes).toBeGreaterThan(budgetBytes * 0.8)
      expect(usedBytes + options.reservationBytes).toBeLessThan(budgetBytes)
      const scansBefore = readerScans()
      const reservation = await host.track(reserveEditorViewBudget({ ...options, budgetBytes }))
      expect(readerScans()).toBe(scansBefore)
      expectCurrent(victim, victimRecord)
      await cancelEditorViewBudgetReservation({
        contentStore: host.contentStore,
        token: reservation.token,
      })
      incomingLock.release()
    } finally {
      await host.cleanup()
    }
  })

  it('scans before eviction and re-proves a reader opened after the victim lock', async () => {
    const host = makeHost()
    try {
      const victim = host.fixture('proof-victim', 183)
      const incoming = host.fixture('proof-incoming', 184, 64)
      const victimRecord = await host.publish(victim)
      await host.publish(incoming)
      const incomingLock = lockRoot(incoming)
      host.advance(hostRecencyMs + hostGraceMs + 1)
      host.age(victim, victimRecord)
      const scansBefore = readerScans()
      let reader: Reader | undefined
      let scansAtLock = 0
      const reservation = await host.track(
        reserveEditorViewBudget({
          contentStore: host.contentStore,
          root: { repoRoot: incoming.root, editorRoot: incoming.editorRoot },
          heldEditorRoot: incoming.editorRoot,
          discoverRoots: () => [{ repoRoot: victim.root, editorRoot: victim.editorRoot }],
          reservationBytes: 1,
          budgetBytes: 1,
          tryLockRoot: (root) => {
            expect(root.editorRoot).toBe(victim.editorRoot)
            expect(readerScans()).toBeGreaterThan(scansBefore)
            return lockRoot(root)
          },
          beforeRetireRoot: async () => {
            scansAtLock = readerScans()
            if (reader === undefined) {
              reader = openReader(host, victim, victimRecord, { fromContentStore: true })
              await reader.ready
            }
          },
        }),
      )
      expect(reader).toBeDefined()
      expect(readerScans()).toBeGreaterThan(scansAtLock)
      expectCurrent(victim, victimRecord)
      expect(pathExists(join(victim.editorRoot, '.evicted-budget-view.json'))).toBe(false)
      if (reader === undefined) throw new Error('eviction never reached its reader barrier')
      expectRunningReader(reader)
      await cancelEditorViewBudgetReservation({
        contentStore: host.contentStore,
        token: reservation.token,
      })
      incomingLock.release()
    } finally {
      await host.cleanup()
    }
  })

  it('shares one near-full census between workers but refreshes after a generation mutation before eviction', async () => {
    const host = makeHost()
    try {
      const victim = host.fixture('session-victim', 185)
      const incoming = host.fixture('session-incoming', 186, 64)
      const oldRecord = await host.publish(victim)
      await host.publish(incoming)
      const incomingLock = lockRoot(incoming)
      host.advance(hostRecencyMs + hostGraceMs + 1)
      host.age(victim, oldRecord)
      const options = {
        contentStore: host.contentStore,
        root: { repoRoot: incoming.root, editorRoot: incoming.editorRoot },
        heldEditorRoot: incoming.editorRoot,
        discoverRoots: () => [{ repoRoot: victim.root, editorRoot: victim.editorRoot }],
        reservationBytes: 1,
        tryLockRoot: lockRoot,
      }
      const probe = await host.track(
        reserveEditorViewBudget({ ...options, budgetBytes: setupBudgetBytes }),
      )
      await cancelEditorViewBudgetReservation({
        contentStore: host.contentStore,
        token: probe.token,
      })
      const baseline = readBudgetLedger(host)
      const budgetBytes = Math.ceil((baseline.usedBytes + 2) / 0.9)
      const censusSession = makeEditorViewBudgetCensusSession()
      const entered = Promise.withResolvers<void>()
      const release = host.gate()
      let censuses = 0
      const onCensus = async () => {
        censuses++
        entered.resolve()
        await release.promise
      }
      const scansBefore = readerScans()
      const workers = [0, 1].map(() =>
        host.track(
          reserveEditorViewBudget({ ...options, budgetBytes, censusSession, onCensus }),
        ),
      )
      await Promise.race([
        entered.promise,
        Promise.race(workers).then(() => {
          throw new Error('worker skipped the census barrier')
        }),
      ])
      release.resolve()
      const reservations = await Promise.all(workers)
      expect(censuses).toBe(1)
      expect(readerScans()).toBe(scansBefore)
      const held = readBudgetLedger(host)
      expect(held.reservations).toHaveLength(2)
      expect(new Set(reservations.map(({ token }) => token)).size).toBe(2)
      expect(held.usedBytes + 2).toBeGreaterThan(budgetBytes * 0.8)
      expect(held.usedBytes + 2).toBeLessThanOrEqual(budgetBytes)
      for (const { token } of reservations)
        await cancelEditorViewBudgetReservation({ contentStore: host.contentStore, token })

      // The batch session still contains the old generation set. A real publication
      // changes both that set and the host journal before pressure reuses the session.
      writeFileSync(victim.payload, Buffer.alloc(payloadBytes, 187))
      const currentRecord = await host.publish(victim)
      expect(currentRecord.snapshot).not.toBe(oldRecord.snapshot)
      const reader = openReader(host, victim, currentRecord, { fromContentStore: true })
      await reader.ready
      host.advance(hostRecencyMs + hostGraceMs + 1)
      host.age(victim, oldRecord)
      host.age(victim, currentRecord)
      let attemptedEviction = false
      const pressure = await host.track(
        reserveEditorViewBudget({
          ...options,
          budgetBytes: 1,
          censusSession,
          onCensus: () => {
            censuses++
          },
          tryLockRoot: (root) => {
            attemptedEviction = true
            expect(censuses).toBeGreaterThan(1)
            return lockRoot(root)
          },
        }),
      )
      expect(attemptedEviction).toBe(true)
      expect(pathExists(join(victim.editorRoot, oldRecord.snapshot))).toBe(false)
      expectCurrent(victim, currentRecord)
      expectRunningReader(reader)
      await cancelEditorViewBudgetReservation({
        contentStore: host.contentStore,
        token: pressure.token,
      })
      incomingLock.release()
    } finally {
      await host.cleanup()
    }
  })
})
