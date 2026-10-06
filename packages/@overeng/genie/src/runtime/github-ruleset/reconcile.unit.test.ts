import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  diffGithubRuleset,
  formatGithubRulesetReport,
  reconcileGithubRuleset,
} from './reconcile.ts'

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
