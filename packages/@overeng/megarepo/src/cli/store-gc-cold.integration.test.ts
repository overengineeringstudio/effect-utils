/**
 * Integration tests for the cold named-branch reclamation path of `mr store gc`
 * (U7 / decisions 0001–0010).
 *
 * Runs the REAL `mr store gc` command (through `mrCommand`) against store-shaped
 * fixtures with a deterministic decision clock (fixed `Clock`) and a stub
 * `PrStateResolver` layer (no real `gh`/network). Exercises the full matrix from
 * the plan's Test section:
 *
 *  - cross-megarepo registered ⇒ kept (live) vs unregistered+merged ⇒ archived
 *  - repin-without-reregister ⇒ new target kept (reconcile-all, B2 + 0010 bug)
 *  - present-but-unreadable workspace ⇒ its live worktree kept (B2)
 *  - merged + clean + reachable ⇒ archived + branch freed (mr-apply re-add works)
 *  - merged + dirty ⇒ archived with dirt intact
 *  - merged + stash ⇒ kept (B3)
 *  - merged + unpushed ⇒ kept (B1)
 *  - open ⇒ kept
 *  - squash-merged + remote-branch-deleted ⇒ kept (no reachable proof)
 *  - absence/post-merge grace unmet ⇒ kept
 *  - archived past retention ⇒ reaped; within retention ⇒ kept
 *  - veto re-checked at archive AND reap (a worktree made live mid-run is kept)
 *  - archive ⇒ mr-apply-equivalent re-materializes the branch (B4)
 *
 * The lossless floor, archive mechanics, and classifier gates have their own unit
 * + library integration tests; here we assert the END-TO-END command outcome
 * (`status`/`reason` in the JSON document and the on-disk effect).
 */

import * as Cli from '@effect/cli'
import { Command, FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Clock, Effect, Exit, Layer, Schema } from 'effect'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath, type RelativeDirPath } from '@overeng/effect-path'

import * as Git from '../lib/git.ts'
import { refreshWorkspaceRegistry } from '../lib/store-liveness.ts'
import { makeStubPrStateResolverLayer, type GhPr, type StubPrRepo } from '../lib/store-pr-state.ts'
import { makeStoreLayer, Store } from '../lib/store.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import {
  createArchiveEntry,
  createStoreFixture,
  createWorkspaceWithLock,
  getWorktreeCommit,
  repinWorkspace,
} from '../test-utils/store-setup.ts'
import { Cwd } from './context.ts'
import { mrCommand } from './mod.ts'

const DAY_MS = 24 * 60 * 60 * 1000
/** A fixed decision clock: well past every default grace window. */
const NOW = Date.parse('2026-06-11T12:00:00.000Z')

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const command = Command.make('git', ...args).pipe(Command.workingDirectory(cwd))
    return (yield* Command.string(command)).trim()
  })

/** Deterministic clock so grace/retention decisions are reproducible. */
const fixedClockLayer = (nowMs: number) =>
  Layer.setClock({
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    currentTimeMillis: Effect.succeed(nowMs),
    currentTimeNanos: Effect.succeed(BigInt(nowMs) * 1_000_000n),
    sleep: () => Effect.void,
    unsafeCurrentTimeMillis: () => nowMs,
    unsafeCurrentTimeNanos: () => BigInt(nowMs) * 1_000_000n,
  })

const StoreGcJsonOutput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      repo: Schema.String,
      ref: Schema.String,
      path: Schema.String,
      status: Schema.String,
      message: Schema.optional(Schema.String),
      reason: Schema.optional(Schema.String),
      recoverPath: Schema.optional(Schema.String),
    }),
  ),
})
const decodeGc = Schema.decodeUnknownSync(Schema.parseJson(StoreGcJsonOutput))
type GcResult = Schema.Schema.Type<typeof StoreGcJsonOutput>['results'][number]

const findByRef = (results: ReadonlyArray<GcResult>, ref: string) =>
  results.find((result) => result.ref === ref)

/**
 * Run `mr store gc` end-to-end with a fixed clock, an injected stub
 * `PrStateResolver`, and `MEGAREPO_STORE` pointed at the fixture store.
 */
