#!/usr/bin/env -S bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'

/** Stable wire identity for the stateless Buck-owned-file census. */
export const buckOwnedFilesSchema = 'buck-owned-files/v1' as const

/** Zero/one/many classification for one candidate's Buck owners. */
export type BuckOwnedFileOwnership = 'multiply-owned' | 'owned' | 'unowned'

/** Canonical ownership evidence for one repository-relative file. */
export type BuckOwnedFile = {
  readonly path: string
  readonly ownership: BuckOwnedFileOwnership
  readonly owners: readonly string[]
}

/** Stable owned-file census report persisted and rendered by the command. */
export type BuckOwnedFilesReport = {
  readonly schema: typeof buckOwnedFilesSchema
  readonly files: readonly BuckOwnedFile[]
}

type CommandInvocation = {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

type CommandResult = {
  readonly status: number | null
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

/** Injectable Git/Buck process boundary for focused census tests. */
export type OwnedFilesCommandRunner = (invocation: CommandInvocation) => CommandResult

/** Runtime tools and working directory for one stateless ownership census. */
export type RunBuckOwnedFilesCensusOptions = {
  readonly cwd: string
  readonly git?: string
  readonly buck2?: string
  readonly runCommand?: OwnedFilesCommandRunner
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

const fail = (message: string): never => {
  throw new Error(`buck owned files: ${message}`)
}

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const decodeUtf8 = ({
  bytes,
  name,
}: {
  readonly bytes: Uint8Array
  readonly name: string
}): string => {
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    return fail(`${name} is not valid UTF-8`)
  }
}

/** Rejects paths that cannot denote one portable repository-relative file. */
export const requireRepositoryRelativePath = (value: string): string => {
  const components = value.split('/')
  if (
    value.length === 0 ||
    isAbsolute(value) === true ||
    /^[A-Za-z]:\//.test(value) === true ||
    value.includes('\\') === true ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)
    }) === true ||
    components.some((component) => component === '' || component === '.' || component === '..') ===
      true
  ) {
    return fail(
      `path must be a normalized portable repository-relative path: ${JSON.stringify(value)}`,
    )
  }
  return value
}

/** Decodes Git's unambiguous NUL-delimited candidate-path output. */
export const parseGitCandidatePaths = (stdout: Uint8Array): readonly string[] => {
  const encoded = decodeUtf8({ bytes: stdout, name: 'Git candidate output' })
  if (encoded.length === 0) return fail('Git candidate census is empty')
  if (encoded.endsWith('\0') === false) return fail('Git candidate output is not NUL terminated')

  const paths = encoded
    .slice(0, -1)
    .split('\0')
    .map(requireRepositoryRelativePath)
    .toSorted((left, right) => compareStrings({ left, right }))
  for (let index = 1; index < paths.length; index += 1) {
    if (paths[index - 1] === paths[index])
      return fail(`Git candidate output repeats path: ${paths[index]}`)
  }
  return paths
}

const requireOwner = ({ value, path }: { value: unknown; path: string }): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)
    }) === true
  ) {
    return fail(`Buck owner for ${JSON.stringify(path)} must be a non-empty single-line label`)
  }
  return value
}

