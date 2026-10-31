import { describe, expect, it } from 'bun:test'

import { proofJobCell } from './buck2-action-evidence.ts'
import {
  apiBudgetAvailable,
  artifactCanMatter,
  artifactInWindow,
  classifyRun,
  discoverProofJobIdentity,
  type EvidenceRun,
  selectRuns,
} from './buck2-cache-join-discovery.ts'

describe('discoverProofJobIdentity', () => {
  it('resolves PR display names to the declared workflow job IDs', () => {
    expect(discoverProofJobIdentity('pr/quality')).toEqual({
      job: 'quality',
      cell: proofJobCell('pr/quality'),
    })
    expect(discoverProofJobIdentity('pr/buck2-tools')).toEqual({
      job: 'pr-buck2-tools',
      cell: proofJobCell('pr/buck2-tools'),
    })
  })

  it('preserves full matrix display names as distinct cell identities', () => {
    const linuxName = 'test (namespace-profile-linux-x86-64)'
    const macosName = 'test (namespace-profile-macos-arm64)'
    const linux = discoverProofJobIdentity(linuxName)
    const macos = discoverProofJobIdentity(macosName)
    expect(linux).toEqual({ job: 'test', cell: proofJobCell(linuxName) })
    expect(macos).toEqual({ job: 'test-macos', cell: proofJobCell(macosName) })
    expect(linux!.cell).not.toBe(macos!.cell)
  })

  it('resolves declared standalone evidence jobs without guessing display prefixes', () => {
    for (const job of ['bootstrap-cold-proof', 'test-storybook-plays', 'build-storybooks']) {
      expect(discoverProofJobIdentity(job)).toEqual({ job, cell: proofJobCell(job) })
    }
  })

  it('fails closed for unknown display names and undeclared matrix cells', () => {
    for (const name of [
      '',
      'future-job',
      'ci/quality',
      'quality',
      'pr-buck2-tools',
      'test',
      'test-macos',
      'test (unknown-runner)',
      'pr/quality (unknown-cell)',
      'constructor',
      '__proto__',
    ]) {
      expect(discoverProofJobIdentity(name)).toBeUndefined()
    }
  })
})

describe('artifactCanMatter', () => {
  it('retains enabled and unknown evidence producers for download', () => {
    for (const name of [
      'buck2-cache-evidence-test-123',
      'buck2-cache-evidence-test-macos-123',
      'buck2-cache-evidence-jobdownload-123',
      'buck2-cache-evidence-future-producer-123',
      'buck2-cache-evidence-cargoextra-123',
      'buck2-cache-evidence-default-ref-policyextra-123',
      'buck2-cache-evidence-build-productsextra-123',
      'buck2-cache-evidence-publish-productsextra-123',
      'buck2-cache-evidence-publish-compiled-productsextra-123',
      'buck2-cache-evidence-',
    ]) {
      expect(artifactCanMatter(name)).toBe(true)
    }
  })

  it('skips each exact known disabled producer prefix', () => {
    for (const job of [
      'default-ref-policy',
      'cargo',
      'build-products',
      'publish-products',
      'publish-compiled-products',
    ]) {
      expect(artifactCanMatter(`buck2-cache-evidence-${job}-123`)).toBe(false)
      expect(artifactCanMatter(`buck2-cache-evidence-${job}-`)).toBe(false)
      expect(artifactCanMatter(`buck2-cache-evidence-${job}`)).toBe(true)
    }
  })

  it('rejects names without the evidence prefix', () => {
    for (const name of [
      '',
      'other-artifact',
      'buck2-cache-evidence',
      'prefix-buck2-cache-evidence-test-123',
    ]) {
      expect(artifactCanMatter(name)).toBe(false)
    }
  })
})

describe('apiBudgetAvailable', () => {
  it('allows calls strictly below the cap with an unknown or sufficient API budget', () => {
    expect(apiBudgetAvailable({ calls: 0, remaining: undefined })).toBe(true)
    expect(apiBudgetAvailable({ calls: 799, remaining: undefined })).toBe(true)
    expect(apiBudgetAvailable({ calls: 799, remaining: 201 })).toBe(true)
  })

  it('stops at the 800-call cap even when the API budget is unknown or sufficient', () => {
    for (const calls of [800, 801]) {
      expect(apiBudgetAvailable({ calls, remaining: undefined })).toBe(false)
      expect(apiBudgetAvailable({ calls, remaining: 1000 })).toBe(false)
    }
  })

  it('preserves the 200-call API reserve', () => {
    for (const remaining of [0, 199, 200]) {
      expect(apiBudgetAvailable({ calls: 0, remaining })).toBe(false)
      expect(apiBudgetAvailable({ calls: 799, remaining })).toBe(false)
    }
  })
})