const runGc = ({
  cwd,
  storePath,
  prRepos,
  now = NOW,
  args = [],
}: {
  cwd: AbsoluteDirPath
  storePath: AbsoluteDirPath
  prRepos: ReadonlyArray<StubPrRepo>
  now?: number
  args?: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines } = yield* makeConsoleCapture
    const previous = process.env['MEGAREPO_STORE']
    process.env['MEGAREPO_STORE'] = storePath

    const argv = ['node', 'mr', 'store', 'gc', ...args, '--output', 'json']
    const exit = yield* Cli.Command.run(mrCommand, { name: 'mr', version: 'test' })(argv).pipe(
      Effect.provideService(Cwd, cwd),
      Effect.provide(consoleLayer),
      Effect.provide(makeStubPrStateResolverLayer(prRepos)),
      Effect.provide(fixedClockLayer(now)),
      Effect.exit,
    )

    if (previous === undefined) delete process.env['MEGAREPO_STORE']
    else process.env['MEGAREPO_STORE'] = previous

    const stdout = (yield* getStdoutLines).join('\n')
    return { exitCode: Exit.isSuccess(exit) === true ? 0 : 1, results: decodeGc(stdout).results }
  }).pipe(Effect.scoped)

const REPO = { host: 'github.com', owner: 'acme', repo: 'widget' } as const
const REPO_KEY = `${REPO.host}/${REPO.owner}/${REPO.repo}`
const REPO_RELATIVE = `${REPO_KEY}/` as RelativeDirPath

const mergedPr = (branch: string, mergedAt: number): GhPr => ({
  number: 1,
  state: 'MERGED',
  headRefName: branch,
  mergedAt: new Date(mergedAt).toISOString(),
  closedAt: new Date(mergedAt).toISOString(),
})

const openPr = (branch: string): GhPr => ({
  number: 2,
  state: 'OPEN',
  headRefName: branch,
  mergedAt: null,
  closedAt: null,
})

/** Materialize a real `refs/heads/<branch>` ref for a fixture (detached) worktree. */
const materializeBranchRef = ({
  bareRepoPath,
  branch,
  commit,
}: {
  bareRepoPath: AbsoluteDirPath
  branch: string
  commit: string
}) => git(bareRepoPath, 'branch', branch, commit)

/**
 * Pre-seed the observation ledger so absence grace (default 14d) is already
 * satisfied at NOW: run gc once `sinceDays` in the past with no PR evidence, which
 * records `firstSeenColdAtMs` for every then-cold named worktree.
 */
const seedColdObservation = ({
  cwd,
  storePath,
  sinceDays = 20,
}: {
  cwd: AbsoluteDirPath
  storePath: AbsoluteDirPath
  sinceDays?: number
}) =>
  runGc({
    cwd,
    storePath,
    prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
    now: NOW - sinceDays * DAY_MS,
  })

/** An outside cwd (not in any megarepo) so gc uses the registry-only liveness. */
const outsideCwd = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const cwd = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('outside/'))
    yield* fs.makeDirectory(cwd, { recursive: true })
    return cwd
  })

