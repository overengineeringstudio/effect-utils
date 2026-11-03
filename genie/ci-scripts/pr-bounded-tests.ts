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

if (import.meta.main) {
  let selection: BoundedSelection
  try {
    const base = process.env['PR_BOUNDED_BASE_SHA']
    if (base === undefined || /^[a-f0-9]{40}$/.test(base) === false)
      throw new Error('PR base is unavailable')
    // Fetch only when the checkout's shallow history cannot resolve the common ancestor.
    let mergeBase: string
    try {
      mergeBase = git('merge-base', base, 'HEAD')
    } catch {
      git('fetch', '--no-tags', '--unshallow', 'origin')
      git('fetch', '--no-tags', 'origin', base)
      mergeBase = git('merge-base', base, 'HEAD')
    }
    // --no-renames records both sides of moves as deletion/addition.
    const files = git('diff', '--no-renames', '--name-only', '-z', mergeBase, 'HEAD')
      .split('\0')
      .filter(Boolean)
    selection = selectBoundedTargets({
      files,
      authority: await Bun.file('buck2-test-authority.json').json(),
    })
  } catch {
    selection = { targets: [], notice: 'PR diff or bounded mapping unavailable' }
  }
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
