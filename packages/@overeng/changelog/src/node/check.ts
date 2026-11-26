import { Effect, Schema, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import {
  checkCoverage,
  describeMissingCoverage,
  type ChangedFile,
  type CoverageResult,
} from '../enforcement.ts'
import { DEFAULT_CHANGELOG_DIRECTORY, type ChangelogConfig } from './config.ts'
import { changelogPaths, discoverEntries, readScreenshotRecord, screenshotHash } from './load.ts'

/** Git could not answer (e.g. the base ref is missing in a shallow clone). */
export class ChangelogGitError extends Schema.TaggedError<ChangelogGitError>()(
  'ChangelogGitError',
  { message: Schema.String, args: Schema.Array(Schema.String) },
) {}

/** The changelog check found problems; `problems` are ready to print. */
export class ChangelogCheckError extends Schema.TaggedError<ChangelogCheckError>()(
  'ChangelogCheckError',
  { problems: Schema.Array(Schema.String) },
) {
  override get message() {
    return this.problems.join('\n\n')
  }
}

const git = Effect.fn('changelog.git')(function* ({
  cwd,
  args,
}: {
  readonly cwd: string
  readonly args: ReadonlyArray<string>
}) {
  const spawner = yield* ChildProcessSpawner
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make('git', ['--no-optional-locks', ...args], { cwd, stderr: 'ignore' }),
      )
      const [stdout, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
        { concurrency: 'unbounded' },
      )
      if (code !== 0) {
        return yield* new ChangelogGitError({ message: `git exited with ${code}`, args: [...args] })
      }
      return stdout
    }),
  ).pipe(
    Effect.catchTag('PlatformError', (cause) =>
      Effect.fail(new ChangelogGitError({ message: String(cause), args: [...args] })),
    ),
  )
})

/**
 * Files changed under `root` since its merge-base with `base` (committed, staged, unstaged and
 * untracked), paths relative to `root`, plus the messages of the commits since the merge-base.
 */
export const collectGitChanges = Effect.fn('changelog.collectGitChanges')(function* ({
  root,
  base,
}: {
  readonly root: string
  readonly base: string
}) {
  const mergeBase = (yield* git({ cwd: root, args: ['merge-base', base, 'HEAD'] })).trim()
  const diff = yield* git({
    cwd: root,
    args: ['diff', '--name-status', '--no-renames', '--relative', mergeBase],
  })
  const untracked = yield* git({ cwd: root, args: ['ls-files', '--others', '--exclude-standard'] })
  const log = yield* git({ cwd: root, args: ['log', '--format=%B%x1e', `${mergeBase}..HEAD`] })
  const changedFiles: ChangedFile[] = []
  for (const line of diff.split('\n')) {
    const [status, path] = line.split('\t')
    if (status === undefined || path === undefined) continue
    changedFiles.push({ path, status: status === 'A' ? 'A' : status === 'D' ? 'D' : 'M' })
  }
  for (const path of untracked.split('\n')) {
    if (path !== '') changedFiles.push({ path, status: 'A' })
  }
  return {
    mergeBase,
    changedFiles: changedFiles as ReadonlyArray<ChangedFile>,
    commitMessages: log
      .split('\x1e')
      .map((message) => message.trim())
      .filter((m) => m !== ''),
  }
})

/** Report of a passing check. */
export interface ChangelogCheckReport {
  readonly entries: number
  readonly screenshots: number
  readonly coverage: CoverageResult
}

/**
 * The product's changelog gate:
 * 1. every entry decodes strictly and scenes pair with screenshot entries;
 * 2. changed source paths ship a new entry or a `changelog: none — <reason>` commit line;
 * 3. every screenshot is rendered and fresh (its recorded hash matches its inputs).
 *
 * Coverage needs the merge-base with `base`; a missing base or shallow history fails the check.
 */
export const checkChangelog = Effect.fn('changelog.check')(function* <Text, Fields>({
  config,
  base,
}: {
  readonly config: ChangelogConfig<Text, Fields>
  /** Git ref the change set is measured against, e.g. `origin/main`. */
  readonly base: string
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const problems: string[] = []
  const entries = yield* discoverEntries(config)
  const { screenshots } = yield* changelogPaths(config)
  let rendered = 0
  for (const entry of entries) {
    if (entry.source.screenshot === undefined) continue
    rendered++
    const record = yield* readScreenshotRecord({ config, id: entry.id })
    const expected = yield* screenshotHash({ config, entry })
    if (record === undefined) {
      problems.push(`${entry.file}: screenshot not rendered yet; run the changelog renderer`)
      continue
    }
    if (record.hash !== expected) {
      problems.push(
        `${entry.file}: screenshot is stale (its entry, scene or declared inputs changed); re-render it`,
      )
    }
    for (const image of record.images) {
      if ((yield* fs.exists(path.join(screenshots, image.file))) === false) {
        problems.push(`${entry.file}: rendered image ${image.file} is missing`)
      }
    }
    const expectedImages = config.screenshots.viewports.length * config.screenshots.schemes.length
    if (record.images.length !== expectedImages) {
      problems.push(
        `${entry.file}: expected ${expectedImages} images (viewports × schemes), found ${record.images.length}; re-render it`,
      )
    }
  }
  const coverageConfig = {
    paths: config.sourcePaths,
    changelogDirectory: config.changelogDirectory ?? DEFAULT_CHANGELOG_DIRECTORY,
  }
  const coverage = checkCoverage({
    config: coverageConfig,
    ...(yield* collectGitChanges({ root: config.root, base })),
  })
  if (coverage._tag === 'Missing') {
    problems.push(describeMissingCoverage({ config: coverageConfig, sources: coverage.sources }))
  }
  if (problems.length > 0) return yield* new ChangelogCheckError({ problems })
  return { entries: entries.length, screenshots: rendered, coverage } satisfies ChangelogCheckReport
})
