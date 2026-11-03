import { expect, test } from 'bun:test'

import { readPrDiff, resolveBoundedSelection, selectBoundedTargets } from './pr-bounded-tests.ts'

const lane = (packagePath: string, name = 'test') => ({
  packagePath,
  target: `effect_utils//${packagePath}:${name}`,
})
const authority = {
  lanes: [
    lane('packages/@overeng/megarepo'),
    lane('packages/@overeng/ci-tools'),
    lane('packages/@overeng/ci-tools', 'test_api'),
    lane('packages/@overeng/megarepo/nested'),
  ],
}

test('selects every changed-package lane for tests, fixtures, deletes and move endpoints', () => {
  expect(
    selectBoundedTargets({
      files: [
        'packages/@overeng/megarepo/src/store/new.integration.test.ts',
        'packages/@overeng/megarepo/src/test-utils/rehome-fixture.ts',
        'packages/@overeng/ci-tools/src/deleted.ts',
      ],
      authority,
    }),
  ).toEqual({
    targets: [
      'effect_utils//packages/@overeng/ci-tools:test',
      'effect_utils//packages/@overeng/ci-tools:test_api',
      'effect_utils//packages/@overeng/megarepo:test',
    ],
  })
})

test('uses segment boundaries and the nearest admitted package', () => {
  expect(
    selectBoundedTargets({ files: ['packages/@overeng/megarepo/nested/src/test.ts'], authority })
      .targets,
  ).toEqual(['effect_utils//packages/@overeng/megarepo/nested:test'])
  expect(
    selectBoundedTargets({ files: ['packages/@overeng/megarepo-other/src/test.ts'], authority })
      .notice,
  ).toBeDefined()
})

test('skips empty diffs, shared changes and failed mappings instead of running everything', () => {
  for (const files of [[], ['devenv.nix'], ['buck2/javascript.bzl'], ['packages/unknown/a.ts']]) {
    const selection = selectBoundedTargets({ files, authority })
    expect(selection.targets).toEqual([])
    expect(selection.notice).toBeDefined()
  }
  for (const invalid of [null, {}, { lanes: [{}] }, { lanes: [lane('outside')] }]) {
    expect(
      selectBoundedTargets({ files: ['packages/a/test.ts'], authority: invalid }).notice,
    ).toBeDefined()
  }
})

test('stacked PR selection uses event revisions, never synthetic checkout HEAD', () => {
  const base = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  const file = 'packages/@overeng/megarepo/src/store/store-symlink.unit.test.ts'
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
  expect(selectBoundedTargets({ files, authority }).targets).toEqual([
    'effect_utils//packages/@overeng/megarepo:test',
  ])
})

test('missing and invalid event revisions fail the bounded check', async () => {
  for (const revisions of [
    { base: '', head: 'b'.repeat(40) },
    { base: 'a'.repeat(40), head: '' },
    { base: 'not-a-sha', head: 'b'.repeat(40) },
    { base: 'a'.repeat(40), head: 'not-a-sha' },
  ]) {
    let gitCalled = false
    const outcome = await resolveBoundedSelection({
      ...revisions,
      runGit: () => {
        gitCalled = true
        return ''
      },
      readAuthority: async () => authority,
    })
    expect(outcome).toEqual({
      exitCode: 1,
      error: 'PR revisions, history, or bounded authority are unavailable',
    })
    expect(gitCalled).toBe(false)
  }
})

test('git failures fail the bounded check without exposing command output or paths', async () => {
  for (const failingCommand of ['merge-base', 'rev-parse', 'fetch', 'diff']) {
    const outcome = await resolveBoundedSelection({
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      runGit: (command) => {
        if (command === failingCommand || (failingCommand !== 'diff' && command === 'merge-base'))
          throw new Error('git failed in /private/checkout\n::notice::unsafe output')
        return command === 'rev-parse' ? 'true' : 'a'.repeat(40)
      },
      readAuthority: async () => authority,
    })
    expect(outcome).toEqual({
      exitCode: 1,
      error: 'PR revisions, history, or bounded authority are unavailable',
    })
  }
})

test('intentional selection skips remain successful', async () => {
  for (const file of ['devenv.nix', 'packages/unknown/a.ts']) {
    const outcome = await resolveBoundedSelection({
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      runGit: (command) => (command === 'merge-base' ? 'a'.repeat(40) : `${file}\0`),
      readAuthority: async () => authority,
    })
    expect(outcome.exitCode).toBe(0)
    if (outcome.exitCode === 0) {
      expect(outcome.selection.targets).toEqual([])
      expect(outcome.selection.notice).toBeDefined()
    }
  }
})
