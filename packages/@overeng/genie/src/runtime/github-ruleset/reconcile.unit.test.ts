import { describe, expect, it } from 'vitest'

import { diffGithubRuleset } from './reconcile.ts'

describe('github ruleset diff', () => {
  it('compares controlled fields only', () => {
    const diffs = diffGithubRuleset({
      desired: {
        name: 'protect-main',
        target: 'branch',
        enforcement: 'active',
        rules: [{ type: 'deletion' }],
      },
      actual: {
        id: 123,
        node_id: 'opaque',
        name: 'protect-main',
        target: 'branch',
        enforcement: 'active',
        rules: [{ type: 'non_fast_forward' }],
      },
    })

    expect(diffs).toEqual([
      {
        field: 'rules',
        desired: [{ type: 'deletion' }],
        actual: [{ type: 'non_fast_forward' }],
      },
    ])
  })

  it('ignores GitHub defaults and rule order', () => {
    expect(
      diffGithubRuleset({
        desired: {
          name: 'protect-main',
          target: 'branch',
          enforcement: 'active',
          rules: [
            {
              type: 'pull_request',
              parameters: {
                required_approving_review_count: 0,
              },
            },
            { type: 'deletion' },
          ],
          bypass_actors: [],
        },
        actual: {
          name: 'protect-main',
          target: 'branch',
          enforcement: 'active',
          rules: [
            { type: 'deletion' },
            {
              type: 'pull_request',
              parameters: {
                required_approving_review_count: 0,
                allowed_merge_methods: ['merge', 'squash', 'rebase'],
              },
            },
          ],
          bypass_actors: null,
        },
      }),
    ).toEqual([])
  })

  it('treats desired integration ids as authoritative', () => {
    const diffs = diffGithubRuleset({
      desired: {
        rules: [
          {
            type: 'required_status_checks',
            parameters: {
              required_status_checks: [{ context: 'hy/admission', integration_id: 3920663 }],
            },
          },
        ],
      },
      actual: {
        rules: [
          {
            type: 'required_status_checks',
            parameters: {
              required_status_checks: [{ context: 'hy/admission', integration_id: 3156013 }],
            },
          },
        ],
      },
    })

    expect(diffs).toHaveLength(1)
    expect(diffs[0]?.field).toBe('rules')
  })
})
