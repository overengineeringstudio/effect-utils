import { ENTRY_FILENAME_PATTERN } from './contract.ts'

/**
 * Changelog coverage: a change to product source paths must ship with a new entry, or carry
 * an explicit waiver line in one of its commit messages:
 *
 *     changelog: none — internal refactor, nothing players can see
 *
 * Pure: callers collect changed files and commit messages (see `collectGitChanges`).
 */

/** Converts a repository glob (`*`, `**`, `?`) into an anchored regular expression. */
export const globToRegExp = (glob: string): RegExp => {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches everything below.
        const slash = glob[index + 2] === '/'
        source += slash ? '(?:.*/)?' : '.*'
        index += slash ? 2 : 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += /[.+^${}()|[\]\\]/u.test(char) ? `\\${char}` : char
    }
  }
  return new RegExp(`^${source}$`, 'u')
}

/** One file changed relative to the base, with its Git status letter. */
export interface ChangedFile {
  /** Repository-relative path with forward slashes. */
  readonly path: string
  /** `A` added, `M` modified, `D` deleted, `R`/`C` treated by their new path. */
  readonly status: 'A' | 'M' | 'D'
}

/** Which paths need an entry and where entries live (both repository-relative). */
export interface CoverageConfig {
  /** Globs of product source paths that need an entry when they change. */
  readonly paths: ReadonlyArray<string>
  /** Directory of authored `YYYY-MM-DD-slug.ts` entries. */
  readonly changelogDirectory: string
}

export type CoverageResult =
  | { readonly _tag: 'NotRequired' }
  | { readonly _tag: 'CoveredByEntry'; readonly entries: ReadonlyArray<string> }
  | { readonly _tag: 'Waived'; readonly reason: string }
  | { readonly _tag: 'Missing'; readonly sources: ReadonlyArray<string> }

/** `changelog: none — <reason>`; an em dash, en dash or one/two hyphens, and a real reason. */
export const WAIVER_PATTERN = /^changelog:\s*none\s*(?:—|–|--?)\s*(?<reason>\S.*?)\s*$/imu

/** Decides whether a change set satisfies the changelog rule. */
export const checkCoverage = ({
  config,
  changedFiles,
  commitMessages,
}: {
  readonly config: CoverageConfig
  readonly changedFiles: ReadonlyArray<ChangedFile>
  readonly commitMessages: ReadonlyArray<string>
}): CoverageResult => {
  const patterns = config.paths.map(globToRegExp)
  const directory = config.changelogDirectory.replace(/\/+$/u, '')
  const sources = changedFiles
    .map(({ path }) => path)
    .filter((path) => patterns.some((pattern) => pattern.test(path)))
  if (sources.length === 0) return { _tag: 'NotRequired' }
  const entries = changedFiles
    .filter(({ path, status }) => {
      if (status !== 'A') return false
      const slash = path.lastIndexOf('/')
      return (
        path.slice(0, Math.max(0, slash)) === directory &&
        ENTRY_FILENAME_PATTERN.test(path.slice(slash + 1))
      )
    })
    .map(({ path }) => path)
  if (entries.length > 0) return { _tag: 'CoveredByEntry', entries }
  for (const message of commitMessages) {
    const reason = WAIVER_PATTERN.exec(message)?.groups?.reason
    if (reason !== undefined) return { _tag: 'Waived', reason }
  }
  return { _tag: 'Missing', sources: sources.toSorted() }
}

/** Human-readable explanation for a failed check, naming both ways to satisfy it. */
export const describeMissingCoverage = ({
  config,
  sources,
}: {
  readonly config: CoverageConfig
  readonly sources: ReadonlyArray<string>
}): string =>
  [
    `Changed product sources need a changelog entry (${config.paths.join(', ')}):`,
    ...sources.slice(0, 12).map((source) => `  ${source}`),
    ...(sources.length > 12 ? [`  … and ${sources.length - 12} more`] : []),
    '',
    `Add ${config.changelogDirectory}/YYYY-MM-DD-slug.ts describing what users notice,`,
    'or, when nothing user-visible changed, add this line to a commit message:',
    '  changelog: none — <reason>',
  ].join('\n')
