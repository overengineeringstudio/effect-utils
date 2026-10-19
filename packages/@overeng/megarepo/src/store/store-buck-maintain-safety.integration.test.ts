import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { encodeJson } from '../test-utils/mod.ts'
import { runBuckMaintain } from './store-buck-maintain.ts'
import { WORKSPACE_ACTIVITY_V2_SCHEMA } from './store-workspace-activity.ts'

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

// All executable fixtures and the synthetic proc tree live in the scoped temp store.
// Only the kernel process-table boundary is substituted; Git, leases, manifests,
// command spawning, project-root discovery, and the maintenance runner stay real.
const makeFixture = Effect.fn('test.buckMaintainSafety.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem
  const store = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
  const source = join(store, 'source')
  const roots = join(store, 'refs', 'heads')
  const bin = join(store, 'bin')
  const duCalls = join(store, 'du-calls')
  const nativeCalls = join(store, 'native-calls')
  const measured = join(store, 'measured')
  const manifestPath = join(store, 'activity.json')
  const configPath = join(store, 'maintain.json')
  const agentsPath = join(store, 'agents.json')
  const subjectPath = join(store, 'subject.json')
  yield* fs.makeDirectory(bin, { recursive: true })
  yield* fs.makeDirectory(source)
  yield* fs.writeFileString(duCalls, '')
  yield* fs.writeFileString(nativeCalls, '')
  yield* Effect.sync(() => {
    execFileSync('git', ['init', source])
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ])
  })
  const executable = Effect.fn('test.buckMaintainSafety.executable')(function* (
    name: string,
    body: string,
  ) {
    const path = join(bin, name)
    yield* fs.writeFileString(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 })
    return path
  })
  yield* executable(
    'du',
    `printf '%s\\n' "$*" >> ${shellQuote(duCalls)}\n: > ${shellQuote(measured)}\nprintf '8192\\tfixture\\n'`,
  )
  // A native-command spy: any accidentally admitted clean remains observable.
  const buck = yield* executable('buck2', `printf '%s\\n' "$*" >> ${shellQuote(nativeCalls)}`)
  yield* fs.makeDirectory(join(store, 'libexec'))
  yield* fs.symlink(buck, join(store, 'libexec', 'buck2'))
  const st3 = yield* executable(
    'st3',
    `case "$1" in\n  agents) cat ${shellQuote(agentsPath)} ;;\n  subject) cat ${shellQuote(subjectPath)} ;;\n  *) exit 1 ;;\nesac`,
  )
  const pty = yield* executable('pty', "printf '[]\\n'")
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const values = {
        MEGAREPO_STORE: store,
        ST_AGENT: 'seat/a',
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        BUCK2_BIN: buck,
        MEGAREPO_GC_ST3_BIN: st3,
        MEGAREPO_GC_PTY_BIN: pty,
      }
      const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
      Object.assign(process.env, values)
      return saved
    }),
    (saved) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
  const writeAgents = (items: readonly { id: string; state: string }[]) =>
    fs.writeFileString(
      agentsPath,
      encodeJson({
        api_version: 'st3.client.v0',
        snapshot: {
          id: 'fixture',
          host_id: `host/${hostname()}`,
          created_at: '2020-01-01T00:00:00.000Z',
          store_index: 1,
        },
        value: {
          kind: 'page',
          collection: 'agents',
          items,
          page: { has_more: false, next_cursor: null },
        },
      }),
    )
  yield* writeAgents([])
  const writeManifest = (
    claims: readonly { workspace: string; owner: string; active: boolean }[],
  ) =>
    fs.writeFileString(
      manifestPath,
      encodeJson({
        schemaVersion: WORKSPACE_ACTIVITY_V2_SCHEMA,
        producer: { name: 'maintenance-safety-fixture', version: '1' },
        epoch: { host: hostname(), snapshotId: 'fixture', storeIndex: 1 },
        capturedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        complete: true,
        errors: [],
        claims: claims.map(({ workspace, owner, active }) => ({
          workspace,
          sources: ['st3-seat'],
          agents: [owner],
          activeRuntimeIds: [],
          active,
        })),
      }),
    )
  yield* writeManifest([])
  yield* fs.makeDirectory(join(store, '.state'), { recursive: true })
  yield* fs.writeFileString(
    join(store, '.state', 'gc-config.json'),
    encodeJson({
      generatedArtifacts: {
        manifestPath,
        agentLivenessProducers: ['maintenance-safety-fixture'],
        builtin: false,
      },
    }),
  )
  yield* fs.writeFileString(
    configPath,
    encodeJson({
      version: 1,
      worktreeRoots: [roots],
      buckOut: { budgetBytes: 0, keepSince: '0s' },
      maintainOwners: ['seat/a'],
      maintainUnowned: true,
    }),
  )
  const addWorktree = Effect.fn('test.buckMaintainSafety.worktree')(function* (
    name: string,
    ownBuckRoot = true,
  ) {
    const path = join(roots, name)
    yield* Effect.sync(() =>
      execFileSync('git', ['-C', source, 'worktree', 'add', '--detach', path, 'HEAD']),
    )
    if (ownBuckRoot === true) {
      yield* fs.writeFileString(join(path, '.buckroot'), '')
      yield* fs.writeFileString(join(path, '.buckconfig'), '[cells]\n  root = .\n')
    }
    yield* fs.makeDirectory(join(path, 'buck-out', 'v2'), { recursive: true })
    yield* fs.writeFileString(join(path, 'buck-out', 'v2', 'retained-output'), 'must survive')
    return path
  })
  const idleFs: FileSystem.FileSystem = {
    ...fs,
    readDirectory: (path, options) =>
      path === '/proc' ? Effect.succeed([]) : fs.readDirectory(path, options),
  }
  const run = (boundary = idleFs) =>
    runBuckMaintain({ configPath, dryRun: false }).pipe(
      Effect.provideService(FileSystem.FileSystem, boundary),
    )
  const expectNoCommands = Effect.fn('test.buckMaintainSafety.noCommands')(function* () {
    expect(yield* fs.readFileString(duCalls)).toBe('')
    expect(yield* fs.readFileString(nativeCalls)).toBe('')
  })
  return {
    fs,
    store,
    source,
    roots,
    configPath,
    duCalls,
    nativeCalls,
    measured,
    st3,
    subjectPath,
    addWorktree,
    writeAgents,
    writeManifest,
    idleFs,
    run,
    expectNoCommands,
  }
})