describe('artifactInWindow', () => {
  const since = Date.parse('2026-10-20T00:00:00.000Z')
  const until = Date.parse('2026-10-21T00:00:00.000Z')

  it('includes the lower bound and excludes the upper bound', () => {
    for (const [createdAt, expected] of [
      ['2026-10-19T23:59:59.999Z', false],
      ['2026-10-20T00:00:00.000Z', true],
      ['2026-10-20T12:00:00.000Z', true],
      ['2026-10-20T23:59:59.999Z', true],
      ['2026-10-21T00:00:00.000Z', false],
      ['2026-10-21T00:00:00.001Z', false],
    ] as const) {
      expect(artifactInWindow({ createdAt, since, until })).toBe(expected)
    }
  })

  it('rejects invalid creation dates', () => {
    for (const createdAt of ['', 'not-a-date']) {
      expect(artifactInWindow({ createdAt, since, until })).toBe(false)
    }
  })

  it('matches no artifacts in an empty or reversed window', () => {
    const createdAt = '2026-10-20T00:00:00.000Z'
    expect(artifactInWindow({ createdAt, since, until: since })).toBe(false)
    expect(artifactInWindow({ createdAt, since: until, until: since })).toBe(false)
  })
})

const evidenceRun = (id: number, overrides: Partial<EvidenceRun> = {}): EvidenceRun => ({
  id,
  event: 'push',
  head_branch: 'main',
  created_at: new Date(Date.UTC(2026, 9, 20, 0, id)).toISOString(),
  workflow: 'ci-test.yml',
  ...overrides,
})

describe('classifyRun', () => {
  it('classifies event lanes before branch and workflow lanes', () => {
    expect(classifyRun(evidenceRun(1, { event: 'merge_group', workflow: 'ci.yml' }))).toBe(
      'merge_group',
    )
    for (const event of ['pull_request', 'pull_request_target']) {
      expect(classifyRun(evidenceRun(1, { event, workflow: 'ci.yml' }))).toBe('pr')
      expect(classifyRun(evidenceRun(1, { event, head_branch: null }))).toBe('pr')
    }
  })

  it('distinguishes the main writer from other main workflows', () => {
    expect(classifyRun(evidenceRun(1, { workflow: 'ci.yml' }))).toBe('main-writer')
    expect(classifyRun(evidenceRun(1))).toBe('main-reader')
    expect(classifyRun(evidenceRun(1, { event: 'workflow_dispatch' }))).toBe('main-reader')
  })

  it('excludes non-main runs outside reader and merge events', () => {
    for (const head_branch of ['feature', 'Main', null]) {
      expect(classifyRun(evidenceRun(1, { head_branch, workflow: 'ci.yml' }))).toBeUndefined()
    }
  })
})

