import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'

import { Effect, Option, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { withExclusiveDirectoryLock } from './git-writer-lock.ts'
import { buckDurationMs, canonicalBuckMaintainRoot } from './store-buck-maintain-config.ts'
import {
  BuckMaintainProgressError,
  canonicalBuckMaintainJson,
  validateBuckMaintainProgressOptions,
} from './store-buck-maintain-progress-schema.ts'
import {
  buckMaintainProgressReceipt,
  openBuckMaintainProgress,
  selectBuckMaintainProgressRoots,
  type BuckMaintainProgressSession,
} from './store-buck-maintain-progress-store.ts'
import { runBuckMaintain, type BuckMaintainProgressHooks } from './store-buck-maintain.ts'

const fail = (message: string) => new BuckMaintainProgressError({ message })

/** No environment variable or caller-provided revision is used as source attestation. */
export const readBuckMaintainRuntimeIdentity = Effect.fn('store.buckMaintain.progress.runtime')(function* () {
  const fs = yield* FileSystem.FileSystem
  const executable = yield* fs.realPath(process.execPath)
  if (process.argv[1] === undefined) return yield* fail('Cannot attest a packaged CLI entrypoint without argv[1]')
  const entrypoint = yield* fs.realPath(process.argv[1])
  for (const path of [executable, entrypoint]) {
    if (!/^\/nix\/store\/[a-z0-9]{32}-[^/]+\/.+/u.test(path))
      return yield* fail('Resumable dry-run requires an immutable packaged entrypoint and runtime in /nix/store')
  }
  const hashFile = (path: string) => fs.stream(path).pipe(
    Stream.runFold(() => createHash('sha256'), (hash, bytes) => hash.update(bytes)),
    Effect.map((hash) => hash.digest('hex')),
  )
  const executableSha256 = yield* hashFile(executable)
  return {
    executable, executableSha256, entrypoint,
    entrypointSha256: entrypoint === executable ? executableSha256 : yield* hashFile(entrypoint),
    platform: process.platform, arch: process.arch,
  }
})

/** Bounded resumable historical receipt. Never feeds historical entries to native actions. */
export const runBuckMaintainWithProgress = Effect.fn('store.buckMaintain.progress.run')(function* ({
  configPath, dryRun, progressDir, maxWorktrees,
}: { configPath: string | undefined; dryRun: boolean; progressDir: string; maxWorktrees: number | undefined }) {
  const invalid = validateBuckMaintainProgressOptions({ dryRun, progressDir, maxWorktrees })
  if (invalid !== undefined) return yield* invalid
  const fs = yield* FileSystem.FileSystem
  const runtime = yield* readBuckMaintainRuntimeIdentity()
  yield* fs.makeDirectory(resolve(progressDir), { recursive: true, mode: 0o700 })
  const directory = yield* fs.realPath(progressDir)
  const directoryInfo = yield* fs.lstat(directory)
  if (directoryInfo.type !== 'Directory' || Option.getOrUndefined(directoryInfo.uid) !== process.getuid?.())
    return yield* fail('Expected an owned progress directory')
  return yield* Effect.gen(function* () {
    let session: BuckMaintainProgressSession | undefined
    let selected: readonly string[] = []
    const mapError = (cause: unknown) => cause instanceof BuckMaintainProgressError ? cause : fail(String(cause))
    const progress: BuckMaintainProgressHooks = {
      selectWorktrees: (input) => Effect.gen(function* () {
        if (session !== undefined) return yield* fail('Progress inventory may only be selected once')
        const inventory = [...input.worktrees].sort()
        if (new Set(inventory).size !== inventory.length) return yield* fail('Duplicate canonical worktree roots')
        const roots = yield* Effect.forEach(input.config.worktreeRoots, (root) => canonicalBuckMaintainRoot(fs, resolve(
          configPath === undefined ? process.cwd() : dirname(resolve(configPath)), root,
        )))
        const configuration = canonicalBuckMaintainJson({
          ...input.config,
          host: hostname(),
          worktreeRoots: [...new Set(roots)].sort(),
          buckOut: {
            budgetBytes: input.config.buckOut.budgetBytes,
            keepSinceMs: buckDurationMs(input.config.buckOut.keepSince),
            fullCleanWhenInactiveForMs: input.config.buckOut.fullCleanWhenInactiveFor === undefined ? undefined : buckDurationMs(input.config.buckOut.fullCleanWhenInactiveFor),
          },
          daemon: { idleStopAfterMs: buckDurationMs(input.config.daemon.idleStopAfter) },
          maintainOwners: [...new Set(input.config.maintainOwners)].sort(),
          blackout: [...input.config.blackout].sort((a, b) => canonicalBuckMaintainJson(a).localeCompare(canonicalBuckMaintainJson(b))),
          storeBase: yield* fs.realPath(input.storeBase),
          activityConfig: input.activityConfig,
          currentAgent: process.env['ST_AGENT'] || null,
          environment: {
            home: process.env['HOME'] === undefined ? undefined : yield* fs.realPath(process.env['HOME']),
            buck2Binary: process.env['BUCK2_BIN'] === undefined ? undefined : yield* fs.realPath(process.env['BUCK2_BIN']),
            path: process.env['PATH'],
          },
        })
        session = yield* openBuckMaintainProgress({ directory, expected: { version: 1, dryRun: true, runtime, configuration, inventory } })
        selected = yield* selectBuckMaintainProgressRoots(session, maxWorktrees)
        return selected
      }).pipe(Effect.mapError(mapError)),
      onEntry: (entry, capture) => Effect.gen(function* () {
        if (session === undefined || !selected.includes(entry.worktree)) return yield* fail('Native runner emitted an unselected checkpoint root')
        yield* session.append(entry, capture)
      }).pipe(Effect.mapError(mapError)),
    }
    yield* runBuckMaintain({ configPath, dryRun: true, progress })
    if (session === undefined) return yield* fail('Native runner did not initialize progress inventory')
    for (const root of selected) {
      if (!session.records.has(session.manifest.inventory.indexOf(root))) return yield* fail('Native runner omitted a selected checkpoint result')
    }
    return buckMaintainProgressReceipt(session, selected.length)
  }).pipe(withExclusiveDirectoryLock(directory))
})
