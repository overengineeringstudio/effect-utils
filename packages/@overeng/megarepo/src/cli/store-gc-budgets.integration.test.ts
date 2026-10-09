/**
 * `mr store gc --budgets` acceptance tests (build-output budgets owner brief).
 *
 * Every case drives the real `bin/mr.ts` CLI as a subprocess against a real
 * store fixture: real git worktrees, real files with real `st_blocks`, real
 * hardlinks/symlinks, real `sleep` holders and real deletion leases. Acceptance
 * 1-11 runs as the unprivileged store owner inside fresh user/PID namespaces
 * with their own populated `/proc`, without relaxing all-UID completeness.
 * Allocation fixtures use an existing tmpfs, never a privileged mount.
 * The separately marked root-snapshot/isolated-UID proof requires `sudo -n`.
 *
 * Two deterministic command fixtures stand in for remote/agent evidence and are
 * named as such — they do not claim live GitHub or st3 proof:
 *  - the activity producer is the producer-neutral
 *    `megarepo.workspace-activity.v2` manifest file written by the test
 *    (`builtin: false`, admitted producer `acceptance-fixture`);
 *  - `gh` is an executable on the CLI's PATH that prints a fixed PR list, so
 *    the merged-teardown path exercises the real live `gh`-shelling resolver
 *    while git reachability/cleanliness/worklog deletion stay fully real.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { link, lstat, mkdir, readdir, statfs, symlink, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect, vi } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { BudgetPlan } from '../store/store-build-budgets.ts'
import {
  acquireDeletionLease,
  canonicalizeOwnerPath,
  releaseDeletionLease,
} from '../store/store-deletion-lease.ts'
import { decodeJson, encodeJson } from '../test-utils/json.ts'
import { createStoreFixture, getWorktreeCommit } from '../test-utils/store-setup.ts'

const BUDGETS_E2E_TIMEOUT_MS = 180_000
vi.setConfig({ hookTimeout: BUDGETS_E2E_TIMEOUT_MS, testTimeout: BUDGETS_E2E_TIMEOUT_MS })

const MiB = 1024 * 1024
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const PRODUCER = 'acceptance-fixture'
const MR_BIN = fileURLToPath(new URL('../../bin/mr.ts', import.meta.url))
const REPO = { host: 'github.com', owner: 'acme', repo: 'widget' } as const
const REPO_KEY = `${REPO.host}/${REPO.owner}/${REPO.repo}`

const decodePlan = Schema.decodeUnknownSync(Schema.fromJsonString(BudgetPlan))
type Plan = typeof BudgetPlan.Type

// =============================================================================
// Root CLI subprocess
// =============================================================================

type Fixture = {
  readonly storePath: AbsoluteDirPath
  readonly worktreePaths: Record<string, AbsoluteDirPath>
  readonly bareRepoPaths: Record<string, AbsoluteDirPath>
  readonly state: string
  readonly commandDir: string
  readonly outside: AbsoluteDirPath
  readonly home: string
  readonly policyPath: string
  readonly manifestPath: string
  readonly isolatedOwner?: boolean
  readonly cliBin?: string
}

/** Fail loudly (never skip) when the root process probe cannot be exercised. */
const requireRoot = () => {
  const probe = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    throw new Error(`privileged root-snapshot fixture needs passwordless sudo: ${probe.stderr}`)
  }
}

/** Fixture env passed explicitly through `/usr/bin/env` (sudo resets the environment). */
const cliEnv = (f: Fixture): ReadonlyArray<string> => {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[0].startsWith('GIT_') === true &&
      entry[0].startsWith('GIT_CONFIG_COUNT') === false &&
      entry[0].startsWith('GIT_CONFIG_KEY_') === false &&
      entry[0].startsWith('GIT_CONFIG_VALUE_') === false &&
      entry[1] !== undefined,
  )
  return [
    ...inherited.map(([key, value]) => `${key}=${value}`),
    // Root operating on user-owned fixture repos must not trip `safe.directory`.
    'GIT_CONFIG_COUNT=1',
    'GIT_CONFIG_KEY_0=safe.directory',
    'GIT_CONFIG_VALUE_0=*',
    `HOME=${f.home}`,
    `PATH=${f.commandDir}/bin:${process.env['PATH'] ?? ''}`,
    `MEGAREPO_STORE=${f.storePath}`,
    'NO_COLOR=1',
    `PTY_SESSION_DIR=${f.home}/pty`,
  ]
}

/**
 * Run `bin/mr.ts` either as root (`sudo -n`, explicit env) or as the store
 * owner (this test's UID, which cannot read foreign-UID `/proc` entries).
 */
const runCli = (
  f: Fixture,
  argv: ReadonlyArray<string>,
  { asRoot = false }: { asRoot?: boolean } = {},
) => {
  const env = cliEnv(f)
  const mrBin = f.cliBin ?? MR_BIN
  const result =
    asRoot === true
      ? spawnSync('sudo', ['-n', '/usr/bin/env', ...env, 'bun', mrBin, ...argv], {
          cwd: f.outside,
          encoding: 'utf8',
          timeout: 120_000,
        })
      : f.isolatedOwner === true
        ? spawnSync('sudo', ['-n', '-u', 'nobody', '/usr/bin/env', ...env, 'bun', mrBin, ...argv], {
            cwd: f.outside,
            encoding: 'utf8',
            timeout: 120_000,
          })
        : spawnSync('bun', [mrBin, ...argv], {
            cwd: f.outside,
            encoding: 'utf8',
            timeout: 120_000,
            env: {
              ...process.env,
              ...Object.fromEntries(
                env.map((pair) => [
                  pair.slice(0, pair.indexOf('=')),
                  pair.slice(pair.indexOf('=') + 1),
                ]),
              ),
            },
          })
  return { exitCode: result.status, stdout: result.stdout.trim(), stderr: result.stderr }
}

