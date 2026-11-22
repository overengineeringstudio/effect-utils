import path from 'node:path'
import { inputReaddirSync as readdirSync } from '../../packages/@overeng/genie/src/runtime/node/inputs.ts'

export type SourceSelection = {
  readonly paths: readonly string[]
  readonly prefixes: readonly string[]
  readonly extensions?: readonly string[]
  readonly membership?: readonly string[]
  readonly membership_inputs?: boolean
}
export type ContractSourceGroup = {
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

export const excludedContractDirectories = [
  '.buck2', '.cache', '.codex', '.context', '.devenv', '.direnv', '.editor-view',
  '.evergreen', '.git', '.playwright-cli', '.playwright-mcp', '.pnpm', '.pnpm-home',
  '.pnpm-store', '.vercel', '.vitest-attachments', '.worktree-tools', 'buck-out',
  'dist', 'genie-locks', 'node_modules', 'repos', 'result', 'storybook-static', 'target', 'tmp',
] as const

/** Discover package boundaries, not source filenames; new boundaries need Genie. */
export const discoverContractPackages = (root: string): { owners: string[]; directories: string[] } => {
  const owners = ['.']
  const directories: string[] = []
  const visit = (directory: string): void => {
    const entries = readdirSync(path.join(root, directory), { withFileTypes: true })
    if (directory !== '.' && entries.some((entry) => entry.isFile() && (entry.name === 'BUCK' || entry.name === 'BUCK.genie.ts'))) owners.push(directory)
    for (const entry of entries) {
      if (!entry.isDirectory() || excludedContractDirectories.some((excluded) => excluded === entry.name)) continue
      const relative = path.posix.join(directory, entry.name)
      directories.push(relative)
      visit(relative)
    }
  }
  visit('.')
  return { owners: owners.sort(), directories: directories.sort() }
}

// Buck has no include_dotfiles. Match the repository's static source patterns,
// and anchor every existing hidden directory to support any current nesting depth.
const descendants = ['**/*', '**/.*', '**/.*/**/*', '**/.*/**/.*', '**/.*/**/.*/**/*']
const unique = (values: readonly string[]): string[] => [...new Set(values)].sort()
export const contractSourceName = (task: string): string =>
  `quick_contract_sources__${task.replaceAll(':', '-')}`

export const contractSourceGroup = ({
  selection, owner, owners, directories,
}: {
  readonly selection: SourceSelection
  readonly owner: string
  readonly owners: readonly string[]
  readonly directories: readonly string[]
}): ContractSourceGroup => {
  const base = owner === '.' ? '' : `${owner}/`
  const anchors = unique(['', ...directories.filter((directory) =>
    directory.startsWith(base) && directory.split('/').some((segment) => segment.startsWith('.')),
  ).map((directory) => `${directory.slice(base.length)}/`)])
  const tails = unique(anchors.flatMap((anchor) => descendants.map((tail) => anchor + tail)))
  const include: string[] = []
  const suffixes = selection.extensions ?? ['']
  for (const prefix of selection.prefixes) {
    if (base.startsWith(prefix)) {
      include.push(...tails.flatMap((tail) => suffixes.map((suffix) => tail + suffix)))
    } else if (prefix.startsWith(base)) {
      const relative = prefix.slice(base.length)
      if (relative.endsWith('/')) {
        include.push(...tails.flatMap((tail) => suffixes.map((suffix) => relative + tail + suffix)))
      } else {
        // startsWith is a string prefix, not a directory selector: retain both
        // matching filenames and descendants of matching directory names.
        include.push(...suffixes.map((suffix) => `${relative}*${suffix}`))
        for (const suffix of suffixes) {
          for (let overlap = 1; overlap <= suffix.length; overlap++) {
            if (relative.endsWith(suffix.slice(0, overlap))) include.push(relative + suffix.slice(overlap))
          }
        }
        include.push(...tails.flatMap((tail) => suffixes.map((suffix) => `${relative}*/${tail}${suffix}`)))
      }
    }
  }
  for (const directory of directories) {
    if (directory.startsWith(base) && directory.split('/').some((segment) => segment.startsWith('.')) &&
      selection.prefixes.some((prefix) => `${directory}/`.startsWith(prefix))) {
      include.push(...descendants.flatMap((tail) => suffixes.map((suffix) => `${directory.slice(base.length)}/${tail}${suffix}`)))
    }
  }
  if (selection.membership_inputs === true) {
    for (const spec of selection.membership ?? []) {
      // Git's slash-free wildcard pathspec matches basenames recursively. No
      // other Git pathspec form is currently authored for membership byte inputs.
      if (!/^\*\.[a-zA-Z0-9.-]+$/.test(spec)) {
        throw new Error(`Unsupported membership byte-input Git pathspec: ${spec}`)
      }
      include.push(...tails.map((tail) => tail + spec.slice(1)))
    }
  }
  for (const file of selection.paths) {
    const covered = selection.prefixes.some((prefix) => file.startsWith(prefix)) &&
      (selection.extensions === undefined || selection.extensions.some((suffix) => file.endsWith(suffix)))
    if (!covered && file.startsWith(base) && !owners.some((nested) =>
      nested !== owner && nested !== '.' && nested.startsWith(base) && file.startsWith(`${nested}/`),
    )) include.push(file.slice(base.length))
  }
  const exclude = unique([
    ...anchors.flatMap((anchor) => ['', '**/', '**/.*/**/', '**/.*/**/.*/**/'].flatMap((ancestor) =>
      excludedContractDirectories.flatMap((directory) => descendants.map((tail) => `${anchor}${ancestor}${directory}/${tail}`)),
    )),
    ...tails.flatMap((tail) => [
      tail.slice(0, -1) + '.BUCK.next.*',
      tail.slice(0, -1) + '.git-archives.json.next.*',
    ]),
  ])
  return { include: unique(include), exclude }
}

export const contractSourceOwners = (
  selection: SourceSelection,
  owners: readonly string[],
  directories: readonly string[],
): readonly string[] => owners.filter((owner) => contractSourceGroup({ selection, owner, owners, directories }).include.length > 0)
