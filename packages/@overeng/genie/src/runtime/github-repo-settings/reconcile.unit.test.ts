import { describe, expect, it } from 'vitest'

import { decodeGithubRepoSettings } from './reconcile.ts'

const ruleset = { name: 'protect-main', enforcement: 'active', rules: [{ type: 'deletion' }] }

describe('repository settings payload compatibility', () => {
  it('keeps legacy single-ruleset files repository-field-free', () => {
    expect(decodeGithubRepoSettings(ruleset)).toEqual({
      repository: {},
      rulesets: [{ ...ruleset, target: 'branch' }],
    })
  })

  it('retains nested rule parameters and ignores generated envelope metadata', () => {
    const requiredChecks = {
      ...ruleset,
      rules: [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'ci', integration_id: 42 }] },
        },
      ],
    }
    expect(
      decodeGithubRepoSettings({
        $genie: { source: '.github/repo-settings.json.genie.ts' },
        repository: { allow_auto_merge: true },
        rulesets: [requiredChecks],
      }),
    ).toEqual({
      repository: { allow_auto_merge: true },
      rulesets: [{ ...requiredChecks, target: 'branch' }],
    })
  })

  it('rejects duplicate desired names before reconciliation can mutate remote settings', () => {
    expect(() =>
      decodeGithubRepoSettings({ repository: {}, rulesets: [ruleset, ruleset] }),
    ).toThrow()
  })

  it('rejects misspelled repository fields rather than silently ignoring desired state', () => {
    expect(() =>
      decodeGithubRepoSettings({ repository: { allow_auto_merg: true }, rulesets: [] }),
    ).toThrow()
  })
})