const runMr = (f: Fixture, args: ReadonlyArray<string>, options?: { asRoot?: boolean }) =>
  runCli(f, ['store', 'gc', ...args, '--output', 'json'], options)

const runBudgets = (
  f: Fixture,
  args: ReadonlyArray<string> = ['--dry-run'],
  options?: { asRoot?: boolean },
) => {
  const result = runMr(f, ['--budgets', f.policyPath, ...args], options)
  const plan: Plan | undefined =
    result.exitCode === 0 && result.stdout.length > 0 ? decodePlan(result.stdout) : undefined
  return { ...result, plan }
}

/** Plan successfully or fail with the CLI's own stderr. */
const planOk = (f: Fixture) => {
  const result = runBudgets(f)
  expect(result.exitCode, result.stderr).toBe(0)
  return result.plan!
}

const applyCandidate = (f: Fixture, { plan, path }: { plan: Plan; path: string }) =>
  runBudgets(f, ['--expected-plan', plan.planSha256, '--candidate-path', path])

const row = (plan: Plan, path: string) => plan.results.find((candidate) => candidate.path === path)

// =============================================================================
// Filesystem fixtures
// =============================================================================

const writePolicy = (
  f: Pick<Fixture, 'policyPath' | 'storePath'>,
  {
    budgetBytes,
    retentionMs = DAY_MS,
    teardown = 'delete',
  }: { budgetBytes: number; retentionMs?: number; teardown?: 'delete' | 'retain' },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(
      f.policyPath,
      encodeJson({
        schemaVersion: 'megarepo.build-output-budgets.v1',
        host: hostname(),
        storeRoots: [f.storePath],
        quotaBytes: 1024 * MiB,
        idleRetentionMs: retentionMs,
        classes: {
          'cargo-target': { budgetBytes, paths: ['target', '**/target'] },
        },
        worklog: { path: 'tmp/worklog', teardown },
      }),
    )
  })

/**
 * Producer-neutral gc-config: only the manifest fixture is admitted, never a
 * builtin st2/st3. The budgets policy file is the sole worklog-teardown source.
 */
const writeGcConfig = (
  f: Fixture,
  {
    manifestPath = f.manifestPath,
    producer = PRODUCER,
  }: { manifestPath?: string; producer?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(
      `${f.state}/gc-config.json`,
      encodeJson({
        // Whole-worktree teardown timers collapse to zero; PR evidence still gates.
        absenceGraceMs: 0,
        postMergeGraceMs: 0,
        buildOutputBudgetsPath: f.policyPath,
        generatedArtifacts: {
          manifestPath,
          agentLivenessProducers: [producer],
          builtin: false,
        },
      }),
    )
  })

type ManifestVariant = 'valid' | 'missing' | 'expired' | 'wrong-host' | 'incomplete'

const writeManifest = (
  f: Pick<Fixture, 'manifestPath'>,
  {
    variant = 'valid',
    activeWorkspaces = [],
  }: { variant?: ManifestVariant; activeWorkspaces?: ReadonlyArray<string> } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (variant === 'missing') {
      yield* fs.remove(f.manifestPath, { force: true })
      return
    }
    const now = Date.now()
    const capturedAt = variant === 'expired' ? now - 10 * 60 * 1000 : now
    yield* fs.writeFileString(
      f.manifestPath,
      encodeJson({
        schemaVersion: 'megarepo.workspace-activity.v2',
        producer: { name: PRODUCER, version: 'fixture-v1' },
        // No `processCoverage`: a user-owned manifest may not claim foreign-UID
        // coverage (it would be rejected wholesale); the root planner probes /proc itself.
        epoch: {
          host: variant === 'wrong-host' ? `${hostname()}-elsewhere` : hostname(),
          snapshotId: 'acceptance-snapshot',
          storeIndex: 1,
        },
        capturedAt: new Date(capturedAt).toISOString(),
        expiresAt: new Date(capturedAt + 4 * 60 * 1000).toISOString(),
        complete: variant !== 'incomplete',
        errors: variant === 'incomplete' ? ['fixture: producer reported partial capture'] : [],
        claims: activeWorkspaces.map((workspace) => ({
          workspace,
          sources: ['pty'],
          agents: [],
          activeRuntimeIds: [],
          active: true,
        })),
      }),
    )
  })