/** Strictly decodes Buck's grouped `owner(%s)` JSON response. */
export const parseBuckOwnershipQuery = ({
  candidates,
  stdout,
}: {
  readonly candidates: readonly string[]
  readonly stdout: Uint8Array
}): ReadonlyMap<string, readonly string[]> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8({ bytes: stdout, name: 'Buck ownership output' }))
  } catch (error) {
    if (error instanceof Error === true && error.message.startsWith('buck owned files:') === true)
      throw error
    return fail(
      `Buck ownership output is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (parsed === null || Array.isArray(parsed) === true || typeof parsed !== 'object') {
    return fail('Buck ownership output must be an object grouped by candidate path')
  }

  const candidateSet = new Set(candidates)
  const entries = Object.entries(parsed)
  for (const [path] of entries) {
    requireRepositoryRelativePath(path)
    if (candidateSet.has(path) === false) {
      return fail(`Buck ownership output contains unexpected path: ${JSON.stringify(path)}`)
    }
  }
  if (entries.length !== candidates.length) {
    const missing = candidates.find((path) => Object.hasOwn(parsed, path) === false)
    return fail(`Buck ownership output is missing path: ${JSON.stringify(missing)}`)
  }

  return new Map(
    candidates.map((path) => {
      const rawOwners = Reflect.get(parsed, path)
      if (Array.isArray(rawOwners) === false) {
        return fail(`Buck owners for ${JSON.stringify(path)} must be an array`)
      }
      const owners = rawOwners
        .map((owner) => requireOwner({ value: owner, path }))
        .toSorted((left, right) => compareStrings({ left, right }))
      for (let index = 1; index < owners.length; index += 1) {
        if (owners[index - 1] === owners[index]) {
          return fail(
            `Buck ownership output repeats owner ${JSON.stringify(owners[index])} for ${JSON.stringify(path)}`,
          )
        }
      }
      return [path, owners] as const
    }),
  )
}

/** Builds the canonical zero/one/many classification report. */
export const makeBuckOwnedFilesReport = ({
  candidates,
  ownersByPath,
}: {
  readonly candidates: readonly string[]
  readonly ownersByPath: ReadonlyMap<string, readonly string[]>
}): BuckOwnedFilesReport => ({
  schema: buckOwnedFilesSchema,
  files: candidates
    .map(requireRepositoryRelativePath)
    .toSorted((left, right) => compareStrings({ left, right }))
    .map((path): BuckOwnedFile => {
      const owners = ownersByPath.get(path)
      if (owners === undefined)
        return fail(`ownership query has no result for ${JSON.stringify(path)}`)
      const sortedOwners = owners
        .map((owner) => requireOwner({ value: owner, path }))
        .toSorted((left, right) => compareStrings({ left, right }))
      return {
        path,
        ownership:
          sortedOwners.length === 0
            ? 'unowned'
            : sortedOwners.length === 1
              ? 'owned'
              : 'multiply-owned',
        owners: sortedOwners,
      }
    }),
})

/** A census passes only when every candidate has exactly one Buck owner. */
export const buckOwnedFilesReportPasses = (report: BuckOwnedFilesReport): boolean =>
  report.files.every((file) => file.ownership === 'owned')

/** Renders the canonical newline-terminated v1 JSON document. */
export const renderBuckOwnedFilesReport = (report: BuckOwnedFilesReport): string =>
  `${JSON.stringify(report, null, 2)}\n`

const runCommandDefault: OwnedFilesCommandRunner = ({ command, args, cwd }) => {
  const result = spawnSync(command, args, {
    cwd,
    maxBuffer: 128 * 1024 * 1024,
  })
  if (result.error !== undefined) return fail(`cannot run ${command}: ${result.error.message}`)
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

const requireCommandSuccess = ({
  command,
  result,
}: {
  readonly command: string
  readonly result: CommandResult
}): void => {
  if (result.status === 0) return
  const stderr = Buffer.from(result.stderr).toString('utf8').trim()
  fail(
    `${command} exited ${result.status === null ? 'without a status' : result.status}${stderr === '' ? '' : `: ${stderr}`}`,
  )
}

/** Runs the stateless Git-universe and single batched Buck-ownership join. */
export const runBuckOwnedFilesCensus = ({
  cwd,
  git = 'git',
  buck2 = 'buck2',
  runCommand = runCommandDefault,
}: RunBuckOwnedFilesCensusOptions): BuckOwnedFilesReport => {
  const rootResult = runCommand({ command: git, args: ['rev-parse', '--show-toplevel'], cwd })
  requireCommandSuccess({ command: git, result: rootResult })
  const rootOutput = decodeUtf8({ bytes: rootResult.stdout, name: 'Git repository root' })
  if (rootOutput.endsWith('\n') === false)
    return fail('Git repository root is not newline terminated')
  const repositoryRoot = rootOutput.slice(0, -1)
  if (
    repositoryRoot.length === 0 ||
    isAbsolute(repositoryRoot) === false ||
    [...repositoryRoot].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)
    }) === true
  ) {
    return fail(`Git repository root must be one absolute path: ${JSON.stringify(repositoryRoot)}`)
  }

  const candidateResult = runCommand({
    command: git,
    args: ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'],
    cwd: repositoryRoot,
  })
  requireCommandSuccess({ command: git, result: candidateResult })
  const candidates = parseGitCandidatePaths(candidateResult.stdout)

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'buck-owned-files-'))
  const argumentFile = join(temporaryDirectory, 'candidates')
  try {
    writeFileSync(argumentFile, `${candidates.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
    const ownershipResult = runCommand({
      command: buck2,
      args: ['uquery', '--output-format', 'json', 'owner(%s)', `@${argumentFile}`],
      cwd: repositoryRoot,
    })
    requireCommandSuccess({ command: buck2, result: ownershipResult })
    const ownersByPath = parseBuckOwnershipQuery({
      candidates,
      stdout: ownershipResult.stdout,
    })
    return makeBuckOwnedFilesReport({ candidates, ownersByPath })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

const main = (): void => {
  if (process.argv.length !== 2) fail('expected no arguments')
  const report = runBuckOwnedFilesCensus({ cwd: process.cwd() })
  process.stdout.write(renderBuckOwnedFilesReport(report))
  if (buckOwnedFilesReportPasses(report) === false) process.exitCode = 1
}

if (import.meta.main === true) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
