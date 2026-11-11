import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { githubRuleset } from './mod.ts'
import {
  diffGithubRuleset,
  formatGithubRulesetReport,
  mergeGithubRulesetForApply,
  reconcileGithubRuleset,
} from './reconcile.ts'

describe('github ruleset diff', () => {
  it('preserves individual user bypass and unattributed-change approval parameters', () => {
    const actor = { actor_id: 123, actor_type: 'User', bypass_mode: 'always' } as const
    const output = githubRuleset({
      name: 'main-workflow',
      target: 'branch',
      enforcement: 'active',
      rules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
            require_extra_approval_for_unattributed_changes: true,
          },
        },
      ],
      bypass_actors: [actor],
    })
    expect(output.data.bypass_actors).toEqual([actor])
    expect(output.data.rules[0].parameters.require_extra_approval_for_unattributed_changes).toBe(
      true,
    )
  })

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

  it('ignores undeclared server-populated parameters, recursively within matching rules', () => {
    const desired = {
      rules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 0,
            dismissal_restriction: { enabled: false },
          },
        },
        { type: 'deletion' },
      ],
    }
    const actual = {
      rules: [
        { type: 'deletion' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 0,
            dismissal_restriction: { enabled: false, allowed_actors: [] },
            require_extra_approval_for_unattributed_changes: true,
          },
        },
      ],
    }
    expect(diffGithubRuleset({ desired, actual })).toEqual([])
    expect(
      diffGithubRuleset({
        desired: {
          rules: [
            { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
            { type: 'deletion' },
          ],
        },
        actual,
      }),
    ).toEqual([])
  })

  it('reports a changed or missing declared parameter even with live-only keys', () => {
    const desired = {
      rules: [{ type: 'pull_request', parameters: { dismissal_restriction: { enabled: false } } }],
    }
    for (const parameters of [
      { dismissal_restriction: { enabled: true, allowed_actors: [] } },
      { dismissal_restriction: { allowed_actors: [] } },
      { require_extra_approval_for_unattributed_changes: true },
    ]) {
      expect(
        diffGithubRuleset({ desired, actual: { rules: [{ type: 'pull_request', parameters }] } }),
      ).toMatchObject([{ field: 'rules' }])
    }
  })

  it('reports a missing or additional rule rather than treating rule presence as unmanaged', () => {
    const desired = {
      rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 0 } }],
    }
    expect(diffGithubRuleset({ desired, actual: { rules: [] } })).toMatchObject([
      { field: 'rules' },
    ])
    expect(
      diffGithubRuleset({
        desired,
        actual: { rules: [...desired.rules, { type: 'deletion' }] },
      }),
    ).toMatchObject([{ field: 'rules' }])
  })

  it('compares scalar arrays and status-check entries exactly, without subset projection', () => {
    for (const [desiredParameters, actualParameters] of [
      [
        { allowed_merge_methods: ['merge', 'squash'] },
        { allowed_merge_methods: ['squash', 'merge'] },
      ],
      [
        { required_status_checks: [{ context: 'ci' }] },
        { required_status_checks: [{ context: 'ci', integration_id: 42 }] },
      ],
      [
        { required_status_checks: [{ context: 'ci' }] },
        { required_status_checks: [{ context: 'ci' }, { context: 'extra' }] },
      ],
    ]) {
      expect(
        diffGithubRuleset({
          desired: { rules: [{ type: 'required_status_checks', parameters: desiredParameters }] },
          actual: { rules: [{ type: 'required_status_checks', parameters: actualParameters }] },
        }),
      ).toMatchObject([{ field: 'rules' }])
    }
  })
})

