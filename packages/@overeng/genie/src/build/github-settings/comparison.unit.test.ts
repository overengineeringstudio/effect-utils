import { Schema } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { githubRuleset } from '../../runtime/github-ruleset/mod.ts'
import {
  diffGithubRepositorySettings,
  normalizeGithubRepositorySettingsForComparison,
} from './comparison.ts'
import {
  githubRepoSettings,
  type GithubRepoSettings as GithubRepoSettingsData,
  type GithubRepositorySettings as GithubRepositorySettingsData,
  type GithubRulesetPayload as GithubRulesetPayloadData,
} from '../../runtime/github-repo-settings/mod.ts'
import { GithubRepoSettings, GithubRulesetPayload, GithubRepositorySettings } from './schema.ts'

const decodeRepository = Schema.decodeUnknownSync(GithubRepositorySettings)

describe('repository settings comparison', () => {
  it('reports both enabling and disabling boolean drift', () => {
    expect(
      diffGithubRepositorySettings({
        desired: { allow_auto_merge: true, allow_merge_commit: false },
        actual: { allow_auto_merge: false, allow_merge_commit: true },
      }),
    ).toEqual([
      { field: 'allow_auto_merge', desired: true, actual: false },
      { field: 'allow_merge_commit', desired: false, actual: true },
    ])
    expect(
      diffGithubRepositorySettings({
        desired: { allow_auto_merge: false },
        actual: { allow_auto_merge: false },
      }),
    ).toEqual([])
  })

  it('ignores unmanaged settings and unknown remote metadata', () => {
    expect(
      normalizeGithubRepositorySettingsForComparison({
        desired: { allow_auto_merge: true },
        actual: {
          allow_auto_merge: true,
          allow_merge_commit: false,
          id: 42,
          owner: { login: 'test' },
        },
      }),
    ).toEqual({ desired: { allow_auto_merge: true }, actual: { allow_auto_merge: true } })
    expect(
      diffGithubRepositorySettings({ desired: {}, actual: { allow_auto_merge: false } }),
    ).toEqual([])
    expect(decodeRepository({ allow_auto_merge: true, id: 42 })).toEqual({ allow_auto_merge: true })
  })

  it('does not control omitted or explicitly undefined settings', () => {
    expect(
      normalizeGithubRepositorySettingsForComparison({
        desired: { allow_auto_merge: undefined, delete_branch_on_merge: true },
        actual: { allow_auto_merge: false, delete_branch_on_merge: true },
      }),
    ).toEqual({
      desired: { delete_branch_on_merge: true },
      actual: { delete_branch_on_merge: true },
    })
  })

  it('preserves missing and null remote values as drift instead of false', () => {
    expect(
      diffGithubRepositorySettings({ desired: { allow_auto_merge: false }, actual: {} }),
    ).toEqual([{ field: 'allow_auto_merge', desired: false, actual: undefined }])
    expect(
      diffGithubRepositorySettings({
        desired: { allow_auto_merge: false },
        actual: { allow_auto_merge: null },
      }),
    ).toEqual([{ field: 'allow_auto_merge', desired: false, actual: null }])
    expect(
      diffGithubRepositorySettings({
        desired: { description: null },
        actual: { description: null },
      }),
    ).toEqual([])
    expect(diffGithubRepositorySettings({ desired: { description: null }, actual: {} })).toEqual([
      { field: 'description', desired: null, actual: undefined },
    ])
    expect(() => decodeRepository({ allow_auto_merge: null })).toThrow()
  })

  it('validates merge strategy enums and rejects desired typos', () => {
    expect(
      decodeRepository({
        squash_merge_commit_title: 'PR_TITLE',
        squash_merge_commit_message: 'COMMIT_MESSAGES',
        merge_commit_title: 'MERGE_MESSAGE',
        merge_commit_message: 'BLANK',
      }),
    ).toEqual({
      squash_merge_commit_title: 'PR_TITLE',
      squash_merge_commit_message: 'COMMIT_MESSAGES',
      merge_commit_title: 'MERGE_MESSAGE',
      merge_commit_message: 'BLANK',
    })
    for (const field of [
      'squash_merge_commit_title',
      'squash_merge_commit_message',
      'merge_commit_title',
      'merge_commit_message',
    ]) {
      expect(() => decodeRepository({ [field]: 'invalid' })).toThrow()
    }
    const desiredWithTypo = { allow_auto_merge: true, typo: false }
    expect(() => githubRepoSettings({ repository: desiredWithTypo, rulesets: [] })).toThrow()
  })
})

describe('repository settings payload', () => {
  it('rejects duplicate ruleset names before reconciliation', () => {
    const ruleset = { name: 'protect-main', enforcement: 'active', rules: [] }
    expect(() =>
      Schema.decodeUnknownSync(GithubRepoSettings)({
        repository: {},
        rulesets: [ruleset, ruleset],
      }),
    ).toThrow()
  })

  it('rejects duplicate ruleset names in the builder without the reconcile-side schema', () => {
    const ruleset = githubRuleset({ name: 'protect-main', enforcement: 'active', rules: [] })
    expect(() => githubRepoSettings({ repository: {}, rulesets: [ruleset, ruleset] })).toThrow(
      /duplicated: protect-main/,
    )
  })

  it('keeps the npm-free builder types and the reconcile-side schemas on one wire shape', () => {
    expectTypeOf<Required<typeof GithubRepositorySettings.Type>>().toEqualTypeOf<
      Required<GithubRepositorySettingsData>
    >()
    expectTypeOf<typeof GithubRulesetPayload.Type>().toEqualTypeOf<GithubRulesetPayloadData>()
    expectTypeOf<typeof GithubRepoSettings.Type>().toEqualTypeOf<GithubRepoSettingsData>()
  })

  it('preserves open rule parameters and defaults an omitted target to branch', () => {
    const ruleset = {
      name: 'protect-main',
      enforcement: 'active',
      rules: [
        { type: 'future_rule', parameters: { enabled: false, nested: { values: [1, null] } } },
      ],
    }
    expect(Schema.decodeUnknownSync(GithubRulesetPayload)(ruleset)).toEqual({
      ...ruleset,
      target: 'branch',
    })
  })

  it('keeps managed repository fields distinct from the composed ruleset', () => {
    const result = githubRepoSettings({
      repository: {
        allow_auto_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: undefined,
      },
      rulesets: [
        githubRuleset({
          name: 'protect-main',
          enforcement: 'active',
          rules: [{ type: 'deletion' }],
        }),
      ],
    })
    expect(result.data).toEqual({
      repository: { allow_auto_merge: true, allow_merge_commit: false },
      rulesets: [
        {
          name: 'protect-main',
          enforcement: 'active',
          target: 'branch',
          rules: [{ type: 'deletion' }],
        },
      ],
    })
  })
})
