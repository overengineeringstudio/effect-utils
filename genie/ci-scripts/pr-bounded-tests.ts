// PR-only, best-effort early feedback; merge_group remains the full bounded authority.
export type BoundedSelection = { targets: string[]; notice?: string }

const skip = (notice: string): BoundedSelection => ({ targets: [], notice })

export const selectBoundedTargets = ({
  files,
  authority,
}: {
  files: readonly string[]
  authority: unknown
}): BoundedSelection => {
  if (files.length === 0) return skip('no changed files')
  if (files.some((file) => file.startsWith('packages/') === false) === true)
    return skip('changes outside packages; full bounded coverage remains in merge_group')
  if (
    typeof authority !== 'object' ||
    authority === null ||
    'lanes' in authority === false ||
    Array.isArray(authority.lanes) === false
  )
    return skip('bounded authority could not be mapped')
  const lanes: { packagePath: string; target: string }[] = []
  for (const lane of authority.lanes) {
    if (
      typeof lane?.packagePath !== 'string' ||
      typeof lane?.target !== 'string' ||
      /^packages\/(?:[a-zA-Z0-9@_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(lane.packagePath) === false ||
      /^effect_utils\/\/packages\/[a-zA-Z0-9@_./-]+:[a-z][a-z0-9_]*$/.test(lane.target) === false ||
      lane.target.startsWith(`effect_utils//${lane.packagePath}:`) === false
    )
      return skip('bounded authority could not be mapped')
    lanes.push({ packagePath: lane.packagePath, target: lane.target })
  }
  const targets = new Set<string>()
  for (const file of files) {
    const owners = lanes.filter((lane) => file.startsWith(`${lane.packagePath}/`))
    const longest = Math.max(...owners.map((lane) => lane.packagePath.length))
    if (owners.length === 0) return skip('a changed package has no bounded mapping')
    for (const lane of owners) if (lane.packagePath.length === longest) targets.add(lane.target)
  }
  return { targets: [...targets].toSorted() }
}

const git = (...args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error('PR diff could not be resolved')
  return result.stdout.toString().trimEnd()
}

type PrRevisions = { base: string; head: string; runGit?: (...args: string[]) => string }

/** Select authored PR changes, not unrelated changes in the synthetic merge checkout. */
export const readPrDiff = ({ base, head, runGit = git }: PrRevisions): string[] => {
  if ([base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha)) === false)
    throw new Error('PR revisions are unavailable')
  let mergeBase: string
  try {
    mergeBase = runGit('merge-base', base, head)
  } catch {
    if (runGit('rev-parse', '--is-shallow-repository') === 'true')
      runGit('fetch', '--no-tags', '--unshallow', 'origin')
    runGit('fetch', '--no-tags', 'origin', base, head)
    mergeBase = runGit('merge-base', base, head)
  }
  // --no-renames records both sides of moves as deletion/addition.
  const diff = runGit('diff', '--no-renames', '--name-only', '-z', mergeBase, head)
  return diff.split('\0').filter(Boolean)
}

export type BoundedOutcome =
  | { exitCode: 0; selection: BoundedSelection }
  | { exitCode: 1; error: string }

/** Diff failures must fail the check; only intentional selection skips are successful. */
export const resolveBoundedSelection = async ({
  readAuthority = () => Bun.file('buck2-test-authority.json').json(),
  ...revisions
}: PrRevisions & { readAuthority?: () => Promise<unknown> }): Promise<BoundedOutcome> => {
  try {
    const files = readPrDiff(revisions)
    const selection = selectBoundedTargets({ files, authority: await readAuthority() })
    return { exitCode: 0, selection }
  } catch {
    // Do not expose command output, repository paths, or environment values in annotations.
    return { exitCode: 1, error: 'PR revisions, history, or bounded authority are unavailable' }
  }
}

if (import.meta.main) {
  const outcome = await resolveBoundedSelection({
    base: process.env['PR_BOUNDED_BASE_SHA'] ?? '',
    head: process.env['PR_BOUNDED_HEAD_SHA'] ?? '',
  })
  if (outcome.exitCode !== 0) {
    console.log(`::error::Bounded PR check could not determine the PR diff: ${outcome.error}`)
    process.exit(outcome.exitCode)
  }
  const { selection } = outcome
  if (selection.notice !== undefined)
    console.log(`::notice::Bounded PR check skipped: ${selection.notice}`)
  if (selection.targets.length > 0) {
    console.log(`Bounded PR targets: ${selection.targets.join(', ')}`)
    const child = Bun.spawn(
      [
        process.env['BUCK2_BIN'] ?? 'buck2',
        'test',
        '--target-platforms',
        'effect_utils//buck2/platforms:host_platform',
        '--local-only',
        ...selection.targets,
      ],
      { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    )
    process.once('SIGTERM', () => child.kill('SIGTERM'))
    process.once('SIGINT', () => child.kill('SIGINT'))
    process.exitCode = await child.exited
  }
}
