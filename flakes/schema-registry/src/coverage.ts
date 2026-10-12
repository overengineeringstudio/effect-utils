import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** Existing error names remain stable for catalog consumers. */
export class ExactGitTreeVerificationError extends Error {
  override readonly name = 'ExactGitTreeVerificationError'
}
/** Rejects evidence output paths inside the repository source tree. */
export class InvalidCoverageOutputDirectoryError extends Error {
  override readonly name = 'InvalidCoverageOutputDirectoryError'
}

/** Resolve existing ancestors so a symlink cannot route evidence back into the source tree. */
export const assertExternalOutputDirectory = (args: {
  readonly repositoryRoot: string
  readonly outputDirectory: string
}): string => {
  if (!isAbsolute(args.outputDirectory))
    throw new InvalidCoverageOutputDirectoryError('Coverage output directory must be absolute')
  const repositoryRoot = realpathSync(resolve(args.repositoryRoot))
  const outputDirectory = resolve(args.outputDirectory)
  let existingAncestor = outputDirectory
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) break
    existingAncestor = parent
  }
  const resolvedOutputDirectory = resolve(
    realpathSync(existingAncestor),
    relative(existingAncestor, outputDirectory),
  )
  const repositoryRelativeOutput = relative(repositoryRoot, resolvedOutputDirectory)
  if (
    repositoryRelativeOutput === '' ||
    (!repositoryRelativeOutput.startsWith('..') && !isAbsolute(repositoryRelativeOutput))
  )
    throw new InvalidCoverageOutputDirectoryError(
      'Coverage output directory must be outside the repository root',
    )
  return resolvedOutputDirectory
}

/** Requires the requested revision to be HEAD with no tracked or untracked changes. */
export const verifyExactGitTree = (args: {
  readonly repositoryRoot: string
  readonly revision: string
  readonly environment: NodeJS.ProcessEnv
}): void => {
  const gitOutput = (command: ReadonlyArray<string>): string => {
    try {
      return execFileSync('git', ['-C', args.repositoryRoot, ...command], {
        encoding: 'utf8',
        env: args.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch {
      throw new ExactGitTreeVerificationError(
        'Unable to verify the requested exact git tree provenance',
      )
    }
  }
  const head = gitOutput(['rev-parse', 'HEAD'])
  if (args.revision !== head)
    throw new ExactGitTreeVerificationError(
      'Requested exact git tree revision does not equal checkout HEAD',
    )
  if (gitOutput(['status', '--porcelain=v1', '--untracked-files=all']) !== '')
    throw new ExactGitTreeVerificationError(
      'Exact git tree provenance requires a clean tracked and untracked checkout',
    )
}
