import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { shareSnapshotFiles } from './editor-view-sharing.ts'
import {
  pinEditorView,
  publishEditorView,
  type EditorViewOptions,
  type EditorViewRecord,
} from './editor-view.ts'

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
  readonly readers: Reader[]
  readonly fixture: (name: string, byte: number, size?: number) => Fixture
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
  const fixture = (name: string, byte: number, size = payloadBytes): Fixture => {
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
        contentStore,
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

const overBudgetPublication = async (host: Host, fixture: Fixture, budgetBytes: number) => {
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
  readonly budgetBytes: number
}

type BudgetLedger = {
  readonly epoch: number
  readonly journal: readonly { readonly epoch: number; readonly estimatedBytes: number }[]
  readonly reservations: readonly BudgetReservation[]
  readonly usedBytes: number
  readonly protectedBytes: number
}

/** Inspect real persistent admission records without changing them or bypassing their flock. */
const readBudgetLedger = (host: Host): BudgetLedger => {
  const value: unknown = JSON.parse(
    readFileSync(`${host.contentStore}.budget/state-v2.json`, 'utf8'),
  )
  if (
    typeof value !== 'object' ||
    value === null ||
    'schema' in value === false ||
    value.schema !== 'effect-utils/editor-view-budget/v2' ||
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
    typeof value.usage.protectedBytes !== 'number'
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
        typeof entry.budgetBytes !== 'number'
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
    openedPath = join(host.contentStore, digest.slice(0, 2), `${digest}-0444`)
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

/** Record actual otel-span subprocess arguments; no span emitter or process runtime is mocked. */
const recordTelemetry = async <TValue>(root: string, run: () => Promise<TValue>) => {
  const bin = join(root, 'record-otel-span')
  const capture = join(root, 'otel-spans.jsonl')
  writeFileSync(
    bin,
    `#!${bun}\nimport { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`,
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
  try {
    const value = await run()
    const spans: readonly unknown[] =
      pathExists(capture) === true
        ? readFileSync(capture, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : []
    return { value, spans }
  } finally {
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
    newer = host.fixture('newer-current', 22)
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

  it('publishes despite protected overflow and emits actionable JSON plus a successful OTEL span', async () => {
    const captured = await recordTelemetry(host.root, () =>
      overBudgetPublication(host, incoming, 1),
    )
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

  beforeAll(async () => {
    host = makeHost()
    pinned = host.fixture('pinned-existing', 91)
    live = host.fixture('opened-existing', 92)
    contenders = [host.fixture('concurrent-view-a', 93), host.fixture('concurrent-view-b', 94)]
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

  it('accounts for both over-budget reservations without CAS-to-publication-root deadlock', async () => {
    const budgetBytes = 1
    const baseline = readBudgetLedger(host)
    expect(baseline.reservations).toEqual([])
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
    let publications: readonly Promise<EditorViewRecord>[] = []
    try {
      const captured = await captureStderr(async () => {
        publications = contenders.map((fixture) =>
          host.publish(fixture, {
            hostBudgetBytes: budgetBytes,
            beforeMaterialize: async () => {
              admitted++
              if (admitted === contenders.length) allAdmitted.resolve()
              await materializeRelease.promise
            },
          }),
        )
        // Each publisher owns a root while the real pin holds CAS. After pin admission
        // both must reserve and reach their copy barriers without waiting on sibling roots.
        pinRelease.resolve()
        await pin
        await Promise.race([
          allAdmitted.promise,
          Promise.race(publications).then(() => {
            throw new Error('publication completed before both reservation barriers were reached')
          }),
        ])
        expect(admitted).toBe(2)
        const held = readBudgetLedger(host)
        expect(held.epoch).toBe(baseline.epoch + 2)
        expect(held.reservations).toHaveLength(2)
        expect(new Set(held.reservations.map(({ token }) => token)).size).toBe(2)
        expect(new Set(held.reservations.map(({ process }) => process)).size).toBe(1)
        expect(held.reservations.map(({ editorRoot }) => editorRoot).toSorted()).toEqual(
          contenders.map(({ editorRoot }) => editorRoot).toSorted(),
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
          JSON.parse(
            readFileSync(join(pinned.editorRoot, '.pins', 'concurrent-reader.json'), 'utf8'),
          ),
        ).toMatchObject({ snapshot: pinnedRecord.snapshot })
        return held
      })
      const events = budgetEvents(captured.stderr)
      const overBudget = events.filter(
        ({ event }) => event === 'editor-view.host-budget.over-budget',
      )
      expect(overBudget).toHaveLength(2)
      for (const event of overBudget) {
        expect(event.budgetBytes).toBe(budgetBytes)
        expect(
          event.usedBytes +
            event.reservedBytes +
            event.pendingEstimateBytes +
            event.reservationBytes,
        ).toBeGreaterThan(budgetBytes)
        expect(event.reservedBytes).toBeGreaterThanOrEqual(0)
        expect(event.pendingEstimateBytes).toBe(0)
        expect(event.protectedBytes).toBeGreaterThanOrEqual(payloadBytes * 2)
      }
      const smallestReservation = Math.min(...captured.value.reservations.map(({ bytes }) => bytes))
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
      ).toBeGreaterThanOrEqual(captured.value.usedBytes + smallestReservation)
      expect(events.some(({ event }) => event === 'editor-view.host-budget.refused')).toBe(false)
    } finally {
      pinRelease.resolve()
      materializeRelease.resolve()
    }
    const records = await Promise.all(publications)
    const finished = readBudgetLedger(host)
    expect(finished.reservations).toEqual([])
    expect(finished.usedBytes).toBeGreaterThanOrEqual(baseline.usedBytes)
    const newEstimates = finished.journal.filter(({ epoch }) => epoch > baseline.epoch)
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
    await reader.stop()
  })
})