const budgetFixture = (
  branches: ReadonlyArray<string>,
  { withRemote = false, privileged = false } = {},
) =>
  Effect.gen(function* () {
    if (privileged === true) requireRoot()
    const fs = yield* FileSystem.FileSystem
    // The acceptance setup needs already-allocated roots, not ZFS txg sleeps.
    const allocationDirectory = yield* Effect.promise(async () => {
      for (const directory of ['/dev/shm', process.env['XDG_RUNTIME_DIR']]) {
        if (directory === undefined) continue
        try {
          if ((await statfs(directory)).type === 0x01021994) return directory
        } catch {
          // Try the next existing tmpfs; never mount a filesystem in the suite.
        }
      }
      throw new Error(
        'budget allocation fixtures require an existing tmpfs (/dev/shm or XDG_RUNTIME_DIR)',
      )
    })
    const created = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env['TMPDIR']
        process.env['TMPDIR'] = allocationDirectory
        return previous
      }),
      () => createStoreFixture([{ ...REPO, branches, withRemote }]),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env['TMPDIR']
          else process.env['TMPDIR'] = previous
        }),
    )
    const tmpRoot = created.storePath.replace(/\/\.megarepo\/$/u, '')
    // Root-run CLI writes leases/locks/archives; hand them back before scoped temp removal.
    if (privileged === true)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          spawnSync('sudo', [
            '-n',
            'chown',
            '-R',
            `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
            tmpRoot,
          ])
        }),
      )
    const state = `${created.storePath}.state`
    const outside = EffectPath.unsafe.absoluteDir(`${tmpRoot}/outside/`)
    const home = `${tmpRoot}/home`
    // Executable command fixtures must not inherit /dev/shm's noexec flag.
    const commandDir = yield* fs.makeTempDirectoryScoped({ directory: '/tmp' })
    yield* fs.chmod(commandDir, 0o755)
    yield* fs.makeDirectory(`${commandDir}/bin`, { recursive: true })
    yield* fs.makeDirectory(outside, { recursive: true })
    yield* fs.makeDirectory(home, { recursive: true })
    const f: Fixture = {
      ...created,
      state,
      commandDir,
      outside,
      home,
      policyPath: `${state}/build-output-budgets.json`,
      manifestPath: `${state}/workspace-activity.json`,
    }
    yield* writeGcConfig(f)
    yield* writeManifest(f)
    return f
  })

const worktree = (f: Fixture, branch: string) => f.worktreePaths[`${REPO_KEY}#${branch}`]!

/** Commit a `.gitignore` so every `target/` below the worktree is ignored. */
const ignoreTargets = (dir: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${dir}.gitignore`, 'target/\n')
    yield* Git.runCommand({ args: ['add', '.gitignore'], cwd: dir })
    yield* Git.runCommand({ args: ['commit', '--no-verify', '-m', 'ignore targets'], cwd: dir })
  })

/** Recursively backdate every entry (post-order so the directory mtimes stick). */
const backdate = async (path: string, at: Date): Promise<void> => {
  const info = await lstat(path)
  if (info.isSymbolicLink() === true) return
  if (info.isDirectory() === true) {
    for (const entry of await readdir(path)) await backdate(join(path, entry), at)
  }
  await utimes(path, at, at)
}

/**
 * Write incompressible bytes (zeros would compress away on ZFS and allocate
 * nothing) and backdate the whole root.
 */
const makeArtifact = (
  root: string,
  { files, ageMs }: { files: Record<string, number>; ageMs: number },
) =>
  Effect.promise(async () => {
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(root, name)
      await ensureParent(path)
      await writeFile(path, randomBytes(bytes))
    }
    await backdate(root, new Date(Date.now() - ageMs))
  })

const ensureParent = (filePath: string) =>
  mkdir(filePath.slice(0, filePath.lastIndexOf('/')), { recursive: true })

/**
 * Independent allocated-bytes oracle: `st_blocks * 512` over unique
 * `(dev, ino)` across all given roots, via `lstat` (symlinks never followed).
 */
const allocatedBytes = (roots: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const inodes = new Map<string, number>()
    const walk = async (path: string): Promise<void> => {
      const info = await lstat(path, { bigint: true })
      inodes.set(`${info.dev}:${info.ino}`, Number(info.blocks * 512n))
      if (info.isDirectory() === true) {
        for (const entry of await readdir(path)) await walk(join(path, entry))
      }
    }
    for (const root of roots) await walk(root)
    let total = 0
    for (const bytes of inodes.values()) total += bytes
    return total
  })

const exists = (path: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(path)))

const spawnHolder = (cwd: string): Promise<ChildProcess> => {
  const { promise, resolve, reject } = Promise.withResolvers<ChildProcess>()
  const child = spawn('sleep', ['120'], { cwd, stdio: 'ignore' })
  child.once('spawn', () => resolve(child))
  child.once('error', reject)
  return promise
}

const killHolder = (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  child.once('exit', () => resolve())
  child.kill('SIGKILL')
  return promise
}

const holderIn = (cwd: string) =>
  Effect.acquireRelease(
    Effect.promise(() => spawnHolder(cwd)),
    (child) => Effect.promise(() => killHolder(child)),
  )

/** Two worktrees, each with an ignored 3 MiB `target/` (`a` older than `b`). */
const twoTargets = ({
  ageA = 3 * DAY_MS,
  ageB = 2 * DAY_MS,
  budgetBytes = 4 * MiB,
  privileged = false,
}: { ageA?: number; ageB?: number; budgetBytes?: number; privileged?: boolean } = {}) =>
  Effect.gen(function* () {
    const f = yield* budgetFixture(['feature/a', 'feature/b'], { privileged })
    const a = worktree(f, 'feature/a')
    const b = worktree(f, 'feature/b')
    yield* ignoreTargets(a)
    yield* ignoreTargets(b)
    const targetA = `${a}target`
    const targetB = `${b}target`
    yield* makeArtifact(targetA, { files: { 'release/app.bin': 3 * MiB }, ageMs: ageA })
    yield* makeArtifact(targetB, { files: { 'release/app.bin': 3 * MiB }, ageMs: ageB })
    yield* writePolicy(f, { budgetBytes })
    return { f, a, b, targetA, targetB }
  })

// =============================================================================
// Acceptance
// =============================================================================

const inOwnerNamespace = process.env['MEGAREPO_BUDGET_TEST_NAMESPACE'] === '1'
if (inOwnerNamespace === false)
  describe('mr budget owner namespace preconditions', () => {
    it('runs acceptance 1-11 in an unprivileged user/PID namespace with real fixture processes', () => {
      const file = fileURLToPath(import.meta.url)
      const packageDir = dirname(dirname(dirname(file)))
      const vitestBin = join(
        dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
        'vitest.mjs',
      )
      const result = spawnSync(
        'unshare',
        [
          '--user',
          '--map-root-user',
          '--pid',
          '--fork',
          '--mount-proc',
          process.execPath,
          vitestBin,
          'run',
          'src/cli/store-gc-budgets.integration.test.ts',
          '--reporter',
          'verbose',
          '--testTimeout',
          '240000',
        ],
        {
          cwd: packageDir,
          env: { ...process.env, MEGAREPO_BUDGET_TEST_NAMESPACE: '1' },
          encoding: 'utf8',
          timeout: 240_000,
        },
      )
      console.log(result.stdout)
      expect(
        result.error,
        'budget acceptance requires unshare and unprivileged user/PID namespaces',
      ).toBeUndefined()
      expect(
        result.status,
        `budget acceptance requires usable unprivileged user/PID namespaces and a populated /proc: ${result.stderr}`,
      ).toBe(0)
    }, 240_000)
  })
if (inOwnerNamespace === true)
  describe('mr store gc --budgets (build-output budgets acceptance)', () => {
    it.effect(
      '1: LRU evicts exactly the older idle root, apply removes it with the plan hash, next plan is empty',
      Effect.fnUntraced(
        function* () {
          const { f, targetA, targetB } = yield* twoTargets()
          const totalBefore = yield* allocatedBytes([targetA, targetB])
          const youngerBytes = yield* allocatedBytes([targetB])
          expect(totalBefore).toBeGreaterThan(4 * MiB)

          const plan = planOk(f)
          expect(plan.schemaVersion).toBe('megarepo.build-output-budget-plan.v1')
          expect(
            plan.results.filter((r) => r.outcome === 'would-delete').map((r) => r.path),
          ).toEqual([targetA])
          expect(row(plan, targetA)).toMatchObject({
            artifactClass: 'cargo-target',
            reason: 'eligible',
          })
          expect(row(plan, targetB)).toMatchObject({ outcome: 'keep', reason: 'within-budget' })
          expect(plan.classes['cargo-target']).toMatchObject({
            totalBytes: totalBefore,
            budgetBytes: 4 * MiB,
            idleCandidateBytes: totalBefore,
            projectedBytes: youngerBytes,
            scanStatus: 'complete',
            status: 'within-budget',
          })
          expect(yield* exists(targetA)).toBe(true)

          const applied = applyCandidate(f, { plan, path: targetA })
          expect(applied.exitCode, applied.stderr).toBe(0)
          expect(applied.plan?.results).toEqual([
            expect.objectContaining({ path: targetA, outcome: 'deleted' }),
          ])
          expect(applied.plan?.classes['cargo-target']?.evictedBytes).toBeGreaterThanOrEqual(
            totalBefore - youngerBytes,
          )
          expect(yield* exists(targetA)).toBe(false)
          expect(yield* exists(targetB)).toBe(true)

          const next = planOk(f)
          expect(next.results.filter((r) => r.outcome === 'would-delete')).toEqual([])
          expect(next.classes['cargo-target']).toMatchObject({
            totalBytes: youngerBytes,
            status: 'within-budget',
          })
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      '2: a live process cwd keeps the older root, a non-idle younger root is kept, class reports over-budget-no-idle-candidate',
      Effect.fnUntraced(
        function* () {
          const { f, a, targetA, targetB } = yield* twoTargets({ ageB: HOUR_MS })
          const holder = yield* holderIn(a)
          const fs = yield* FileSystem.FileSystem
          // Positive control: the namespace /proc really contains our sibling
          // sleep and its cwd; an empty process table cannot satisfy this case.
          expect(yield* fs.readLink(`/proc/${holder.pid}/cwd`)).toBe(a.replace(/\/$/u, ''))
          const plan = planOk(f)
          expect(row(plan, targetA)).toMatchObject({ outcome: 'keep', reason: 'live' })
          expect(row(plan, targetB)).toMatchObject({ outcome: 'keep', reason: 'retention' })
          expect(plan.classes['cargo-target']).toMatchObject({
            status: 'over-budget-no-idle-candidate',
            idleCandidateBytes: 0,
            evictedBytes: 0,
            keptByReason: { live: 1, retention: 1 },
          })
          const refused = applyCandidate(f, { plan, path: targetA })
          expect(refused.exitCode).not.toBe(0)
          expect(yield* exists(targetA)).toBe(true)

          // The holder was the only veto: once it exits the older root is evictable.
          yield* Effect.promise(() => killHolder(holder))
          expect(row(planOk(f), targetA)).toMatchObject({ outcome: 'would-delete' })
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      '3: a held mr store lease on the candidate worktree keeps it',
      Effect.fnUntraced(
        function* () {
          const { f, a, targetA } = yield* twoTargets({ budgetBytes: 0 })
          const lease = yield* acquireDeletionLease({
            storeBasePath: f.storePath,
            ownerPath: yield* canonicalizeOwnerPath(a),
            now: Date.now(),
          })
          const held = planOk(f)
          expect(row(held, targetA)).toMatchObject({ outcome: 'keep', reason: 'lease-held' })
          const stale = runBudgets(f)
          expect(stale.plan?.planSha256).toBe(held.planSha256)
          expect(applyCandidate(f, { plan: held, path: targetA }).exitCode).not.toBe(0)
          expect(yield* exists(targetA)).toBe(true)

          yield* releaseDeletionLease(lease)
          expect(row(planOk(f), targetA)).toMatchObject({ outcome: 'would-delete' })
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      '4: missing, expired, wrong-host or incomplete activity makes every row unknown and deletes nothing',
      Effect.fnUntraced(
        function* () {
          const { f, targetA, targetB } = yield* twoTargets({ budgetBytes: 0 })
          const admitted = planOk(f)
          expect(row(admitted, targetA)?.outcome).toBe('would-delete')
          for (const variant of ['missing', 'expired', 'wrong-host', 'incomplete'] as const) {
            yield* writeManifest(f, { variant })
            const plan = planOk(f)
            expect(plan.results.length, variant).toBe(2)
            for (const candidate of plan.results) {
              expect(candidate, variant).toMatchObject({
                outcome: 'unknown',
                reason: 'agent-liveness-unavailable',
              })
            }
            const refused = applyCandidate(f, { plan: admitted, path: targetA })
            expect(refused.exitCode, variant).not.toBe(0)
            expect(yield* exists(targetA)).toBe(true)
            expect(yield* exists(targetB)).toBe(true)
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      '5: roots written within idleRetentionMs are kept as retention even when over budget',
      Effect.fnUntraced(
        function* () {
          const { f, targetA, targetB } = yield* twoTargets({ ageA: HOUR_MS, ageB: HOUR_MS })
          const plan = planOk(f)
          expect(row(plan, targetA)).toMatchObject({ outcome: 'keep', reason: 'retention' })
          expect(row(plan, targetB)).toMatchObject({ outcome: 'keep', reason: 'retention' })
          expect(plan.classes['cargo-target']).toMatchObject({
            status: 'over-budget-no-idle-candidate',
            keptByReason: { retention: 2 },
          })
          expect(plan.classes['cargo-target']!.totalBytes).toBeGreaterThan(4 * MiB)
          expect(yield* exists(targetA)).toBe(true)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      '6: nested roots are discovered and budgeted, a symlinked root is unknown, tmp/worklog is never a candidate',
      Effect.fnUntraced(
        function* () {
          const f = yield* budgetFixture(['feature/nested'])
          const w = worktree(f, 'feature/nested')
          yield* ignoreTargets(w)
          const nested = `${w}packages/x/target`
          const rust = `${w}rust/target`
          const worklogTarget = `${w}tmp/worklog/a/target`
          for (const root of [nested, rust, worklogTarget]) {
            yield* makeArtifact(root, { files: { 'debug/out.bin': 256 * 1024 }, ageMs: 3 * DAY_MS })
          }
          yield* writePolicy(f, { budgetBytes: 0 })

          const plan = planOk(f)
          expect(plan.results.map((r) => r.path).toSorted()).toEqual([nested, rust])
          expect(plan.results.every((r) => r.outcome === 'would-delete')).toBe(true)
          expect(plan.classes['cargo-target']?.totalBytes).toBe(
            yield* allocatedBytes([nested, rust]),
          )

          const outsideTarget = `${f.outside}symlinked-target`
          yield* makeArtifact(outsideTarget, { files: { 'big.bin': 2 * MiB }, ageMs: 3 * DAY_MS })
          yield* Effect.promise(() => symlink(outsideTarget, `${w}target`))
          const withSymlink = planOk(f)
          expect(row(withSymlink, `${w}target`)).toMatchObject({
            outcome: 'unknown',
            reason: 'artifact-scan-incomplete',
          })
          expect(withSymlink.results.some((r) => r.path.startsWith(`${w}tmp/worklog`))).toBe(false)
          expect(withSymlink.results.filter((r) => r.outcome === 'would-delete')).toEqual([])
          expect(withSymlink.classes['cargo-target']?.scanStatus).toBe('scan-incomplete')
          expect(
            withSymlink.classes['cargo-target']?.keptByReason['scan-incomplete'],
          ).toBeUndefined()
          expect(
            withSymlink.classes['cargo-target']?.keptByReason['artifact-scan-incomplete'],
          ).toBeUndefined()

          expect(applyCandidate(f, { plan, path: nested }).exitCode).not.toBe(0)
          for (const root of [nested, rust, worklogTarget, `${outsideTarget}/big.bin`]) {
            expect(yield* exists(root)).toBe(true)
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      '7: a target containing a tracked file, or one that is not ignored, is kept',
      Effect.fnUntraced(
        function* () {
          const f = yield* budgetFixture(['feature/tracked', 'feature/unignored'])
          const tracked = worktree(f, 'feature/tracked')
          const unignored = worktree(f, 'feature/unignored')
          yield* ignoreTargets(tracked)
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(`${tracked}target`, { recursive: true })
          yield* fs.writeFileString(`${tracked}target/committed.txt`, 'tracked\n')
          yield* Git.runCommand({ args: ['add', '-f', 'target/committed.txt'], cwd: tracked })
          yield* Git.runCommand({
            args: ['commit', '--no-verify', '-m', 'track target file'],
            cwd: tracked,
          })
          yield* makeArtifact(`${tracked}target`, { files: { 'out.bin': MiB }, ageMs: 3 * DAY_MS })
          yield* makeArtifact(`${unignored}target`, {
            files: { 'out.bin': MiB },
            ageMs: 3 * DAY_MS,
          })
          yield* writePolicy(f, { budgetBytes: 0 })

          const plan = planOk(f)
          expect(row(plan, `${tracked}target`)).toMatchObject({
            outcome: 'keep',
            reason: 'artifact-tracked',
          })
          expect(row(plan, `${unignored}target`)).toMatchObject({
            outcome: 'keep',
            reason: 'artifact-not-ignored',
          })
          expect(plan.classes['cargo-target']?.status).toBe('over-budget-no-idle-candidate')
          expect(applyCandidate(f, { plan, path: `${unignored}target` }).exitCode).not.toBe(0)
          expect(yield* exists(`${tracked}target/committed.txt`)).toBe(true)
          expect(yield* exists(`${unignored}target/out.bin`)).toBe(true)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      '8: a write into the candidate between plan and apply makes apply refuse',
      Effect.fnUntraced(
        function* () {
          const { f, targetA } = yield* twoTargets()
          const plan = planOk(f)
          expect(row(plan, targetA)?.outcome).toBe('would-delete')
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString(`${targetA}/release/late-build-output.o`, 'fresh write')

          const refused = applyCandidate(f, { plan, path: targetA })
          expect(refused.exitCode).not.toBe(0)
          expect(refused.plan).toBeUndefined()
          expect(yield* exists(`${targetA}/release/late-build-output.o`)).toBe(true)
          expect(yield* exists(`${targetA}/release/app.bin`)).toBe(true)
          expect(planOk(f).planSha256).not.toBe(plan.planSha256)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    describe('9: merged-worktree teardown and the worklog (deterministic `gh` command fixture)', () => {
      const BRANCH = 'feature/merged'

      const writeGh = (f: Fixture, prs: ReadonlyArray<unknown>) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString(`${f.commandDir}/gh-prs.json`, encodeJson(prs))
          yield* fs.writeFileString(
            `${f.commandDir}/bin/gh`,
            '#!/bin/sh\n[ "$1 $2" = "pr list" ] || exit 64\nexec cat "${0%/*}/../gh-prs.json"\n',
          )
          yield* fs.chmod(`${f.commandDir}/bin/gh`, 0o755)
        })

      const pr = (state: 'MERGED' | 'OPEN') => ({
        number: 1,
        state,
        headRefName: BRANCH,
        mergedAt: state === 'MERGED' ? new Date(Date.now() - 30 * DAY_MS).toISOString() : null,
        closedAt: state === 'MERGED' ? new Date(Date.now() - 30 * DAY_MS).toISOString() : null,
      })

      /** Real reachable branch with a real worklog; first run seeds the cold observation. */
      const teardownFixture = ({
        teardown,
        prState,
      }: {
        teardown: 'delete' | 'retain'
        prState: 'MERGED' | 'OPEN'
      }) =>
        Effect.gen(function* () {
          const f = yield* budgetFixture([BRANCH], { withRemote: true })
          const w = worktree(f, BRANCH)
          const commit = yield* getWorktreeCommit(w)
          yield* Git.runCommand({
            args: ['branch', BRANCH, commit],
            cwd: f.bareRepoPaths[REPO_KEY]!,
          })
          yield* writePolicy(f, { budgetBytes: 0, teardown })
          const worklog = `${w}tmp/worklog/session`
          yield* makeArtifact(worklog, {
            files: { 'notes.md': 64 * 1024, 'cache/pnpm/blob': 128 * 1024 },
            ageMs: 3 * DAY_MS,
          })
          const worklogBytes = yield* allocatedBytes([`${w}tmp/worklog`])
          yield* writeGh(f, [])
          const seeded = runMr(f, [])
          expect(seeded.exitCode, seeded.stderr).toBe(0)
          expect(yield* exists(w)).toBe(true)
          yield* writeGh(f, [pr(prState)])
          // Teardown apply requires admitted activity under the lock; refresh so the
          // fixture manifest (no claims) is well within its 5-minute validity window.
          yield* writeManifest(f)
          return { f, w, worklog, worklogBytes }
        })

      const gcRow = (stdout: string, path: string) => {
        const json = decodeJson(stdout) as { results?: ReadonlyArray<Record<string, unknown>> }
        return (json.results ?? []).find(
          (result) => result['ref'] === BRANCH || result['path'] === path,
        )
      }

      it.effect(
        'teardown "delete" removes the merged worktree including tmp/worklog and records bytes',
        Effect.fnUntraced(
          function* () {
            const { f, w, worklog, worklogBytes } = yield* teardownFixture({
              teardown: 'delete',
              prState: 'MERGED',
            })
            const result = runMr(f, [])
            expect(result.exitCode, result.stderr).toBe(0)
            const receipt = gcRow(result.stdout, w)
            expect(receipt).toMatchObject({ status: 'reaped', reason: 'merged-worklog-teardown' })
            expect(receipt?.['worklogBytesRemoved']).toBeGreaterThan(0)
            expect(receipt?.['worklogBytesRemoved']).toBeLessThanOrEqual(worklogBytes)
            expect(yield* exists(w)).toBe(false)
            expect(yield* exists(worklog)).toBe(false)
            expect(receipt?.['recoverPath']).toBeUndefined()
            expect(receipt).toMatchObject({ worklogPolicyPath: f.policyPath })
            expect(receipt?.['worklogPolicySha256']).toMatch(/^[0-9a-f]{64}$/u)
          },
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        ),
      )

      it.effect(
        'teardown "delete" without admitted activity keeps the merged worktree and its worklog',
        Effect.fnUntraced(
          function* () {
            const { f, w, worklog } = yield* teardownFixture({
              teardown: 'delete',
              prState: 'MERGED',
            })
            yield* writeManifest(f, { variant: 'missing' })
            const result = runMr(f, [])
            expect(result.exitCode, result.stderr).toBe(0)
            expect(gcRow(result.stdout, w)).toMatchObject({
              status: 'kept',
              reason: 'agent-liveness-unavailable',
            })
            expect(yield* exists(`${worklog}/notes.md`)).toBe(true)
          },
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        ),
      )

      it.effect(
        'teardown "retain" keeps today\'s behavior: the worklog survives',
        Effect.fnUntraced(
          function* () {
            const { f, w } = yield* teardownFixture({ teardown: 'retain', prState: 'MERGED' })
            const result = runMr(f, [])
            expect(result.exitCode, result.stderr).toBe(0)
            const receipt = gcRow(result.stdout, w)
            expect(receipt?.['reason']).not.toBe('merged-worklog-teardown')
            expect(receipt?.['worklogBytesRemoved'] ?? 0).toBe(0)
            const survivingRoot =
              (yield* exists(w)) === true
                ? w
                : typeof receipt?.['recoverPath'] === 'string'
                  ? `${receipt['recoverPath'].replace(/\/?$/u, '/')}`
                  : undefined
            expect(
              survivingRoot,
              'retain must neither delete the worktree nor its worklog',
            ).toBeDefined()
            expect(yield* exists(`${survivingRoot}tmp/worklog/session/notes.md`)).toBe(true)
          },
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        ),
      )

      it.effect(
        'an unmerged worktree with a worklog is never removed even with teardown "delete"',
        Effect.fnUntraced(
          function* () {
            const { f, w, worklog } = yield* teardownFixture({
              teardown: 'delete',
              prState: 'OPEN',
            })
            const result = runMr(f, [])
            expect(result.exitCode, result.stderr).toBe(0)
            expect(gcRow(result.stdout, w)?.['status']).toBe('kept')
            expect(yield* exists(w)).toBe(true)
            expect(yield* exists(`${worklog}/notes.md`)).toBe(true)
          },
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        ),
      )
    })

    it.effect(
      '10: a malformed or unknown-schema budgets file exits non-zero and deletes nothing',
      Effect.fnUntraced(
        function* () {
          const { f, targetA, targetB } = yield* twoTargets({ budgetBytes: 0 })
          const valid = planOk(f)
          expect(row(valid, targetA)?.outcome).toBe('would-delete')
          const fs = yield* FileSystem.FileSystem
          const validPolicy = decodeJson(yield* fs.readFileString(f.policyPath)) as Record<
            string,
            unknown
          >
          const unknownField = encodeJson({ ...validPolicy, unexpected: true })
          const unknownSchema = encodeJson({
            ...(decodeJson(yield* fs.readFileString(f.policyPath)) as Record<string, unknown>),
            schemaVersion: 'megarepo.build-output-budgets.v99',
          })
          for (const content of [
            '{"schemaVersion": "megarepo.build-output-budgets.v1",',
            unknownSchema,
            unknownField,
          ]) {
            yield* fs.writeFileString(f.policyPath, content)
            for (const args of [
              ['--dry-run'],
              ['--expected-plan', valid.planSha256, '--candidate-path', targetA],
            ]) {
              const result = runBudgets(f, args)
              expect(result.exitCode).not.toBe(0)
              expect(result.plan).toBeUndefined()
            }
            expect(yield* exists(targetA)).toBe(true)
            expect(yield* exists(targetB)).toBe(true)
          }
          const unreadable = runMr(f, ['--budgets', `${f.state}/absent.json`, '--dry-run'])
          expect(unreadable.exitCode).not.toBe(0)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      '11: accounting counts hardlinked inodes once, never follows symlinks, and reports reflinks as allocated bytes',
      Effect.fnUntraced(
        function* () {
          const f = yield* budgetFixture(['feature/a', 'feature/b'])
          const a = worktree(f, 'feature/a')
          const b = worktree(f, 'feature/b')
          yield* ignoreTargets(a)
          yield* ignoreTargets(b)
          const targetA = `${a}target`
          const targetB = `${b}target`
          yield* makeArtifact(targetA, { files: { 'big.bin': 3 * MiB }, ageMs: 3 * DAY_MS })
          yield* Effect.promise(async () => {
            await link(`${targetA}/big.bin`, `${targetA}/big-hardlink.bin`)
            await ensureParent(`${targetB}/x`)
            await link(`${targetA}/big.bin`, `${targetB}/shared.bin`)
            // A reflink (or plain copy where unsupported) is reported by its own
            // `st_blocks`; physical ZFS block-clone savings are invisible to `du`/stat.
            spawnSync('cp', ['--reflink=auto', `${targetA}/big.bin`, `${targetA}/reflink.bin`])
            await backdate(a, new Date(Date.now() - 3 * DAY_MS))
            await backdate(b, new Date(Date.now() - 3 * DAY_MS))
          })
          yield* writePolicy(f, { budgetBytes: 64 * MiB })

          const plan = planOk(f)
          const aBytes = yield* allocatedBytes([targetA])
          expect(row(plan, targetA)?.allocatedBytes).toBe(aBytes)
          expect(row(plan, targetB)?.allocatedBytes).toBe(yield* allocatedBytes([targetB]))
          const union = yield* allocatedBytes([targetA, targetB])
          expect(plan.classes['cargo-target']?.totalBytes).toBe(union)
          // Three 3 MiB names to one inode plus the reflink copy: far below the logical 12 MiB.
          expect(union).toBeLessThan(9 * MiB)

          const outsideBig = `${f.outside}huge.bin`
          yield* Effect.promise(() => writeFile(outsideBig, randomBytes(8 * MiB)))
          const rust = `${a}rust/target`
          yield* Effect.promise(async () => {
            await ensureParent(`${rust}/x`)
            await symlink(outsideBig, `${rust}/huge.bin`)
            await backdate(`${a}rust`, new Date(Date.now() - 3 * DAY_MS))
          })
          const withSymlink = planOk(f)
          expect(row(withSymlink, rust)).toMatchObject({
            outcome: 'unknown',
            reason: 'artifact-scan-incomplete',
          })
          expect(withSymlink.classes['cargo-target']?.totalBytes).toBe(
            yield* allocatedBytes([targetA, targetB, rust]),
          )
          expect(withSymlink.classes['cargo-target']!.totalBytes).toBeLessThan(union + 8 * MiB)
          expect(yield* exists(outsideBig)).toBe(true)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

if (inOwnerNamespace === false && process.env['MEGAREPO_TEST_PRIVILEGED'] === '1')
  describe('privileged: root-snapshot and isolated-UID budget proof', () => {
    it.effect(
      'deployment: a root `mr store activity snapshot` covers foreign UIDs so the owner-run plan/apply can prove idleness',
      Effect.fnUntraced(
        function* () {
          const created = yield* twoTargets({ privileged: true })
          const { a, targetA, targetB } = created
          // Bundle the real CLI into the fixture: a distinct owner UID cannot
          // traverse the checkout's private home-directory ancestry.
          const outdir = `${created.f.state}/fixture-cli`
          const bundle = spawnSync(
            'bun',
            ['build', MR_BIN, '--target=bun', '--external=@opentui/core-*', '--outdir', outdir],
            { encoding: 'utf8' },
          )
          expect(bundle.status, bundle.stderr).toBe(0)
          const f: Fixture = { ...created.f, isolatedOwner: true, cliBin: `${outdir}/mr.js` }
          // Trusted coverage requires the manifest AND its whole parent ancestry to be
          // root-controlled (root-owned, not group/world-writable unless sticky like /tmp).
          // Hand the fixture temp root to root; store/.state/outside stay user-owned and
          // the fixture finalizer chowns everything back before scoped temp removal.
          const tmpRoot = f.outside.replace(/\/outside\/$/u, '')
          for (const command of [
            ['chown', '0:0', tmpRoot],
            ['chmod', '0755', tmpRoot],
            ['install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', `${tmpRoot}/root-activity`],
          ]) {
            const setup = spawnSync('sudo', ['-n', ...command], { encoding: 'utf8' })
            expect(setup.status, setup.stderr).toBe(0)
          }
          const rootDir = `${tmpRoot}/root-activity`
          const rootManifest = `${rootDir}/workspace-activity.json`
          const snapshot = () => {
            const result = runCli(f, ['store', 'activity', 'snapshot', '--output', rootManifest], {
              asRoot: true,
            })
            expect(result.exitCode, result.stderr).toBe(0)
            return decodeJson(spawnSync('cat', [rootManifest], { encoding: 'utf8' }).stdout) as {
              readonly producer: { readonly name: string; readonly version: string }
              readonly processCoverage?: string
              readonly processRoots?: ReadonlyArray<string>
              readonly complete: boolean
              readonly claims: ReadonlyArray<{
                readonly workspace: string
                readonly sources: ReadonlyArray<string>
                readonly active: boolean
              }>
            }
          }

          // A root-owned holder: the owner UID cannot read its /proc cwd, only the root producer can.
          // `ready` is printed by the root shell after it inherited the cwd, before exec'ing sleep.
          const holder = yield* Effect.acquireRelease(
            Effect.promise(() => {
              const { promise, resolve, reject } = Promise.withResolvers<ChildProcess>()
              const child = spawn('sudo', ['-n', 'sh', '-c', 'echo ready; exec sleep 120'], {
                cwd: a,
                stdio: ['ignore', 'pipe', 'ignore'],
              })
              child.stdout?.once('data', () => resolve(child))
              child.once('error', reject)
              child.once('exit', (code) => reject(new Error(`root holder exited early (${code})`)))
              return promise
            }),
            (child) => Effect.promise(() => stopRootHolder(child)),
          )
          const live = snapshot()
          const manifestOwner = yield* Effect.promise(() => lstat(rootManifest))
          expect(manifestOwner.uid).toBe(0)
          expect(manifestOwner.mode & 0o022).toBe(0)
          expect(live).toMatchObject({ processCoverage: 'all-uids', complete: true })
          expect(live.processRoots).toContain(f.storePath.replace(/\/$/u, ''))
          expect(live.producer.name).toBe('mr-process')
          const canonicalA = a.replace(/\/$/u, '')
          expect(
            live.claims.find((claim) => claim.workspace === canonicalA && claim.active === true)
              ?.sources,
          ).toContain('process')
          yield* writeGcConfig(f, { manifestPath: rootManifest, producer: live.producer.name })
          // A separate unprivileged UID isolates this proof from ambient owner
          // processes while keeping the real process table and PTY CLI.
          const ownership = spawnSync(
            'sudo',
            ['-n', 'chown', '-R', 'nobody:nogroup', f.storePath, f.outside, f.home],
            { encoding: 'utf8' },
          )
          expect(ownership.status, ownership.stderr).toBe(0)

          const ownerLive = runBudgets(f, ['--dry-run'], { asRoot: false })
          expect(ownerLive.exitCode, ownerLive.stderr).toBe(0)
          expect(row(ownerLive.plan!, targetA)).toMatchObject({ outcome: 'keep', reason: 'live' })
          expect(
            ownerLive.plan!.results.some((r) => r.reason === 'process-liveness-unavailable'),
          ).toBe(false)

          yield* Effect.promise(() => stopRootHolder(holder))
          const idle = snapshot()
          expect(idle.claims.some((claim) => claim.workspace === canonicalA)).toBe(false)
          const ownerPlan = runBudgets(f, ['--dry-run'], { asRoot: false })
          expect(ownerPlan.exitCode, ownerPlan.stderr).toBe(0)
          expect(row(ownerPlan.plan!, targetA)).toMatchObject({ outcome: 'would-delete' })
          expect(row(ownerPlan.plan!, targetB)).toMatchObject({ outcome: 'keep' })
          const applied = runBudgets(
            f,
            ['--expected-plan', ownerPlan.plan!.planSha256, '--candidate-path', targetA],
            { asRoot: false },
          )
          expect(applied.exitCode, applied.stderr).toBe(0)
          expect(applied.plan?.results).toEqual([
            expect.objectContaining({ path: targetA, outcome: 'deleted' }),
          ])
          expect(yield* exists(targetA)).toBe(false)
          expect(yield* exists(targetB)).toBe(true)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

/** SIGTERM the `sudo` parent, which relays it to the root-owned holder, then await exit. */
const stopRootHolder = (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  child.once('exit', () => resolve())
  child.kill('SIGTERM')
  return promise
}
