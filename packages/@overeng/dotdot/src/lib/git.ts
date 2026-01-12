/**
 * Git operations via Command
 */

import { Command } from '@effect/platform'
import { Effect, Schema } from 'effect'

/** Error when git command fails */
export class GitError extends Schema.TaggedError<GitError>()('GitError', {
  command: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Run a git command in a directory */
const runGit = (args: string[], cwd: string) =>
  Effect.gen(function* () {
    const command = Command.make('git', ...args).pipe(Command.workingDirectory(cwd))
    const result = yield* Command.string(command).pipe(
      Effect.mapError(
        (cause) =>
          new GitError({
            command: `git ${args.join(' ')}`,
            message: `Git command failed in ${cwd}`,
            cause,
          }),
      ),
    )
    return result.trim()
  })

/** Check if directory is a git repo */
export const isGitRepo = (path: string) =>
  Effect.gen(function* () {
    const result = yield* runGit(['rev-parse', '--git-dir'], path).pipe(
      Effect.map(() => true),
      Effect.catchAll(() => Effect.succeed(false)),
    )
    return result
  }).pipe(Effect.withSpan('git/isGitRepo'))

/** Get current HEAD revision */
export const getCurrentRev = (repoPath: string) =>
  runGit(['rev-parse', 'HEAD'], repoPath).pipe(Effect.withSpan('git/getCurrentRev'))

/** Get short revision (7 chars) */
export const getShortRev = (repoPath: string) =>
  runGit(['rev-parse', '--short', 'HEAD'], repoPath).pipe(Effect.withSpan('git/getShortRev'))

/** Get current branch name (or HEAD if detached) */
export const getCurrentBranch = (repoPath: string) =>
  runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath).pipe(
    Effect.withSpan('git/getCurrentBranch'),
  )

/** Check if working tree is dirty */
export const isDirty = (repoPath: string) =>
  Effect.gen(function* () {
    const status = yield* runGit(['status', '--porcelain'], repoPath)
    return status.length > 0
  }).pipe(Effect.withSpan('git/isDirty'))

/** Clone a repo */
export const clone = (url: string, targetPath: string) =>
  Effect.gen(function* () {
    const command = Command.make('git', 'clone', url, targetPath)
    yield* Command.string(command).pipe(
      Effect.mapError(
        (cause) =>
          new GitError({
            command: `git clone ${url} ${targetPath}`,
            message: `Failed to clone ${url}`,
            cause,
          }),
      ),
    )
  }).pipe(Effect.withSpan('git/clone'))

/** Checkout a specific revision */
export const checkout = (repoPath: string, rev: string) =>
  runGit(['checkout', rev], repoPath).pipe(Effect.withSpan('git/checkout'))

/** Fetch from remote */
export const fetch = (repoPath: string) =>
  runGit(['fetch'], repoPath).pipe(Effect.withSpan('git/fetch'))

/** Pull from remote */
export const pull = (repoPath: string) =>
  runGit(['pull'], repoPath).pipe(Effect.withSpan('git/pull'))

/** Get remote URL */
export const getRemoteUrl = (repoPath: string) =>
  runGit(['remote', 'get-url', 'origin'], repoPath).pipe(Effect.withSpan('git/getRemoteUrl'))

/** Error when shell command fails */
export class ShellError extends Schema.TaggedError<ShellError>()('ShellError', {
  command: Schema.String,
  cwd: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Run a shell command in a directory */
export const runShellCommand = (command: string, cwd: string) =>
  Effect.gen(function* () {
    const cmd = Command.make('sh', '-c', command).pipe(Command.workingDirectory(cwd))
    yield* Command.string(cmd).pipe(
      Effect.mapError(
        (cause) =>
          new ShellError({
            command,
            cwd,
            message: `Shell command failed`,
            cause,
          }),
      ),
    )
  }).pipe(Effect.withSpan('shell/run'))