describe('selectRuns', () => {
  it('reports all empty lanes when no runs qualify', () => {
    const expected = {
      selected: [],
      lanes: [
        { lane: 'main-writer', seen: 0, selected: 0 },
        { lane: 'main-reader', seen: 0, selected: 0 },
        { lane: 'merge_group', seen: 0, selected: 0 },
        { lane: 'pr', seen: 0, selected: 0 },
      ],
    }
    expect(selectRuns([])).toEqual(expected)
    expect(selectRuns([evidenceRun(1, { head_branch: 'feature' })])).toEqual(expected)
  })

  it('retains every main writer and caps each sampled lane independently', () => {
    const runs = Array.from({ length: 30 }, (_, index) => [
      evidenceRun(index + 1, { workflow: 'ci.yml' }),
      evidenceRun(index + 101),
      evidenceRun(index + 201, { event: 'merge_group' }),
      evidenceRun(index + 301, { event: 'pull_request', head_branch: 'feature' }),
    ]).flat()
    const result = selectRuns(runs)
    expect(result.lanes).toEqual([
      { lane: 'main-writer', seen: 30, selected: 30 },
      { lane: 'main-reader', seen: 30, selected: 25 },
      { lane: 'merge_group', seen: 30, selected: 30 },
      { lane: 'pr', seen: 30, selected: 25 },
    ])
    expect(result.selected).toHaveLength(110)
    expect(result.selected.filter((run) => classifyRun(run) === 'main-writer')).toEqual(
      runs.filter((run) => classifyRun(run) === 'main-writer'),
    )
    expect(result.selected.filter((run) => classifyRun(run) === 'merge_group')).toEqual(
      runs.filter((run) => classifyRun(run) === 'merge_group'),
    )
  })

  it('samples at most 50 merge writers per UTC day by numeric run ID', () => {
    const runs = Array.from({ length: 116 }, (_, index) =>
      evidenceRun(index + 1, {
        event: 'merge_group',
        created_at: new Date(Date.UTC(2026, 9, 20, 0, 116 - index)).toISOString(),
      }),
    )
    const result = selectRuns(runs)
    const expectedIds = Array.from({ length: 50 }, (_, index) => 1 + Math.floor((index * 115) / 49))
    expect(result.selected.map((run) => run.id).sort((a, b) => a - b)).toEqual(expectedIds)
    expect(result.lanes.find(({ lane }) => lane === 'merge_group')).toEqual({
      lane: 'merge_group',
      seen: 116,
      selected: 50,
    })
    expect(selectRuns([...runs].reverse())).toEqual(result)
    const nextDay = runs.map((run) => ({
      ...run,
      id: run.id + 1000,
      created_at: run.created_at.replace('2026-10-20', '2026-10-21'),
    }))
    expect(selectRuns([...runs, ...nextDay]).selected).toHaveLength(100)
  })

  it('applies reader limits independently to each UTC day', () => {
    const runs = Array.from({ length: 30 }, (_, index) => evidenceRun(index + 1))
    const nextDay = runs.map((run) => ({
      ...run,
      id: run.id + 100,
      created_at: run.created_at.replace('2026-10-20', '2026-10-21'),
    }))
    expect(selectRuns([...runs, ...nextDay]).selected).toHaveLength(50)
  })

  it('uses evenly spaced indices including both endpoints', () => {
    const runs = Array.from({ length: 11 }, (_, index) => evidenceRun(index + 1))
    expect(selectRuns(runs, 4).selected.map((run) => run.id)).toEqual([1, 4, 7, 11])
    expect(selectRuns(runs, 1).selected.map((run) => run.id)).toEqual([1])
    expect(selectRuns(runs, 0).selected).toEqual([])
    expect(selectRuns(runs, 11).selected).toEqual(runs)
    expect(selectRuns(runs, 20).selected).toEqual(runs)
  })

  it('deduplicates run IDs before counting and sampling', () => {
    const runs = [evidenceRun(1), evidenceRun(2), evidenceRun(3)]
    const result = selectRuns([...runs, ...runs, runs[0]!], 2)
    expect(result.selected.map((run) => run.id)).toEqual([1, 3])
    expect(result.lanes.find(({ lane }) => lane === 'main-reader')).toEqual({
      lane: 'main-reader',
      seen: 3,
      selected: 2,
    })
  })

  it('orders by creation time then numeric ID independently of input order', () => {
    const timestamp = '2026-10-20T12:00:00.000Z'
    const runs = [
      evidenceRun(20, { created_at: timestamp }),
      evidenceRun(3, { created_at: timestamp }),
      evidenceRun(10, { created_at: timestamp }),
      evidenceRun(100, { created_at: '2026-10-20T11:00:00.000Z' }),
      evidenceRun(1, { created_at: '2026-10-20T13:00:00.000Z' }),
    ]
    const expected = selectRuns(runs, 3)
    expect(expected.selected.map((run) => run.id)).toEqual([100, 10, 1])
    expect(selectRuns([...runs].reverse(), 3)).toEqual(expected)
    expect(selectRuns([...runs.slice(2), ...runs.slice(0, 2)], 3)).toEqual(expected)
    expect(selectRuns(runs, 1).selected.map((run) => run.id)).toEqual([100])
  })

  it('chooses duplicate metadata deterministically across permutations', () => {
    const runs = [
      evidenceRun(1, { workflow: 'ci.yml' }),
      evidenceRun(1, { workflow: 'ci-test.yml' }),
      evidenceRun(2),
    ]
    expect(selectRuns(runs)).toEqual(selectRuns([...runs].reverse()))
  })
})
