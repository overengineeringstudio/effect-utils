import { expect, test } from 'bun:test'

import { selectBoundedTargets } from './pr-bounded-tests.ts'

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
