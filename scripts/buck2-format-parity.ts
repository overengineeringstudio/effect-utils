import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import knownDifferences from './buck2-format-known-differences.json'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (command: readonly string[]): string => {
  const result = Bun.spawnSync([...command], { cwd: root, stderr: 'inherit' })
  if (result.exitCode !== 0) process.exit(result.exitCode)
  return result.stdout.toString()
}

// Read the task's literal pathspecs rather than maintaining another lint surface.
const config = readFileSync(path.join(root, 'devenv.nix'), 'utf8')
const lintPaths = config.match(/lintPaths = \[([^\]]*)\];/)?.[1]
if (lintPaths === undefined) throw new Error('Cannot locate literal lintPaths in devenv.nix')
const pathspecs = [...lintPaths.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
if (pathspecs.length === 0) throw new Error('Empty formatter lintPaths')

// Buck inputs include extensionless build files and support configuration. Only
// extensions admitted by the format task participate in its formatter file set.
const lintModule = readFileSync(
  path.join(root, 'nix/devenv-modules/tasks/shared/lint-oxc.nix'),
  'utf8',
)
const includeCase = lintModule.match(/oxfmtIncludeCase = ''\s*([^\n]+)\)/)?.[1]
if (includeCase === undefined) throw new Error('Cannot locate oxfmtIncludeCase')
const extensions = new Set(
  includeCase
    .trim()
    .split('|')
    .map((pattern) => pattern.slice(1)),
)
const admitted = (file: string): boolean => extensions.has(path.extname(file))
const git = new Set(
  [
    ...run(['git', 'ls-files', '-z', '--', ...pathspecs]).split('\0'),
    ...run(['git', 'ls-files', '-z', '--others', '--exclude-standard', '--', ...pathspecs]).split(
      '\0',
    ),
  ].filter((file) => admitted(file) && existsSync(path.join(root, file))),
)
// This read-only query runs alongside editor publication in check:quick. Its
// gate cleanup must not stop the publisher's daemon in the default isolation.
const buckInputs: unknown = JSON.parse(
  run([
    'buck2',
    '--isolation-dir',
    'format-parity',
    'uquery',
    'inputs(filter(":static_sources$", deps(//buck2/static:check_format)))',
    '--output-format',
    'json',
  ]),
)
if (
  Array.isArray(buckInputs) === false ||
  buckInputs.every((file) => typeof file === 'string') === false
) {
  throw new Error('Unexpected Buck input enumeration')
}
const buck = new Set(buckInputs.filter(admitted))
const actual = [
  ...[...git].filter((file) => !buck.has(file)).map((file) => `git-only:${file}`),
  ...[...buck].filter((file) => !git.has(file)).map((file) => `buck-only:${file}`),
].toSorted()
const expected = knownDifferences
  .map(({ side, path: file, reason, issue }) => {
    if (reason.length === 0 || /^https:\/\/github\.com\/.+\/issues\/\d+$/.test(issue) === false) {
      throw new Error(`Missing reason or follow-up issue for ${file}`)
    }
    return `${side}:${file}`
  })
  .toSorted()
const expectedSet = new Set(expected)
if (expectedSet.size !== expected.length) throw new Error('Duplicate known formatter differences')
const actualSet = new Set(actual)
const unexpected = actual.filter((difference) => !expectedSet.has(difference))
const stale = expected.filter((difference) => !actualSet.has(difference))
console.log(`Format parity: git=${git.size} buck=${buck.size} known=${expected.length}`)
if (unexpected.length > 0 || stale.length > 0) {
  for (const difference of unexpected) console.error(`Unexpected difference: ${difference}`)
  for (const difference of stale) console.error(`Stale known difference: ${difference}`)
  process.exit(1)
}
console.log('Format parity: normalized sets equal; unexpected=0 stale=0')
