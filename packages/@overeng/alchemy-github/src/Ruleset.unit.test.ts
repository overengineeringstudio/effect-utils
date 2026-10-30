import { Ruleset as UpstreamRuleset } from '@alchemy.run/github'
import { describe, expect, it } from 'vitest'

import { Ruleset, type RulesetProps } from './mod.ts'

/** No parallel provider or payload mapper: the upstream contract owns these fields. */
const policy: RulesetProps = {
  owner: 'example',
  repository: 'project',
  name: 'Required publisher check',
  rules: {
    requiredStatusChecks: {
      checks: [{ context: 'publisher', integrationId: 123 }],
      strictRequiredStatusChecksPolicy: true,
    },
  },
  bypassActors: [{ actorId: 123, actorType: 'Integration', bypassMode: 'pull_request' }],
}

describe('upstream Ruleset contract', () => {
  it('re-exports the upstream resource without registering a competing provider', () => {
    expect(Ruleset).toBe(UpstreamRuleset)
    expect(Ruleset.Type).toBe('GitHub.Ruleset')
    expect(policy.rules?.requiredStatusChecks?.checks[0]?.integrationId).toBe(123)
    expect(policy.rules?.requiredStatusChecks?.strictRequiredStatusChecksPolicy).toBe(true)
    expect(policy.bypassActors?.[0]?.actorType).toBe('Integration')
  })
})