describe('github ruleset update payload', () => {
  it('preserves unmanaged parameters but replaces managed arrays and rule presence', () => {
    const desired = {
      name: 'protect-main',
      rules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            dismissal_restriction: { enabled: false },
            allowed_merge_methods: ['squash'],
          },
        },
        { type: 'deletion' },
      ],
    }
    const actual = {
      id: 123,
      rules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 0,
            dismissal_restriction: { enabled: true, allowed_actors: [{ actor_id: 42 }] },
            allowed_merge_methods: ['merge', 'squash'],
            require_extra_approval_for_unattributed_changes: true,
          },
        },
        { type: 'non_fast_forward' },
      ],
    }
    expect(mergeGithubRulesetForApply({ desired, actual })).toEqual({
      ...desired,
      rules: [
        {
          type: 'pull_request',
          parameters: {
            ...desired.rules[0]!.parameters,
            dismissal_restriction: { enabled: false, allowed_actors: [{ actor_id: 42 }] },
            require_extra_approval_for_unattributed_changes: true,
          },
        },
        { type: 'deletion' },
      ],
    })
    expect(actual.rules[0]!.parameters?.required_approving_review_count).toBe(0)
  })

  it('preserves live parameters when the retained rule declares none', () => {
    const parameters = { require_extra_approval_for_unattributed_changes: true }
    const desired = { rules: [{ type: 'pull_request' }] }
    const actual = { rules: [{ type: 'pull_request', parameters }] }
    expect(diffGithubRuleset({ desired, actual })).toEqual([])
    expect(mergeGithubRulesetForApply({ desired, actual })).toEqual(actual)
  })
})

describe('github ruleset reconciliation', () => {
  afterEach(() => vi.unstubAllGlobals())

  const fixture = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genie-ruleset-'))
    const desired = {
      name: 'protect-main',
      target: 'branch',
      enforcement: 'active',
      rules: [{ type: 'deletion' }],
    }
    const file = join(directory, 'ruleset.json')
    await writeFile(file, JSON.stringify(desired))
    let remote: Record<string, unknown> | undefined
    const writes: string[] = []
    vi.stubGlobal('Bun', {
      spawn: (args: string[]) => {
        const method = args[args.indexOf('--method') + 1]
        let result: unknown
        if (args.includes('--method') === true) {
          writes.push(method!)
          remote = { ...desired, id: 123 }
          result = remote
        } else if (args[2]!.endsWith('/123') === true) {
          result = remote
        } else {
          result = remote === undefined ? [] : [{ id: 123, name: desired.name }]
        }
        return { stdout: JSON.stringify(result), stderr: '', exited: Promise.resolve(0) }
      },
    })
    return {
      options: { repo: 'owner/repo', ruleset: desired.name, file },
      writes,
      remove: () => rm(directory, { recursive: true, force: true }),
    }
  }

  it('reports an absent ruleset as drift without creating it', async () => {
    const state = await fixture()
    try {
      const report = await reconcileGithubRuleset({ mode: 'check', options: state.options })
      expect(report).toMatchObject({ rulesetId: null, changed: true, applied: false })
      expect(formatGithubRulesetReport({ mode: 'check', report })).toContain('(absent)')
      expect(report.diffs.map((diff) => diff.field)).toEqual([
        'name',
        'target',
        'enforcement',
        'rules',
      ])
      expect(state.writes).toEqual([])
    } finally {
      await state.remove()
    }
  })

  it('creates an absent ruleset once, then reports a matching remote without another write', async () => {
    const state = await fixture()
    try {
      const created = await reconcileGithubRuleset({ mode: 'apply', options: state.options })
      expect(created).toMatchObject({ rulesetId: 123, changed: true, applied: true })
      const checked = await reconcileGithubRuleset({ mode: 'check', options: state.options })
      expect(checked).toMatchObject({ rulesetId: 123, changed: false, applied: false, diffs: [] })
      const applied = await reconcileGithubRuleset({ mode: 'apply', options: state.options })
      expect(applied).toMatchObject({ changed: false, applied: false })
      expect(state.writes).toEqual(['POST'])
    } finally {
      await state.remove()
    }
  })
})
