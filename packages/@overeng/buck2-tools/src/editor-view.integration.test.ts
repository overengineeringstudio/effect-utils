import { spawnSync } from 'node:child_process'
import * as ChildProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  cancelEditorViewBudgetReservation,
  reserveEditorViewBudget as reserveEditorViewBudgetUnscoped,
  type EditorViewBudgetRootLock,
} from './editor-view-budget.ts'
import { managedEditorViewSnapshots, type EditorViewPinRecord } from './editor-view-readers.ts'
import {
  editorViewStagingCreatorIdentity,
  readEditorViewSourceManifest,
} from './editor-view-sharing.ts'
import { editorViewTestDataRoot } from './editor-view-test-filesystem.ts'
import {
  scopeEditorViewTestProcesses,
  trackEditorViewTestSpawn,
} from './editor-view-test-processes.ts'
import {
  canonicalTreeFingerprint,
  canonicalTreeFingerprintWithResolvedLinks,
  checkEditorView,
  editorViewPublicationWorkers,
  pinEditorView,
  publishEditorView as publishEditorViewUnscoped,
  publishEditorViews as publishEditorViewsUnscoped,
  recoverEditorViewLock,
  releaseEditorViewRoot as releaseEditorViewRootUnscoped,
  unpinEditorView,
  verifyEditorViewSnapshot,
  tryAcquireEditorViewBudgetRootLock,
  type EditorViewOptions,
  type EditorViewRecord,
} from './editor-view.ts'
import { emitCompletedSpanAsync } from './otel-span-cli.ts'
import { realpathThroughName } from './real-path.ts'
import * as fingerprintRunner from './typescript-runner.ts'

// Namespace-property spies do not replace Bun's native named-import bindings.
// Capture native functions, then register stable mocked exports for fault injection.
const nativeFs = { ...process.getBuiltinModule('fs') }
// Scope every retirement entrypoint to real fixture PIDs on Linux and macOS.
// Host-wide fail-closed policy has one explicit native-lease integration case.
const fixtureProcessIds = new Set([process.pid])
const publishEditorView = scopeEditorViewTestProcesses({
  processIds: fixtureProcessIds,
  operation: publishEditorViewUnscoped,
})
const publishEditorViews = scopeEditorViewTestProcesses({
  processIds: fixtureProcessIds,
  operation: publishEditorViewsUnscoped,
})
const reserveEditorViewBudget = scopeEditorViewTestProcesses({
  processIds: fixtureProcessIds,
  operation: reserveEditorViewBudgetUnscoped,
})
const releaseEditorViewRoot = scopeEditorViewTestProcesses({
  processIds: fixtureProcessIds,
  operation: releaseEditorViewRootUnscoped,
})
const fsMocks = {
  openSync: vi.fn(nativeFs.openSync),
  fchmodSync: vi.fn(nativeFs.fchmodSync),
  readSync: vi.fn(nativeFs.readSync),
  readFileSync: vi.fn(nativeFs.readFileSync),
  readdirSync: vi.fn(nativeFs.readdirSync),
  lstatSync: vi.fn(nativeFs.lstatSync),
  mkdirSync: vi.fn(nativeFs.mkdirSync),
  realpathSync: vi.fn(nativeFs.realpathSync),
}
vi.mock('node:fs', () => ({ ...nativeFs, ...fsMocks }))
const nativeChildProcess = {
  ...ChildProcess,
  spawn: trackEditorViewTestSpawn({
    processIds: fixtureProcessIds,
    spawnProcess: ChildProcess.spawn,
  }),
}
const childProcessMocks = { spawn: vi.fn(nativeChildProcess.spawn) }
vi.mock('node:child_process', () => ({ ...nativeChildProcess, ...childProcessMocks }))

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const cp = requireTool('CP_BIN')
const mv = requireTool('MV_BIN')
const falseTool = requireTool('FALSE_BIN')
const fingerprintTool = requireTool('FINGERPRINT_BIN')

let integrationBudgetState: string
const savedIntegrationBudgetState = process.env.EDITOR_VIEW_HOST_BUDGET_STATE
const savedIntegrationTraceContext = {
  TRACEPARENT: process.env.TRACEPARENT,
  OTEL_TASK_TRACEPARENT: process.env.OTEL_TASK_TRACEPARENT,
}
beforeAll(() => {
  fsMocks.readdirSync.mockImplementation(nativeFs.readdirSync)
  // Unrelated publications must not consume the shared exporter bound from CI's ambient trace.
  delete process.env.TRACEPARENT
  delete process.env.OTEL_TASK_TRACEPARENT
  integrationBudgetState = realpathSync(
    mkdtempSync(join(editorViewTestDataRoot(), 'editor-view-test-host-budget-')),
  )
  process.env.EDITOR_VIEW_HOST_BUDGET_STATE = integrationBudgetState
})
afterAll(() => {
  fsMocks.readdirSync.mockReset().mockImplementation(nativeFs.readdirSync)
  for (const [key, value] of Object.entries(savedIntegrationTraceContext))
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  if (savedIntegrationBudgetState === undefined) delete process.env.EDITOR_VIEW_HOST_BUDGET_STATE
  else process.env.EDITOR_VIEW_HOST_BUDGET_STATE = savedIntegrationBudgetState
  const unlock = (path: string): void => {
    const status = lstatSync(path)
    if (status.isDirectory() === false || status.isSymbolicLink() === true) return
    chmodSync(path, (status.mode & 0o777) | 0o700)
    for (const name of readdirSync(path)) unlock(join(path, name))
  }
  unlock(integrationBudgetState)
  rmSync(integrationBudgetState, { recursive: true, force: true })
})

/** A scenario keeps its own ledger across publications without inheriting earlier test roots. */
const isolateHostBudget = (): (() => void) => {
  const savedState = process.env.EDITOR_VIEW_HOST_BUDGET_STATE
  const savedRecency = process.env.EDITOR_VIEW_HOST_RECENCY_MS
  process.env.EDITOR_VIEW_HOST_BUDGET_STATE = mkdtempSync(join(integrationBudgetState, 'scenario-'))
  process.env.EDITOR_VIEW_HOST_RECENCY_MS = '86400000'
  return () => {
    if (savedState === undefined) delete process.env.EDITOR_VIEW_HOST_BUDGET_STATE
    else process.env.EDITOR_VIEW_HOST_BUDGET_STATE = savedState
    if (savedRecency === undefined) delete process.env.EDITOR_VIEW_HOST_RECENCY_MS
    else process.env.EDITOR_VIEW_HOST_RECENCY_MS = savedRecency
  }
}
type Fixture = {
  readonly root: string
  readonly packageDir: string
  readonly editorRoot: string
  readonly editorInputs: string
  readonly nodeModules: string
  readonly options: EditorViewOptions
  readonly workspaceAuthority: string
  readonly consumerCache: string
}

const editorCliProcesses = new Set<Bun.Subprocess<'ignore', 'pipe', 'pipe'>>()
afterEach(async () => {
  for (const child of editorCliProcesses) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
    await child.exited
    fixtureProcessIds.delete(child.pid)
    editorCliProcesses.delete(child)
  }
  fsMocks.openSync.mockReset().mockImplementation(nativeFs.openSync)
  fsMocks.fchmodSync.mockReset().mockImplementation(nativeFs.fchmodSync)
  fsMocks.readSync.mockReset().mockImplementation(nativeFs.readSync)
  fsMocks.readFileSync.mockReset().mockImplementation(nativeFs.readFileSync)
  fsMocks.readdirSync.mockReset().mockImplementation(nativeFs.readdirSync)
  fsMocks.lstatSync.mockReset().mockImplementation(nativeFs.lstatSync)
  fsMocks.mkdirSync.mockReset().mockImplementation(nativeFs.mkdirSync)
  fsMocks.realpathSync.mockReset().mockImplementation(nativeFs.realpathSync)
  childProcessMocks.spawn.mockReset().mockImplementation(nativeChildProcess.spawn)
})

const runEditorViewCli = async ({
  fixture,
  command,
  flags,
}: {
  fixture: Fixture
  command: 'pin' | 'unpin'
  flags: readonly string[]
}): Promise<{ status: number; stdout: string; stderr: string }> => {
  const child = Bun.spawn(
    [
      requireTool('BUN_BIN'),
      fileURLToPath(new URL('./editor-view.ts', import.meta.url)),
      command,
      '--repo-root',
      fixture.root,
      '--package',
      fixture.options.package,
      '--content-store',
      fixture.options.contentStore!,
      ...flags,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true },
  )
  editorCliProcesses.add(child)
  fixtureProcessIds.add(child.pid)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      Bun.readableStreamToText(child.stdout),
      Bun.readableStreamToText(child.stderr),
    ])
    return { status, stdout, stderr }
  } finally {
    fixtureProcessIds.delete(child.pid)
    editorCliProcesses.delete(child)
  }
}

