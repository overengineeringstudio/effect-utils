import { expect, test } from 'bun:test'

import { readPrDiff, resolveBoundedSelection, selectBoundedTargets } from './pr-bounded-tests.ts'

const lane = (packagePath: string, name = 'test') => ({
  packagePath,
  target: `effect_utils//${packagePath}:${name}`,
})
const a = lane('packages/a')
const b = lane('packages/b')
const api = lane('packages/b', 'test_api')
const nested = lane('packages/a/nested')
const authority = { lanes: [a, b, api, nested] }
const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const select = (files: string[]) => selectBoundedTargets({ files, authority })

test('selects changed-package lanes with nearest ownership and segment boundaries', () => {
  const files = ['packages/a/new.test.ts', 'packages/a/fixture.ts', 'packages/b/deleted.ts']
  expect(select(files).targets).toEqual([a.target, b.target, api.target])
  expect(select(['packages/a/nested/test.ts']).targets).toEqual([nested.target])
  expect(select(['packages/a-other/test.ts']).notice).toBeDefined()
})

test('skips empty diffs, shared changes and failed mappings instead of running everything', () => {
  for (const files of [[], ['devenv.nix'], ['buck2/javascript.bzl'], ['packages/unknown/a.ts']]) {
    expect(select(files)).toEqual({ targets: [], notice: expect.any(String) })
  }
  for (const invalid of [null, {}, { lanes: [{}] }, { lanes: [lane('outside')] }]) {
    const selection = selectBoundedTargets({ files: ['packages/a/test.ts'], authority: invalid })
    expect(selection.notice).toBeDefined()
  }
})

test('stacked PR selection uses event revisions, never synthetic checkout HEAD', () => {
  const file = 'packages/a/store-symlink.unit.test.ts'
  const commands: string[][] = []
  const files = readPrDiff({
    base,
    head,
    runGit: (...args) => {
      commands.push(args)
      return args[0] === 'merge-base' ? base : `${file}\0`
    },
  })
  expect(commands).toEqual([
    ['merge-base', base, head],
    ['diff', '--no-renames', '--name-only', '-z', base, head],
  ])
  expect(select(files).targets).toEqual([a.target])
})

test('diff failures fail safely while intentional selection skips succeed', async () => {
  for (const [caseBase, caseHead, failure, file] of [
    ['', head, '', ''],
    [base, 'invalid', '', ''],
    [base, head, 'merge-base', ''],
    [base, head, 'diff', ''],
    [base, head, '', 'devenv.nix'],
    [base, head, '', 'packages/unknown/a.ts'],
  ] as const) {
    const outcome = await resolveBoundedSelection({
      base: caseBase,
      head: caseHead,
      runGit: (command) => {
        if (command === failure)
          throw new Error('git failed in /private/checkout\n::notice::unsafe output')
        return command === 'merge-base' ? base : `${file}\0`
      },
      readAuthority: async () => authority,
    })
    expect(outcome).toEqual(
      file !== ''
        ? { exitCode: 0, selection: { targets: [], notice: expect.any(String) } }
        : {
            exitCode: 1,
            error: 'PR revisions, history, or bounded authority are unavailable',
          },
    )
  }
})
