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
const runGit = ({ args, cwd }: { args: string[]; cwd: string }) =>
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

/**
 * Check if directory is a git repo by verifying exit code.
 * Note: We use `Command.exitCode` instead of `Command.string` because
 * `Command.string` does not fail on non-zero exit codes.
 */
export const isGitRepo = (path: string) =>
  Effect.gen(function* () {
    const command = Command.make('git', 'rev-parse', '--git-dir').pipe(
      Command.workingDirectory(path),
    )
    const exitCode = yield* Command.exitCode(command)
    return exitCode === 0
  }).pipe(Effect.withSpan('git/isGitRepo'))

/** Get current HEAD revision */
export const getCurrentRev = (repoPath: string) =>
  runGit({ args: ['rev-parse', 'HEAD'], cwd: repoPath }).pipe(Effect.withSpan('git/getCurrentRev'))

/** Get short revision (7 chars) */
export const getShortRev = (repoPath: string) =>
  runGit({ args: ['rev-parse', '--short', 'HEAD'], cwd: repoPath }).pipe(
    Effect.withSpan('git/getShortRev'),
  )

/** Get current branch name (or HEAD if detached) */
export const getCurrentBranch = (repoPath: string) =>
  runGit({ args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: repoPath }).pipe(
    Effect.withSpan('git/getCurrentBranch'),
  )

/** Check if working tree is dirty */
export const isDirty = (repoPath: string) =>
  Effect.gen(function* () {
    const status = yield* runGit({ args: ['status', '--porcelain'], cwd: repoPath })
    return status.length > 0
  }).pipe(Effect.withSpan('git/isDirty'))

/** Clone a repo */
export const clone = ({ url, targetPath }: { url: string; targetPath: string }) =>
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
export const checkout = ({
  repoPath,
  rev,
  force = false,
}: {
  repoPath: string
  rev: string
  force?: boolean
}) =>
  runGit({
    args: force ? ['checkout', '--force', rev] : ['checkout', rev],
    cwd: repoPath,
  }).pipe(Effect.withSpan('git/checkout'))

/** Fetch from remote */
export const fetch = (repoPath: string) =>
  runGit({ args: ['fetch'], cwd: repoPath }).pipe(Effect.withSpan('git/fetch'))

/** Pull from remote */
export const pull = (repoPath: string) =>
  runGit({ args: ['pull'], cwd: repoPath }).pipe(Effect.withSpan('git/pull'))

/** Get remote URL */
export const getRemoteUrl = (repoPath: string) =>
  runGit({ args: ['remote', 'get-url', 'origin'], cwd: repoPath }).pipe(
    Effect.withSpan('git/getRemoteUrl'),
  )

/** Error when shell command fails */
export class ShellError extends Schema.TaggedError<ShellError>()('ShellError', {
  command: Schema.String,
  cwd: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Run a shell command in a directory, returns stdout */
export const runShellCommand = ({ command, cwd }: { command: string; cwd: string }) =>
  Effect.gen(function* () {
    const cmd = Command.make('sh', '-c', command).pipe(Command.workingDirectory(cwd))
    const output = yield* Command.string(cmd).pipe(
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
    return output.trim()
  }).pipe(Effect.withSpan('shell/run'))