/** One package view fixture; `packageName` also names the published editor view. */
const makeFixture = ({ packageName = 'tui-core' }: { packageName?: string } = {}): Fixture => {
  const root = realpathSync(mkdtempSync(join(editorViewTestDataRoot(), 'editor-view-integration-')))
  const packagePath = `packages/@overeng/${packageName}`
  const packageDir = join(root, 'packages', '@overeng', packageName)
  const editorRoot = join(root, 'packages', '.editor-view')
  const editorInputs = join(root, 'inputs', 'editor_inputs')
  const nodeModules = join(root, 'inputs', 'node_modules')
  const workspaceAuthority = join(root, 'workspace-authority.json')
  const consumerCache = join(root, '.devenv', 'vite-cache', packageName)
  mkdirSync(join(packageDir, 'node_modules'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), '{}\n')
  writeFileSync(join(packageDir, 'node_modules', 'legacy-root-install'), 'retained')
  mkdirSync(editorInputs, { recursive: true })
  writeFileSync(join(editorInputs, 'install-descriptor.json'), '{"revision":1}\n')
  mkdirSync(join(nodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep'), { recursive: true })
  writeFileSync(
    join(nodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep', 'index.js'),
    'export default 1\n',
  )
  symlinkSync('.pnpm/dep@1/node_modules/dep', join(nodeModules, 'dep'))
  writeFileSync(
    workspaceAuthority,
    `${JSON.stringify({
      schema: 'effect-utils/workspace-dependency-authority/v1',
      requiredPackages: [packagePath],
      ownedPackages: [packagePath],
    })}\n`,
  )
  const options: EditorViewOptions = {
    repoRoot: root,
    package: packagePath,
    viewName: packageName,
    cell: packageName,
    target: `//${packagePath}:editor_inputs`,
    editorInputs,
    nodeModules,
    cp,
    fingerprintTool,
    workspaceAuthority,
    consumerCache,
    snapshotRetention: 2,
    snapshotGraceMs: 0,
    contentStore: join(root, '.editor-view-content', 'v1'),
    hostBudgetBytes: 40_000_000_000,
    mv,
  }
  return {
    root,
    packageDir,
    editorRoot,
    editorInputs,
    nodeModules,
    workspaceAuthority,
    consumerCache,
    options,
  }
}
const makeWritable = (path: string): void => {
  const status = lstatSync(path)
  if (status.isSymbolicLink() === true) return
  if (status.isDirectory() === true) {
    chmodSync(path, 0o700)
    for (const name of readdirSync(path)) makeWritable(join(path, name))
    return
  }
  // Regular files may share snapshot/CAS inodes; only parent directories need write access.
}

const cleanup = (fixture: Fixture): void => {
  const unlock = (path: string): void => {
    const status = lstatSync(path)
    if (status.isDirectory() === false || status.isSymbolicLink() === true) return
    chmodSync(path, (status.mode & 0o777) | 0o700)
    for (const name of readdirSync(path)) unlock(join(path, name))
  }
  // Never chmod shared payload inodes while retiring one worktree.
  unlock(fixture.root)
  rmSync(fixture.root, { recursive: true, force: true })
}

it('preserves shared payload modes while unlocking and removing readonly fixture directories', async () => {
  const fixture = makeFixture()
  const retainedRoot = mkdtempSync(join(editorViewTestDataRoot(), 'editor-view-cleanup-alias-'))
  try {
    const record = await publishEditorView(fixture.options)
    const snapshot = join(fixture.editorRoot, record.snapshot)
    const payload = join(snapshot, 'node_modules', 'dep', 'index.js')
    const retained = join(retainedRoot, 'payload')
    linkSync(payload, retained)
    const payloadMode = statSync(retained).mode
    expect(payloadMode & 0o222).toBe(0)
    expect(statSync(payload).ino).toBe(statSync(retained).ino)
    const externalDirectory = join(retainedRoot, 'external')
    mkdirSync(externalDirectory)
    chmodSync(externalDirectory, 0o500)
    symlinkSync(externalDirectory, join(fixture.root, 'external-directory'))
    symlinkSync(retained, join(fixture.root, 'external-file'))
    symlinkSync('missing', join(fixture.root, 'dangling'))
    chmodSync(fixture.root, 0o500)

    makeWritable(fixture.root)
    expect(statSync(retained).mode).toBe(payloadMode)
    expect(statSync(externalDirectory).mode & 0o777).toBe(0o500)
    // Exercise cleanup from readonly directories independently of the unlock above.
    chmodSync(snapshot, 0o500)
    chmodSync(fixture.root, 0o500)
    cleanup(fixture)
    expect(existsSync(fixture.root)).toBe(false)
    expect(statSync(retained).mode).toBe(payloadMode)
    expect(statSync(externalDirectory).mode & 0o777).toBe(0o500)
  } finally {
    if (existsSync(fixture.root) === true) cleanup(fixture)
    rmSync(retainedRoot, { recursive: true, force: true })
  }
})

const currentTarget = (fixture: Fixture): string =>
  readlinkSync(join(fixture.editorRoot, fixture.options.viewName))

const recordPath = (fixture: Fixture, target = currentTarget(fixture)): string =>
  join(fixture.editorRoot, target, 'editor-view.json')

/** Store-relative snapshot directory name carried by a record's `snapshot` pointer. */
const storeName = (snapshot: string): string => snapshot.slice('.store/'.length)

const ownedSnapshots = (fixture: Fixture): readonly string[] =>
  readdirSync(join(fixture.editorRoot, '.store')).filter((name) =>
    name.startsWith(`${fixture.options.viewName}-`),
  )

type StoreFile = {
  readonly path: string
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

/** Payload identities and write timestamps, without following relocated snapshot links. */
const storeFiles = (store: string): readonly StoreFile[] =>
  readdirSync(store)
    .toSorted()
    .flatMap((name) => {
      const path = join(store, name)
      const status = lstatSync(path, { bigint: true })
      if (status.isDirectory() === true) return storeFiles(path)
      return [
        {
          path,
          ino: status.ino,
          size: status.size,
          mtimeNs: status.mtimeNs,
          ctimeNs: status.ctimeNs,
        },
      ]
    })

/** A second package view publishing into the fixture's shared `packages/.editor-view` store. */
const makeSiblingView = ({
  fixture,
  packageName,
}: {
  fixture: Fixture
  packageName: string
}): { readonly options: EditorViewOptions; readonly editorInputs: string } => {
  const packagePath = `packages/@overeng/${packageName}`
  const packageDir = join(fixture.root, 'packages', '@overeng', packageName)
  const editorInputs = join(fixture.root, 'inputs', `${packageName}-editor-inputs`)
  const nodeModules = join(fixture.root, 'inputs', `${packageName}-node-modules`)
  const workspaceAuthority = join(fixture.root, `${packageName}-workspace-authority.json`)
  mkdirSync(join(packageDir, 'node_modules'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), '{}\n')
  mkdirSync(editorInputs)
  writeFileSync(join(editorInputs, 'install-descriptor.json'), '{"revision":1}\n')
  mkdirSync(join(nodeModules, 'dep'), { recursive: true })
  writeFileSync(join(nodeModules, 'dep', 'index.js'), `export default "${packageName}"\n`)
  writeFileSync(
    workspaceAuthority,
    `${JSON.stringify({
      schema: 'effect-utils/workspace-dependency-authority/v1',
      requiredPackages: [packagePath],
      ownedPackages: [packagePath],
    })}\n`,
  )
  return {
    editorInputs,
    options: {
      ...fixture.options,
      package: packagePath,
      viewName: packageName,
      cell: packageName,
      target: `//${packagePath}:editor_inputs`,
      editorInputs,
      nodeModules,
      workspaceAuthority,
      consumerCache: join(fixture.root, '.devenv', 'vite-cache', packageName),
    },
  }
}

/** Every entered phase, plus implicit admission, must finish exactly once. */
const expectCompletedPublicationPhases = (stderr: string, terminalPhase: string): void => {
  const phases: { phase: string; event: string; durationMs?: number }[] = stderr
    .split('\n')
    .filter((line) => line.startsWith('[editor-view-phase] '))
    .map((line) => JSON.parse(line.slice('[editor-view-phase] '.length)))
  const entered = [
    'admission',
    ...phases.filter((phase) => phase.event === 'enter').map((phase) => phase.phase),
  ]
  const completed = phases.filter((phase) => phase.event === 'complete')
  expect(completed.map((phase) => phase.phase)).toEqual(entered)
  expect(new Set(completed.map((phase) => phase.phase)).size).toBe(completed.length)
  expect(completed.at(-1)?.phase).toBe(terminalPhase)
  for (const phase of completed) {
    expect(phase.durationMs).toEqual(expect.any(Number))
    expect(Number.isInteger(phase.durationMs)).toBe(true)
    expect(phase.durationMs).toBeGreaterThanOrEqual(0)
  }
}

/** Observe actual exporter requests/close events without making publication await delivery. */
const withPublisherTelemetry = async <TValue>(
  fixture: Fixture,
  run: (children: readonly ChildProcess.ChildProcess[]) => Promise<TValue>,
  { hang = false }: { readonly hang?: boolean } = {},
) => {
  const executableRoot = mkdtempSync(join(tmpdir(), 'editor-view-telemetry-'))
  const bin = join(executableRoot, 'record-otel-span')
  const capture = join(fixture.root, 'otel-spans.txt')
  writeFileSync(
    bin,
    hang === true
      ? `#!${requireTool('BUN_BIN')}\nimport { watch } from 'node:fs'\nwatch(${JSON.stringify(bin)}, () => {})\nawait Promise.withResolvers().promise\n`
      : `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(capture)}\n`,
  )
  chmodSync(bin, 0o755)
  const values = {
    OTEL_SPAN_BIN: bin,
    OTEL_SPAN_SPOOL_DIR: fixture.root,
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
  const settle = async () => {
    const turn = Promise.withResolvers<void>()
    setImmediate(turn.resolve)
    await turn.promise
    return Promise.all(exits)
  }
  try {
    const value = await run(children)
    const settled = await settle()
    return {
      value,
      invocations,
      exits: settled,
      captured: existsSync(capture) === true ? readFileSync(capture, 'utf8') : '',
    }
  } finally {
    await settle()
    spawned.mockReset().mockImplementation(nativeChildProcess.spawn)
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    rmSync(executableRoot, { recursive: true, force: true })
  }
}

describe('editor view publisher', () => {
  it('fingerprints deterministically with byte ordering, path framing, and dereferencing', async () => {
    const fixture = makeFixture()
    try {
      const second = join(fixture.root, 'second')
      const collisionShape = join(fixture.root, 'collision')
      mkdirSync(second)
      writeFileSync(join(second, 'z'), 'last')
      mkdirSync(join(second, 'a'))
      writeFileSync(join(second, 'a', 'bc'), 'value')
      const first = join(fixture.root, 'first')
      mkdirSync(join(first, 'a'), { recursive: true })
      writeFileSync(join(first, 'a', 'bc'), 'value')
      writeFileSync(join(first, 'z'), 'last')
      mkdirSync(join(collisionShape, 'ab'), { recursive: true })
      writeFileSync(join(collisionShape, 'ab', 'c'), 'value')
      writeFileSync(join(collisionShape, 'z'), 'last')

      const fingerprint = await canonicalTreeFingerprint({ tree: first })
      expect(await canonicalTreeFingerprint({ tree: second })).toBe(fingerprint)
      expect(await canonicalTreeFingerprint({ tree: first, fingerprintTool })).toBe(fingerprint)
      expect(await canonicalTreeFingerprint({ tree: collisionShape })).not.toBe(fingerprint)

      // A dereferenced view digest equals the plain digest of the same bytes
      // materialized without links, which is what the byte snapshot contains.
      const linked = join(fixture.root, 'linked')
      mkdirSync(join(linked, 'real'), { recursive: true })
      writeFileSync(join(linked, 'real', 'index.js'), 'export default 1\n')
      symlinkSync('real', join(linked, 'alias'))
      const materialized = join(fixture.root, 'materialized')
      mkdirSync(join(materialized, 'alias'), { recursive: true })
      mkdirSync(join(materialized, 'real'))
      writeFileSync(join(materialized, 'alias', 'index.js'), 'export default 1\n')
      writeFileSync(join(materialized, 'real', 'index.js'), 'export default 1\n')
      expect(await canonicalTreeFingerprint({ tree: linked, dereference: true })).toBe(
        await canonicalTreeFingerprint({ tree: materialized }),
      )
      expect(
        await canonicalTreeFingerprint({ tree: linked, dereference: true, fingerprintTool }),
      ).toBe(await canonicalTreeFingerprint({ tree: materialized }))
      expect(await canonicalTreeFingerprint({ tree: linked })).not.toBe(
        await canonicalTreeFingerprint({ tree: linked, dereference: true }),
      )
    } finally {
      cleanup(fixture)
    }
  })

  it('matches Rust and TypeScript inventories for in-root, cross-root and owner-root links', async () => {
    const fixture = makeFixture()
    try {
      const tree = join(fixture.root, 'parity-tree')
      const backing = join(fixture.root, 'parity-backing')
      mkdirSync(join(tree, 'dir'), { recursive: true })
      mkdirSync(backing)
      writeFileSync(join(tree, 'dir', 'first.txt'), 'first\n')
      writeFileSync(join(backing, 'external.txt'), 'external\n')
      symlinkSync('dir/first.txt', join(tree, 'in-root'))
      symlinkSync('../parity-backing', join(tree, 'owner-root'))
      symlinkSync('../parity-backing/external.txt', join(tree, 'cross-root'))
      const linkOwners = [
        { source: tree, identity: 'source' },
        { source: backing, identity: 'backing' },
      ]
      expect(
        await canonicalTreeFingerprintWithResolvedLinks({ tree, linkOwners, fingerprintTool }),
      ).toEqual(await canonicalTreeFingerprintWithResolvedLinks({ tree, linkOwners }))
      expect(
        await canonicalTreeFingerprint({
          tree,
          dereference: true,
          backingRoots: [backing],
          fingerprintTool,
        }),
      ).toBe(await canonicalTreeFingerprint({ tree, dereference: true, backingRoots: [backing] }))
    } finally {
      cleanup(fixture)
    }
  })

  it('rejects a link whose parent traversal escapes through an intermediate symlink', async () => {
    const fixture = makeFixture()
    try {
      const owned = join(fixture.root, 'owned')
      const tree = join(owned, 'tree')
      const backing = join(owned, 'backing')
      mkdirSync(tree, { recursive: true })
      mkdirSync(backing)
      writeFileSync(join(tree, 'secret'), 'decoy\n')
      writeFileSync(join(owned, 'secret'), 'secret\n')
      symlinkSync(backing, join(tree, 'dir'))
      // The kernel resolves `dir` before `..`, landing on `owned/secret`; a
      // lexical collapse would name the in-tree decoy instead.
      symlinkSync('dir/../secret', join(tree, 'leaf'))
      expect(readFileSync(join(tree, 'leaf'), 'utf8')).toBe('secret\n')

      await expect(
        canonicalTreeFingerprint({ tree, dereference: true, backingRoots: [backing] }),
      ).rejects.toThrow(
        `tree symbolic link resolves outside declared backing roots: ${join(tree, 'leaf')} -> ${join(owned, 'secret')}`,
      )
    } finally {
      cleanup(fixture)
    }
  })

  it.each(['payload.js/.', 'payload.js/'])(
    'rejects a link whose target %s requires a regular file to be a directory',
    async (target) => {
      const fixture = makeFixture()
      try {
        const tree = join(fixture.root, 'notdir-tree')
        mkdirSync(tree)
        writeFileSync(join(tree, 'payload.js'), 'payload\n')
        symlinkSync(target, join(tree, 'leaf'))

        await expect(canonicalTreeFingerprint({ tree, dereference: true })).rejects.toThrow(
          `tree contains an unresolvable symbolic link: ${join(tree, 'leaf')}`,
        )
      } finally {
        cleanup(fixture)
      }
    },
  )

  it('publishes a dereferenced byte-owned snapshot with distinct inodes and stable hops', async () => {
    const fixture = makeFixture()
    try {
      const packageManifest = join(fixture.packageDir, 'package.json')
      const manifestContent = readFileSync(packageManifest)
      const manifestIdentity = statSync(packageManifest, { bigint: true }).ino
      const record = await publishEditorView(fixture.options)
      expect(readFileSync(packageManifest)).toEqual(manifestContent)
      expect(statSync(packageManifest, { bigint: true }).ino).not.toBe(manifestIdentity)
      expect(statSync(fixture.consumerCache).mode & 0o200).not.toBe(0)
      expect(readlinkSync(join(fixture.packageDir, 'node_modules'))).toBe(
        '../../.editor-view/tui-core/node_modules',
      )
      // The pointer names the snapshot by its combined store identity, not by the
      // editor-inputs fingerprint alone.
      expect(readlinkSync(join(fixture.editorRoot, 'tui-core'))).toBe(record.snapshot)
      expect(record.snapshot).toMatch(/^\.store\/tui-core-[0-9a-f]{64}$/u)
      expect(record.byteSnapshotDigest).toBe(record.normalizedStoreDigest)
      expect(record.selectedViewDigest).not.toBe(record.normalizedStoreDigest)
      const snapshotRoot = join(fixture.editorRoot, record.snapshot)
      const admittedFile = join(
        fixture.nodeModules,
        '.pnpm',
        'dep@1',
        'node_modules',
        'dep',
        'index.js',
      )
      const snapshotFile = join(
        snapshotRoot,
        'node_modules',
        '.pnpm',
        'dep@1',
        'node_modules',
        'dep',
        'index.js',
      )
      const admittedStatus = statSync(admittedFile, { bigint: true })
      const snapshotStatus = lstatSync(snapshotFile, { bigint: true })
      expect(snapshotStatus.isFile()).toBe(true)
      expect([snapshotStatus.dev, snapshotStatus.ino]).not.toEqual([
        admittedStatus.dev,
        admittedStatus.ino,
      ])
      expect(snapshotStatus.nlink).toBeGreaterThanOrEqual(2n)
      expect(snapshotStatus.mode & 0o777n).toBe(0o444n)
      const contentHash = createHash('sha256').update(readFileSync(snapshotFile)).digest('hex')
      const contentBlob = join(
        fixture.options.contentStore!,
        contentHash.slice(0, 2),
        `${contentHash}-0444`,
      )
      expect(lstatSync(contentBlob, { bigint: true }).ino).toBe(snapshotStatus.ino)
      // The admitted view's symlink is dereferenced into owned bytes.
      const dereferenced = join(snapshotRoot, 'node_modules', 'dep')
      expect(lstatSync(dereferenced).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(dereferenced, 'index.js'), 'utf8')).toBe('export default 1\n')
      expect(statSync(snapshotRoot).mode & 0o222).toBe(0)
      expect(statSync(join(snapshotRoot, 'node_modules')).mode & 0o222).toBe(0)
      expect(statSync(join(snapshotRoot, 'node_modules', '.pnpm')).mode & 0o222).toBe(0)
      expect(statSync(snapshotFile).mode & 0o222).toBe(0)
      expect(statSync(recordPath(fixture)).mode & 0o222).toBe(0)
      const legacyEntries = readdirSync(join(fixture.editorRoot, '.legacy'))
      expect(legacyEntries).toHaveLength(1)
      expect(
        readFileSync(
          join(fixture.editorRoot, '.legacy', legacyEntries[0]!, 'legacy-root-install'),
          'utf8',
        ),
      ).toBe('retained')
      const before = statSync(recordPath(fixture), { bigint: true }).mtimeNs
      await publishEditorView(fixture.options)
      expect(statSync(recordPath(fixture), { bigint: true }).mtimeNs).toBe(before)
      expect(existsSync(join(fixture.editorRoot, '.legacy', legacyEntries[0]!))).toBe(false)
      await expect(checkEditorView(fixture.options)).resolves.toEqual(record)
    } finally {
      cleanup(fixture)
    }
  })

  for (const finite of [false, true]) {
    describe(`unchanged publication (finite closure: ${finite})`, () => {
      let fixture: Fixture
      let options: EditorViewOptions
      let record: EditorViewRecord
      let before: readonly StoreFile[]
      let publication: Promise<EditorViewRecord> | undefined
      let completed = 0

      beforeAll(async () => {
        fixture = makeFixture()
        options = {
          ...fixture.options,
          ...(finite === true ? { backingRoots: [fixture.editorInputs] } : {}),
        }
        publication = publishEditorView(options)
        record = await publication
        before = storeFiles(join(fixture.editorRoot, '.store'))
      })

      afterAll(async () => {
        await publication?.catch(() => undefined)
        if (fixture !== undefined) cleanup(fixture)
      })

      // Keep all ten warm publications against the same immutable baseline,
      // with the normal guard on each publication rather than the whole loop.
      for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        it(`writes zero store bytes on unchanged publication ${index}`, async () => {
          expect(completed).toBe(index - 1)
          expect(before.reduce((bytes, file) => bytes + file.size, 0n)).toBeGreaterThan(0n)
          publication = publishEditorView({
            ...options,
            cp: falseTool,
            beforeMaterialize: () => {
              throw new Error('unchanged publication attempted materialization')
            },
          })
          await expect(publication).resolves.toEqual(record)
          const after = storeFiles(join(fixture.editorRoot, '.store'))
          const previous = new Map(before.map((file) => [file.path, file]))
          const writtenBytes = after.reduce((bytes, file) => {
            const old = previous.get(file.path)
            return old?.ino === file.ino &&
              old.mtimeNs === file.mtimeNs &&
              old.ctimeNs === file.ctimeNs
              ? bytes
              : bytes + file.size
          }, 0n)
          expect(writtenBytes).toBe(0n)
          expect(after).toEqual(before)
          expect(ownedSnapshots(fixture)).toEqual([storeName(record.snapshot)])
          completed = index
        })
      }
    })
  }

  describe('incremental finite source-stat manifest reuse', () => {
    let fixture: Fixture
    let options: EditorViewOptions
    let first: EditorViewRecord
    let second: EditorViewRecord
    let firstRoot: string
    let stableIdentity: readonly [bigint, bigint]
    let sourceIdentity: readonly [bigint, bigint]
    let pending: Promise<unknown> | undefined
    const stablePath = join('node_modules', '.pnpm', 'dep@1', 'node_modules', 'dep', 'index.js')
    const manifestName = 'editor-view-sources-v1.json'
    beforeAll(async () => {
      fixture = makeFixture()
      options = { ...fixture.options, backingRoots: [fixture.editorInputs] }
      const publication = publishEditorView(options)
      pending = publication
      first = await publication
      firstRoot = join(fixture.editorRoot, first.snapshot)
      const stable = lstatSync(join(firstRoot, stablePath), { bigint: true })
      stableIdentity = [stable.dev, stable.ino]
      const source = lstatSync(
        join(fixture.nodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep', 'index.js'),
        { bigint: true },
      )
      sourceIdentity = [source.dev, source.ino]
    })
    afterAll(async () => {
      await pending?.catch(() => undefined)
      if (fixture !== undefined) cleanup(fixture)
    })
    it('keeps the source-stat manifest private and immutable', () => {
      expect(lstatSync(join(firstRoot, manifestName)).mode & 0o777).toBe(0o444)
      expect(lstatSync(join(firstRoot, manifestName)).nlink).toBe(1)
    })
    it('reuses an unchanged CAS inode without sharing the source inode', async () => {
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
      const publication = publishEditorView(options)
      pending = publication
      second = await publication
      const secondRoot = join(fixture.editorRoot, second.snapshot)
      expect(second.snapshot).not.toBe(first.snapshot)
      const reused = lstatSync(join(secondRoot, stablePath), { bigint: true })
      expect([reused.dev, reused.ino]).toEqual(stableIdentity)
      expect([reused.dev, reused.ino]).not.toEqual(sourceIdentity)
      expect(reused.mode & 0o777n).toBe(0o444n)
      expect(readEditorViewSourceManifest(join(secondRoot, manifestName)).get(stablePath)).toEqual(
        readEditorViewSourceManifest(join(firstRoot, manifestName)).get(stablePath),
      )
    })
    it('fully checks the incrementally admitted generation against its record', async () => {
      pending = checkEditorView(options)
      await expect(pending).resolves.toEqual(second)
    })
  })

  describe('source-stat hints never substitute for the admitted payload proof', () => {
    let fixture: Fixture
    let options: EditorViewOptions
    let first: EditorViewRecord
    let pending: Promise<unknown> | undefined
    beforeAll(async () => {
      fixture = makeFixture()
      options = { ...fixture.options, backingRoots: [fixture.editorInputs] }
      const publication = publishEditorView(options)
      pending = publication
      first = await publication
      const manifestPath = join(fixture.editorRoot, first.snapshot, 'editor-view-sources-v1.json')
      const manifest = readEditorViewSourceManifest(manifestPath)
      const stablePath = join('node_modules', '.pnpm', 'dep@1', 'node_modules', 'dep', 'index.js')
      const stable = manifest.get(stablePath)!
      const descriptor = [...manifest].find(([path]) =>
        path.endsWith('/install-descriptor.json'),
      )![1]
      manifest.set(stablePath, {
        ...stable,
        digest: descriptor.digest,
        mode: descriptor.mode,
        blobKey: descriptor.blobKey,
      })
      chmodSync(manifestPath, 0o600)
      writeFileSync(manifestPath, JSON.stringify(Object.fromEntries(manifest)))
      chmodSync(manifestPath, 0o444)
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
    })
    afterAll(async () => {
      await pending?.catch(() => undefined)
      if (fixture !== undefined) cleanup(fixture)
    })
    it('rejects a forged hint while preserving the published generation', async () => {
      pending = publishEditorView(options)
      await expect(pending).rejects.toThrow('declared backing roots changed while materializing')
      expect(currentTarget(fixture)).toBe(first.snapshot)
    })
  })

  describe('canonical reuse when equivalent backing artifacts move or link spelling changes', () => {
    let fixture: Fixture
    let secondRoot: string
    let first: EditorViewRecord
    let movedOptions: EditorViewOptions
    let before: readonly StoreFile[]
    let publication: Promise<EditorViewRecord> | undefined
    let checking: Promise<EditorViewRecord> | undefined
    let completed = 0
    let checked = false

    beforeAll(async () => {
      fixture = makeFixture()
      const firstRoot = join(fixture.root, 'inputs', 'artifact-first')
      secondRoot = join(fixture.root, 'inputs', 'artifact-second')
      const view = join(fixture.root, 'inputs', 'artifact-view')
      for (const root of [firstRoot, secondRoot]) {
        mkdirSync(join(root, 'dep'), { recursive: true })
        writeFileSync(join(root, 'dep', 'index.js'), 'export default "stable"\n')
      }
      mkdirSync(view)
      symlinkSync(join(firstRoot, 'dep'), join(view, 'dep'))
      const firstOptions = {
        ...fixture.options,
        editorInputs: view,
        nodeModules: view,
        backingRoots: [firstRoot],
      }
      publication = publishEditorView(firstOptions)
      first = await publication
      before = storeFiles(join(fixture.editorRoot, '.store'))
      rmSync(join(view, 'dep'))
      symlinkSync(`${secondRoot}/./dep`, join(view, 'dep'))
      movedOptions = { ...firstOptions, backingRoots: [secondRoot] }
    })

    afterAll(async () => {
      await publication?.catch(() => undefined)
      await checking?.catch(() => undefined)
      if (fixture !== undefined) cleanup(fixture)
    })

    it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
      'reuses canonical content on relocated publication %s',
      async (index) => {
        expect(completed).toBe(index - 1)
        publication = publishEditorView({ ...movedOptions, cp: falseTool })
        await expect(publication).resolves.toEqual(first)
        expect(storeFiles(join(fixture.editorRoot, '.store'))).toEqual(before)
        expect(ownedSnapshots(fixture)).toEqual([storeName(first.snapshot)])
        completed = index
      },
    )

    it('checks relocated canonical content', async () => {
      expect(completed).toBe(10)
      checking = checkEditorView(movedOptions)
      await expect(checking).resolves.toEqual(first)
      checked = true
    })

    it('publishes meaningful transitive payload changes after relocation', async () => {
      expect(checked).toBe(true)
      // Relocation is not permission to ignore meaningful transitive payload changes.
      writeFileSync(join(secondRoot, 'dep', 'index.js'), 'export default "changed"\n')
      publication = publishEditorView(movedOptions)
      const changed = await publication
      expect(changed.editorInputsFingerprint).toBe(first.editorInputsFingerprint)
      expect(changed.normalizedStoreDigest).not.toBe(first.normalizedStoreDigest)
      expect(changed.snapshot).not.toBe(first.snapshot)
    })
  })

  it('hashes immutable shared bytes while another snapshot adds a hardlink', async () => {
    const fixture = makeFixture()
    try {
      const tree = join(fixture.root, 'immutable-tree')
      mkdirSync(tree)
      const payload = join(tree, 'payload')
      writeFileSync(payload, Buffer.alloc(1024 * 1024, 37))
      chmodSync(payload, 0o444)
      linkSync(payload, join(fixture.root, 'first-reader'))
      const before = await canonicalTreeFingerprint({ tree })
      // The TS walk has admitted the file before yielding to its first read.
      // Place the extra link outside the hashed tree so only file ctime changes.
      const hashing = canonicalTreeFingerprint({ tree })
      linkSync(payload, join(fixture.root, 'second-reader'))
      await expect(hashing).resolves.toBe(before)
      expect(await canonicalTreeFingerprint({ tree, fingerprintTool })).toBe(before)
    } finally {
      cleanup(fixture)
    }
  })

  it('publishes the source-generator dependency closure at the repository root', async () => {
    const fixture = makeFixture()
    try {
      writeFileSync(join(fixture.root, 'package.json'), '{"private":true}\n')
      mkdirSync(join(fixture.root, 'node_modules'))
      writeFileSync(join(fixture.root, 'node_modules', 'legacy-root-install'), 'retained')
      writeFileSync(
        fixture.workspaceAuthority,
        `${JSON.stringify({
          schema: 'effect-utils/workspace-dependency-authority/v1',
          requiredPackages: ['.'],
          ownedPackages: ['.'],
        })}\n`,
      )
      const options: EditorViewOptions = {
        ...fixture.options,
        package: '.',
        viewName: 'root',
        cell: 'effect_utils',
        target: '//:editor_inputs',
        consumerCache: join(fixture.root, '.devenv', 'vite-cache', 'root'),
      }

      const record = await publishEditorView(options)

      expect(readlinkSync(join(fixture.root, 'node_modules'))).toBe(
        '.editor-view/root/node_modules',
      )
      expect(readlinkSync(join(fixture.root, '.editor-view', 'root'))).toBe(record.snapshot)
      await expect(checkEditorView(options)).resolves.toEqual(record)
    } finally {
      cleanup(fixture)
    }
  })

  for (const residue of ['link', 'marker', 'ambiguous', 'published', 'locked', 'batch'] as const) {
    it(`retires only pnpm-owned unselected importers at root cutover (${residue})`, async () => {
      const fixture = makeFixture()
      try {
        writeFileSync(join(fixture.root, 'package.json'), '{"private":true}\n')
        const oldEffect = join(
          fixture.root,
          'node_modules',
          '.pnpm',
          'effect@4.0.3',
          'node_modules',
          'effect',
        )
        mkdirSync(oldEffect, { recursive: true })
        writeFileSync(join(oldEffect, 'index.js'), 'old effect\n')
        mkdirSync(join(fixture.nodeModules, 'effect'))
        writeFileSync(join(fixture.nodeModules, 'effect', 'index.js'), 'root view effect\n')
        const importer = join(fixture.packageDir, 'node_modules')
        const legacyIdentity = statSync(importer, { bigint: true }).ino
        if (residue === 'link')
          symlinkSync(
            '../../../../node_modules/.pnpm/effect@4.0.3/node_modules/effect',
            join(importer, 'effect'),
          )
        if (residue === 'marker' || residue === 'locked' || residue === 'batch')
          writeFileSync(join(importer, '.modules.yaml'), 'layoutVersion: 5\n')
        if (residue === 'published') await publishEditorView(fixture.options)
        const publishedTarget = residue === 'published' ? readlinkSync(importer) : undefined
        writeFileSync(
          fixture.workspaceAuthority,
          `${JSON.stringify({
            schema: 'effect-utils/workspace-dependency-authority/v1',
            requiredPackages: ['.', fixture.options.package],
            ownedPackages: ['.', fixture.options.package],
          })}\n`,
        )
        const options: EditorViewOptions = {
          ...fixture.options,
          package: '.',
          viewName: 'root',
          cell: 'effect_utils',
          target: '//:editor_inputs',
          consumerCache: join(fixture.root, '.devenv', 'vite-cache', 'root'),
        }
        if (residue === 'locked') {
          const packageLock = join(fixture.editorRoot, '.publish.lock')
          mkdirSync(packageLock, { recursive: true })
          writeFileSync(
            join(packageLock, 'owner.json'),
            '{"schema":"effect-utils/editor-view-lock/v1","token":"held-package-publisher","pid":1}\n',
          )
          // Normal live publication contention fails closed rather than waiting.
          // The importer cannot be classified or moved while its publisher owns it.
          await expect(publishEditorView(options)).rejects.toThrow('publication lock exists')
          expect(statSync(importer, { bigint: true }).ino).toBe(legacyIdentity)
          expect(lstatSync(join(fixture.root, 'node_modules')).isDirectory()).toBe(true)
          expect(existsSync(join(fixture.root, '.editor-view', '.publish.lock'))).toBe(false)
          expect(readFileSync(join(packageLock, 'owner.json'), 'utf8')).toContain(
            'held-package-publisher',
          )
          rmSync(packageLock, { recursive: true })
          await publishEditorView(options)
          expect(existsSync(importer)).toBe(false)
          return
        }
        if (residue === 'batch') {
          const acquired: string[] = []
          fsMocks.mkdirSync.mockImplementation((...args) => {
            const path = String(args[0])
            if (path.endsWith('/.publish.lock') === true) acquired.push(path)
            return nativeFs.mkdirSync(...args)
          })
          // Reverse request order must still lock root first and reuse the
          // package lock already owned by the batch, without self-contention.
          await publishEditorViews({ options: [fixture.options, options] })
          expect(acquired).toEqual([
            join(fixture.root, '.editor-view', '.publish.lock'),
            join(fixture.editorRoot, '.publish.lock'),
          ])
          expect(lstatSync(importer).isSymbolicLink()).toBe(true)
          expect(existsSync(join(fixture.root, '.editor-view', '.publish.lock'))).toBe(false)
          expect(existsSync(join(fixture.editorRoot, '.publish.lock'))).toBe(false)
          return
        }
        if (residue === 'ambiguous') {
          await expect(publishEditorView(options)).rejects.toThrow(
            'ambiguous package-local node_modules ownership',
          )
          expect(statSync(importer, { bigint: true }).ino).toBe(legacyIdentity)
          expect(lstatSync(join(fixture.root, 'node_modules')).isDirectory()).toBe(true)
        } else {
          await publishEditorView(options)
          if (residue === 'published') {
            expect(readlinkSync(importer)).toBe(publishedTarget)
          } else {
            expect(existsSync(importer)).toBe(false)
            // This is the same parent fallback used by a package-local import.
            expect(
              createRequire(join(fixture.packageDir, 'package.json')).resolve('effect/index.js'),
            ).toBe(realpathSync(join(fixture.root, 'node_modules', 'effect', 'index.js')))
            const retained = readdirSync(join(fixture.root, '.editor-view', '.legacy')).find(
              (name) => name.startsWith('importer-'),
            )!
            const retainedDir = join(fixture.root, '.editor-view', '.legacy', retained)
            expect(statSync(retainedDir, { bigint: true }).ino).toBe(legacyIdentity)
            expect(readFileSync(join(retainedDir, 'legacy-root-install'), 'utf8')).toBe('retained')
            expect(
              readFileSync(join(fixture.root, 'node_modules', 'effect', 'index.js'), 'utf8'),
            ).toBe('root view effect\n')
            await publishEditorView(options)
            expect(
              readdirSync(join(fixture.root, '.editor-view', '.legacy')).filter((name) =>
                name.startsWith('importer-'),
              ),
            ).toEqual([])
          }
        }
      } finally {
        cleanup(fixture)
      }
    })
  }

  it('survives deletion of every backing artifact', async () => {
    const fixture = makeFixture()
    try {
      const record = await publishEditorView(fixture.options)
      rmSync(join(fixture.root, 'inputs'), { recursive: true, force: true })
      expect(
        readFileSync(join(fixture.packageDir, 'node_modules', 'dep', 'index.js'), 'utf8'),
      ).toBe('export default 1\n')
      await expect(verifyEditorViewSnapshot(fixture.options)).resolves.toEqual(record)
    } finally {
      cleanup(fixture)
    }
  })

  describe('atomically flips old to new while retaining the bounded rollback snapshot', () => {
    let fixture: Fixture
    let oldRecord: EditorViewRecord
    let newRecord: EditorViewRecord
    let oldTarget: string
    let firstHopBefore: { readonly dev: bigint; readonly ino: bigint }
    const pending: Promise<unknown>[] = []
    let published = false

    beforeAll(async () => {
      fixture = makeFixture()
      const publication = publishEditorView(fixture.options)
      pending.push(publication)
      oldRecord = await publication
      oldTarget = currentTarget(fixture)
      firstHopBefore = lstatSync(join(fixture.packageDir, 'node_modules'), { bigint: true })
    })

    afterAll(async () => {
      await Promise.allSettled(pending)
      if (fixture !== undefined) cleanup(fixture)
    })

    it('publishes the changed install and payload as a new generation', async () => {
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
      const refreshedNodeModules = join(fixture.root, 'inputs', 'node_modules-v2')
      mkdirSync(join(refreshedNodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep'), {
        recursive: true,
      })
      writeFileSync(
        join(refreshedNodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep', 'index.js'),
        'export default 2\n',
      )
      symlinkSync('.pnpm/dep@1/node_modules/dep', join(refreshedNodeModules, 'dep'))
      const refreshedOptions = { ...fixture.options, nodeModules: refreshedNodeModules }
      const publication = publishEditorView(refreshedOptions)
      pending.push(publication)
      newRecord = await publication
      published = true
    })

    it('flips the stable hop and retains the original rollback bytes', () => {
      expect(published).toBe(true)
      expect(newRecord.editorInputsFingerprint).not.toBe(oldRecord.editorInputsFingerprint)
      expect(currentTarget(fixture)).not.toBe(oldTarget)
      expect(
        readFileSync(join(fixture.editorRoot, oldTarget, 'editor-view.json'), 'utf8'),
      ).toContain(oldRecord.editorInputsFingerprint)
      expect(
        readFileSync(
          join(fixture.editorRoot, oldTarget, 'node_modules', 'dep', 'index.js'),
          'utf8',
        ),
      ).toBe('export default 1\n')
      const firstHopAfter = lstatSync(join(fixture.packageDir, 'node_modules'), { bigint: true })
      expect([firstHopAfter.dev, firstHopAfter.ino]).toEqual([
        firstHopBefore.dev,
        firstHopBefore.ino,
      ])
      expect(ownedSnapshots(fixture)).toHaveLength(2)
    })
  })

  describe('keeps current and previous snapshots while reclaiming an unreserved candidate', () => {
    let fixture: Fixture
    let oldest: EditorViewRecord
    let abandoned: string
    const pending: Promise<unknown>[] = []
    let revision = 1

    beforeAll(async () => {
      fixture = makeFixture()
      const publication = publishEditorView(fixture.options)
      pending.push(publication)
      oldest = await publication
      abandoned = join(fixture.editorRoot, '.store', '.candidate-abandoned')
      mkdirSync(abandoned)
    })

    afterAll(async () => {
      await Promise.allSettled(pending)
      if (fixture !== undefined) cleanup(fixture)
    })

    it.each([2, 3])(
      'publishes generation %s after reclaiming the abandoned candidate',
      async (nextRevision) => {
        expect(revision).toBe(nextRevision - 1)
        writeFileSync(
          join(fixture.editorInputs, 'install-descriptor.json'),
          `${JSON.stringify({ revision: nextRevision })}\n`,
        )
        const nodeModules = join(fixture.root, 'inputs', `node_modules-v${nextRevision}`)
        mkdirSync(join(nodeModules, 'dep'), { recursive: true })
        writeFileSync(join(nodeModules, 'dep', 'index.js'), `export default ${nextRevision}\n`)
        const publication = publishEditorView({ ...fixture.options, nodeModules })
        pending.push(publication)
        await publication
        revision = nextRevision
      },
    )

    it('retains only current and previous snapshots, not the abandoned candidate', () => {
      expect(revision).toBe(3)
      const snapshots = ownedSnapshots(fixture)
      expect(snapshots).toHaveLength(2)
      expect(snapshots).toContain(currentTarget(fixture).replace('.store/', ''))
      expect(snapshots).not.toContain(storeName(oldest.snapshot))
      expect(existsSync(abandoned)).toBe(false)
      const retention = JSON.parse(
        readFileSync(
          join(fixture.editorRoot, `.retention-${fixture.options.viewName}.json`),
          'utf8',
        ),
      ) as { snapshots: readonly string[] }
      expect(retention.snapshots).toHaveLength(2)
      expect(retention.snapshots[0]).toBe(currentTarget(fixture).replace('.store/', ''))
    })
  })

  describe('waits five minutes from supersession before enforcing configured retention', () => {
    let fixture: Fixture
    let options: EditorViewOptions
    let oldest: EditorViewRecord
    let revision = 1
    let publication: Promise<EditorViewRecord> | undefined

    beforeAll(async () => {
      fixture = makeFixture()
      options = { ...fixture.options, snapshotGraceMs: 300_000, snapshotRetention: 3 }
      publication = publishEditorView(options)
      oldest = await publication
    })

    afterAll(async () => {
      await Promise.allSettled([publication])
      if (fixture !== undefined) cleanup(fixture)
    })

    for (let nextRevision = 2; nextRevision <= 6; nextRevision++) {
      it(`retains generation ${nextRevision} within the supersession grace period`, async () => {
        expect(revision).toBe(nextRevision - 1)
        writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), `${nextRevision}\n`)
        publication = publishEditorView(options)
        await publication
        revision = nextRevision
        expect(ownedSnapshots(fixture)).toHaveLength(nextRevision)
      })
    }

    it('enforces retention=3 only after all six generations exceed the grace period', async () => {
      expect(revision).toBe(6)
      expect(ownedSnapshots(fixture)).toHaveLength(6)
      const oldestRoot = join(fixture.editorRoot, oldest.snapshot)
      expect(Date.now() - statSync(oldestRoot).mtimeMs).toBeLessThan(300_000)
      const expired = new Date(Date.now() - 300_001)
      for (const name of ownedSnapshots(fixture)) {
        const root = join(fixture.editorRoot, '.store', name)
        utimesSync(root, statSync(root).atime, expired)
      }
      const current = currentTarget(fixture)
      publication = publishEditorView(options)
      await publication
      expect(ownedSnapshots(fixture)).toHaveLength(3)
      expect(currentTarget(fixture)).toBe(current)
      expect(ownedSnapshots(fixture)).not.toContain(storeName(oldest.snapshot))
    })
  })

  describe('preserves managed reader pins and advisory open descriptors beyond retention', () => {
    let fixture: Fixture
    let pinned: EditorViewRecord
    let opened: EditorViewRecord
    let descriptor: number | undefined
    let revision = 1
    let operation: Promise<unknown> | undefined

    beforeAll(async () => {
      fixture = makeFixture()
      const publication = publishEditorView(fixture.options)
      operation = publication
      pinned = await publication
      operation = pinEditorView({
        options: fixture.options,
        name: 'editor',
        snapshot: pinned.snapshot,
      })
      await operation
    })

    afterAll(async () => {
      await Promise.allSettled([operation])
      if (descriptor !== undefined) closeSync(descriptor)
      if (fixture !== undefined) cleanup(fixture)
    })

    it('opens an advisory descriptor for the second generation', async () => {
      expect(revision).toBe(1)
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), 'second\n')
      const publication = publishEditorView(fixture.options)
      operation = publication
      opened = await publication
      // Payloads are CAS hardlinks shared across generations. macOS lsof may
      // report another link's pathname, so use the generation-owned record for
      // this pathname-based advisory census (managed pins are the guarantee).
      const readerPath = recordPath(fixture, opened.snapshot)
      expect(statSync(readerPath).nlink).toBe(1)
      descriptor = openSync(readerPath, 'r')
      revision = 2
    })

    for (let nextRevision = 3; nextRevision <= 5; nextRevision++) {
      it(`preserves both readers while publishing generation ${nextRevision}`, async () => {
        expect(revision).toBe(nextRevision - 1)
        writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), `${nextRevision}\n`)
        operation = publishEditorView(fixture.options)
        await operation
        revision = nextRevision
        expect(ownedSnapshots(fixture)).toContain(storeName(pinned.snapshot))
        expect(ownedSnapshots(fixture)).toContain(storeName(opened.snapshot))
        // One detected unleased descriptor disables automatic eviction root-wide,
        // including generations that neither the descriptor nor the pin names.
        expect(ownedSnapshots(fixture)).toHaveLength(nextRevision)
      })
    }

    it('collects both reader generations after closing the descriptor and removing the pin', async () => {
      expect(revision).toBe(5)
      expect(ownedSnapshots(fixture)).toContain(storeName(pinned.snapshot))
      expect(ownedSnapshots(fixture)).toContain(storeName(opened.snapshot))
      expect(descriptor).toBeDefined()
      if (descriptor !== undefined) closeSync(descriptor)
      descriptor = undefined
      operation = unpinEditorView({ options: fixture.options, name: 'editor' })
      await operation
      operation = publishEditorView(fixture.options)
      await operation
      expect(ownedSnapshots(fixture)).toHaveLength(2)
      expect(ownedSnapshots(fixture)).not.toContain(storeName(pinned.snapshot))
      expect(ownedSnapshots(fixture)).not.toContain(storeName(opened.snapshot))
    })
  })

  it.skipIf(process.platform !== 'linux')(
    'preserves all local generations on an unknown scan and collects only after a complete clear scan',
    async () => {
      const fixture = makeFixture()
      let publication: Promise<EditorViewRecord> | undefined
      try {
        for (const revision of [1, 2]) {
          writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), `${revision}\n`)
          publication = publishEditorView(fixture.options)
          await publication
        }
        let scans = 0
        fsMocks.lstatSync.mockImplementation((...args) => {
          if (String(args[0]) === `/proc/${process.pid}`) {
            scans++
            throw Object.assign(new Error('unobserved fixture process'), { code: 'EACCES' })
          }
          return nativeFs.lstatSync(...args)
        })
        writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), 'third\n')
        publication = publishEditorView(fixture.options)
        await publication
        expect(scans).toBeGreaterThan(0)
        expect(ownedSnapshots(fixture)).toHaveLength(3)
        fsMocks.lstatSync.mockReset().mockImplementation(nativeFs.lstatSync)
        publication = publishEditorView(fixture.options)
        await publication
        expect(ownedSnapshots(fixture)).toHaveLength(2)
      } finally {
        if (publication !== undefined) await Promise.allSettled([publication])
        fsMocks.lstatSync.mockReset().mockImplementation(nativeFs.lstatSync)
        cleanup(fixture)
      }
    },
  )

  it('pins the current generation through the CLI', async () => {
    const fixture = makeFixture()
    try {
      const first = await publishEditorView(fixture.options)
      const pinned = await runEditorViewCli({
        fixture,
        command: 'pin',
        flags: ['--name', 'current-reader'],
      })
      expect({ status: pinned.status, stderr: pinned.stderr }).toEqual({ status: 0, stderr: '' })
      expect(pinned.stdout).toBe(`pinned editor view current-reader ${first.snapshot}\n`)
      const pinPath = join(fixture.editorRoot, '.pins', 'current-reader.json')
      expect(JSON.parse(readFileSync(pinPath, 'utf8'))).toEqual({
        schema: 'effect-utils/editor-view-pin/v1',
        name: 'current-reader',
        snapshot: first.snapshot,
      })
      expect(lstatSync(pinPath).isFile()).toBe(true)
    } finally {
      cleanup(fixture)
    }
  })

  describe('pins an explicitly selected rollback generation through the CLI', () => {
    let fixture: Fixture
    let first: EditorViewRecord
    let revision = 1
    let operation: Promise<unknown> | undefined

    beforeAll(async () => {
      fixture = makeFixture()
      const publication = publishEditorView(fixture.options)
      operation = publication
      first = await publication
      operation = pinEditorView({ options: fixture.options, name: 'current-reader' })
      await operation
    })

    afterAll(async () => {
      await Promise.allSettled([operation])
      if (fixture !== undefined) cleanup(fixture)
    })

    // Keep the rollback generation available beyond the retention=2 boundary.
    for (let nextRevision = 2; nextRevision <= 3; nextRevision++) {
      it(`publishes generation ${nextRevision} while retaining the current reader`, async () => {
        expect(revision).toBe(nextRevision - 1)
        writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), `${nextRevision}\n`)
        operation = publishEditorView(fixture.options)
        await operation
        revision = nextRevision
      })
    }

    it('pins the selected rollback generation', async () => {
      expect(revision).toBe(3)
      const pin = runEditorViewCli({
        fixture,
        command: 'pin',
        flags: ['--name', 'rollback-reader', '--snapshot', first.snapshot],
      })
      operation = pin
      const rollback = await pin
      expect({ status: rollback.status, stderr: rollback.stderr }).toEqual({
        status: 0,
        stderr: '',
      })
      expect(rollback.stdout).toBe(`pinned editor view rollback-reader ${first.snapshot}\n`)
    })
  })

  describe('unpins the current reader through the CLI while retaining a rollback reader', () => {
    let fixture: Fixture
    let first: EditorViewRecord
    let revision = 1
    let rollbackPinned = false
    let currentReaderUnpinned = false
    let operation: Promise<unknown> | undefined

    beforeAll(async () => {
      fixture = makeFixture()
      const publication = publishEditorView(fixture.options)
      operation = publication
      first = await publication
      operation = pinEditorView({ options: fixture.options, name: 'current-reader' })
      await operation
    })

    afterAll(async () => {
      await Promise.allSettled([operation])
      if (fixture !== undefined) cleanup(fixture)
    })

    for (let nextRevision = 2; nextRevision <= 3; nextRevision++) {
      it(`publishes generation ${nextRevision} while retaining the current reader`, async () => {
        expect(revision).toBe(nextRevision - 1)
        writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), `${nextRevision}\n`)
        operation = publishEditorView(fixture.options)
        await operation
        revision = nextRevision
      })
    }

    it('registers a rollback reader for the first generation', async () => {
      expect(revision).toBe(3)
      operation = pinEditorView({
        options: fixture.options,
        name: 'rollback-reader',
        snapshot: first.snapshot,
      })
      await operation
      rollbackPinned = true
    })

    it('unpins the current reader without removing the rollback reader', async () => {
      expect(rollbackPinned).toBe(true)
      const unpin = runEditorViewCli({
        fixture,
        command: 'unpin',
        flags: ['--name', 'current-reader'],
      })
      operation = unpin
      const unpinned = await unpin
      expect({ status: unpinned.status, stderr: unpinned.stderr }).toEqual({
        status: 0,
        stderr: '',
      })
      expect(unpinned.stdout).toBe('unpinned editor view current-reader\n')
      expect(existsSync(join(fixture.editorRoot, '.pins', 'current-reader.json'))).toBe(false)
      currentReaderUnpinned = true
    })

    it('retains the rollback generation during subsequent collection', async () => {
      expect(currentReaderUnpinned).toBe(true)
      operation = publishEditorView(fixture.options)
      await operation
      expect(ownedSnapshots(fixture)).toContain(storeName(first.snapshot))
    })
  })

  describe('unpins the last rollback reader through the CLI before collecting its generation', () => {
    let fixture: Fixture
    let first: EditorViewRecord
    let revision = 1
    let rollbackReaderUnpinned = false
    let operation: Promise<unknown> | undefined

    beforeAll(async () => {
      fixture = makeFixture()
      const publication = publishEditorView(fixture.options)
      operation = publication
      first = await publication
      operation = pinEditorView({
        options: fixture.options,
        name: 'rollback-reader',
        snapshot: first.snapshot,
      })
      await operation
    })

    afterAll(async () => {
      await Promise.allSettled([operation])
      if (fixture !== undefined) cleanup(fixture)
    })

    for (let nextRevision = 2; nextRevision <= 3; nextRevision++) {
      it(`publishes generation ${nextRevision} while retaining the rollback reader`, async () => {
        expect(revision).toBe(nextRevision - 1)
        writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), `${nextRevision}\n`)
        operation = publishEditorView(fixture.options)
        await operation
        revision = nextRevision
      })
    }

    it('unpins the last rollback reader', async () => {
      expect(revision).toBe(3)
      const unpin = runEditorViewCli({
        fixture,
        command: 'unpin',
        flags: ['--name', 'rollback-reader'],
      })
      operation = unpin
      const released = await unpin
      expect({ status: released.status, stderr: released.stderr }).toEqual({
        status: 0,
        stderr: '',
      })
      rollbackReaderUnpinned = true
    })

    it('collects the released rollback generation', async () => {
      expect(rollbackReaderUnpinned).toBe(true)
      operation = publishEditorView(fixture.options)
      await operation
      expect(ownedSnapshots(fixture)).not.toContain(storeName(first.snapshot))
    })
  })

  describe('rejects pinning a collected rollback generation through the CLI', () => {
    let fixture: Fixture
    let first: EditorViewRecord
    let revision = 1
    let operation: Promise<unknown> | undefined

    beforeAll(async () => {
      fixture = makeFixture()
      const publication = publishEditorView(fixture.options)
      operation = publication
      first = await publication
    })

    afterAll(async () => {
      await Promise.allSettled([operation])
      if (fixture !== undefined) cleanup(fixture)
    })

    for (let nextRevision = 2; nextRevision <= 3; nextRevision++) {
      it(`publishes generation ${nextRevision} without retaining a rollback reader`, async () => {
        expect(revision).toBe(nextRevision - 1)
        writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), `${nextRevision}\n`)
        operation = publishEditorView(fixture.options)
        await operation
        revision = nextRevision
      })
    }

    it('rejects a pin for the collected rollback generation', async () => {
      expect(revision).toBe(3)
      const pin = runEditorViewCli({
        fixture,
        command: 'pin',
        flags: ['--name', 'too-late', '--snapshot', first.snapshot],
      })
      operation = pin
      const missing = await pin
      expect(missing.status).not.toBe(0)
      expect(missing.stderr).toContain('pin snapshot is missing')
      expect(existsSync(join(fixture.editorRoot, '.pins', 'too-late.json'))).toBe(false)
    })
  })

  describe('managed pin input and registration ownership', () => {
    let fixture: Fixture
    let record: EditorViewRecord
    let pending: Promise<unknown> | undefined
    beforeAll(async () => {
      fixture = makeFixture()
      const publication = publishEditorView(fixture.options)
      pending = publication
      record = await publication
    })
    afterAll(async () => {
      await pending?.catch(() => undefined)
      if (fixture !== undefined) cleanup(fixture)
    })
    for (const name of ['', '../outside', 'reader.json', '.hidden', 'x'.repeat(65)]) {
      it(`rejects unsafe pin name ${JSON.stringify(name)}`, async () => {
        pending = pinEditorView({ options: fixture.options, name })
        await expect(pending).rejects.toThrow('pin name')
      })
    }
    for (const kind of ['outside', 'descendant', 'foreign', 'malformed'] as const) {
      it(`rejects the ${kind} generation name`, async () => {
        const snapshot =
          kind === 'outside'
            ? '../outside'
            : kind === 'descendant'
              ? `${record.snapshot}/node_modules`
              : kind === 'foreign'
                ? `.store/other-${'a'.repeat(64)}`
                : `.store/${fixture.options.viewName}-invalid`
        pending = pinEditorView({ options: fixture.options, name: 'reader', snapshot })
        await expect(pending).rejects.toThrow('pin snapshot must name a generation')
      })
    }
    it('rejects a missing generation without creating registration metadata', async () => {
      pending = pinEditorView({
        options: fixture.options,
        name: 'reader',
        snapshot: `.store/${fixture.options.viewName}-${'a'.repeat(64)}`,
      })
      await expect(pending).rejects.toThrow('pin snapshot is missing')
      expect(existsSync(join(fixture.editorRoot, '.pins'))).toBe(false)
    })
    it('rejects pin replacement of a registration owned by another view', async () => {
      mkdirSync(join(fixture.editorRoot, '.pins'))
      const path = join(fixture.editorRoot, '.pins', 'reader.json')
      writeFileSync(
        path,
        JSON.stringify({
          schema: 'effect-utils/editor-view-pin/v1',
          name: 'reader',
          snapshot: `.store/other-${'a'.repeat(64)}`,
        }),
      )
      pending = pinEditorView({ options: fixture.options, name: 'reader' })
      await expect(pending).rejects.toThrow('belongs to another view')
    })
    it('rejects unpinning a foreign registration without changing it', async () => {
      pending = unpinEditorView({ options: fixture.options, name: 'reader' })
      await expect(pending).rejects.toThrow('belongs to another view')
      const path = join(fixture.editorRoot, '.pins', 'reader.json')
      expect(JSON.parse(readFileSync(path, 'utf8')).snapshot).toBe(`.store/other-${'a'.repeat(64)}`)
    })
    it('rejects a symlink in place of managed registration metadata', async () => {
      const path = join(fixture.editorRoot, '.pins', 'reader.json')
      rmSync(path)
      symlinkSync(join(fixture.root, 'workspace-authority.json'), path)
      pending = pinEditorView({ options: fixture.options, name: 'reader' })
      await expect(pending).rejects.toThrow('managed pin must be a regular file')
    })
  })

  describe('winning managed pin versus snapshot retirement', () => {
    let fixture: Fixture
    let oldest: EditorViewRecord
    let setup: Promise<EditorViewRecord> | undefined
    const entered = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    let pin: Promise<EditorViewPinRecord> | undefined
    let publication: Promise<EditorViewRecord> | undefined
    beforeAll(async () => {
      fixture = makeFixture()
      setup = publishEditorView({ ...fixture.options, snapshotRetention: 32 })
      oldest = await setup
    })
    for (const revision of [2, 3]) {
      it(`prepares retained generation ${revision}`, async () => {
        writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), `${revision}\n`)
        setup = publishEditorView({ ...fixture.options, snapshotRetention: 32 })
        await setup
      })
    }
    afterAll(async () => {
      proceed.resolve()
      await Promise.allSettled([setup, pin, publication])
      if (fixture !== undefined) cleanup(fixture)
    })
    it('serializes a managed pin with real retirement under the flock', async () => {
      try {
        pin = pinEditorView({
          options: fixture.options,
          name: 'racing-reader',
          snapshot: oldest.snapshot,
          afterStoreLock: async () => {
            entered.resolve()
            await proceed.promise
          },
        })
        await entered.promise
        // The pin already owns the real flock but has not written its registration.
        publication = publishEditorView(fixture.options)
        expect(existsSync(join(fixture.editorRoot, '.pins', 'racing-reader.json'))).toBe(false)
        proceed.resolve()
        await expect(pin).resolves.toMatchObject({ snapshot: oldest.snapshot })
        await publication
        expect(ownedSnapshots(fixture)).toContain(storeName(oldest.snapshot))
        await unpinEditorView({ options: fixture.options, name: 'racing-reader' })
        await publishEditorView(fixture.options)
        expect(ownedSnapshots(fixture)).not.toContain(storeName(oldest.snapshot))
      } finally {
        proceed.resolve()
        await Promise.allSettled([pin, publication])
      }
    })
  })

  describe('losing managed pin versus snapshot retirement', () => {
    let fixture: Fixture
    let oldest: EditorViewRecord
    let setup: Promise<EditorViewRecord> | undefined
    const entered = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const cleanupEntered = Promise.withResolvers<void>()
    const cleanupProceed = Promise.withResolvers<void>()
    let pinOutcome: Promise<unknown> | undefined
    let publication: Promise<EditorViewRecord> | undefined
    beforeAll(async () => {
      fixture = makeFixture()
      setup = publishEditorView({ ...fixture.options, snapshotRetention: 32 })
      oldest = await setup
    })
    for (const revision of [2, 3]) {
      it(`prepares retained generation ${revision}`, async () => {
        writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), `${revision}\n`)
        setup = publishEditorView({ ...fixture.options, snapshotRetention: 32 })
        await setup
      })
    }
    afterAll(async () => {
      proceed.resolve()
      cleanupProceed.resolve()
      await Promise.allSettled([setup, pinOutcome, publication])
      if (fixture !== undefined) cleanup(fixture)
    })
    it('rejects a losing pin instead of registering a dangling generation', async () => {
      try {
        publication = publishEditorView({
          ...fixture.options,
          beforeSnapshotRetirement: async () => {
            entered.resolve()
            await proceed.promise
          },
          beforeSnapshotCleanup: async () => {
            cleanupEntered.resolve()
            await cleanupProceed.promise
          },
        })
        await entered.promise
        // Retirement owns the actual flock after its managed-pin census. Admission
        // must wait and then recheck existence, not register against the stale name.
        pinOutcome = pinEditorView({
          options: fixture.options,
          name: 'too-late',
          snapshot: oldest.snapshot,
        }).then(
          (value) => value,
          (error: unknown) => error,
        )
        proceed.resolve()
        await cleanupEntered.promise
        // The canonical generation has retired, but recursive cleanup is paused.
        // Admission can acquire the flock now and must reject the hidden name.
        expect(
          readdirSync(fixture.editorRoot).some(
            (name) => name.startsWith('.gc-') === true && name.endsWith(storeName(oldest.snapshot)),
          ),
        ).toBe(true)
        const failure = await pinOutcome
        expect(failure).toBeInstanceOf(Error)
        expect(failure instanceof Error ? failure.message : undefined).toContain(
          'pin snapshot is missing',
        )
        expect(ownedSnapshots(fixture)).not.toContain(storeName(oldest.snapshot))
        expect(existsSync(join(fixture.editorRoot, '.pins', 'too-late.json'))).toBe(false)
        cleanupProceed.resolve()
        await publication
        expect(existsSync(join(fixture.editorRoot, '.publish.lock'))).toBe(false)
      } finally {
        proceed.resolve()
        cleanupProceed.resolve()
        await Promise.allSettled([pinOutcome, publication])
      }
    })
  })

  describe('treats shell symlinks as advisory retention observations', () => {
    let fixture: Fixture
    let oldest: EditorViewRecord
    let link: string
    let revision = 1
    let publication: Promise<EditorViewRecord> | undefined

    beforeAll(async () => {
      fixture = makeFixture()
      publication = publishEditorView(fixture.options)
      oldest = await publication
      link = join(fixture.editorRoot, 'shell-reader')
      symlinkSync(oldest.snapshot, link)
    })

    afterAll(async () => {
      await Promise.allSettled([publication])
      if (fixture !== undefined) cleanup(fixture)
    })

    for (const nextRevision of [2, 3]) {
      it(`observes the shell reader while publishing generation ${nextRevision}`, async () => {
        expect(revision).toBe(nextRevision - 1)
        writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), `${nextRevision}\n`)
        publication = publishEditorView(fixture.options)
        await publication
        revision = nextRevision
        expect(ownedSnapshots(fixture)).toContain(storeName(oldest.snapshot))
        expect(existsSync(join(fixture.editorRoot, '.pins', 'shell-reader.json'))).toBe(false)
      })
    }

    it('collects the advisory generation after the shell reader disappears', async () => {
      expect(revision).toBe(3)
      expect(ownedSnapshots(fixture)).toContain(storeName(oldest.snapshot))
      expect(existsSync(join(fixture.editorRoot, '.pins', 'shell-reader.json'))).toBe(false)
      rmSync(link)
      publication = publishEditorView(fixture.options)
      await publication
      expect(ownedSnapshots(fixture)).not.toContain(storeName(oldest.snapshot))
    })
  })

  it('releases read-only editor roots through the teardown CLI without following links', async () => {
    const fixture = makeFixture()
    try {
      const record = await publishEditorView(fixture.options)
      expect(statSync(join(fixture.editorRoot, record.snapshot)).mode & 0o222).toBe(0)
      const external = join(fixture.root, 'external')
      mkdirSync(external, { mode: 0o555 })
      symlinkSync(external, join(fixture.editorRoot, 'external-link'))
      const externalMode = statSync(external).mode
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./editor-view.ts', import.meta.url)),
          'release',
          '--repo-root',
          fixture.root,
          '--package',
          fixture.options.package,
          '--content-store',
          fixture.options.contentStore!,
        ],
        { encoding: 'utf8' },
      )
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
      expect(readdirSync(fixture.editorRoot)).toEqual(['.leases'])
      expect(
        readdirSync(dirname(fixture.editorRoot)).filter((name) =>
          name.startsWith('.editor-view.release-'),
        ),
      ).toEqual([])
      expect(statSync(external).mode).toBe(externalMode)
      expect(lstatSync(join(fixture.packageDir, 'node_modules')).isSymbolicLink()).toBe(true)
      await releaseEditorViewRoot(fixture.options)
    } finally {
      cleanup(fixture)
    }
  })

  it.each([0o500, 0o555])(
    'releases a hardened editor root and lease parent mode %s without chmodding shared bytes',
    async (leaseMode) => {
      const fixture = makeFixture()
      try {
        const record = await publishEditorView(fixture.options)
        const payload = join(fixture.editorRoot, record.snapshot, 'node_modules', 'dep', 'index.js')
        const retained = join(fixture.root, 'retained-payload')
        linkSync(payload, retained)
        const digest = createHash('sha256').update(readFileSync(payload)).digest('hex')
        const blob = join(fixture.options.contentStore!, digest.slice(0, 2), `${digest}-0444`)
        const shared = lstatSync(blob, { bigint: true })
        expect(shared.nlink).toBeGreaterThan(1n)
        expect(shared.mode & 0o777n).toBe(0o444n)
        expect(lstatSync(retained, { bigint: true }).ino).toBe(shared.ino)
        const leaseDirectory = join(fixture.editorRoot, '.leases')
        const control = join(leaseDirectory, `${storeName(record.snapshot)}.lock`)
        const controlBefore = lstatSync(control, { bigint: true })
        chmodSync(leaseDirectory, leaseMode)
        chmodSync(fixture.editorRoot, 0o555)

        await releaseEditorViewRoot(fixture.options)

        expect(readdirSync(fixture.editorRoot)).toEqual(['.leases'])
        expect(lstatSync(fixture.editorRoot).mode & 0o777).toBe(0o755)
        expect(lstatSync(leaseDirectory).mode & 0o777).toBe(0o700)
        const controlAfter = lstatSync(control, { bigint: true })
        expect([controlAfter.dev, controlAfter.ino, controlAfter.mode]).toEqual([
          controlBefore.dev,
          controlBefore.ino,
          controlBefore.mode,
        ])
        for (const path of [retained, blob]) {
          const status = lstatSync(path, { bigint: true })
          expect([status.dev, status.ino]).toEqual([shared.dev, shared.ino])
          expect(status.nlink).toBeGreaterThan(1n)
          expect(status.mode & 0o777n).toBe(0o444n)
        }
      } finally {
        cleanup(fixture)
      }
    },
  )

  it('refuses release permission normalization for a foreign-owned editor root', async () => {
    const fixture = makeFixture()
    try {
      const record = await publishEditorView(fixture.options)
      chmodSync(fixture.editorRoot, 0o555)
      const owner = lstatSync(fixture.editorRoot).uid
      const uid = vi.spyOn(process, 'getuid').mockReturnValue(owner + 1)
      try {
        await expect(releaseEditorViewRoot(fixture.options)).rejects.toThrow(
          'unsafe release directory',
        )
        expect(lstatSync(fixture.editorRoot).mode & 0o777).toBe(0o555)
        expect(existsSync(join(fixture.editorRoot, record.snapshot))).toBe(true)
        expect(existsSync(join(fixture.editorRoot, '.publish.lock'))).toBe(false)
      } finally {
        uid.mockRestore()
      }
    } finally {
      cleanup(fixture)
    }
  })

  it('refuses release permission normalization through a symlinked lease parent', async () => {
    const fixture = makeFixture()
    try {
      const record = await publishEditorView(fixture.options)
      const leaseDirectory = join(fixture.editorRoot, '.leases')
      const retained = join(fixture.root, 'retained-leases')
      nativeFs.renameSync(leaseDirectory, retained)
      chmodSync(retained, 0o500)
      symlinkSync(retained, leaseDirectory)
      chmodSync(fixture.editorRoot, 0o555)
      await expect(releaseEditorViewRoot(fixture.options)).rejects.toThrow(
        'unsafe release directory',
      )
      expect(lstatSync(retained).mode & 0o777).toBe(0o500)
      expect(existsSync(join(fixture.editorRoot, record.snapshot))).toBe(true)
      expect(existsSync(join(fixture.editorRoot, '.publish.lock'))).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  describe('refuses teardown while a publisher lock exists without unlocking payload directories', () => {
    let fixture: Fixture
    let record: EditorViewRecord
    const pending: Promise<unknown>[] = []
    let refused = false

    beforeAll(async () => {
      fixture = makeFixture()
      const publication = publishEditorView(fixture.options)
      pending.push(publication)
      record = await publication
    })

    afterAll(async () => {
      await Promise.allSettled(pending)
      if (fixture !== undefined) cleanup(fixture)
    })

    it('refuses real root release while the live publisher lock exists', async () => {
      const lock = join(fixture.editorRoot, '.publish.lock')
      mkdirSync(lock)
      writeFileSync(
        join(lock, 'owner.json'),
        JSON.stringify({
          schema: 'effect-utils/editor-view-lock/v1',
          token: 'held',
          pid: process.pid,
        }),
      )
      chmodSync(fixture.editorRoot, 0o555)
      const release = releaseEditorViewRoot(fixture.options)
      pending.push(release)
      await expect(release).rejects.toThrow('publication lock exists')
      refused = true
    })

    it('leaves the immutable payload directory and current pointer untouched', () => {
      expect(refused).toBe(true)
      expect(statSync(join(fixture.editorRoot, record.snapshot)).mode & 0o222).toBe(0)
      expect(readlinkSync(join(fixture.editorRoot, fixture.options.viewName))).toBe(record.snapshot)
    })
  })

  describe('shares immutable bytes across views, state roots, and worktrees until the last owner releases', () => {
    let first: Fixture
    let second: Fixture
    let options: readonly EditorViewOptions[]
    const records: EditorViewRecord[] = []
    const pending: Promise<unknown>[] = []
    let blob: string
    let completed = 0

    beforeAll(async () => {
      first = makeFixture()
      second = makeFixture({ packageName: 'genie' })
      writeFileSync(join(first.root, 'package.json'), '{}\n')
      writeFileSync(
        first.workspaceAuthority,
        `${JSON.stringify({
          schema: 'effect-utils/workspace-dependency-authority/v1',
          requiredPackages: ['.', first.options.package],
          ownedPackages: ['.', first.options.package],
        })}\n`,
      )
      const rootOptions: EditorViewOptions = {
        ...first.options,
        package: '.',
        viewName: 'root',
        target: '//:editor_inputs',
        consumerCache: '.devenv/vite-cache/root',
      }
      const secondOptions = { ...second.options, contentStore: first.options.contentStore! }
      options = [first.options, rootOptions, secondOptions]
      const publication = publishEditorView(options[0]!)
      pending.push(publication)
      records[0] = await publication
    })

    afterAll(async () => {
      await Promise.allSettled(pending)
      if (second !== undefined) cleanup(second)
      if (first !== undefined) cleanup(first)
    })

    // Keep all three owners of one real content store; each API operation gets
    // its own normal guard rather than combining publications and releases.
    it.each([1, 2])('publishes shared-store owner %s in its own state root', async (index) => {
      expect(completed).toBe(index - 1)
      const publication = publishEditorView(options[index]!)
      pending.push(publication)
      records[index] = await publication
      completed += 1
    })

    it('shares immutable payload inodes but not snapshot records across all three owners', () => {
      expect(completed).toBe(2)
      const snapshots = [
        join(first.editorRoot, records[0]!.snapshot),
        join(first.root, '.editor-view', records[1]!.snapshot),
        join(second.editorRoot, records[2]!.snapshot),
      ]
      const payloads = snapshots.map((snapshot) =>
        join(snapshot, 'node_modules', 'dep', 'index.js'),
      )
      const shared = lstatSync(payloads[0]!, { bigint: true })
      for (const payload of payloads) {
        const status = lstatSync(payload, { bigint: true })
        expect([status.dev, status.ino]).toEqual([shared.dev, shared.ino])
        expect(status.mode & 0o777n).toBe(0o444n)
      }
      expect(
        new Set(snapshots.map((snapshot) => statSync(join(snapshot, 'editor-view.json')).ino)).size,
      ).toBe(3)
      const hash = createHash('sha256').update(readFileSync(payloads[0]!)).digest('hex')
      blob = join(first.options.contentStore!, hash.slice(0, 2), `${hash}-0444`)
      expect(lstatSync(blob, { bigint: true }).ino).toBe(shared.ino)
      rmSync(first.nodeModules, { recursive: true })
      rmSync(second.nodeModules, { recursive: true })
      completed += 1
    })

    it.each([0, 1, 2])(
      'verifies owner %s after both original payload trees disappear',
      async (index) => {
        expect(completed).toBe(3 + index)
        const verification = verifyEditorViewSnapshot(options[index]!)
        pending.push(verification)
        await expect(verification).resolves.toBeDefined()
        completed += 1
      },
    )

    it('releases the first package state root', async () => {
      expect(completed).toBe(6)
      const release = releaseEditorViewRoot(options[0]!)
      pending.push(release)
      await release
      completed += 1
    })

    it.each([1, 2])(
      'verifies surviving owner %s after the first state root releases',
      async (index) => {
        expect(completed).toBe(6 + index)
        const verification = verifyEditorViewSnapshot(options[index]!)
        pending.push(verification)
        await expect(verification).resolves.toBeDefined()
        completed += 1
      },
    )

    it('releases the workspace-root view without unlocking the shared blob', async () => {
      expect(completed).toBe(9)
      const release = releaseEditorViewRoot(options[1]!)
      pending.push(release)
      await release
      expect(lstatSync(blob).mode & 0o777).toBe(0o444)
      completed += 1
    })

    it('verifies the remaining worktree after both other state roots release', async () => {
      expect(completed).toBe(10)
      const verification = verifyEditorViewSnapshot(options[2]!)
      pending.push(verification)
      await expect(verification).resolves.toBeDefined()
      completed += 1
    })

    it('releases the last worktree owner', async () => {
      expect(completed).toBe(11)
      const release = releaseEditorViewRoot(options[2]!)
      pending.push(release)
      await release
      completed += 1
    })

    it('collects the shared blob only after the last owner releases', () => {
      expect(completed).toBe(12)
      expect(existsSync(blob)).toBe(false)
    })
  })

  describe('shared store bounds for each publishing view', () => {
    let fixture: Fixture
    let options: readonly EditorViewOptions[]
    let publication: Promise<EditorViewRecord> | undefined
    const histories: string[][] = [[], []]
    let completed = 0

    beforeAll(() => {
      fixture = makeFixture()
      const sibling = makeSiblingView({ fixture, packageName: 'genie' })
      options = [fixture.options, sibling.options]
    })

    afterAll(async () => {
      await publication?.catch(() => undefined)
      if (fixture !== undefined) cleanup(fixture)
    })

    // All three generations and both views still share one real store. Each
    // publication gets its own guard; completed prevents advancing a failed step.
    for (const revision of [1, 2, 3]) {
      it.each([0, 1])(
        `bounds current plus previous at revision ${revision} for view %s`,
        async (index) => {
          expect(completed).toBe((revision - 1) * 2 + index)
          const option = options[index]!
          writeFileSync(
            join(option.editorInputs, 'install-descriptor.json'),
            `${JSON.stringify({ revision })}\n`,
          )
          publication = publishEditorView(option)
          const record = await publication
          const history = histories[index]!
          history.unshift(storeName(record.snapshot))
          const retained = readdirSync(join(fixture.editorRoot, '.store'))
            .filter((name) => name.startsWith(`${option.viewName}-`))
            .toSorted()
          expect(retained).toEqual(history.slice(0, 2).toSorted())
          if (index === 1)
            expect(readdirSync(join(fixture.editorRoot, '.store'))).toHaveLength(
              revision === 1 ? 2 : 4,
            )
          completed += 1
        },
      )
    }
  })

  describe('older generation permission proof at retirement', () => {
    let fixture: Fixture
    let oldestRoot: string
    let privateDirectory: string
    let pending: Promise<unknown> | undefined
    beforeAll(async () => {
      fixture = makeFixture()
      const initial = publishEditorView(fixture.options)
      pending = initial
      const oldest = await initial
      oldestRoot = join(fixture.editorRoot, oldest.snapshot)
      privateDirectory = join(oldestRoot, 'node_modules')
      chmodSync(privateDirectory, 0o700)
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
      pending = publishEditorView(fixture.options)
      await pending
    })
    afterAll(async () => {
      await pending?.catch(() => undefined)
      if (fixture !== undefined) cleanup(fixture)
    })
    it('does not rewalk a protected older generation', () => {
      expect(existsSync(oldestRoot)).toBe(true)
    })
    it('checks the complete permission proof before retirement', async () => {
      const previous = currentTarget(fixture)
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), '{"revision":3}\n')
      pending = publishEditorView(fixture.options)
      await expect(pending).rejects.toThrow('snapshot directory is writable')
      expect(existsSync(oldestRoot)).toBe(true)
      expect(currentTarget(fixture)).toBe(previous)
    })
    it('retires the generation once private directory permissions are restored', async () => {
      chmodSync(privateDirectory, 0o555)
      pending = publishEditorView(fixture.options)
      await pending
      expect(existsSync(oldestRoot)).toBe(false)
    })
  })

  it('shares one admission census across real batch publications, but not across invocations', async () => {
    const restoreBudget = isolateHostBudget()
    const fixture = makeFixture()
    const stderr = vi.spyOn(process.stderr, 'write')
    try {
      const options = [
        fixture.options,
        ...['genie', 'utils'].map(
          (packageName) => makeSiblingView({ fixture, packageName }).options,
        ),
      ]
      const censusCount = (): number =>
        stderr.mock.calls.filter(([message]) => {
          if (typeof message !== 'string' || message.startsWith('[editor-view-budget] ') === false)
            return false
          const event = JSON.parse(message.slice('[editor-view-budget] '.length))
          return event.event === 'working' && event.reason === 'census'
        }).length
      const first = await publishEditorViews({ options })
      expect(first).toHaveLength(options.length)
      expect(censusCount()).toBe(1)
      for (const option of options)
        writeFileSync(join(option.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
      const second = await publishEditorViews({ options })
      expect(second).toHaveLength(options.length)
      expect(second.map((record) => record.snapshot)).not.toEqual(
        first.map((record) => record.snapshot),
      )
      expect(censusCount()).toBe(2)
      for (const [index, option] of options.entries())
        expect(readlinkSync(join(fixture.editorRoot, option.viewName))).toBe(
          second[index]?.snapshot,
        )
    } finally {
      stderr.mockRestore()
      cleanup(fixture)
      restoreBudget()
    }
  })

  describe('bounded shared-root preparation and exclusive teardown fencing', () => {
    let fixture: Fixture
    let options: readonly EditorViewOptions[]
    const entered = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const started: string[] = []
    let active = 0
    let peak = 0
    let completed = 0
    let batch: Promise<readonly EditorViewRecord[]> | undefined
    let publication: Promise<EditorViewRecord> | undefined
    let teardown: Promise<void> | undefined
    let verification: Promise<EditorViewRecord> | undefined
    let verified = 0

    beforeAll(async () => {
      fixture = makeFixture()
      options = [
        fixture.options,
        ...['genie', 'utils', 'restate-effect', 'ci-tools', 'buck2-tools'].map(
          (packageName) => makeSiblingView({ fixture, packageName }).options,
        ),
      ].map((option) =>
        Object.assign(option, {
          backingRoots: [option.nodeModules],
          beforeMaterialize: async () => {
            active += 1
            peak = Math.max(peak, active)
            started.push(option.viewName)
            if (started.length === editorViewPublicationWorkers) entered.resolve()
            await proceed.promise
            active -= 1
          },
        }),
      )
      batch = publishEditorViews({ options })
      await entered.promise
    })

    afterAll(async () => {
      proceed.resolve()
      await batch?.catch(() => undefined)
      await publication?.catch(() => undefined)
      await teardown?.catch(() => undefined)
      await verification?.catch(() => undefined)
      if (fixture !== undefined) cleanup(fixture)
    })

    it('starts only the bounded preparation workers', () => {
      expect(started.toSorted()).toEqual(
        options
          .slice(0, editorViewPublicationWorkers)
          .map((option) => option.viewName)
          .toSorted(),
      )
      completed = 1
    })

    it('fences root teardown while the batch is preparing', async () => {
      expect(completed).toBe(1)
      teardown = releaseEditorViewRoot(fixture.options)
      await expect(teardown).rejects.toThrow('publication lock exists')
      completed = 2
    })

    it('fences an independent publication while the batch is preparing', async () => {
      expect(completed).toBe(2)
      publication = publishEditorView(fixture.options)
      await expect(publication).rejects.toThrow('publication lock exists')
      completed = 3
    })

    it('completes all six views without exceeding the worker bound', async () => {
      expect(completed).toBe(3)
      proceed.resolve()
      const records = await batch
      expect(records).toHaveLength(options.length)
      expect(peak).toBe(editorViewPublicationWorkers)
      expect(started.toSorted()).toEqual(options.map((option) => option.viewName).toSorted())
      expect(readdirSync(fixture.editorRoot)).not.toContain('.publish.lock')
      expect(readdirSync(join(fixture.editorRoot, '.store'))).toHaveLength(options.length)
      completed = 4
    })

    it.each(['tui-core', 'genie', 'utils', 'restate-effect', 'ci-tools', 'buck2-tools'])(
      'verifies the completed batch view %s',
      async (viewName) => {
        expect(completed).toBe(4)
        const index = options.findIndex((option) => option.viewName === viewName)
        expect(verified).toBe(index)
        const option = options[index]!
        verification = verifyEditorViewSnapshot(option)
        await expect(verification).resolves.toBeDefined()
        verified += 1
      },
    )
  })

  describe('batch failure settlement and cleanup', () => {
    let fixture: Fixture
    let options: EditorViewOptions[]
    let pending: Promise<unknown> | undefined
    const visited: string[] = []
    beforeAll(() => {
      fixture = makeFixture()
      options = [
        fixture.options,
        ...['genie', 'utils'].map(
          (packageName) => makeSiblingView({ fixture, packageName }).options,
        ),
      ].map((option) =>
        Object.assign(option, {
          backingRoots: [option.nodeModules],
          beforeMaterialize: () => {
            visited.push(option.viewName)
            if (option.viewName === 'tui-core') throw new Error('first view preparation failed')
          },
        }),
      )
    })
    afterAll(async () => {
      await pending?.catch(() => undefined)
      if (fixture !== undefined) cleanup(fixture)
    })
    it('settles all three real batch publications after the first worker fails', async () => {
      pending = publishEditorViews({ options })
      await expect(pending).rejects.toThrow('first view preparation failed')
      expect(visited.toSorted()).toEqual(['genie', 'tui-core', 'utils'])
      expect(readdirSync(fixture.editorRoot)).not.toContain('.publish.lock')
      expect(readdirSync(join(fixture.editorRoot, '.store'))).toHaveLength(2)
    })
    for (const index of [1, 2]) {
      it(`fully verifies settled sibling ${index}`, async () => {
        pending = verifyEditorViewSnapshot(options[index]!)
        await expect(pending).resolves.toBeDefined()
      })
    }
    it('rejects duplicate batch identities without leaving a publication lock', async () => {
      pending = publishEditorViews({ options: [fixture.options, fixture.options] })
      await expect(pending).rejects.toThrow('duplicate batch publication identity')
      expect(readdirSync(fixture.editorRoot)).not.toContain('.publish.lock')
    })
  })

  it.each(['.backing', '.backing/0001'])(
    'settles every payload fingerprint before cleaning a candidate after %s fails',
    async (failedRoot) => {
      const fixture = makeFixture()
      const entered = Promise.withResolvers<string>()
      const failPayload = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      const runFingerprintTool = fingerprintRunner.runFingerprintTool
      let publication: Promise<unknown> | undefined
      let failure: unknown
      const spy = vi
        .spyOn(fingerprintRunner, 'runFingerprintTool')
        .mockImplementation(async (request) => {
          const tree = request.args[0] ?? ''
          if (tree.includes('/.candidate-') === true) {
            if (tree.endsWith(`/${failedRoot}`) === true) {
              await failPayload.promise
              throw new Error('payload fingerprint failed')
            }
            if (tree.endsWith('/.backing/0000') === true) {
              entered.resolve(tree)
              await proceed.promise
              throw new Error('later payload fingerprint failed')
            }
          }
          return runFingerprintTool(request)
        })
      try {
        const backing = join(fixture.root, 'inputs', 'backing')
        mkdirSync(join(backing, 'node_modules'), { recursive: true })
        writeFileSync(join(backing, 'node_modules', 'dep.js'), 'export default 1\n')
        const secondBacking = join(fixture.root, 'inputs', 'second-backing')
        mkdirSync(secondBacking)
        writeFileSync(join(secondBacking, 'dep.js'), 'export default 2\n')
        publication = publishEditorView({
          ...fixture.options,
          backingRoots: [backing, secondBacking],
        }).catch((error: unknown) => {
          failure = error
        })
        const pendingTree = await entered.promise
        const before = lstatSync(join(pendingTree, 'node_modules'), { bigint: true })
        failPayload.resolve()
        // Drain the rejection and cleanup microtasks while the other root walk stays gated.
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
        expect(failure).toBeUndefined()
        const after = lstatSync(join(pendingTree, 'node_modules'), { bigint: true })
        expect(after.ctimeNs).toBe(before.ctimeNs)
        expect(after.mode).toBe(before.mode)
        expect(readdirSync(fixture.editorRoot)).toContain('.publish.lock')
        proceed.resolve()
        await publication
        expect(failure).toBeInstanceOf(Error)
        expect(failure instanceof Error ? failure.cause : undefined).toEqual(
          new Error('payload fingerprint failed'),
        )
        expect(readdirSync(join(fixture.editorRoot, '.store'))).toEqual([])
        expect(readdirSync(fixture.editorRoot)).not.toContain('.publish.lock')
      } finally {
        failPayload.resolve()
        proceed.resolve()
        await publication
        spy.mockRestore()
        cleanup(fixture)
      }
    },
  )

  it('allows sibling preparation without mutating an active private payload walk', async () => {
    const fixture = makeFixture()
    const entered = Promise.withResolvers<string>()
    let siblingStarted = false
    const siblingEntered = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const runFingerprintTool = fingerprintRunner.runFingerprintTool
    let pausedTree: string | undefined
    let publication: Promise<readonly unknown[]> | undefined
    const spy = vi
      .spyOn(fingerprintRunner, 'runFingerprintTool')
      .mockImplementation(async (request) => {
        const tree = request.args[0] ?? ''
        if (
          pausedTree === undefined &&
          tree.includes('/.candidate-') === true &&
          tree.endsWith('/.backing/0000') === true
        ) {
          pausedTree = tree
          entered.resolve(tree)
          await proceed.promise
        }
        return runFingerprintTool(request)
      })
    try {
      const sibling = makeSiblingView({ fixture, packageName: 'genie' })
      const backing = join(fixture.root, 'inputs', 'shared-backing')
      mkdirSync(join(backing, 'node_modules', 'dep'), { recursive: true })
      writeFileSync(join(backing, 'node_modules', 'dep', 'index.js'), 'export default 1\n')
      const options = [fixture.options, sibling.options].map((option, index) => {
        symlinkSync(join(backing, 'node_modules', 'dep'), join(option.nodeModules, 'shared'))
        if (index === 1)
          Object.assign(option, {
            beforeMaterialize: async () => {
              siblingStarted = true
              siblingEntered.resolve()
            },
          })
        return Object.assign(option, { backingRoots: [backing] })
      })
      const source = lstatSync(join(backing, 'node_modules'), { bigint: true })
      publication = publishEditorViews({
        options,
        onPublished: (record) => {
          if (record.package === fixture.options.package) {
            const copied = lstatSync(join(backing, 'node_modules'), { bigint: true })
            expect(copied.ctimeNs).toBe(source.ctimeNs)
            expect(copied.mode).toBe(source.mode)
          }
        },
      })
      const pendingTree = await entered.promise
      const before = lstatSync(join(pendingTree, 'node_modules'), { bigint: true })
      await siblingEntered.promise
      expect(editorViewPublicationWorkers).toBe(4)
      expect(siblingStarted).toBe(true)
      const after = lstatSync(join(pendingTree, 'node_modules'), { bigint: true })
      expect(after.ctimeNs).toBe(before.ctimeNs)
      expect(after.mode).toBe(before.mode)
      expect([after.dev, after.ino]).not.toEqual([source.dev, source.ino])
      const unchangedSource = lstatSync(join(backing, 'node_modules'), { bigint: true })
      expect(unchangedSource.ctimeNs).toBe(source.ctimeNs)
      expect(unchangedSource.mode).toBe(source.mode)
      expect(readdirSync(fixture.editorRoot)).toContain('.publish.lock')
      proceed.resolve()
      await publication
      expect(siblingStarted).toBe(true)
      for (const option of options)
        await expect(verifyEditorViewSnapshot(option)).resolves.toBeDefined()
      expect(readdirSync(fixture.editorRoot)).not.toContain('.publish.lock')
    } finally {
      proceed.resolve()
      await publication?.catch(() => undefined)
      spy.mockRestore()
      cleanup(fixture)
    }
  })

  it('captures the failed worker before a queued sibling begins preparing', async () => {
    const fixture = makeFixture()
    const entered = Promise.withResolvers<string>()
    const failPayload = Promise.withResolvers<void>()
    const peersEntered = Promise.withResolvers<void>()
    let peersStarted = 0
    let siblingStarted = false
    const proceed = Promise.withResolvers<void>()
    const original = Object.assign(new Error('payload fingerprint failed'), { exitCode: 17 })
    const runFingerprintTool = fingerprintRunner.runFingerprintTool
    let pausedTree: string | undefined
    let publication: Promise<unknown> | undefined
    let failure: unknown
    const spy = vi
      .spyOn(fingerprintRunner, 'runFingerprintTool')
      .mockImplementation(async (request) => {
        const tree = request.args[0] ?? ''
        if (tree.includes('/.candidate-') === true) {
          if (tree.endsWith('/.backing') === true && tree === dirname(await entered.promise)) {
            await failPayload.promise
            throw original
          }
          if (tree.endsWith('/.backing/0000') === true && pausedTree === undefined) {
            pausedTree = tree
            entered.resolve(tree)
            await proceed.promise
          }
        }
        return runFingerprintTool(request)
      })
    try {
      const sibling = makeSiblingView({ fixture, packageName: 'genie' })
      const backing = join(fixture.root, 'inputs', 'shared-backing')
      mkdirSync(backing)
      writeFileSync(join(backing, 'dep.js'), 'export default 1\n')
      const peers = ['utils', 'ci-tools', 'buck2-tools'].map(
        (packageName) => makeSiblingView({ fixture, packageName }).options,
      )
      publication = publishEditorViews({
        options: [
          { ...fixture.options, backingRoots: [backing] },
          ...peers.map((option) => ({
            ...option,
            backingRoots: [backing],
            beforeMaterialize: async () => {
              peersStarted += 1
              if (peersStarted === editorViewPublicationWorkers - 1) peersEntered.resolve()
              await proceed.promise
            },
          })),
          {
            ...sibling.options,
            backingRoots: [backing],
            beforeMaterialize: async () => {
              siblingStarted = true
            },
          },
        ],
      }).catch((error: unknown) => {
        failure = error
      })
      await entered.promise
      await peersEntered.promise
      failPayload.resolve()
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
      expect(siblingStarted).toBe(false)
      expect(failure).toBeUndefined()
      proceed.resolve()
      await publication
      expect(siblingStarted).toBe(true)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error('publication did not fail')
      expect(failure.cause).toBe(original)
      expect('exitCode' in failure ? failure.exitCode : undefined).toBe(17)
      const states: unknown = JSON.parse(
        failure.message.split('; publication workers=')[1] ?? 'null',
      )
      expect(states).toEqual(
        expect.arrayContaining([
          {
            package: fixture.options.package,
            viewName: fixture.options.viewName,
            editorRoot: realpathSync(fixture.editorRoot),
            phase: 'payload',
            candidate: expect.stringMatching(/\/\.store\/\.candidate-[0-9a-f]+$/u),
          },
          ...peers.map((option) => ({
            package: option.package,
            viewName: option.viewName,
            editorRoot: realpathSync(fixture.editorRoot),
            phase: 'materialize',
            candidate: expect.stringMatching(/\/\.store\/\.candidate-[0-9a-f]+$/u),
          })),
        ]),
      )
      expect(states).toHaveLength(editorViewPublicationWorkers)
    } finally {
      failPayload.resolve()
      proceed.resolve()
      await publication
      spy.mockRestore()
      cleanup(fixture)
    }
  })

  it('promotes hardened payloads with a writable rename root before publishing immutable views', async () => {
    const fixture = makeFixture()
    try {
      // Linux permits renaming a read-only source directory, so runtime success
      // alone cannot catch the Darwin regression. Pin the permission bridge and
      // commit ordering, then exercise both real snapshot materialization modes.
      const source = readFileSync(new URL('./editor-view.ts', import.meta.url), 'utf8')
      const portableRename = source.slice(
        source.indexOf('const renameReadOnlySnapshot ='),
        source.indexOf('const garbageCollectSnapshots ='),
      )
      const writableRoot = portableRename.indexOf('chmodSync(source, sourceMode | 0o200)')
      expect(writableRoot).toBeGreaterThanOrEqual(0)
      expect(portableRename.indexOf('renameSync(source, destination)')).toBeGreaterThan(
        writableRoot,
      )
      const commit = source.slice(
        source.indexOf('const commit = async (): Promise<EditorViewRecord> =>'),
        source.indexOf('return await (coordinator === undefined ? commit()'),
      )
      const promotion = commit.indexOf('renameReadOnlySnapshot({')
      const hardening = commit.indexOf(
        'chmodSync(snapshotDir, statSync(snapshotDir).mode & ~0o222)',
      )
      const proof = commit.indexOf('requireReadOnlySnapshotRoot(snapshotDir)')
      expect(promotion).toBeGreaterThanOrEqual(0)
      expect(hardening).toBeGreaterThan(promotion)
      expect(proof).toBeGreaterThan(hardening)
      expect(commit.indexOf('publishCurrentPointer(')).toBeGreaterThan(proof)
      const sibling = makeSiblingView({ fixture, packageName: 'genie' })
      const options = [
        fixture.options,
        Object.assign(sibling.options, { backingRoots: [sibling.options.nodeModules] }),
      ]
      const records = await publishEditorViews({ options })
      for (const record of records)
        expect(lstatSync(join(fixture.editorRoot, record.snapshot)).mode & 0o222).toBe(0)
      for (const option of options)
        await expect(verifyEditorViewSnapshot(option)).resolves.toBeDefined()
    } finally {
      cleanup(fixture)
    }
  })

  it('fails closed on incomplete whole-workspace authority and cache paths inside the package', async () => {
    const fixture = makeFixture()
    try {
      writeFileSync(
        fixture.workspaceAuthority,
        `${JSON.stringify({
          schema: 'effect-utils/workspace-dependency-authority/v1',
          requiredPackages: ['packages/@overeng/tui-core', 'packages/@overeng/tui-react'],
          ownedPackages: ['packages/@overeng/buck2-tools', 'packages/@overeng/tui-core'],
        })}\n`,
      )
      await expect(publishEditorView(fixture.options)).rejects.toThrow(
        'missing=["packages/@overeng/tui-react"] extra=["packages/@overeng/buck2-tools"]',
      )
      expect(() => lstatSync(fixture.editorRoot)).toThrow()

      writeFileSync(
        fixture.workspaceAuthority,
        `${JSON.stringify({
          schema: 'effect-utils/workspace-dependency-authority/v1',
          requiredPackages: ['packages/@overeng/tui-core'],
          ownedPackages: ['packages/@overeng/tui-core'],
        })}\n`,
      )
      await expect(
        publishEditorView({
          ...fixture.options,
          consumerCache: join(fixture.packageDir, '.vite'),
        }),
      ).rejects.toThrow('consumer cache must be inside the repository and outside package')
    } finally {
      cleanup(fixture)
    }
  })

  describe('declared backing links and undeclared escapes', () => {
    let fixture: Fixture
    let options: EditorViewOptions
    let record: EditorViewRecord
    let pending: Promise<unknown> | undefined
    beforeAll(() => {
      fixture = makeFixture()
      const backingRoot = join(fixture.root, 'inputs', 'store-entry')
      mkdirSync(join(backingRoot, 'dep'), { recursive: true })
      writeFileSync(join(backingRoot, 'dep', 'index.js'), 'export default "external"\n')
      const backingAlias = join(fixture.root, 'inputs', 'store-entry-alias')
      symlinkSync(backingRoot, backingAlias, 'dir')
      const linkedView = join(fixture.root, 'inputs', 'node_modules-linked')
      mkdirSync(linkedView)
      symlinkSync(join(backingAlias, 'dep'), join(linkedView, 'dep'))
      options = { ...fixture.options, nodeModules: linkedView, backingRoots: [backingRoot] }
    })
    afterAll(async () => {
      await pending?.catch(() => undefined)
      if (fixture !== undefined) cleanup(fixture)
    })
    it('rejects selected links into an undeclared backing root', async () => {
      pending = publishEditorView({ ...fixture.options, nodeModules: options.nodeModules })
      await expect(pending).rejects.toThrow('outside declared backing roots')
      expect(ownedSnapshots(fixture)).toHaveLength(0)
    })
    it('publishes byte-owned payload from the declared backing alias', async () => {
      const publication = publishEditorView(options)
      pending = publication
      record = await publication
      expect(
        readFileSync(
          join(fixture.editorRoot, record.snapshot, 'node_modules', 'dep', 'index.js'),
          'utf8',
        ),
      ).toBe('export default "external"\n')
    })
    it('checks the admitted backing-link generation against its record', async () => {
      pending = checkEditorView(options)
      await expect(pending).resolves.toEqual(record)
    })
  })

  it.each(['relocation', 'hardening'] as const)(
    'keeps a hardlinked symlink leaf inside its named owner during %s',
    async (phase) => {
      const fixture = makeFixture()
      try {
        const contents = 'export default 1\n'
        const sourceTarget = join(
          fixture.nodeModules,
          '.pnpm',
          'dep@1',
          'node_modules',
          'dep',
          'index.js',
        )
        const alias = join(fixture.nodeModules, 'leaf.js')
        symlinkSync('.pnpm/dep@1/node_modules/dep/index.js', alias)
        const outside = join(fixture.root, 'outside-owner.js')
        if (phase === 'relocation') linkSync(sourceTarget, outside)
        const digest = createHash('sha256').update(contents).digest('hex')
        const blob = join(fixture.options.contentStore!, digest.slice(0, 2), `${digest}-0444`)
        // Darwin's F_GETPATH may name a file through any of its hardlinks.
        // Model that syscall result, but only for a real alias of the same inode,
        // so this regression is deterministic even on Linux.
        fsMocks.realpathSync.mockImplementation((...args) => {
          const named = nativeFs.realpathSync(...args)
          const path = String(args[0])
          const otherName = phase === 'relocation' ? outside : blob
          if (
            path.endsWith('/leaf.js') === true &&
            (phase === 'relocation' || path.includes('/.candidate-') === true) &&
            nativeFs.existsSync(otherName) === true
          ) {
            const target = nativeFs.statSync(path, { bigint: true })
            const other = nativeFs.lstatSync(otherName, { bigint: true })
            if (target.dev === other.dev && target.ino === other.ino) return otherName
          }
          return named
        })
        const options = { ...fixture.options, backingRoots: [fixture.nodeModules] }
        const record = await publishEditorView(options)
        const snapshot = join(fixture.editorRoot, record.snapshot)
        const snapshotAlias = join(snapshot, 'node_modules', 'leaf.js')
        const target = realpathThroughName(snapshotAlias)
        expect(target.startsWith(`${snapshot}/`)).toBe(true)
        expect(readFileSync(snapshotAlias, 'utf8')).toBe(contents)
        const shared = statSync(target, { bigint: true })
        const cached = lstatSync(blob, { bigint: true })
        expect([shared.dev, shared.ino]).toEqual([cached.dev, cached.ino])
        expect(shared.nlink).toBeGreaterThan(1n)
        // Prove the injected OS condition exists independently of the publisher.
        if (phase === 'relocation') expect(realpathSync(alias)).toBe(outside)
        else {
          const candidateAlias = join(dirname(snapshot), '.candidate-probe', 'leaf.js')
          mkdirSync(dirname(candidateAlias))
          symlinkSync(target, candidateAlias)
          expect(realpathSync(candidateAlias)).toBe(blob)
          rmSync(dirname(candidateAlias), { recursive: true })
        }
      } finally {
        fsMocks.realpathSync.mockReset().mockImplementation(nativeFs.realpathSync)
        cleanup(fixture)
      }
    },
  )

  describe('residual links in byte-owned snapshots', () => {
    let fixture: Fixture
    let pending: Promise<unknown> | undefined
    beforeAll(async () => {
      fixture = makeFixture()
      const publication = publishEditorView(fixture.options)
      pending = publication
      const record = await publication
      const snapshotNodeModules = join(fixture.editorRoot, record.snapshot, 'node_modules')
      chmodSync(snapshotNodeModules, 0o700)
      symlinkSync('dep', join(snapshotNodeModules, 'alias'))
      chmodSync(snapshotNodeModules, 0o555)
    })
    afterAll(async () => {
      await pending?.catch(() => undefined)
      if (fixture !== undefined) cleanup(fixture)
    })
    it('rejects a residual symbolic link during complete snapshot verification', async () => {
      pending = verifyEditorViewSnapshot(fixture.options)
      await expect(pending).rejects.toThrow('snapshot contains a symbolic link')
    })
  })

  it('names a Vite cache written into the snapshot and the directory to remove', async () => {
    const fixture = makeFixture()
    try {
      const record = await publishEditorView(fixture.options)
      const snapshotNodeModules = join(fixture.editorRoot, record.snapshot, 'node_modules')
      const viteTemp = join(snapshotNodeModules, '.vite-temp')
      // Simulates a capability-holding Vitest that bypasses the read-only modes.
      chmodSync(snapshotNodeModules, 0o700)
      mkdirSync(viteTemp)
      chmodSync(snapshotNodeModules, 0o555)
      const expectedViteTemp = join(
        realpathSync(fixture.root),
        'packages',
        '.editor-view',
        record.snapshot,
        'node_modules',
        '.vite-temp',
      )
      await expect(verifyEditorViewSnapshot(fixture.options)).rejects.toThrow(
        `snapshot directory is writable: ${expectedViteTemp}; Vite/Vitest created .vite-temp inside the read-only editor-view snapshot`,
      )
      await expect(verifyEditorViewSnapshot(fixture.options)).rejects.toThrow(
        `then remove ${expectedViteTemp}`,
      )
    } finally {
      cleanup(fixture)
    }
  })

  it('fails closed when a declared backing root changes while materializing', async () => {
    const fixture = makeFixture()
    try {
      const backingRoot = join(fixture.root, 'inputs', 'store-entry')
      mkdirSync(join(backingRoot, 'dep'), { recursive: true })
      writeFileSync(join(backingRoot, 'dep', 'index.js'), 'export default "first"\n')
      const linkedView = join(fixture.root, 'inputs', 'node_modules-linked')
      mkdirSync(linkedView)
      symlinkSync(join(backingRoot, 'dep'), join(linkedView, 'dep'))
      const options = { ...fixture.options, nodeModules: linkedView, backingRoots: [backingRoot] }

      await expect(
        publishEditorView({
          ...options,
          beforeMaterialize: () => {
            makeWritable(backingRoot)
            writeFileSync(join(backingRoot, 'dep', 'index.js'), 'export default "swapped"\n')
          },
        }),
      ).rejects.toThrow('declared backing roots changed while materializing')
      expect(ownedSnapshots(fixture)).toHaveLength(0)
      expect(
        readdirSync(join(fixture.editorRoot, '.store')).some((name) =>
          name.startsWith('.candidate-'),
        ),
      ).toBe(false)

      // The unmodified roots still publish the exact record a clean run produces.
      makeWritable(backingRoot)
      writeFileSync(join(backingRoot, 'dep', 'index.js'), 'export default "first"\n')
      const record = await publishEditorView(options)
      await expect(checkEditorView(options)).resolves.toEqual(record)
    } finally {
      cleanup(fixture)
    }
  })

  it('fails closed when a declared root link is retargeted while materializing', async () => {
    const fixture = makeFixture()
    try {
      const backingRoot = join(fixture.root, 'inputs', 'store-entry')
      mkdirSync(join(backingRoot, 'dep'), { recursive: true })
      writeFileSync(join(backingRoot, 'dep', 'index.js'), 'export default "first"\n')
      const linkedView = join(fixture.root, 'inputs', 'node_modules-linked')
      mkdirSync(linkedView)
      const depLink = join(linkedView, 'dep')
      symlinkSync(join(backingRoot, 'dep'), depLink)
      const options = { ...fixture.options, nodeModules: linkedView, backingRoots: [backingRoot] }

      await expect(
        publishEditorView({
          ...options,
          beforeMaterialize: () => {
            rmSync(depLink)
            // A different spelling of the same resolved path: the owner-resolved
            // digest alone accepts it, the copied link inventory must not.
            symlinkSync(`${backingRoot}/./dep`, depLink)
          },
        }),
      ).rejects.toThrow('declared backing roots changed while materializing')
      expect(ownedSnapshots(fixture)).toHaveLength(0)
      expect(
        readdirSync(join(fixture.editorRoot, '.store')).some((name) =>
          name.startsWith('.candidate-'),
        ),
      ).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  it.each(['created', 'reused', 'failed'] as const)(
    'completes every phase exactly once for a %s publication',
    async (outcome) => {
      const fixture = makeFixture()
      const stderr = vi.spyOn(process.stderr, 'write')
      try {
        if (outcome === 'reused') await publishEditorView(fixture.options)
        stderr.mockClear()
        if (outcome === 'failed')
          await expect(publishEditorView({ ...fixture.options, cp: falseTool })).rejects.toThrow(
            'cp --dereference --reflink=auto failed',
          )
        else await publishEditorView(fixture.options)
        expectCompletedPublicationPhases(
          stderr.mock.calls.map(([message]) => String(message)).join(''),
          outcome === 'failed' ? 'failed' : 'gc',
        )
      } finally {
        stderr.mockRestore()
        cleanup(fixture)
      }
    },
  )

  it('completes the interrupted phase and terminal interruption exactly once', async () => {
    const fixture = makeFixture()
    try {
      // Interrupt at an actual asynchronous publication boundary, before the
      // fingerprint child can finish, without timing-dependent parent polling.
      const preload = join(fixture.root, 'interrupt-publication.ts')
      writeFileSync(
        preload,
        `import { editorViewProcessTestScope } from ${JSON.stringify(new URL('./editor-view-readers.ts', import.meta.url).href)}
editorViewProcessTestScope.enterWith(() => [process.pid, ...${JSON.stringify([...fixtureProcessIds])}])
const write = process.stderr.write.bind(process.stderr)
process.stderr.write = (...args) => {
  const result = write(...args)
  if (String(args[0]).includes('"phase":"fingerprint","event":"enter"'))
    process.kill(process.pid, 'SIGTERM')
  return result
}
`,
      )
      const child = Bun.spawn(
        [
          requireTool('BUN_BIN'),
          '--preload',
          preload,
          fileURLToPath(new URL('./editor-view.ts', import.meta.url)),
          'publish',
          ...Object.entries({
            '--repo-root': fixture.root,
            '--package': fixture.options.package,
            '--cell': fixture.options.cell,
            '--target': fixture.options.target,
            '--editor-inputs': fixture.editorInputs,
            '--node-modules': fixture.nodeModules,
            '--cp': cp,
            '--mv': mv,
            '--fingerprint-tool': fingerprintTool,
            '--workspace-authority': fixture.workspaceAuthority,
            '--consumer-cache': fixture.consumerCache,
            '--snapshot-retention': '2',
            '--content-store': fixture.options.contentStore!,
          }).flat(),
        ],
        { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true },
      )
      editorCliProcesses.add(child)
      fixtureProcessIds.add(child.pid)
      const [status, , stderr] = await Promise.all([
        child.exited,
        Bun.readableStreamToText(child.stdout),
        Bun.readableStreamToText(child.stderr),
      ])
      editorCliProcesses.delete(child)
      fixtureProcessIds.delete(child.pid)
      expect(status).not.toBe(0)
      expectCompletedPublicationPhases(stderr, 'interrupted')
    } finally {
      cleanup(fixture)
    }
  })

  it('emits one completed editor-view.phases span per publication when tracing is active', async () => {
    const fixture = makeFixture()
    try {
      const { captured, invocations } = await withPublisherTelemetry(fixture, () =>
        publishEditorView(fixture.options),
      )
      expect(invocations).toHaveLength(1)
      expect(captured).toContain('emit-span effect-utils-devenv editor-view.phases')
      expect(captured).toContain('--attr-bool snapshot.created=true')
      expect(captured).toContain('--attr-int phase.fingerprint.ms=')
      expect(captured).toContain('--attr-int phase.pointers.ms=')
      expect(captured).toContain('--attr-int phase.gc.ms=')
      expect(
        invocations[0]?.filter((argument) => argument.startsWith('phase.gc.ms=')),
      ).toHaveLength(1)
      expect(captured).toContain('--attr-string package.path=packages/@overeng/tui-core')
      expect(captured).toContain('--attr-string span.label=phases tui-core')
      expect(invocations[0]).toEqual(expect.arrayContaining(['exit.code=0', 'ok']))
    } finally {
      cleanup(fixture)
    }
  })

  it('records snapshot reuse as a successful phase span', async () => {
    const fixture = makeFixture()
    try {
      await publishEditorView(fixture.options)
      const { invocations } = await withPublisherTelemetry(fixture, () =>
        publishEditorView(fixture.options),
      )
      expect(invocations).toHaveLength(1)
      expect(invocations[0]).toEqual(
        expect.arrayContaining([
          'editor-view.phases',
          'snapshot.created=false',
          'exit.code=0',
          'ok',
        ]),
      )
    } finally {
      cleanup(fixture)
    }
  })

  it('records snapshot copy failure as a failed phase span', async () => {
    const fixture = makeFixture()
    try {
      const { invocations } = await withPublisherTelemetry(fixture, async () => {
        await expect(publishEditorView({ ...fixture.options, cp: falseTool })).rejects.toThrow(
          'cp --dereference --reflink=auto failed',
        )
      })
      expect(invocations).toHaveLength(1)
      expect(invocations[0]).toEqual(
        expect.arrayContaining([
          'editor-view.phases',
          'snapshot.created=false',
          'exit.code=1',
          'error',
        ]),
      )
    } finally {
      cleanup(fixture)
    }
  })

  it.each(['single', 'batch'] as const)(
    'finishes %s publication while exporters are hung, then bounds and reaps delivery',
    async (mode) => {
      const fixture = makeFixture()
      try {
        const captured = await withPublisherTelemetry(
          fixture,
          async (children) => {
            const records =
              mode === 'single'
                ? [await publishEditorView(fixture.options)]
                : await publishEditorViews({ options: [fixture.options] })
            expect(records).toHaveLength(1)
            expect(currentTarget(fixture)).toBe(records[0]?.snapshot)
            expect(existsSync(join(fixture.editorRoot, '.publish.lock'))).toBe(false)
            const turn = Promise.withResolvers<void>()
            setImmediate(turn.resolve)
            await turn.promise
            expect(children).toHaveLength(mode === 'single' ? 1 : 2)
            for (const child of children) {
              expect(child.exitCode).toBeNull()
              expect(child.signalCode).toBeNull()
            }
          },
          { hang: true },
        )
        expect(captured.exits).toEqual(
          Array.from({ length: mode === 'single' ? 1 : 2 }, () => ({
            code: null,
            signal: 'SIGKILL',
          })),
        )
        expect(captured.invocations).toEqual(
          expect.arrayContaining([
            expect.arrayContaining([
              'editor-view.phases',
              'snapshot.created=true',
              'package.path=packages/@overeng/tui-core',
              'span.label=phases tui-core',
              'exit.code=0',
              'ok',
            ]),
          ]),
        )
        if (mode === 'batch')
          expect(captured.invocations).toEqual(
            expect.arrayContaining([
              expect.arrayContaining([
                'editor-view.publish',
                'package.path=packages/@overeng/tui-core',
                'span.label=publish tui-core',
                'exit.code=0',
                'ok',
              ]),
            ]),
          )
      } finally {
        cleanup(fixture)
      }
    },
  )

  it.each(['single', 'batch'] as const)(
    'finishes %s publication when the shared exporter slots are saturated',
    async (mode) => {
      const fixture = makeFixture()
      try {
        const captured = await withPublisherTelemetry(
          fixture,
          async (children) => {
            // Hold only delivery deadlines behind a barrier; publication I/O and
            // event-loop turns stay real, without unsupported Bun fake-timer APIs.
            const released = Promise.withResolvers<void>()
            const nativeTimeout = globalThis.setTimeout
            const deadlines = vi
              .spyOn(globalThis, 'setTimeout')
              .mockImplementation((handler, delay, ...args) =>
                delay === 1_000
                  ? nativeTimeout(() => {
                      void released.promise.then(() => handler(...args))
                    }, delay)
                  : nativeTimeout(handler, delay, ...args),
              )
            try {
              const now = performance.timeOrigin + performance.now()
              const span = {
                name: 'editor-view.saturated',
                label: 'saturated',
                attributes: [],
                startedAtMs: now,
                endedAtMs: now,
              }
              for (let index = 0; index < 4; index++)
                expect(emitCompletedSpanAsync(span)).toBe(true)
              expect(emitCompletedSpanAsync(span)).toBe(false)
              const records =
                mode === 'single'
                  ? [await publishEditorView(fixture.options)]
                  : await publishEditorViews({ options: [fixture.options] })
              expect(records).toHaveLength(1)
              expect(currentTarget(fixture)).toBe(records[0]?.snapshot)
              expect(existsSync(join(fixture.editorRoot, '.publish.lock'))).toBe(false)
              const turn = Promise.withResolvers<void>()
              setImmediate(turn.resolve)
              await turn.promise
              expect(children).toHaveLength(4)
              for (const child of children) {
                expect(child.exitCode).toBeNull()
                expect(child.signalCode).toBeNull()
              }
            } finally {
              released.resolve()
              deadlines.mockRestore()
            }
          },
          { hang: true },
        )
        expect(captured.invocations).toHaveLength(4)
        expect(captured.invocations.every((args) => args.includes('editor-view.saturated'))).toBe(
          true,
        )
        expect(captured.exits).toEqual(
          Array.from({ length: 4 }, () => ({ code: null, signal: 'SIGKILL' })),
        )
      } finally {
        cleanup(fixture)
      }
    },
  )

  it('republishes a distinct snapshot when only declared backing-root bytes change', async () => {
    const fixture = makeFixture()
    try {
      const backingRoot = join(fixture.root, 'inputs', 'store-entry')
      mkdirSync(join(backingRoot, 'dep'), { recursive: true })
      writeFileSync(join(backingRoot, 'dep', 'index.js'), 'export default "first"\n')
      const linkedView = join(fixture.root, 'inputs', 'node_modules-linked')
      mkdirSync(linkedView)
      symlinkSync(join(backingRoot, 'dep'), join(linkedView, 'dep'))
      const options = { ...fixture.options, nodeModules: linkedView, backingRoots: [backingRoot] }

      const first = await publishEditorView(options)
      // The admitted view reaches its bytes through the declared root, so moving those
      // bytes leaves BOTH the editor-inputs fingerprint and the admitted view digest
      // unchanged. Only the normalized store digest moves, and the store key has to
      // cover it or the second publication collides with the first immutable snapshot.
      makeWritable(backingRoot)
      writeFileSync(join(backingRoot, 'dep', 'index.js'), 'export default "second"\n')
      const second = await publishEditorView(options)

      expect(second.editorInputsFingerprint).toBe(first.editorInputsFingerprint)
      expect(second.selectedViewDigest).toBe(first.selectedViewDigest)
      expect(second.normalizedStoreDigest).not.toBe(first.normalizedStoreDigest)
      expect(second.snapshot).not.toBe(first.snapshot)
      expect(currentTarget(fixture)).toBe(second.snapshot)
      // Retention keeps the superseded snapshot, and it still holds its own bytes.
      expect(ownedSnapshots(fixture).toSorted()).toEqual(
        [storeName(first.snapshot), storeName(second.snapshot)].toSorted(),
      )
      const dependency = (record: { snapshot: string }): string =>
        readFileSync(
          join(fixture.editorRoot, record.snapshot, 'node_modules', 'dep', 'index.js'),
          'utf8',
        )
      expect(dependency(first)).toBe('export default "first"\n')
      expect(dependency(second)).toBe('export default "second"\n')
      await expect(checkEditorView(options)).resolves.toEqual(second)
    } finally {
      cleanup(fixture)
    }
  })

  it('publishes a finite byte-owned snapshot of a declared cyclic store component', async () => {
    const fixture = makeFixture()
    try {
      const view = join(fixture.root, 'inputs', 'cyclic-view')
      const group = join(fixture.root, 'inputs', 'cyclic-group')
      const aModules = join(group, 'a-key', 'node_modules')
      const bModules = join(group, 'b-key', 'node_modules')
      mkdirSync(join(aModules, 'a'), { recursive: true })
      mkdirSync(join(bModules, 'b'), { recursive: true })
      writeFileSync(join(aModules, 'a', 'index.js'), 'export const name = "a"\n')
      writeFileSync(join(bModules, 'b', 'index.js'), 'export const name = "b"\n')
      symlinkSync('../../b-key/node_modules/b', join(aModules, 'b'))
      symlinkSync('../../a-key/node_modules/a', join(bModules, 'a'))
      mkdirSync(view)
      symlinkSync(join(aModules, 'a'), join(view, 'a'))

      const options = {
        ...fixture.options,
        nodeModules: view,
        backingRoots: [view, group, group],
      }
      const record = await publishEditorView(options)
      const snapshot = join(fixture.editorRoot, record.snapshot)
      expect(readlinkSync(join(snapshot, 'node_modules', 'a'))).not.toContain(fixture.root)
      const ownedA = realpathSync(join(snapshot, 'node_modules', 'a'))
      const ownedB = realpathSync(join(dirname(ownedA), 'b'))
      expect(readFileSync(join(ownedA, 'index.js'), 'utf8')).toBe('export const name = "a"\n')
      expect(readFileSync(join(ownedB, 'index.js'), 'utf8')).toBe('export const name = "b"\n')
      expect(realpathSync(join(dirname(ownedB), 'a'))).toBe(ownedA)
      expect(readdirSync(join(snapshot, '.backing'))).toHaveLength(1)

      rmSync(join(fixture.root, 'inputs'), { recursive: true, force: true })
      await expect(verifyEditorViewSnapshot(fixture.options)).resolves.toEqual(record)
      expect(readFileSync(join(ownedB, 'index.js'), 'utf8')).toBe('export const name = "b"\n')
    } finally {
      cleanup(fixture)
    }
  })

  it('detects a writable published snapshot even when its content digest is unchanged', async () => {
    const fixture = makeFixture()
    try {
      await publishEditorView(fixture.options)
      chmodSync(join(fixture.editorRoot, currentTarget(fixture)), 0o700)
      await expect(checkEditorView(fixture.options)).rejects.toThrow(
        'snapshot immutability violation',
      )
    } finally {
      cleanup(fixture)
    }
  })

  describe('independent publication, checks, and garbage collection of two package views', () => {
    let first: Fixture
    const secondPackage = 'tui-react'
    let options: readonly EditorViewOptions[]
    let pending: Promise<EditorViewRecord> | undefined
    const current: EditorViewRecord[] = []
    const currentOptions: EditorViewOptions[] = []
    let completed = 0
    let initialChecks = 0
    let finalChecks = 0

    beforeAll(() => {
      first = makeFixture()
      const sibling = makeSiblingView({ fixture: first, packageName: secondPackage })
      options = [first.options, sibling.options]
    })

    afterAll(async () => {
      await pending?.catch(() => undefined)
      if (first !== undefined) cleanup(first)
    })

    it.each([0, 1])('publishes the initial generation of package view %s', async (index) => {
      expect(completed).toBe(index)
      currentOptions[index] = options[index]!
      pending = publishEditorView(currentOptions[index]!)
      current[index] = await pending
      completed += 1
    })

    it.each([0, 1])('checks the initial generation of package view %s', async (index) => {
      expect(completed).toBe(2)
      expect(initialChecks).toBe(index)
      pending = checkEditorView(options[index]!)
      await expect(pending).resolves.toEqual(current[index])
      initialChecks += 1
    })

    // Preserve both changed node_modules trees and all three generations for
    // each view; split the publication guards, not the shared-store history.
    for (const revision of [2, 3]) {
      it.each([0, 1])(
        `publishes revision ${revision} independently for package view %s`,
        async (index) => {
          expect(initialChecks).toBe(2)
          expect(completed).toBe((revision - 1) * 2 + index)
          const option = options[index]!
          writeFileSync(
            join(option.editorInputs, 'install-descriptor.json'),
            `${JSON.stringify({ revision })}\n`,
          )
          const nodeModules = join(
            first.root,
            'inputs',
            `${index === 0 ? 'first' : 'second'}-node-modules-${revision}`,
          )
          mkdirSync(join(nodeModules, 'dep'), { recursive: true })
          writeFileSync(
            join(nodeModules, 'dep', 'index.js'),
            index === 0 ? `export default ${revision}\n` : `export default "second-${revision}"\n`,
          )
          currentOptions[index] = { ...option, nodeModules }
          pending = publishEditorView(currentOptions[index]!)
          current[index] = await pending
          completed += 1
        },
      )
    }

    it.each([0, 1])('checks bounded retention independently for package view %s', async (index) => {
      expect(completed).toBe(6)
      expect(finalChecks).toBe(index)
      if (index === 0) expect(ownedSnapshots(first)).toHaveLength(2)
      else
        expect(
          readdirSync(join(first.editorRoot, '.store')).filter((name) =>
            name.startsWith(`${secondPackage}-`),
          ),
        ).toHaveLength(2)
      pending = checkEditorView(currentOptions[index]!)
      await expect(pending).resolves.toEqual(current[index])
      finalChecks += 1
    })
  })

  describe('snapshot mode repair rejects descriptor races', () => {
    it('rejects a FIFO swapped in after native hashing without blocking or protecting the retained inode', async () => {
      const fixture = makeFixture()
      let payloadDirectory: string | undefined
      let swapped = false
      let nativeHashed = false
      let unsafeOpenAttempt = false
      try {
        const record = await publishEditorView(fixture.options)
        const snapshot = join(fixture.editorRoot, record.snapshot, 'node_modules')
        const payload = join(snapshot, 'dep', 'index.js')
        payloadDirectory = dirname(payload)
        const alias = join(fixture.root, 'fifo-retained-inode')
        linkSync(payload, alias)
        chmodSync(alias, 0o644)
        fsMocks.openSync.mockImplementation((...args) => {
          if (String(args[0]) === payload) {
            const flags = args[1]
            const nonblocking =
              typeof flags === 'number' && (flags & nativeFs.constants.O_NONBLOCK) !== 0
            unsafeOpenAttempt ||= nonblocking === false
            // Assert before the real open: a blocking FIFO open would wedge the test runner.
            expect(nonblocking).toBe(true)
            if (nativeHashed === true && swapped === false) {
              // Swap after the walk's lstat, immediately before its descriptor open.
              chmodSync(dirname(payload), 0o755)
              rmSync(payload)
              const fifo = spawnSync(join(dirname(cp), 'mkfifo'), [payload], {
                encoding: 'utf8',
              })
              expect(fifo.status, fifo.stderr).toBe(0)
              chmodSync(dirname(payload), 0o555)
              swapped = true
            }
          }
          return Reflect.apply(nativeFs.openSync, fs, args)
        })
        childProcessMocks.spawn.mockImplementation((...args) => {
          const child = Reflect.apply(
            nativeChildProcess.spawn,
            ChildProcess,
            args,
          ) as ChildProcess.ChildProcess
          if (
            String(args[0]) === fingerprintTool &&
            Array.isArray(args[1]) === true &&
            args[1][0] === snapshot
          ) {
            // Register before runFingerprintTool receives the child and resumes its verifier.
            child.once('exit', (code) => {
              expect(code).toBe(0)
              nativeHashed = true
            })
          }
          return child
        })
        const started = performance.now()
        await expect(verifyEditorViewSnapshot(fixture.options)).rejects.toThrow()
        expect(performance.now() - started).toBeLessThan(5_000)
        expect(swapped).toBe(true)
        expect(unsafeOpenAttempt).toBe(false)
        expect(lstatSync(payload).isFIFO()).toBe(true)
        expect(statSync(alias).mode & 0o777).toBe(0o644)
        expect(readFileSync(alias, 'utf8')).toBe('export default 1\n')
      } finally {
        fsMocks.openSync.mockReset().mockImplementation(nativeFs.openSync)
        childProcessMocks.spawn.mockReset().mockImplementation(nativeChildProcess.spawn)
        if (payloadDirectory !== undefined) chmodSync(payloadDirectory, 0o755)
        cleanup(fixture)
      }
    })

    it('rejects a corrupted writable inode hidden by an ancestor swap during native hashing', async () => {
      const fixture = makeFixture()
      let snapshot: string | undefined
      let ancestor: string | undefined
      let parked: string | undefined
      let replacement: string | undefined
      const swapState = { hidden: false }
      let restored = false
      let nativeDigestOutput = ''
      try {
        // Unique bytes avoid sharing A with the fixture's duplicated dep/.pnpm payloads.
        mkdirSync(join(fixture.nodeModules, 'race-payload'))
        writeFileSync(join(fixture.nodeModules, 'race-payload', 'index.js'), 'clean inode B\n')
        const record = await publishEditorView(fixture.options)
        snapshot = join(fixture.editorRoot, record.snapshot, 'node_modules')
        ancestor = join(snapshot, 'race-payload')
        parked = join(fixture.root, 'corrupted-ancestor')
        replacement = join(fixture.root, 'clean-ancestor')
        const payload = join(ancestor, 'index.js')
        const alias = join(fixture.root, 'ancestor-retained-inode')
        const cleanDigest = await canonicalTreeFingerprint({ tree: snapshot, fingerprintTool })
        nativeFs.cpSync(ancestor, replacement, { recursive: true })
        const originalInode = statSync(payload).ino
        linkSync(payload, alias)
        chmodSync(alias, 0o644)
        writeFileSync(alias, 'corrupted inode A\n')
        const snapshotPath = snapshot
        const ancestorPath = ancestor
        const parkedPath = parked
        const replacementPath = replacement
        childProcessMocks.spawn.mockImplementation((...args) => {
          const target =
            String(args[0]) === fingerprintTool &&
            Array.isArray(args[1]) === true &&
            args[1][0] === snapshotPath
          if (target === true) {
            // Collection already saw writable inode A. Only the native subprocess sees clean B.
            chmodSync(snapshotPath, 0o755)
            // Cross-parent directory renames need owner-write on the moved roots.
            chmodSync(ancestorPath, 0o755)
            chmodSync(replacementPath, 0o755)
            nativeFs.renameSync(ancestorPath, parkedPath)
            nativeFs.renameSync(replacementPath, ancestorPath)
            chmodSync(ancestorPath, 0o555)
            chmodSync(snapshotPath, 0o555)
            swapState.hidden = true
          }
          const child = Reflect.apply(
            nativeChildProcess.spawn,
            ChildProcess,
            args,
          ) as ChildProcess.ChildProcess
          if (target === true) {
            child.stdout?.on('data', (chunk) => {
              nativeDigestOutput += String(chunk)
            })
            // Restore A before the caller's subprocess completion handler can resume repair.
            child.once('exit', (code) => {
              chmodSync(snapshotPath, 0o755)
              chmodSync(ancestorPath, 0o755)
              nativeFs.renameSync(ancestorPath, replacementPath)
              nativeFs.renameSync(parkedPath, ancestorPath)
              chmodSync(ancestorPath, 0o555)
              chmodSync(replacementPath, 0o555)
              chmodSync(snapshotPath, 0o555)
              swapState.hidden = false
              restored = true
              expect(code).toBe(0)
            })
          }
          return child
        })
        await expect(verifyEditorViewSnapshot(fixture.options)).rejects.toThrow()
        expect(restored).toBe(true)
        expect(nativeDigestOutput.trim()).toBe(`digest ${cleanDigest}`)
        expect(statSync(payload).ino).toBe(originalInode)
        expect(statSync(payload).mode & 0o777).toBe(0o644)
        expect(statSync(alias).mode & 0o777).toBe(0o644)
        expect(readFileSync(alias, 'utf8')).toBe('corrupted inode A\n')
      } finally {
        childProcessMocks.spawn.mockReset().mockImplementation(nativeChildProcess.spawn)
        if (snapshot !== undefined) chmodSync(snapshot, 0o755)
        if (
          swapState.hidden === true &&
          ancestor !== undefined &&
          parked !== undefined &&
          replacement !== undefined
        ) {
          chmodSync(ancestor, 0o755)
          nativeFs.renameSync(ancestor, replacement)
          nativeFs.renameSync(parked, ancestor)
        }
        // Both swapped directories are fixture-owned; restore their modes before removal.
        if (ancestor !== undefined && existsSync(ancestor) === true) makeWritable(ancestor)
        if (replacement !== undefined && existsSync(replacement) === true) makeWritable(replacement)
        if (parked !== undefined && existsSync(parked) === true) makeWritable(parked)
        cleanup(fixture)
      }
    })
  })

  describe('hash-verified snapshot mode drift', () => {
    it('prepares a writable hardlinked snapshot and reports repaired inode modes', async () => {
      const fixture = makeFixture()
      const stderr = vi.spyOn(process.stderr, 'write')
      try {
        const record = await publishEditorView(fixture.options)
        const payload = join(fixture.editorRoot, record.snapshot, 'node_modules', 'dep', 'index.js')
        const alias = join(fixture.root, 'retained-snapshot-alias')
        linkSync(payload, alias)
        chmodSync(alias, 0o644)
        stderr.mockClear()
        await expect(publishEditorView(fixture.options)).resolves.toEqual(record)
        expect(statSync(payload).mode & 0o777).toBe(0o444)
        expect(statSync(alias).mode & 0o777).toBe(0o444)
        expect(
          stderr.mock.calls.some(
            ([message]) =>
              typeof message === 'string' &&
              message.includes('[editor-view-mode-drift]') &&
              message.includes('"count":1') &&
              message.includes(payload),
          ),
        ).toBe(true)
        await expect(verifyEditorViewSnapshot(fixture.options)).resolves.toEqual(record)
      } finally {
        stderr.mockRestore()
        cleanup(fixture)
      }
    })

    it('leaves every writable mode unchanged when any snapshot byte is mutated', async () => {
      const fixture = makeFixture()
      try {
        writeFileSync(join(fixture.nodeModules, 'clean.js'), 'unchanged bytes\n')
        const record = await publishEditorView(fixture.options)
        const snapshot = join(fixture.editorRoot, record.snapshot, 'node_modules')
        const clean = join(snapshot, 'clean.js')
        const mutated = join(snapshot, 'dep', 'index.js')
        const alias = join(fixture.root, 'mutated-snapshot-alias')
        linkSync(mutated, alias)
        chmodSync(clean, 0o644)
        chmodSync(alias, 0o644)
        writeFileSync(alias, 'mutated bytes\n')
        await expect(publishEditorView(fixture.options)).rejects.toMatchObject({
          cause: expect.objectContaining({
            message: expect.stringContaining('existing snapshot byte digest mismatch'),
          }),
        })
        for (const path of [clean, mutated, alias]) expect(statSync(path).mode & 0o777).toBe(0o644)
      } finally {
        cleanup(fixture)
      }
    })
  })

  it.each(['after-chmod', 'during-rehash', 'append-during-rehash'] as const)(
    'restores the shared inode mode when a preopened writer mutates bytes %s',
    async (timing) => {
      const fixture = makeFixture()
      let writer: number | undefined
      try {
        const record = await publishEditorView(fixture.options)
        const payload = join(fixture.editorRoot, record.snapshot, 'node_modules', 'dep', 'index.js')
        const alias = join(fixture.root, 'post-chmod-snapshot-alias')
        linkSync(payload, alias)
        chmodSync(alias, 0o644)
        writer = nativeFs.openSync(alias, 'r+')
        const writableFd = writer
        const identity = nativeFs.fstatSync(writableFd)
        // Keep size fixed so a write to an already-read region can fool a hash without stat guards.
        const mutation = 'x'.repeat(identity.size)
        let repairedDescriptor: number | undefined
        let rollbackDescriptor: number | undefined
        let writtenBytes = 0
        fsMocks.fchmodSync.mockImplementation((fd, mode) => {
          nativeFs.fchmodSync(fd, mode)
          const status = nativeFs.fstatSync(fd)
          if (status.dev !== identity.dev || status.ino !== identity.ino) return
          if (repairedDescriptor === undefined && (status.mode & 0o222) === 0) {
            repairedDescriptor = fd
            // An already-open writer remains writable after fchmod removes permission bits.
            if (timing === 'after-chmod')
              writtenBytes = nativeFs.writeSync(writableFd, mutation, 0, 'utf8')
          } else if ((status.mode & 0o777) === (identity.mode & 0o777)) {
            rollbackDescriptor = fd
          }
        })
        fsMocks.readSync.mockImplementation((...args) => {
          const count = Reflect.apply(nativeFs.readSync, fs, args)
          if (
            (timing === 'during-rehash' || timing === 'append-during-rehash') &&
            args[0] === repairedDescriptor &&
            (writtenBytes === 0 || timing === 'append-during-rehash') &&
            count > 0
          ) {
            // Keep feeding an unbounded EOF loop, but fail the regression promptly.
            expect(writtenBytes).toBeLessThan(Buffer.byteLength(mutation) * 3)
            writtenBytes += nativeFs.writeSync(
              writableFd,
              mutation,
              timing === 'append-during-rehash' ? identity.size + writtenBytes : 0,
              'utf8',
            )
          }
          return count
        })
        const started = Date.now()
        await expect(publishEditorView(fixture.options)).rejects.toMatchObject({
          cause: expect.objectContaining({
            message: expect.stringContaining('snapshot file changed after mode repair:'),
          }),
        })
        expect(Date.now() - started).toBeLessThan(5000)
        expect(repairedDescriptor).toBeDefined()
        expect(writtenBytes).toBe(Buffer.byteLength(mutation))
        expect(rollbackDescriptor).toBe(repairedDescriptor)
        expect(readFileSync(alias, 'utf8').includes(mutation)).toBe(true)
        expect(statSync(payload).mode & 0o777).toBe(0o644)
        expect(statSync(alias).mode & 0o777).toBe(0o644)
      } finally {
        fsMocks.fchmodSync.mockReset().mockImplementation(nativeFs.fchmodSync)
        fsMocks.readSync.mockReset().mockImplementation(nativeFs.readSync)
        if (writer !== undefined) nativeFs.closeSync(writer)
        cleanup(fixture)
      }
    },
  )

  it('keeps a proven inode protected when a later inode changes after the aggregate proof', async () => {
    const fixture = makeFixture()
    try {
      // Distinct payloads and inode identities avoid the fixture's duplicated dep aliases.
      const source = join(fixture.options.nodeModules, 'race-two-inodes')
      mkdirSync(source)
      writeFileSync(join(source, 'a.js'), 'export default "first"\n')
      writeFileSync(join(source, 'b.js'), 'export default "second"\n')
      const record = await publishEditorView(fixture.options)
      const payloadRoot = join(
        fixture.editorRoot,
        record.snapshot,
        'node_modules',
        'race-two-inodes',
      )
      const first = join(payloadRoot, 'a.js')
      const second = join(payloadRoot, 'b.js')
      const firstAlias = join(fixture.root, 'first-retained-alias')
      const secondAlias = join(fixture.root, 'second-retained-alias')
      linkSync(first, firstAlias)
      linkSync(second, secondAlias)
      chmodSync(first, 0o644)
      chmodSync(second, 0o644)
      const identities = [statSync(first).ino, statSync(second).ino]
      const repairState: { protectedInode?: number } = {}
      let mutations = 0
      fsMocks.fchmodSync.mockImplementation((fd, mode) => {
        nativeFs.fchmodSync(fd, mode)
        const status = nativeFs.fstatSync(fd)
        if (
          repairState.protectedInode === undefined &&
          identities.includes(status.ino) === true &&
          (status.mode & 0o222) === 0
        ) {
          repairState.protectedInode = status.ino
          const laterAlias = status.ino === identities[0] ? secondAlias : firstAlias
          writeFileSync(laterAlias, 'changed after aggregate proof\n')
          mutations += 1
        }
      })
      await expect(publishEditorView(fixture.options)).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining('snapshot file changed after hash verification:'),
        }),
      })
      expect(mutations).toBe(1)
      for (const [payload, alias, original] of [
        [first, firstAlias, 'export default "first"\n'],
        [second, secondAlias, 'export default "second"\n'],
      ] as const) {
        const protectedInode = statSync(payload).ino === repairState.protectedInode
        for (const path of [payload, alias])
          expect(statSync(path).mode & 0o777).toBe(protectedInode === true ? 0o444 : 0o644)
        expect(readFileSync(alias, 'utf8')).toBe(
          protectedInode === true ? original : 'changed after aggregate proof\n',
        )
      }
    } finally {
      fsMocks.fchmodSync.mockReset().mockImplementation(nativeFs.fchmodSync)
      cleanup(fixture)
    }
  })

  describe('tampered shared inode rejection in every owning view', () => {
    let first: Fixture
    let sibling: { readonly options: EditorViewOptions; readonly editorInputs: string }
    let pending: Promise<unknown> | undefined
    beforeAll(async () => {
      first = makeFixture()
      sibling = makeSiblingView({ fixture: first, packageName: 'tui-react' })
      writeFileSync(join(sibling.options.nodeModules, 'dep', 'index.js'), 'export default 1\n')
      pending = publishEditorView(first.options)
      await pending
      pending = publishEditorView(sibling.options)
      await pending
      const payload = join(
        first.editorRoot,
        currentTarget(first),
        'node_modules',
        'dep',
        'index.js',
      )
      chmodSync(payload, 0o644)
      writeFileSync(payload, 'mutated shared bytes\n')
    })
    afterAll(async () => {
      await pending?.catch(() => undefined)
      if (first !== undefined) cleanup(first)
    })
    // Setup is a guarded API hook; each owner gets the normal assertion guard.
    for (const owner of ['first', 'sibling'] as const) {
      it(`rejects the tampered shared inode in the ${owner} view without repair`, async () => {
        const options = owner === 'first' ? first.options : sibling.options
        pending = checkEditorView(options)
        await expect(pending).rejects.toThrow('snapshot byte digest mismatch')
        pending = publishEditorView(options)
        await expect(pending).rejects.toMatchObject({
          message: expect.stringContaining('; publication workers='),
          cause: expect.objectContaining({
            message: expect.stringMatching(
              /^editor view: existing snapshot byte digest mismatch:/u,
            ),
          }),
        })
      })
    }
  })

  it('refuses garbage collection when snapshot ownership is ambiguous', async () => {
    const fixture = makeFixture()
    try {
      await publishEditorView(fixture.options)
      const current = currentTarget(fixture)
      mkdirSync(join(fixture.editorRoot, '.store', 'unowned'))
      await expect(publishEditorView(fixture.options)).rejects.toThrow(
        'snapshot store contains an ambiguously owned entry',
      )
      expect(currentTarget(fixture)).toBe(current)
    } finally {
      cleanup(fixture)
    }
  })

  it('leaves the old view current when byte snapshot creation fails before flip', async () => {
    const fixture = makeFixture()
    try {
      await publishEditorView(fixture.options)
      const oldTarget = currentTarget(fixture)
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
      await expect(publishEditorView({ ...fixture.options, cp: falseTool })).rejects.toThrow(
        'cp --dereference --reflink=auto failed',
      )
      expect(currentTarget(fixture)).toBe(oldTarget)
      expect(ownedSnapshots(fixture)).toHaveLength(1)
      expect(
        readdirSync(join(fixture.editorRoot, '.store')).some((name) =>
          name.startsWith('.candidate-'),
        ),
      ).toBe(false)
      await expect(checkEditorView(fixture.options)).rejects.toThrow(
        'editor_inputs fingerprint mismatch',
      )
    } finally {
      cleanup(fixture)
    }
  })

  it('rejects an existing lock and requires exact-token explicit recovery', async () => {
    const fixture = makeFixture()
    try {
      mkdirSync(fixture.editorRoot, { recursive: true })
      const lock = join(fixture.editorRoot, '.publish.lock')
      mkdirSync(lock)
      writeFileSync(
        join(lock, 'owner.json'),
        '{"schema":"effect-utils/editor-view-lock/v1","token":"held-token","pid":1}\n',
      )
      await expect(publishEditorView(fixture.options)).rejects.toThrow('publication lock exists')
      expect(() => recoverEditorViewLock({ options: fixture.options, token: 'wrong' })).toThrow(
        'token mismatch',
      )
      expect(() =>
        recoverEditorViewLock({ options: fixture.options, token: 'held-token' }),
      ).not.toThrow()
      await expect(publishEditorView(fixture.options)).resolves.toBeDefined()
    } finally {
      cleanup(fixture)
    }
  })

  it('publishes any admitted package identity and rejects mismatched identity', async () => {
    const fixture = makeFixture({ packageName: 'tui-react' })
    try {
      const record = await publishEditorView(fixture.options)
      expect(record.package).toBe('packages/@overeng/tui-react')
      expect(record.target).toBe('//packages/@overeng/tui-react:editor_inputs')
      expect(readlinkSync(join(fixture.packageDir, 'node_modules'))).toBe(
        '../../.editor-view/tui-react/node_modules',
      )
      expect(readlinkSync(join(fixture.editorRoot, 'tui-react'))).toBe(record.snapshot)
      expect(record.snapshot).toMatch(/^\.store\/tui-react-[0-9a-f]{64}$/u)
      await expect(checkEditorView(fixture.options)).resolves.toEqual(record)
      await expect(
        publishEditorView({
          ...fixture.options,
          target: '//packages/@overeng/other:editor_inputs',
        }),
      ).rejects.toThrow('target must be the stable label')
      await expect(
        publishEditorView({ ...fixture.options, viewName: 'tui.react' }),
      ).rejects.toThrow('view name must be a portable identifier')
    } finally {
      cleanup(fixture)
    }
  })

  it('rejects escaping and dangling current pointers with both fingerprints named', async () => {
    const escaping = makeFixture()
    try {
      const record = await publishEditorView(escaping.options)
      rmSync(join(escaping.editorRoot, 'tui-core'))
      symlinkSync('../../escape', join(escaping.editorRoot, 'tui-core'))
      await expect(checkEditorView(escaping.options)).rejects.toThrow(
        `recorded fingerprint=<invalid-pointer>; current fingerprint=${record.editorInputsFingerprint}`,
      )
    } finally {
      cleanup(escaping)
    }

    const dangling = makeFixture()
    try {
      const record = await publishEditorView(dangling.options)
      rmSync(join(dangling.editorRoot, 'tui-core'))
      symlinkSync(record.snapshot, join(dangling.editorRoot, 'tui-core'))
      makeWritable(join(dangling.editorRoot, record.snapshot))
      rmSync(join(dangling.editorRoot, record.snapshot), { recursive: true })
      const identity = storeName(record.snapshot).slice('tui-core-'.length)
      await expect(checkEditorView(dangling.options)).rejects.toThrow(
        `recorded fingerprint=${identity}; current fingerprint=${record.editorInputsFingerprint}`,
      )
    } finally {
      cleanup(dangling)
    }
  })

  it('names recorded and current hashes for descriptor mismatch and mutated snapshot', async () => {
    const mismatch = makeFixture()
    try {
      const record = await publishEditorView(mismatch.options)
      writeFileSync(join(mismatch.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
      const current = await canonicalTreeFingerprint({ tree: mismatch.editorInputs })
      await expect(checkEditorView(mismatch.options)).rejects.toThrow(
        `recorded fingerprint=${record.editorInputsFingerprint}; current fingerprint=${current}`,
      )
    } finally {
      cleanup(mismatch)
    }

    const mutated = makeFixture()
    try {
      const record = await publishEditorView(mutated.options)
      const snapshotNodeModules = join(mutated.editorRoot, record.snapshot, 'node_modules')
      chmodSync(snapshotNodeModules, 0o700)
      chmodSync(join(snapshotNodeModules, 'dep'), 0o700)
      rmSync(join(snapshotNodeModules, 'dep'), { recursive: true })
      chmodSync(snapshotNodeModules, 0o555)
      await expect(verifyEditorViewSnapshot(mutated.options)).rejects.toThrow(
        `snapshot byte digest mismatch`,
      )
      await expect(checkEditorView(mutated.options)).rejects.toThrow(
        `recorded fingerprint=${record.editorInputsFingerprint}; current fingerprint=${record.editorInputsFingerprint}`,
      )
    } finally {
      cleanup(mutated)
    }
  })

  it('refuses a store published by an earlier record schema', async () => {
    const fixture = makeFixture()
    try {
      await publishEditorView(fixture.options)
      const path = recordPath(fixture)
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      chmodSync(path, 0o600)
      writeFileSync(
        path,
        `${JSON.stringify({
          schema: 'effect-utils/editor-view/v1',
          package: record.package,
          cell: record.cell,
          target: record.target,
          editorInputsFingerprint: record.editorInputsFingerprint,
          snapshot: record.snapshot,
          nodeModulesTreeDigest: record.byteSnapshotDigest,
        })}\n`,
      )
      chmodSync(path, 0o444)
      await expect(verifyEditorViewSnapshot(fixture.options)).rejects.toThrow(
        'was published by incompatible editor view schema effect-utils/editor-view/v1',
      )
    } finally {
      cleanup(fixture)
    }
  })

  it('rejects unknown record fields and package paths containing symlink components', async () => {
    const malformed = makeFixture()
    try {
      await publishEditorView(malformed.options)
      const path = recordPath(malformed)
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      record.untrusted = true
      chmodSync(path, 0o600)
      writeFileSync(path, `${JSON.stringify(record)}\n`)
      await expect(checkEditorView(malformed.options)).rejects.toThrow(
        'record has unknown or missing fields',
      )
    } finally {
      cleanup(malformed)
    }

    const root = mkdtempSync(join(tmpdir(), 'editor-view-symlink-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'editor-view-symlink-outside-'))
    try {
      mkdirSync(join(outside, 'packages', '@overeng', 'tui-core'), { recursive: true })
      symlinkSync(join(outside, 'packages'), join(root, 'packages'))
      const options = {
        ...malformed.options,
        repoRoot: root,
        editorInputs: join(outside, 'inputs'),
        nodeModules: join(outside, 'node_modules'),
      }
      await expect(publishEditorView(options)).rejects.toThrow(
        'package path must not contain symbolic links',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('budget observations tolerate concurrent reader and worktree teardown', () => {
  it('tolerates a pin removed after lstat only in the preliminary inventory', () => {
    const fixture = makeFixture()
    const pins = join(fixture.editorRoot, '.pins')
    const pin = join(pins, 'vanishing-reader.json')
    mkdirSync(pins, { recursive: true })
    const record = {
      schema: 'effect-utils/editor-view-pin/v1',
      name: 'vanishing-reader',
      snapshot: `.store/${fixture.options.viewName}-${'a'.repeat(64)}`,
    }
    const nativeRead = nativeFs.readFileSync
    const read = fsMocks.readFileSync
    const vanishBeforeRead = () => {
      rmSync(pin)
      return nativeRead(pin, 'utf8')
    }
    try {
      writeFileSync(pin, JSON.stringify(record))
      read.mockImplementationOnce(vanishBeforeRead)
      expect(
        managedEditorViewSnapshots({ editorRoot: fixture.editorRoot, advisory: true }),
      ).toEqual(new Set())
      writeFileSync(pin, JSON.stringify(record))
      read.mockImplementationOnce(vanishBeforeRead)
      expect(() => managedEditorViewSnapshots({ editorRoot: fixture.editorRoot })).toThrow('ENOENT')
    } finally {
      read.mockReset().mockImplementation(nativeFs.readFileSync)
      cleanup(fixture)
    }
  })

  it('skips a Git worktree registration removed after the directory inventory', async () => {
    const fixture = makeFixture()
    const registrations = join(fixture.root, '.git', 'worktrees')
    const registration = join(registrations, 'vanishing-worktree')
    mkdirSync(registration, { recursive: true })
    writeFileSync(join(registration, 'gitdir'), `${join(fixture.root, 'gone', '.git')}\n`)
    const nativeReaddir = nativeFs.readdirSync
    let removed = false
    const scan = fsMocks.readdirSync.mockImplementation((...args) => {
      const entries = Reflect.apply(nativeReaddir, fs, args) as ReturnType<typeof fs.readdirSync>
      if (String(args[0]) === registrations && removed === false) {
        removed = true
        rmSync(registration, { recursive: true })
      }
      return entries
    })
    let publication: Promise<EditorViewRecord> | undefined
    try {
      publication = publishEditorView(fixture.options)
      const record = await publication
      expect(removed).toBe(true)
      expect(currentTarget(fixture)).toBe(record.snapshot)
    } finally {
      if (publication !== undefined) await Promise.allSettled([publication])
      scan.mockReset().mockImplementation(nativeFs.readdirSync)
      cleanup(fixture)
    }
  })

  it('skips an editor root removed after its worktree was resolved', async () => {
    const fixture = makeFixture()
    const registrations = join(fixture.root, '.git', 'worktrees')
    const registration = join(registrations, 'vanishing-root')
    const otherRepo = join(fixture.root, 'another-worktree')
    const otherRoot = join(otherRepo, 'packages', '.editor-view')
    mkdirSync(otherRoot, { recursive: true })
    mkdirSync(registration, { recursive: true })
    writeFileSync(join(registration, 'gitdir'), `${join(otherRepo, '.git')}\n`)
    const nativeLstat = nativeFs.lstatSync
    let removed = false
    const inspect = fsMocks.lstatSync.mockImplementation((...args) => {
      if (String(args[0]) === otherRoot && removed === false) {
        removed = true
        rmSync(otherRoot, { recursive: true })
      }
      return Reflect.apply(nativeLstat, fs, args) as ReturnType<typeof fs.lstatSync>
    })
    let publication: Promise<EditorViewRecord> | undefined
    try {
      publication = publishEditorView(fixture.options)
      const record = await publication
      expect(removed).toBe(true)
      expect(currentTarget(fixture)).toBe(record.snapshot)
    } finally {
      if (publication !== undefined) await Promise.allSettled([publication])
      inspect.mockReset().mockImplementation(nativeFs.lstatSync)
      cleanup(fixture)
    }
  })
})

describe('budget failures reject admission and preserve uncertain readers', () => {
  it.each(['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES'])(
    'propagates publication-lock %s without retrying',
    async (code) => {
      const fixture = makeFixture()
      const nativeMkdir = nativeFs.mkdirSync
      const injected = Object.assign(new Error(`injected ${code}`), { code })
      let attempts = 0
      const create = fsMocks.mkdirSync.mockImplementation((...args) => {
        if (String(args[0]) === join(fixture.editorRoot, '.publish.lock')) {
          attempts++
          // One failure makes the old busy loop terminate on its next attempt,
          // so this regression fails normally rather than hanging the test runner.
          if (attempts === 1) throw injected
        }
        return Reflect.apply(nativeMkdir, fs, args) as ReturnType<typeof fs.mkdirSync>
      })
      let publication: Promise<EditorViewRecord> | undefined
      try {
        publication = publishEditorView(fixture.options)
        await expect(publication).rejects.toThrow(`injected ${code}`)
        expect(attempts).toBe(1)
        expect(existsSync(join(fixture.editorRoot, '.publish.lock'))).toBe(false)
      } finally {
        if (publication !== undefined) await Promise.allSettled([publication])
        create.mockReset().mockImplementation(nativeFs.mkdirSync)
        cleanup(fixture)
      }
    },
  )

  describe.each(['ENOTDIR', 'EACCES', 'ELOOP'])('uncertain sibling discovery %s', (code) => {
    let incoming: Fixture
    let victim: Fixture
    let held: EditorViewRecord
    let publication: Promise<EditorViewRecord> | undefined
    let restoreHostBudget: () => void

    beforeAll(async () => {
      restoreHostBudget = isolateHostBudget()
      incoming = makeFixture()
      victim = makeFixture()
      victim = {
        ...victim,
        options: {
          ...victim.options,
          contentStore: join(incoming.root, '.editor-view-content', 'v1'),
        },
      }
      held = await publishEditorView(victim.options)
      const registration = join(incoming.root, '.git', 'worktrees', 'uncertain-sibling')
      mkdirSync(registration, { recursive: true })
      writeFileSync(join(registration, 'gitdir'), `${join(victim.root, '.git')}\n`)
    })
    afterAll(async () => {
      if (publication !== undefined) await Promise.allSettled([publication])
      cleanup(victim)
      cleanup(incoming)
      restoreHostBudget()
    })

    it('propagates discovery uncertainty before admission without evicting any generation', async () => {
      const nativeLstat = nativeFs.lstatSync
      const injected = Object.assign(new Error(`unobserved ${code}`), { code })
      let observations = 0
      const inspect = fsMocks.lstatSync.mockImplementation((...args) => {
        if (String(args[0]) === victim.editorRoot) {
          observations++
          throw injected
        }
        return Reflect.apply(nativeLstat, fs, args) as ReturnType<typeof fs.lstatSync>
      })
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1_000)
      let materialized = false
      try {
        publication = publishEditorView({
          ...incoming.options,
          hostBudgetBytes: 1,
          beforeMaterialize: () => {
            materialized = true
          },
        })
        await expect(publication).rejects.toThrow(`unobserved ${code}`)
        expect(observations).toBeGreaterThan(0)
        expect(existsSync(join(incoming.editorRoot, incoming.options.viewName))).toBe(false)
        expect(currentTarget(victim)).toBe(held.snapshot)
        expect(materialized).toBe(false)
        expect(existsSync(join(incoming.editorRoot, '.publish.lock'))).toBe(false)
      } finally {
        if (publication !== undefined) await Promise.allSettled([publication])
        clock.mockRestore()
        inspect.mockReset().mockImplementation(nativeFs.lstatSync)
      }
    })
  })

  describe('cleanup after the pointer commit is advisory', () => {
    let fixture: Fixture
    let publication: Promise<EditorViewRecord> | undefined
    let revision = 0
    beforeAll(() => {
      fixture = makeFixture()
    })
    afterAll(async () => {
      if (publication !== undefined) await Promise.allSettled([publication])
      cleanup(fixture)
    })
    for (const next of [1, 2]) {
      it(`prepares retained generation ${next}`, async () => {
        expect(revision).toBe(next - 1)
        writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), `${next}\n`)
        publication = publishEditorView(fixture.options)
        await publication
        revision = next
      })
    }
    it('logs cleanup failure and still returns the committed generation', async () => {
      expect(revision).toBe(2)
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), 'third\n')
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      let cleanupEntered = false
      try {
        publication = publishEditorView({
          ...fixture.options,
          beforeSnapshotCleanup: () => {
            cleanupEntered = true
            throw new Error('injected post-commit cleanup error')
          },
        })
        const record = await publication
        expect(cleanupEntered).toBe(true)
        expect(currentTarget(fixture)).toBe(record.snapshot)
        expect(
          log.mock.calls.some(
            ([line]) =>
              String(line).includes('"phase":"snapshot-cleanup"') &&
              String(line).includes('injected post-commit cleanup error'),
          ),
        ).toBe(true)
      } finally {
        if (publication !== undefined) await Promise.allSettled([publication])
        log.mockRestore()
      }
    })
  })
})

describe('budget victim teardown after the census', () => {
  let incoming: Fixture
  let victim: Fixture
  let publication: Promise<EditorViewRecord> | undefined
  let restoreHostBudget: () => void
  beforeAll(async () => {
    restoreHostBudget = isolateHostBudget()
    incoming = makeFixture()
    const original = makeFixture()
    victim = {
      ...original,
      options: {
        ...original.options,
        contentStore: join(incoming.root, '.editor-view-content', 'v1'),
      },
    }
    await publishEditorView(victim.options)
  })
  afterAll(async () => {
    if (publication !== undefined) await Promise.allSettled([publication])
    if (existsSync(victim.root) === true) cleanup(victim)
    cleanup(incoming)
    restoreHostBudget()
  })
  it('skips a clear victim removed immediately before acquiring its eviction fence', async () => {
    const nativeMkdir = nativeFs.mkdirSync
    let removed = false
    const create = fsMocks.mkdirSync.mockImplementation((...args) => {
      if (String(args[0]) === join(victim.editorRoot, '.publish.lock') && removed === false) {
        removed = true
        cleanup(victim)
      }
      return Reflect.apply(nativeMkdir, fs, args) as ReturnType<typeof fs.mkdirSync>
    })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1_000)
    try {
      publication = publishEditorView({ ...incoming.options, hostBudgetBytes: 1 })
      await expect(publication).rejects.toMatchObject({
        name: 'EditorViewCapacityError',
        code: 'EDITOR_VIEW_CAPACITY',
        budgetBytes: 1,
      })
      expect(removed).toBe(true)
      expect(existsSync(join(incoming.editorRoot, incoming.options.viewName))).toBe(false)
      expect(existsSync(victim.root)).toBe(false)
    } finally {
      if (publication !== undefined) await Promise.allSettled([publication])
      clock.mockRestore()
      create.mockReset().mockImplementation(nativeFs.mkdirSync)
    }
  })
})

describe('same-host abandoned publication lock recovery', () => {
  const writeOwner = ({
    fixture,
    pid,
    processIdentity,
    host = hostname(),
  }: {
    readonly fixture: Fixture
    readonly pid: number
    readonly processIdentity: string
    readonly host?: string
  }): string => {
    const lock = join(fixture.editorRoot, '.publish.lock')
    mkdirSync(lock, { recursive: true })
    const owner = JSON.stringify({
      schema: 'effect-utils/editor-view-lock/v1',
      token: 'abandoned-owner',
      pid,
      host,
      process: processIdentity,
    })
    writeFileSync(join(lock, 'owner.json'), owner)
    return owner
  }

  describe('a killed publisher process', () => {
    let fixture: Fixture
    let child: ChildProcess.ChildProcess | undefined
    let publication: Promise<EditorViewRecord> | undefined
    let exited: Promise<void> | undefined
    let deadPid: number
    beforeAll(async () => {
      fixture = makeFixture()
      const ready = Promise.withResolvers<void>()
      child = ChildProcess.spawn(
        requireTool('BUN_BIN'),
        ['--eval', 'process.stdout.write("ready\\n"); process.stdin.resume()'],
        {
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      )
      child.once('error', ready.reject)
      child.stdout!.once('data', () => ready.resolve())
      const closed = Promise.withResolvers<void>()
      exited = closed.promise
      child.once('close', () => closed.resolve())
      await ready.promise
      if (child.pid === undefined) throw new Error('reader process has no pid')
      deadPid = child.pid
      const processIdentity = editorViewStagingCreatorIdentity({ pid: deadPid })
      expect(processIdentity).not.toBe('unknown')
      expect(processIdentity).not.toBe('dead')
      writeOwner({ fixture, pid: deadPid, processIdentity })
      child.kill('SIGKILL')
      await exited
      expect(() => process.kill(deadPid, 0)).toThrow()
    })
    afterAll(async () => {
      if (child !== undefined && child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
      if (exited !== undefined) await exited
      if (publication !== undefined) await Promise.allSettled([publication])
      cleanup(fixture)
    })
    it('recovers the dead owner through exact-token recovery and publishes', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        publication = publishEditorView({
          ...fixture.options,
          beforeMaterialize: () => {
            expect(
              JSON.parse(
                readFileSync(join(fixture.editorRoot, '.publish.lock', 'owner.json'), 'utf8'),
              ),
            ).toMatchObject({
              pid: process.pid,
              host: hostname(),
              process: editorViewStagingCreatorIdentity({ pid: process.pid }),
            })
          },
        })
        const record = await publication
        expect(currentTarget(fixture)).toBe(record.snapshot)
        expect(existsSync(join(fixture.editorRoot, '.publish.lock'))).toBe(false)
        expect(
          log.mock.calls.some(
            ([line]) =>
              String(line).includes('"event":"editor-view.publication-lock.recovered"') &&
              String(line).includes('"reason":"dead-pid"') &&
              String(line).includes(`"pid":${deadPid}`),
          ),
        ).toBe(true)
      } finally {
        if (publication !== undefined) await Promise.allSettled([publication])
        log.mockRestore()
      }
    })
  })

  it('recovers a reused pid only when its recorded start incarnation differs', async () => {
    const fixture = makeFixture()
    const observed = editorViewStagingCreatorIdentity({ pid: process.pid })
    expect(observed).not.toBe('unknown')
    expect(observed).not.toBe('dead')
    writeOwner({ fixture, pid: process.pid, processIdentity: `${observed}-previous-start` })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let publication: Promise<EditorViewRecord> | undefined
    try {
      publication = publishEditorView(fixture.options)
      const record = await publication
      expect(currentTarget(fixture)).toBe(record.snapshot)
      expect(log.mock.calls.some(([line]) => String(line).includes('"reason":"reused-pid"'))).toBe(
        true,
      )
    } finally {
      if (publication !== undefined) await Promise.allSettled([publication])
      log.mockRestore()
      cleanup(fixture)
    }
  })

  it.each(['live', 'foreign-host', 'unknown-incarnation'])(
    'preserves the %s owner and explicit recovery failure',
    async (kind) => {
      const fixture = makeFixture()
      const owner = writeOwner({
        fixture,
        pid: process.pid,
        processIdentity:
          kind === 'unknown-incarnation'
            ? 'unknown'
            : editorViewStagingCreatorIdentity({ pid: process.pid }),
        host: kind === 'foreign-host' ? `${hostname()}-another-host` : hostname(),
      })
      let publication: Promise<EditorViewRecord> | undefined
      try {
        publication = publishEditorView(fixture.options)
        await expect(publication).rejects.toThrow('publication lock exists')
        expect(readFileSync(join(fixture.editorRoot, '.publish.lock', 'owner.json'), 'utf8')).toBe(
          owner,
        )
      } finally {
        if (publication !== undefined) await Promise.allSettled([publication])
        cleanup(fixture)
      }
    },
  )
})

describe('publication startup orphan reclamation', () => {
  type PausedPublisher = {
    readonly child: ChildProcess.ChildProcess
    readonly ready: Promise<void>
    readonly kill: () => Promise<void>
  }
  /** A real publisher holds its own lock and reservation until the parent kills it. */
  const pausedPublisher = ({
    fixture,
    hook,
  }: {
    readonly fixture: Fixture
    readonly hook: 'beforeMaterialize' | 'beforeSnapshotCleanup'
  }): PausedPublisher => {
    const ready = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    let output = ''
    let errors = ''
    const child = ChildProcess.spawn(
      requireTool('BUN_BIN'),
      [
        '--eval',
        `import { publishEditorView } from ${JSON.stringify(new URL('./editor-view.ts', import.meta.url).href)};
import { editorViewProcessTestScope } from ${JSON.stringify(new URL('./editor-view-readers.ts', import.meta.url).href)};
await editorViewProcessTestScope.run(() => [process.pid, ...${JSON.stringify([...fixtureProcessIds])}], async () => publishEditorView({
  ...${JSON.stringify(fixture.options)},
  backingRoots: ${JSON.stringify([fixture.nodeModules])},
  ${hook}: async () => {
    process.stdout.write("publisher-paused\\n");
    process.stdin.resume();
    await Promise.withResolvers().promise;
  },
}));`,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    child.once('error', ready.reject)
    child.stdout!.on('data', (chunk) => {
      output += String(chunk)
      if (output.includes('publisher-paused\n') === true) ready.resolve()
    })
    child.stderr!.on('data', (chunk) => {
      errors += String(chunk)
    })
    child.once('close', (code, signal) => {
      ready.reject(
        new Error(`publisher exited before its barrier: code=${code} signal=${signal}\n${errors}`),
      )
      closed.resolve()
    })
    return {
      child,
      ready: ready.promise,
      kill: async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await closed.promise
      },
    }
  }

  it('reclaims a real SIGKILLed publisher candidate before preparing the next candidate', async () => {
    const fixture = makeFixture()
    const restoreHostBudget = isolateHostBudget()
    const publisher = pausedPublisher({ fixture, hook: 'beforeMaterialize' })
    let publication: Promise<EditorViewRecord> | undefined
    try {
      await publisher.ready
      const candidates = readdirSync(join(fixture.editorRoot, '.store')).filter((name) =>
        name.startsWith('.candidate-'),
      )
      expect(candidates).toHaveLength(1)
      const abandoned = join(fixture.editorRoot, '.store', candidates[0]!)
      const owner = JSON.parse(
        readFileSync(join(fixture.editorRoot, '.publish.lock', 'owner.json'), 'utf8'),
      )
      expect(owner.pid).toBe(publisher.child.pid)
      expect(owner.process).toBe(editorViewStagingCreatorIdentity({ pid: publisher.child.pid! }))
      await publisher.kill()
      expect(publisher.child.signalCode).toBe('SIGKILL')
      expect(existsSync(abandoned)).toBe(true)
      let prepared = false
      publication = publishEditorView({
        ...fixture.options,
        backingRoots: [fixture.nodeModules],
        beforeMaterialize: () => {
          prepared = true
          expect(existsSync(abandoned)).toBe(false)
          expect(
            readdirSync(join(fixture.editorRoot, '.store')).filter((name) =>
              name.startsWith('.candidate-'),
            ),
          ).toHaveLength(1)
        },
      })
      const record = await publication
      expect(prepared).toBe(true)
      expect(currentTarget(fixture)).toBe(record.snapshot)
      expect(existsSync(join(fixture.editorRoot, '.publish.lock'))).toBe(false)
      await expect(
        checkEditorView({ ...fixture.options, backingRoots: [fixture.nodeModules] }),
      ).resolves.toEqual(record)
    } finally {
      await publisher.kill()
      if (publication !== undefined) await Promise.allSettled([publication])
      cleanup(fixture)
      restoreHostBudget()
    }
  })

  it('budget eviction recovers a SIGKILLed publisher lock and reclaims its candidate', async () => {
    const fixture = makeFixture()
    const pressure = makeFixture()
    const restoreHostBudget = isolateHostBudget()
    const publisher = pausedPublisher({ fixture, hook: 'beforeMaterialize' })
    let pressureLock: EditorViewBudgetRootLock | undefined
    try {
      await publisher.ready
      const candidateName = readdirSync(join(fixture.editorRoot, '.store')).find((name) =>
        name.startsWith('.candidate-'),
      )!
      const candidate = join(fixture.editorRoot, '.store', candidateName)
      const ownerPath = join(fixture.editorRoot, '.publish.lock', 'owner.json')
      const owner = readFileSync(ownerPath, 'utf8')
      expect(
        await tryAcquireEditorViewBudgetRootLock({
          repoRoot: fixture.root,
          editorRoot: fixture.editorRoot,
        }),
      ).toBeUndefined()
      expect(readFileSync(ownerPath, 'utf8')).toBe(owner)
      expect(existsSync(candidate)).toBe(true)
      await publisher.kill()
      expect(publisher.child.signalCode).toBe('SIGKILL')
      mkdirSync(join(pressure.editorRoot, '.store'), { recursive: true })
      const pressureRoot = { repoRoot: pressure.root, editorRoot: pressure.editorRoot }
      pressureLock = await tryAcquireEditorViewBudgetRootLock(pressureRoot)
      expect(pressureLock).toBeDefined()
      await expect(
        reserveEditorViewBudget({
          contentStore: fixture.options.contentStore!,
          root: pressureRoot,
          heldEditorRoot: pressure.editorRoot,
          discoverRoots: () => [{ repoRoot: fixture.root, editorRoot: fixture.editorRoot }],
          tryLockRoot: tryAcquireEditorViewBudgetRootLock,
          reservationBytes: 1,
          budgetBytes: 1,
        }),
      ).rejects.toMatchObject({ name: 'EditorViewCapacityError', code: 'EDITOR_VIEW_CAPACITY' })
      expect(existsSync(candidate)).toBe(false)
      expect(existsSync(join(fixture.editorRoot, '.publish.lock'))).toBe(false)
      expect(readdirSync(join(fixture.editorRoot, '.store'))).toEqual([])
    } finally {
      await publisher.kill()
      pressureLock?.release()
      cleanup(pressure)
      cleanup(fixture)
      restoreHostBudget()
    }
  })

  it('excludes a concurrent publisher without touching the live publisher candidate or lock', async () => {
    const fixture = makeFixture()
    const restoreHostBudget = isolateHostBudget()
    const publisher = pausedPublisher({ fixture, hook: 'beforeMaterialize' })
    try {
      await publisher.ready
      const store = join(fixture.editorRoot, '.store')
      const candidates = readdirSync(store)
      const ownerPath = join(fixture.editorRoot, '.publish.lock', 'owner.json')
      const owner = readFileSync(ownerPath, 'utf8')
      const candidate = join(
        store,
        candidates.find((name) => name.startsWith('.candidate-'))!,
      )
      const identity = statSync(candidate, { bigint: true })
      await expect(publishEditorView(fixture.options)).rejects.toThrow('publication lock exists')
      expect(readFileSync(ownerPath, 'utf8')).toBe(owner)
      expect(readdirSync(store)).toEqual(candidates)
      expect(statSync(candidate, { bigint: true }).ino).toBe(identity.ino)
      expect(() => process.kill(publisher.child.pid!, 0)).not.toThrow()
    } finally {
      await publisher.kill()
      cleanup(fixture)
      restoreHostBudget()
    }
  })

  it('converges after SIGKILL interrupts renamed snapshot garbage cleanup', async () => {
    const fixture = makeFixture()
    const restoreHostBudget = isolateHostBudget()
    const options = { ...fixture.options, backingRoots: [fixture.nodeModules] }
    let publisher: PausedPublisher | undefined
    try {
      await publishEditorView(options)
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), 'second\n')
      await publishEditorView(options)
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), 'third\n')
      publisher = pausedPublisher({ fixture, hook: 'beforeSnapshotCleanup' })
      await publisher.ready
      const garbage = readdirSync(fixture.editorRoot).filter((name) => name.startsWith('.gc-'))
      expect(garbage.length).toBeGreaterThan(0)
      const committed = currentTarget(fixture)
      await publisher.kill()
      for (const name of garbage) expect(existsSync(join(fixture.editorRoot, name))).toBe(true)
      const record = await publishEditorView(options)
      expect(record.snapshot).toBe(committed)
      expect(readdirSync(fixture.editorRoot).filter((name) => name.startsWith('.gc-'))).toEqual([])
      await expect(checkEditorView(options)).resolves.toEqual(record)
    } finally {
      await publisher?.kill()
      cleanup(fixture)
      restoreHostBudget()
    }
  })

  it('protects a candidate while its root has a live budget reservation and reclaims it after cancellation', async () => {
    const fixture = makeFixture()
    const restoreHostBudget = isolateHostBudget()
    let token: string | undefined
    try {
      const record = await publishEditorView(fixture.options)
      const root = { repoRoot: fixture.root, editorRoot: fixture.editorRoot }
      const reservation = await reserveEditorViewBudget({
        contentStore: fixture.options.contentStore!,
        root,
        reservationBytes: 1,
        heldEditorRoot: fixture.editorRoot,
        discoverRoots: () => [root],
        tryLockRoot: () => {
          throw new Error('a roomy reservation must not try to evict another root')
        },
        budgetBytes: fixture.options.hostBudgetBytes!,
      })
      token = reservation.token
      const candidate = join(fixture.editorRoot, '.store', '.candidate-live-reservation')
      mkdirSync(candidate)
      const payload = join(candidate, 'partial')
      writeFileSync(payload, 'in progress\n')
      const before = statSync(payload, { bigint: true })
      expect(await publishEditorView(fixture.options)).toEqual(record)
      expect(readFileSync(payload, 'utf8')).toBe('in progress\n')
      expect(statSync(payload, { bigint: true }).ino).toBe(before.ino)
      await cancelEditorViewBudgetReservation({
        contentStore: fixture.options.contentStore!,
        token,
      })
      token = undefined
      expect(await publishEditorView(fixture.options)).toEqual(record)
      expect(existsSync(candidate)).toBe(false)
    } finally {
      if (token !== undefined)
        await cancelEditorViewBudgetReservation({
          contentStore: fixture.options.contentStore!,
          token,
        })
      cleanup(fixture)
      restoreHostBudget()
    }
  })

  for (const kind of ['candidate', 'gc', 'legacy'] as const) {
    describe(`preserves pointer-reached ${kind} payload bytes and modes until its reader releases the pointer`, () => {
      let fixture: Fixture
      let restoreHostBudget: () => void
      let record: EditorViewRecord
      let retained: string
      let payload: string
      let pointer: string
      let rootPointer: string
      let before: fs.BigIntStats
      let directoryBefore: fs.BigIntStats
      let bytes: Buffer
      let pending: Promise<void> = Promise.resolve()

      beforeAll(() => {
        fixture = makeFixture()
        restoreHostBudget = isolateHostBudget()
      })
      afterAll(async () => {
        // Keep the fixture alive through a timed-out phase, including its assertions.
        await Promise.allSettled([pending])
        if (fixture !== undefined) cleanup(fixture)
        restoreHostBudget?.()
      })

      it('prepares the retained payload', () => {
        pending = pending.then(async () => {
          record = await publishEditorView(fixture.options)
          retained =
            kind === 'legacy'
              ? join(
                  fixture.editorRoot,
                  '.legacy',
                  readdirSync(join(fixture.editorRoot, '.legacy'))[0]!,
                )
              : join(
                  fixture.editorRoot,
                  ...(kind === 'candidate' ? ['.store', '.candidate-reader'] : ['.gc-reader']),
                )
          if (kind !== 'legacy') mkdirSync(retained)
          payload = join(retained, kind === 'legacy' ? 'legacy-root-install' : 'partial')
          if (kind !== 'legacy') writeFileSync(payload, 'reader-owned bytes\n')
          chmodSync(payload, 0o444)
          chmodSync(retained, 0o555)
          before = statSync(payload, { bigint: true })
          directoryBefore = statSync(retained, { bigint: true })
          bytes = readFileSync(payload)
          const reader = join(fixture.root, 'packages', '@overeng', 'retained-reader')
          mkdirSync(reader)
          pointer = join(reader, 'node_modules')
          rootPointer = join(fixture.editorRoot, '.retained-reader')
        })
        return pending
      })

      it('preserves bytes and metadata while the package pointer reaches the payload', () => {
        pending = pending.then(async () => {
          symlinkSync(retained, pointer)
          expect(await publishEditorView(fixture.options)).toEqual(record)
          expect(
            readFileSync(join(pointer, kind === 'legacy' ? 'legacy-root-install' : 'partial')),
          ).toEqual(bytes)
          const after = statSync(payload, { bigint: true })
          expect([after.dev, after.ino, after.mode, after.mtimeNs, after.ctimeNs]).toEqual([
            before.dev,
            before.ino,
            before.mode,
            before.mtimeNs,
            before.ctimeNs,
          ])
          const directoryAfter = statSync(retained, { bigint: true })
          expect([directoryAfter.ino, directoryAfter.mode, directoryAfter.ctimeNs]).toEqual([
            directoryBefore.ino,
            directoryBefore.mode,
            directoryBefore.ctimeNs,
          ])
        })
        return pending
      })

      it('preserves the payload after the reader moves to a root pointer', () => {
        pending = pending.then(async () => {
          symlinkSync(retained, rootPointer)
          rmSync(pointer)
          expect(await publishEditorView(fixture.options)).toEqual(record)
          expect(readFileSync(payload)).toEqual(bytes)
          expect(statSync(payload, { bigint: true }).ino).toBe(before.ino)
          expect(statSync(payload, { bigint: true }).mode).toBe(before.mode)
        })
        return pending
      })

      it('reclaims the payload after the reader releases its final pointer', () => {
        pending = pending.then(async () => {
          rmSync(rootPointer)
          expect(await publishEditorView(fixture.options)).toEqual(record)
          expect(existsSync(retained)).toBe(false)
        })
        return pending
      })

      it('checks the published view after reclamation', () => {
        pending = pending.then(async () => {
          await expect(checkEditorView(fixture.options)).resolves.toEqual(record)
        })
        return pending
      })
    })
  }

  it('keeps orphan payloads when a pointer input is unreadable', async () => {
    const fixture = makeFixture()
    const restoreHostBudget = isolateHostBudget()
    try {
      const record = await publishEditorView(fixture.options)
      const candidate = join(fixture.editorRoot, '.store', '.candidate-unreadable-reader')
      mkdirSync(candidate)
      writeFileSync(join(candidate, 'partial'), 'must remain until pointer inspection succeeds\n')
      const pointer = join(fixture.editorRoot, '.unreadable-reader')
      symlinkSync(candidate, pointer)
      const inspect = fsMocks.lstatSync.mockImplementation((...args) => {
        if (String(args[0]) === pointer)
          throw Object.assign(new Error('unreadable orphan pointer'), { code: 'EACCES' })
        return nativeFs.lstatSync(...args)
      })
      try {
        expect(await publishEditorView(fixture.options)).toEqual(record)
        expect(readFileSync(join(candidate, 'partial'), 'utf8')).toBe(
          'must remain until pointer inspection succeeds\n',
        )
      } finally {
        inspect.mockReset().mockImplementation(nativeFs.lstatSync)
      }
      rmSync(pointer)
      expect(await publishEditorView(fixture.options)).toEqual(record)
      expect(existsSync(candidate)).toBe(false)
    } finally {
      cleanup(fixture)
      restoreHostBudget()
    }
  })
})