it.live('vetoes a complete unrelated holder first observed after output measurement', () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    const { fs, store, measured, idleFs } = fixture
    const worktree = yield* fixture.addWorktree('holder-arrives')
    const pid = 2_000_000_001
    const procRoot = join(store, 'synthetic-proc')
    yield* fs.makeDirectory(join(procRoot, 'fd'), { recursive: true })
    // PPID 0 deliberately makes this unrelated to the test runner, whose children
    // the production census correctly excludes. The lifetime is stable on reread.
    yield* fs.writeFileString(
      join(procRoot, 'stat'),
      `${pid} (fixture-holder) S 0 ${pid} ${pid} 0 -1 4194560 ${'0 '.repeat(12)}12345`,
    )
    yield* fs.writeFileString(
      join(procRoot, 'status'),
      `Name:\tfixture-holder\nPPid:\t0\nUid:\t${process.getuid?.() ?? 0}\t${process.getuid?.() ?? 0}\t${process.getuid?.() ?? 0}\t${process.getuid?.() ?? 0}\n`,
    )
    yield* fs.writeFileString(join(procRoot, 'environ'), 'ST_AGENT=seat/a\0')
    yield* fs.writeFileString(join(procRoot, 'cmdline'), 'fixture-holder\0')
    yield* fs.writeFileString(join(procRoot, 'maps'), '')
    yield* fs.symlink(worktree, join(procRoot, 'cwd'))
    yield* fs.symlink('/', join(procRoot, 'root'))
    yield* fs.symlink('/bin/sh', join(procRoot, 'exe'))
    const prefix = `/proc/${pid}/`
    const mapProc = (path: string) =>
      path.startsWith(prefix) === true ? join(procRoot, path.slice(prefix.length)) : path
    let observedAfterMeasurement = false
    const boundary: FileSystem.FileSystem = {
      ...idleFs,
      readDirectory: (path, options) =>
        path === '/proc'
          ? fs.exists(measured).pipe(
              Effect.map((exists) => {
                if (exists === true) observedAfterMeasurement = true
                return exists === true ? [String(pid)] : []
              }),
            )
          : fs.readDirectory(mapProc(path), options),
      readFileString: (path, options) => fs.readFileString(mapProc(path), options),
      readLink: (path) => fs.readLink(mapProc(path)),
    }
    const receipt = yield* fixture.run(boundary)
    expect(observedAfterMeasurement).toBe(true)
    expect(receipt.entries).toHaveLength(1)
    expect(receipt.entries[0]).toMatchObject({
      worktree,
      action: 'none',
      reason: 'holder-live',
      bytesBefore: 8192,
      bytesAfter: 8192,
    })
    expect((yield* fs.readFileString(fixture.duCalls)).trim().split('\n')).toHaveLength(1)
    expect(yield* fs.readFileString(fixture.nativeCalls)).toBe('')
    expect(yield* fs.readFileString(join(worktree, 'buck-out/v2/retained-output'))).toBe(
      'must survive',
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live(
  'skips locked, foreign-owned, and actively claimed worktrees before any du invocation',
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const locked = yield* fixture.addWorktree('locked')
      const foreign = yield* fixture.addWorktree('foreign')
      const active = yield* fixture.addWorktree('active')
      yield* Effect.sync(() =>
        execFileSync('git', ['-C', fixture.source, 'worktree', 'lock', locked]),
      )
      yield* fixture.writeManifest([
        { workspace: foreign, owner: 'seat/foreign', active: false },
        { workspace: active, owner: 'seat/a', active: true },
      ])
      const receipt = yield* fixture.run()
      expect(receipt.entries).toHaveLength(3)
      for (const [worktree, reason] of [
        [locked, 'git-locked'],
        [foreign, 'foreign-owner'],
        [active, 'active-claim'],
      ]) {
        expect(receipt.entries.find((entry) => entry.worktree === worktree)).toMatchObject({
          action: 'none',
          reason,
          bytesBefore: null,
          bytesAfter: null,
        })
      }
      yield* fixture.expectNoCommands()
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('treats a missing Git activity file as unknown before measuring output', () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    const worktree = yield* fixture.addWorktree('missing-git-activity')
    const gitDir = yield* Effect.sync(() =>
      execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], {
        encoding: 'utf8',
      }).trim(),
    )
    yield* fixture.fs.remove(join(gitDir, 'logs', 'HEAD'))
    const receipt = yield* fixture.run()
    expect(receipt.entries).toHaveLength(1)
    expect(receipt.entries[0]).toMatchObject({
      worktree,
      action: 'none',
      reason: 'git-activity-unknown',
      bytesBefore: null,
      bytesAfter: null,
    })
    yield* fixture.expectNoCommands()
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('rejects a Git worktree that resolves to an ancestor Buck project', () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    yield* fixture.fs.writeFileString(join(fixture.store, '.buckroot'), '')
    yield* fixture.fs.writeFileString(join(fixture.store, '.buckconfig'), '[cells]\n  root = .\n')
    const worktree = yield* fixture.addWorktree('ancestor-buck-root', false)
    const receipt = yield* fixture.run()
    expect(receipt.entries).toHaveLength(1)
    expect(receipt.entries[0]).toMatchObject({
      worktree,
      action: 'none',
      reason: 'project-root-mismatch',
      bytesBefore: null,
      bytesAfter: null,
    })
    yield* fixture.expectNoCommands()
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live(
  'requires authoritative native seat coverage despite an empty manifest and maintainUnowned',
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const worktree = yield* fixture.addWorktree('native-unavailable')
      yield* fixture.fs.remove(fixture.st3)
      const receipt = yield* fixture.run()
      expect(receipt.entries).toHaveLength(1)
      expect(receipt.entries[0]).toMatchObject({
        worktree,
        action: 'none',
        reason: 'seat-claims-incomplete',
        bytesBefore: null,
        bytesAfter: null,
      })
      yield* fixture.expectNoCommands()
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('protects a waiting remote seat with no local holder even when the manifest is empty', () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    const worktree = yield* fixture.addWorktree('remote-waiting')
    yield* fixture.writeAgents([{ id: 'seat/remote', state: 'waiting' }])
    yield* fixture.fs.writeFileString(
      fixture.subjectPath,
      encodeJson({
        status: {
          store_index: 1,
          subjects: [
            {
              subject: 'seat/remote',
              actual: { status: 'waiting', workspace: worktree, host: 'host/remote-fixture' },
            },
          ],
        },
      }),
    )
    const receipt = yield* fixture.run()
    expect(receipt.entries).toHaveLength(1)
    expect(receipt.entries[0]).toMatchObject({
      worktree,
      action: 'none',
      bytesBefore: null,
      bytesAfter: null,
    })
    expect(['active-claim', 'foreign-owner']).toContain(receipt.entries[0]?.reason)
    expect(receipt.entries[0]?.ownerEvidence).toContainEqual({
      source: 'st3-seat',
      owner: 'seat/remote',
      workspace: worktree,
    })
    yield* fixture.expectNoCommands()
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('keeps recent daemon-state activity even when Git and Buck logs are ten days old', () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    const { fs } = fixture
    const worktree = yield* fixture.addWorktree('recent-daemon-state')
    const gitDir = yield* Effect.sync(() =>
      execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], {
        encoding: 'utf8',
      }).trim(),
    )
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const recent = new Date(Date.now() - 60_000)
    for (const name of ['HEAD', 'index', 'logs/HEAD']) {
      yield* fs.utimes(join(gitDir, name), old, old)
    }
    const output = join(worktree, 'buck-out', 'v2')
    for (const name of ['log', 'daemon']) {
      yield* fs.makeDirectory(join(output, name))
      yield* fs.writeFileString(join(output, name, 'state'), 'exited fixture daemon')
      yield* fs.utimes(join(output, name, 'state'), old, old)
      yield* fs.utimes(join(output, name), old, old)
    }
    // An exited daemon can leave no live PID while its last state transition is
    // much newer than the event log. That activity must veto a full clean.
    yield* fs.utimes(join(output, 'daemon'), recent, recent)
    yield* fs.writeFileString(
      fixture.configPath,
      encodeJson({
        version: 1,
        worktreeRoots: [fixture.roots],
        buckOut: { budgetBytes: 1_000_000, keepSince: '0s', fullCleanWhenInactiveFor: '24h' },
        maintainOwners: ['seat/a'],
        maintainUnowned: true,
      }),
    )
    const receipt = yield* fixture.run()
    expect(receipt.entries).toHaveLength(1)
    expect(receipt.entries[0]).toMatchObject({
      worktree,
      action: 'none',
      reason: 'within-budget',
      bytesBefore: 8192,
      bytesAfter: 8192,
    })
    expect((yield* fs.readFileString(fixture.duCalls)).trim().split('\n')).toHaveLength(1)
    expect(yield* fs.readFileString(fixture.nativeCalls)).toBe('')
    expect(yield* fs.exists(join(output, 'log', 'state'))).toBe(true)
    expect(yield* fs.exists(join(output, 'daemon', 'state'))).toBe(true)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live(
  'skips unknown Buck activity before du when inactivity-based full cleaning is enabled',
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const worktree = yield* fixture.addWorktree('unknown-buck-activity')
      // This real output tree has retained output but no log/daemon timestamps.
      yield* fixture.fs.writeFileString(
        fixture.configPath,
        encodeJson({
          version: 1,
          worktreeRoots: [fixture.roots],
          buckOut: { budgetBytes: 1_000_000, keepSince: '0s', fullCleanWhenInactiveFor: '24h' },
          maintainOwners: ['seat/a'],
          maintainUnowned: true,
        }),
      )
      const receipt = yield* fixture.run()
      expect(receipt.entries).toHaveLength(1)
      expect(receipt.entries[0]).toMatchObject({
        worktree,
        action: 'none',
        reason: 'inactivity-unknown',
        bytesBefore: null,
        bytesAfter: null,
      })
      yield* fixture.expectNoCommands()
      expect(yield* fixture.fs.readFileString(join(worktree, 'buck-out/v2/retained-output'))).toBe(
        'must survive',
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

for (const recentCommand of [false, true]) {
  it.live(
    recentCommand === true
      ? 'keeps recent Buck command activity despite old Git and daemon-state timestamps'
      : 'allows full cleaning with no current daemon and all known work signals ten days old',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const { fs } = fixture
        const worktree = yield* fixture.addWorktree(
          recentCommand === true ? 'recent-command' : 'old-work-signals',
        )
        const gitDir = yield* Effect.sync(() =>
          execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], {
            encoding: 'utf8',
          }).trim(),
        )
        const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
        for (const name of ['HEAD', 'index', 'logs/HEAD']) {
          yield* fs.utimes(join(gitDir, name), old, old)
        }
        const output = join(worktree, 'buck-out', 'v2')
        for (const name of ['log', 'daemon']) {
          yield* fs.makeDirectory(join(output, name))
          yield* fs.writeFileString(join(output, name, 'state'), 'old work signal')
          yield* fs.utimes(join(output, name, 'state'), old, old)
          yield* fs.utimes(join(output, name), old, old)
        }
        yield* fs.utimes(join(output, 'retained-output'), old, old)
        yield* fs.utimes(output, old, old)
        yield* fs.utimes(join(worktree, 'buck-out'), old, old)
        if (recentCommand === true) {
          const recent = new Date(Date.now() - 60_000)
          yield* fs.utimes(join(output, 'log', 'state'), recent, recent)
        }
        // No artificial "time since daemon disappearance" is required. Inactivity
        // is the last observed work signal, plus absence of a current live holder.
        yield* fs.writeFileString(
          fixture.configPath,
          encodeJson({
            version: 1,
            worktreeRoots: [fixture.roots],
            buckOut: { budgetBytes: 1_000_000, keepSince: '0s', fullCleanWhenInactiveFor: '24h' },
            maintainOwners: ['seat/a'],
            maintainUnowned: true,
          }),
        )
        const receipt = yield* fixture.run()
        expect(receipt.entries).toHaveLength(1)
        expect(receipt.entries[0]).toMatchObject({
          worktree,
          action: recentCommand === true ? 'none' : 'full-clean',
          reason: recentCommand === true ? 'within-budget' : 'completed',
          bytesBefore: 8192,
          bytesAfter: 8192,
        })
        const nativeCalls = yield* fs.readFileString(fixture.nativeCalls)
        if (recentCommand === true) {
          expect(nativeCalls).toBe('')
        } else {
          expect(nativeCalls).toBe('--isolation-dir v2 clean\n')
          expect(nativeCalls).not.toContain('--stale')
        }
        expect((yield* fs.readFileString(fixture.duCalls)).trim().split('\n')).toHaveLength(
          recentCommand === true ? 1 : 2,
        )
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
}

for (const resolvable of [true, false]) {
  it.live(
    `preserves inactive foreign ownership through ${resolvable === true ? 'a physical alias' : 'an unresolved path'}`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const worktree = yield* fixture.addWorktree('foreign-alias')
        const alias = join(fixture.store, 'workspace-alias')
        if (resolvable === true) yield* fixture.fs.symlink(worktree, alias)
        yield* fixture.writeManifest([{ workspace: alias, owner: 'seat/foreign', active: false }])
        const receipt = yield* fixture.run()
        expect(receipt.entries[0]?.reason).toBe('foreign-owner')
        expect(receipt.entries[0]?.ownerEvidence).toContainEqual({
          source: 'st3-seat',
          owner: 'seat/foreign',
          workspace: alias,
        })
        yield* fixture.expectNoCommands()
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
}

for (const boundary of ['', 'v2', 'v2/log']) {
  it.live(`rejects a linked buck-out boundary ${boundary || 'root'} before measurement`, () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const worktree = yield* fixture.addWorktree('linked-output')
      const target = join(fixture.store, 'external-output')
      yield* fixture.fs.makeDirectory(target)
      const path = join(worktree, 'buck-out', boundary)
      if (boundary !== 'v2/log') yield* fixture.fs.remove(path, { recursive: true })
      yield* fixture.fs.symlink(target, path)
      const receipt = yield* fixture.run()
      expect(receipt.entries[0]?.reason).toBe('output-activity-unknown')
      yield* fixture.expectNoCommands()
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
}

for (const history of ['absent', 'empty', 'partial'] as const) {
  it.live(`handles ${history} output history conservatively before full cleaning`, () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const worktree = yield* fixture.addWorktree('lost-history')
      const output = join(worktree, 'buck-out')
      if (history === 'absent') yield* fixture.fs.remove(output, { recursive: true })
      else if (history === 'empty')
        yield* fixture.fs.remove(join(output, 'v2'), { recursive: true })
      else yield* fixture.fs.makeDirectory(join(output, 'v2', 'daemon'))
      yield* fixture.fs.writeFileString(
        fixture.configPath,
        encodeJson({
          version: 1,
          worktreeRoots: [fixture.roots],
          buckOut: { budgetBytes: 0, keepSince: '0s', fullCleanWhenInactiveFor: '24h' },
          maintainOwners: ['seat/a'],
          maintainUnowned: true,
        }),
      )
      const receipt = yield* fixture.run()
      expect(receipt.entries[0]).toMatchObject({
        action: 'none',
        reason: history === 'absent' ? 'no-buck-out' : 'inactivity-unknown',
        bytesBefore: null,
        bytesAfter: null,
      })
      yield* fixture.expectNoCommands()
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
}

interface DaemonFixture {
  readonly fs: FileSystem.FileSystem
  readonly store: string
  readonly idleFs: FileSystem.FileSystem
  readonly nativeCalls: string
  readonly measured: string
}

const makeDaemonBoundary = Effect.fn('test.buckMaintainSafety.daemons')(function* (
  fixture: DaemonFixture,
  worktree: string,
  initial: readonly number[],
  arriveAfterMeasurement = false,
  arriveAfterKill = false,
  failKill = false,
  arriveAfterClean = false,
) {
  const { fs, store, idleFs } = fixture
  const procRoot = join(store, 'daemon-proc')
  const binary = join(store, 'bin', 'buck2')
  const killed = join(store, 'killed')
  for (const pid of [2000000001, 2000000002, 2000000003]) {
    const root = join(procRoot, String(pid))
    yield* fs.makeDirectory(join(root, 'fd'), { recursive: true })
    yield* fs.writeFileString(
      join(root, 'stat'),
      `${pid} (buck2) S 0 ${pid} ${pid} 0 -1 4194560 ${'0 '.repeat(12)}12345`,
    )
    const uid = process.getuid?.() ?? 0
    yield* fs.writeFileString(
      join(root, 'status'),
      `Name:\tbuck2\nPPid:\t0\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
    )
    yield* fs.writeFileString(join(root, 'environ'), 'ST_AGENT=seat/a\0')
    yield* fs.writeFileString(
      join(root, 'cmdline'),
      `buck2\0--isolation-dir\0iso-${pid}\0daemon\0--daemon-id\0id-${pid}\0`,
    )
    yield* fs.writeFileString(join(root, 'maps'), '')
    yield* fs.symlink(worktree, join(root, 'cwd'))
    yield* fs.symlink('/', join(root, 'root'))
    yield* fs.symlink(binary, join(root, 'exe'))
  }
  yield* fs.writeFileString(
    binary,
    `#!/bin/sh\nset -eu\nprintf '%s\\n' "$*" >> ${shellQuote(fixture.nativeCalls)}
pid="\${2#iso-}"
case "$3" in
status) printf '{"process_info":{"pid":%s},"daemon_constraints":{"daemon_id":"id-%s"},"active_commands":[],"start_time":"2000-01-01T00:00:00Z"}\\n' "$pid" "$pid" ;;
kill) ${failKill === true ? 'exit 1' : `printf '%s\\n' "$pid" >> ${shellQuote(killed)}\nprintf 'Buck2 daemon pid %s has exited\\n' "$pid" >&2`} ;;
esac\n`,
    { mode: 0o755 },
  )
  const mapProc = (path: string) => {
    const match = /^\/proc\/(200000000[123])(?:\/(.*))?$/u.exec(path)
    return match === null ? path : join(procRoot, match[1]!, match[2] ?? '')
  }
  const boundary: FileSystem.FileSystem = {
    ...idleFs,
    readDirectory: (path, options) =>
      path === '/proc'
        ? Effect.gen(function* () {
            const stopped = yield* fs.readFileString(killed).pipe(Effect.orElseSucceed(() => ''))
            const arrival =
              (arriveAfterMeasurement === true && (yield* fs.exists(fixture.measured))) ||
              (arriveAfterKill === true && stopped !== '') ||
              (arriveAfterClean === true &&
                (yield* fs.readFileString(fixture.nativeCalls)).includes(' clean'))
            return [...initial, ...(arrival === true ? [2000000003] : [])]
              .filter((pid) => stopped.split('\n').includes(String(pid)) === false)
              .map(String)
          })
        : fs.readDirectory(mapProc(path), options),
    readFileString: (path, options) => fs.readFileString(mapProc(path), options),
    readLink: (path) => fs.readLink(mapProc(path)),
    stat: (path) => fs.stat(mapProc(path)),
  }
  return boundary
})

for (const arrival of [false, true]) {
  it.live(
    arrival === false
      ? 'stops multiple idle isolations independently and records each stopped lifetime'
      : 'vetoes a new daemon lifetime arriving between isolation kills and records partial outcomes',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const worktree = yield* fixture.addWorktree('idle-daemons')
        yield* fixture.fs.writeFileString(
          fixture.configPath,
          encodeJson({
            version: 1,
            worktreeRoots: [fixture.roots],
            buckOut: { budgetBytes: 100000, keepSince: '0s' },
            daemon: { idleStopAfter: '0s' },
            maintainOwners: ['seat/a'],
            maintainUnowned: true,
          }),
        )
        const boundary = yield* makeDaemonBoundary(
          fixture,
          worktree,
          [2000000001, 2000000002],
          false,
          arrival,
        )
        const receipt = yield* fixture.run(boundary)
        expect(receipt.entries[0]?.daemon.map((daemon) => daemon.outcome)).toEqual(
          arrival === true ? ['stopped', 'kept-active'] : ['stopped', 'stopped'],
        )
        expect(
          (yield* fixture.fs.readFileString(fixture.nativeCalls)).match(/ kill/gu),
        ).toHaveLength(arrival === true ? 1 : 2)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
}

it.live('vetoes a daemon first appearing after measurement before full clean', () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    const worktree = yield* fixture.addWorktree('late-full-clean-daemon')
    yield* fixture.fs.makeDirectory(join(worktree, 'buck-out/v2/log'), { recursive: true })
    yield* fixture.fs.makeDirectory(join(worktree, 'buck-out/v2/daemon'))
    const log = join(worktree, 'buck-out/v2/log/old-event')
    yield* fixture.fs.writeFileString(log, 'old event')
    // A zero interval makes all already-recorded Git and output history eligible.
    yield* fixture.fs.writeFileString(
      fixture.configPath,
      encodeJson({
        version: 1,
        worktreeRoots: [fixture.roots],
        buckOut: { budgetBytes: 100000, keepSince: '0s', fullCleanWhenInactiveFor: '0s' },
        maintainOwners: ['seat/a'],
        maintainUnowned: true,
      }),
    )
    const boundary = yield* makeDaemonBoundary(fixture, worktree, [], true)
    const receipt = yield* fixture.run(boundary)
    expect(receipt.entries[0]?.action).toBe('none')
    expect(yield* fixture.fs.exists(fixture.measured)).toBe(true)
    expect(receipt.entries[0]?.reason).toBe('holder-live')
    expect(yield* fixture.fs.readFileString(fixture.nativeCalls)).toBe('')
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

for (const failure of ['clean', 'kill'] as const) {
  it.live(`retains every worktree receipt after a native ${failure} failure`, () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const worktree = yield* fixture.addWorktree('failed')
      const other = yield* fixture.addWorktree('other')
      let boundary = fixture.idleFs
      if (failure === 'clean') {
        yield* fixture.fs.writeFileString(join(fixture.store, 'bin/buck2'), '#!/bin/sh\nexit 1\n', {
          mode: 0o755,
        })
      } else {
        yield* fixture.fs.writeFileString(
          fixture.configPath,
          encodeJson({
            version: 1,
            worktreeRoots: [fixture.roots],
            buckOut: { budgetBytes: 100000, keepSince: '0s' },
            daemon: { idleStopAfter: '0s' },
            maintainOwners: ['seat/a'],
            maintainUnowned: true,
          }),
        )
        boundary = yield* makeDaemonBoundary(fixture, worktree, [2000000001], false, false, true)
      }
      const receipt = yield* fixture.run(boundary)
      expect(receipt.entries.map((entry) => entry.worktree).sort()).toEqual(
        [worktree, other].sort(),
      )
      expect(receipt.entries.find((entry) => entry.worktree === worktree)?.reason).toBe(
        `${failure}-failed`,
      )
      if (failure === 'kill')
        expect(
          receipt.entries.find((entry) => entry.worktree === worktree)?.daemon[0],
        ).toMatchObject({
          outcome: 'unreachable',
          reason: 'kill-failed',
        })
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
}

it.live('does not admit an unproven daemon arriving between native isolation cleans', () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    const worktree = yield* fixture.addWorktree('between-cleans')
    yield* fixture.fs.makeDirectory(join(worktree, 'buck-out/second'), { recursive: true })
    const boundary = yield* makeDaemonBoundary(fixture, worktree, [], false, false, false, true)
    const receipt = yield* fixture.run(boundary)
    expect(receipt.entries[0]?.action).toBe('clean-stale')
    expect(receipt.entries[0]?.reason).not.toBe('completed')
    expect((yield* fixture.fs.readFileString(fixture.nativeCalls)).trim().split('\n')).toHaveLength(
      1,
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live(
  'does not fully clean an old surviving isolation after another isolation was removed recently',
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const { fs } = fixture
      const worktree = yield* fixture.addWorktree('removed-isolation')
      const gitDir = yield* Effect.sync(() =>
        execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], {
          encoding: 'utf8',
        }).trim(),
      )
      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      for (const name of ['HEAD', 'index', 'logs/HEAD'])
        yield* fs.utimes(join(gitDir, name), old, old)
      for (const name of ['log', 'daemon']) {
        const path = join(worktree, 'buck-out', 'v2', name)
        yield* fs.makeDirectory(path)
        yield* fs.writeFileString(join(path, 'state'), 'old work')
        yield* fs.utimes(join(path, 'state'), old, old)
        yield* fs.utimes(path, old, old)
      }
      const output = join(worktree, 'buck-out')
      yield* fs.makeDirectory(join(output, 'removed'))
      yield* fs.utimes(output, old, old)
      yield* fs.remove(join(output, 'removed'), { recursive: true })
      yield* fs.writeFileString(
        fixture.configPath,
        encodeJson({
          version: 1,
          worktreeRoots: [fixture.roots],
          buckOut: { budgetBytes: 100000, keepSince: '0s', fullCleanWhenInactiveFor: '24h' },
          maintainOwners: ['seat/a'],
          maintainUnowned: true,
        }),
      )
      const receipt = yield* fixture.run()
      expect(receipt.entries[0]).toMatchObject({ action: 'none', reason: 'within-budget' })
      expect((yield* fs.readFileString(fixture.duCalls)).trim().split('\n')).toHaveLength(1)
      expect(yield* fs.readFileString(fixture.nativeCalls)).toBe('')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