describe('mr store gc — cold named-branch reclamation', () => {
  it.effect(
    'merged + clean + reachable ⇒ archived, branch freed, mr-apply re-add works',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/merged'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/merged`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/merged', commit })

        const cwd = yield* outsideCwd()
        yield* seedColdObservation({ cwd, storePath })
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/merged', NOW - 30 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/merged')
        expect(result?.status).toBe('archived')
        expect(result?.reason).toBe('merged')
        expect(result?.recoverPath).toContain('/.archive/feature/merged--')
        // Original gone, branch freed.
        expect(yield* fs.exists(worktreePath)).toBe(false)
        expect(
          yield* Git.refExists({ repoPath: bareRepoPath, ref: 'refs/heads/feature/merged' }),
        ).toBe(false)
        // mr-apply-equivalent re-materialization succeeds (B4).
        const reAddPath = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir(`${REPO_KEY}/refs/heads/feature/merged/`),
        )
        yield* git(bareRepoPath, 'branch', 'feature/merged', commit)
        yield* git(bareRepoPath, 'worktree', 'add', reAddPath, 'feature/merged')
        expect(yield* fs.exists(reAddPath)).toBe(true)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'merged + dirty ⇒ archived with dirt intact',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          {
            ...REPO,
            branches: ['feature/dirty'],
            dirtyWorktrees: ['feature/dirty'],
            withRemote: true,
          },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/dirty`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/dirty', commit })

        const cwd = yield* outsideCwd()
        yield* seedColdObservation({ cwd, storePath })
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/dirty', NOW - 30 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/dirty')
        expect(result?.status).toBe('archived')
        // The dirt traveled with the move.
        const dest = EffectPath.unsafe.absoluteDir(`${result!.recoverPath!.replace(/\/+$/, '')}/`)
        expect(
          yield* fs.readFileString(
            EffectPath.ops.join(dest, EffectPath.unsafe.relativeFile('dirty.txt')),
          ),
        ).toBe('uncommitted changes\n')
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'merged + unpushed ⇒ kept (B1: unrecoverable local history)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/unpushed'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/unpushed`]!

        // Create a local commit on the worktree that is on NO remote.
        yield* fs.writeFileString(
          EffectPath.ops.join(worktreePath, EffectPath.unsafe.relativeFile('local.txt')),
          'local-only\n',
        )
        yield* git(worktreePath, 'add', '-A')
        yield* git(worktreePath, 'commit', '--no-verify', '-m', 'local only')
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/unpushed', commit })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/unpushed', NOW - 30 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/unpushed')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('unrecoverable-local-work')
        expect(yield* fs.exists(worktreePath)).toBe(true)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'merged + stash ⇒ kept (B3: stash does not travel with a dir move)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/stash'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/stash`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/stash', commit })
        // Put a real stash (modify a tracked file then stash).
        yield* git(worktreePath, 'checkout', 'feature/stash')
        yield* fs.writeFileString(
          EffectPath.ops.join(worktreePath, EffectPath.unsafe.relativeFile('README.md')),
          '# modified for stash\n',
        )
        yield* git(worktreePath, 'stash')

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/stash', NOW - 30 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/stash')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('unrecoverable-local-work')
        expect(yield* fs.exists(worktreePath)).toBe(true)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'open PR ⇒ kept (not-stale)',
    Effect.fnUntraced(
      function* () {
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/open'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/open`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/open', commit })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [openPr('feature/open')] }],
        })

        const result = findByRef(results, 'feature/open')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('not-stale')
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'squash-merged + remote branch deleted (no PR evidence) ⇒ kept',
    Effect.fnUntraced(
      function* () {
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/squash'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/squash`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/squash', commit })

        const cwd = yield* outsideCwd()
        // No PR rows for this branch ⇒ resolver returns `none` ⇒ keep (not-stale).
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
        })

        const result = findByRef(results, 'feature/squash')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('not-stale')
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'merged but within post-merge grace ⇒ kept (grace)',
    Effect.fnUntraced(
      function* () {
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/grace'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/grace`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/grace', commit })

        const cwd = yield* outsideCwd()
        // Pre-seed the observation ledger (absence grace already elapsed) by running
        // gc once at an earlier time, then run again within the post-merge window.
        yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
          now: NOW - 20 * DAY_MS,
        })
        // Merged 1 day ago (< 7d post-merge grace) at the real NOW.
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/grace', NOW - 1 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/grace')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('post-merge-grace')
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'absence grace unmet (first observation this run) ⇒ kept',
    Effect.fnUntraced(
      function* () {
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/fresh'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/fresh`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/fresh', commit })

        const cwd = yield* outsideCwd()
        // First-ever observation: coldSince === now ⇒ absence grace not yet elapsed.
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/fresh', NOW - 30 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/fresh')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('absence-grace')
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'registered by another workspace ⇒ kept (live); unregistered+merged ⇒ archived',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/live', 'feature/dead'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const livePath = worktreePaths[`${REPO_KEY}#feature/live`]!
        const deadPath = worktreePaths[`${REPO_KEY}#feature/dead`]!
        const liveCommit = yield* getWorktreeCommit(livePath)
        const deadCommit = yield* getWorktreeCommit(deadPath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/live', commit: liveCommit })
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/dead', commit: deadCommit })

        // Observe both branches cold in the past so absence grace is satisfied.
        yield* seedColdObservation({ cwd: yield* outsideCwd(), storePath })

        // Register a workspace that consumes feature/live via a repos/ symlink.
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { widget: 'acme/widget#feature/live' },
        })
        yield* fs.makeDirectory(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/')),
          { recursive: true },
        )
        yield* fs.symlink(
          livePath.replace(/\/+$/, ''),
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/widget')),
        )
        const store = yield* Store.pipe(Effect.provide(makeStoreLayer({ basePath: storePath })))
        yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store, now: NOW })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            {
              relativePath: REPO_RELATIVE,
              prs: [
                mergedPr('feature/live', NOW - 30 * DAY_MS),
                mergedPr('feature/dead', NOW - 30 * DAY_MS),
              ],
            },
          ],
        })

        expect(findByRef(results, 'feature/live')?.status).toBe('kept')
        expect(findByRef(results, 'feature/live')?.reason).toBe('live')
        expect(findByRef(results, 'feature/dead')?.status).toBe('archived')
        expect(yield* fs.exists(livePath)).toBe(true)
        expect(yield* fs.exists(deadPath)).toBe(false)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'repin-without-reregister ⇒ reconcile-all keeps the new target (B2 / 0010)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/old', 'feature/new'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const oldPath = worktreePaths[`${REPO_KEY}#feature/old`]!
        const newPath = worktreePaths[`${REPO_KEY}#feature/new`]!
        const oldCommit = yield* getWorktreeCommit(oldPath)
        const newCommit = yield* getWorktreeCommit(newPath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/old', commit: oldCommit })
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/new', commit: newCommit })

        // Register a workspace pointing at feature/old, then repin to feature/new
        // WITHOUT re-registering (stale liveness record still names old).
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { widget: 'acme/widget#feature/old' },
        })
        yield* fs.makeDirectory(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/')),
          { recursive: true },
        )
        yield* fs.symlink(
          oldPath.replace(/\/+$/, ''),
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/widget')),
        )
        const store = yield* Store.pipe(Effect.provide(makeStoreLayer({ basePath: storePath })))
        yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store, now: NOW })
        yield* repinWorkspace({ workspacePath, memberName: 'widget', newTarget: newPath })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            {
              relativePath: REPO_RELATIVE,
              prs: [
                mergedPr('feature/old', NOW - 30 * DAY_MS),
                mergedPr('feature/new', NOW - 30 * DAY_MS),
              ],
            },
          ],
        })

        // reconcile-all re-derives feature/new from the repinned symlink ⇒ kept.
        expect(findByRef(results, 'feature/new')?.status).toBe('kept')
        expect(findByRef(results, 'feature/new')?.reason).toBe('live')
        expect(yield* fs.exists(newPath)).toBe(true)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'present-but-unreadable workspace ⇒ its live worktree kept (fail safe, B2)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/protected'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const protectedPath = worktreePaths[`${REPO_KEY}#feature/protected`]!
        const commit = yield* getWorktreeCommit(protectedPath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/protected', commit })

        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { widget: 'acme/widget#feature/protected' },
        })
        yield* fs.makeDirectory(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/')),
          { recursive: true },
        )
        yield* fs.symlink(
          protectedPath.replace(/\/+$/, ''),
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/widget')),
        )
        const store = yield* Store.pipe(Effect.provide(makeStoreLayer({ basePath: storePath })))
        yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store, now: NOW })

        // Make the workspace's members dir unreadable so a strict reconcile errors;
        // the last-known live path must be preserved (never overwritten with empty).
        const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
        yield* fs.chmod(reposDir, 0o000)

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            {
              relativePath: REPO_RELATIVE,
              prs: [mergedPr('feature/protected', NOW - 30 * DAY_MS)],
            },
          ],
        }).pipe(Effect.ensuring(fs.chmod(reposDir, 0o755).pipe(Effect.ignore)))

        const result = findByRef(results, 'feature/protected')
        expect(result?.status).toBe('kept')
        // live (last-known path retained) — NOT archived.
        expect(yield* fs.exists(protectedPath)).toBe(true)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'ref_mismatch (HEAD on a different branch) ⇒ kept',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/claimed'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/claimed`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        // Check out a DIFFERENT branch in the worktree than the path claims.
        yield* git(bareRepoPath, 'branch', 'feature/other', commit)
        yield* git(worktreePath, 'checkout', 'feature/other')

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            {
              relativePath: REPO_RELATIVE,
              prs: [mergedPr('feature/claimed', NOW - 30 * DAY_MS)],
            },
          ],
        })

        const result = findByRef(results, 'feature/claimed')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('ref_mismatch')
        expect(yield* fs.exists(worktreePath)).toBe(true)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'fetch failure (no remote configured) ⇒ all named worktrees kept',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        // No `withRemote`: the bare has no `origin`, so `fetch --prune origin` fails.
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/no-remote'] },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/no-remote`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/no-remote', commit })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            {
              relativePath: REPO_RELATIVE,
              prs: [mergedPr('feature/no-remote', NOW - 30 * DAY_MS)],
            },
          ],
        })

        const result = findByRef(results, 'feature/no-remote')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('fetch-failed')
        expect(yield* fs.exists(worktreePath)).toBe(true)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'archive past retention ⇒ reaped; within retention ⇒ kept',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['live/keep'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const repoRoot = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir(`${REPO_KEY}/`),
        )
        const commit = yield* getWorktreeCommit(worktreePaths[`${REPO_KEY}#live/keep`]!)

        // One archived 40d ago (> 30d retention) and one 5d ago (within).
        const { archivePath: stalePath } = yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'feature/stale',
          commit,
          archivedAt: new Date(NOW - 40 * DAY_MS),
        })
        const { archivePath: freshPath } = yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'feature/fresh-archive',
          commit,
          archivedAt: new Date(NOW - 5 * DAY_MS),
        })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
        })

        const reaped = results.find((r) => r.status === 'reaped')
        expect(reaped?.ref).toBe('feature/stale')
        expect(yield* fs.exists(stalePath)).toBe(false)
        // The within-retention archive is untouched and not reported as reaped.
        expect(yield* fs.exists(freshPath)).toBe(true)
        expect(
          results.some((r) => r.status === 'reaped' && r.ref === 'feature/fresh-archive'),
        ).toBe(false)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'veto re-check at reap: an archive that became live ⇒ kept, not reaped',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['live/keep'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const repoRoot = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir(`${REPO_KEY}/`),
        )
        const commit = yield* getWorktreeCommit(worktreePaths[`${REPO_KEY}#live/keep`]!)

        const { archivePath } = yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'feature/contested',
          commit,
          archivedAt: new Date(NOW - 40 * DAY_MS),
        })

        // Register a workspace whose symlink points AT the archived path, so the
        // under-lock veto re-check finds it live and refuses to reap (invariant 1).
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { widget: 'acme/widget#feature/contested' },
        })
        yield* fs.makeDirectory(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/')),
          { recursive: true },
        )
        yield* fs.symlink(
          archivePath.replace(/\/+$/, ''),
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/widget')),
        )
        const store = yield* Store.pipe(Effect.provide(makeStoreLayer({ basePath: storePath })))
        yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store, now: NOW })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
        })

        const result = findByRef(results, 'feature/contested')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('live')
        expect(yield* fs.exists(archivePath)).toBe(true)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'dry-run ⇒ reports archive/reap intent without mutating disk',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/merged'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/merged`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/merged', commit })
        // Seed an old observation so absence grace is satisfied on the dry run.
        yield* runGc({
          cwd: yield* outsideCwd(),
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
          now: NOW - 20 * DAY_MS,
        })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/merged', NOW - 30 * DAY_MS)] },
          ],
          args: ['--dry-run'],
        })

        expect(findByRef(results, 'feature/merged')?.status).toBe('archived')
        // Dry run leaves the worktree and branch intact.
        expect(yield* fs.exists(worktreePath)).toBe(true)
        expect(
          yield* Git.refExists({ repoPath: bareRepoPath, ref: 'refs/heads/feature/merged' }),
        ).toBe(true)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    '--all is unchanged: removes named worktrees (no cold path)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/x'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/x`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/x', commit })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          // No PR rows — under --all this is irrelevant (everything is removed).
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
          args: ['--all'],
        })

        const result = findByRef(results, 'feature/x')
        expect(result?.status).toBe('removed')
        // Not archived/kept — the legacy --all path owns it.
        expect(result?.reason).toBeUndefined()
        expect(yield* fs.exists(worktreePath)).toBe(false)
      },
      Effect.provide(NodeContext.layer),
      Effect.scoped,
    ),
  )
})
