import { Effect } from 'effect'

import type { AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'

/** Noncanonical default for fixtures that do not exercise a literal branch name. */
export const FIXTURE_BRANCH = 'fixture-main'

/** Initialize a source repo on the shared noncanonical fixture branch. */
export const initFixtureRepo = (cwd: AbsoluteDirPath) =>
  Git.runCommand({ cwd, args: ['init', '-b', FIXTURE_BRANCH] })

/** Push the fixture branch and attach its origin tracking ref. */
export const pushFixtureBranch = (cwd: AbsoluteDirPath) =>
  Git.runCommand({ cwd, args: ['push', '-u', 'origin', FIXTURE_BRANCH] })

/** Only call against a freshly initialized bare origin with no refs. */
export const bootstrapMain = Effect.fnUntraced(function* (cwd: AbsoluteDirPath) {
  const commit = yield* Git.runCommand({ cwd, args: ['rev-parse', 'HEAD'] })
  yield* Git.runCommand({ cwd, args: ['push', 'origin', `${commit}:refs/heads/main`] })
  yield* Git.runCommand({ cwd, args: ['fetch', 'origin'] })
  yield* Git.runCommand({ cwd, args: ['branch', '--set-upstream-to=origin/main'] })
})
