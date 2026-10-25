import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import type { InputReason } from '../runtime/node/input-observations.ts'
import { accountSourceGraph, summarizeInputReasons } from './input-manifest.ts'

type SourceModule =
  Parameters<typeof accountSourceGraph>[0]['graph'] extends ReadonlyMap<string, infer TModule>
    ? TModule
    : never

const moduleNode = (module: string, children: Array<string> = []): SourceModule => ({
  module,
  children,
  reasons: [],
})

const entries = [
  { module: 'a.genie.ts', generator: 'a.genie.ts' },
  { module: 'b.genie.ts', generator: 'b.genie.ts' },
  { module: 'other.genie.ts', generator: 'other.genie.ts' },
]

describe('source closure accounting', () => {
  it('expands shared transitive helpers and cycles to exactly their importing generators', () => {
    const graph = new Map<string, SourceModule>([
      ['a.genie.ts', moduleNode('a.genie.ts', ['shared.ts'])],
      ['b.genie.ts', moduleNode('b.genie.ts', ['bridge.ts'])],
      ['bridge.ts', moduleNode('bridge.ts', ['shared.ts'])],
      ['shared.ts', moduleNode('shared.ts', ['leaf.ts'])],
      ['leaf.ts', moduleNode('leaf.ts', ['shared.ts'])],
      ['other.genie.ts', moduleNode('other.genie.ts')],
    ])
    const reasons = accountSourceGraph({ entries: entries, graph: graph })
    for (const module of ['shared.ts', 'leaf.ts']) {
      expect(reasons.find((reason) => reason.source.module === module)?.generators).toEqual([
        'a.genie.ts',
        'b.genie.ts',
      ])
    }
    expect(reasons.find((reason) => reason.source.module === 'bridge.ts')?.generators).toEqual([
      'b.genie.ts',
    ])
  })

  it('keeps an unrestricted module incomplete even with no visible bypasses', () => {
    const reasons = accountSourceGraph({
      entries: [{ module: 'plain.genie.ts', generator: 'plain.genie.ts' }],
      graph: new Map([['plain.genie.ts', moduleNode('plain.genie.ts')]]),
    })
    expect(reasons).toEqual([
      {
        code: 'unknown-capability',
        operation: 'module-closure',
        detail: 'Unrestricted module input closure is not accounted for.',
        source: { module: 'plain.genie.ts', line: null },
        evidence: 'unproven',
        generators: ['plain.genie.ts'],
      },
    ])
  })

  it('retains every capability occurrence and its origin alongside conservative unknown', () => {
    const shared = moduleNode('shared.ts')
    shared.reasons = [
      {
        code: 'unmediated-fs',
        operation: 'Bun.file',
        detail: 'Static capability presence; execution is unproven.',
        source: { module: 'shared.ts', line: 3 },
        evidence: 'unproven',
      },
      {
        code: 'ambient-env',
        operation: 'process.env',
        detail: 'Static capability presence; execution is unproven.',
        source: { module: 'shared.ts', line: 4 },
        evidence: 'unproven',
      },
    ]
    const reasons = accountSourceGraph({
      entries: entries,
      graph: new Map([
        ['a.genie.ts', moduleNode('a.genie.ts', ['shared.ts'])],
        ['b.genie.ts', moduleNode('b.genie.ts', ['shared.ts'])],
        ['other.genie.ts', moduleNode('other.genie.ts')],
        ['shared.ts', shared],
      ]),
    }).filter((reason) => reason.source.module === 'shared.ts')
    expect(reasons.map((reason) => reason.code)).toEqual([
      'unknown-capability',
      'unmediated-fs',
      'ambient-env',
    ])
    expect(reasons.map((reason) => reason.source.line)).toEqual([null, 3, 4])
    expect(reasons.every((reason) => reason.evidence === 'unproven')).toBe(true)
    for (const reason of reasons) expect(reason.generators).toEqual(['a.genie.ts', 'b.genie.ts'])
  })

  it('names opaque dependencies and expands their exact affected generators', () => {
    const reasons = accountSourceGraph({
      entries: entries,
      graph: new Map([
        ['a.genie.ts', moduleNode('a.genie.ts', ['dependency/subpath'])],
        ['b.genie.ts', moduleNode('b.genie.ts', ['shared.ts'])],
        ['shared.ts', moduleNode('shared.ts', ['dependency/subpath'])],
        ['dependency/subpath', moduleNode('dependency/subpath')],
        ['other.genie.ts', moduleNode('other.genie.ts')],
      ]),
    })
    expect(reasons.find((reason) => reason.source.module === 'dependency/subpath')).toMatchObject({
      code: 'unknown-capability',
      generators: ['a.genie.ts', 'b.genie.ts'],
      evidence: 'unproven',
    })
  })

  it.effect(
    'groups occurrence counts by code and exact source without dropping per-generator attribution',
    () =>
      Effect.sync(() => {
        const reason: InputReason = {
          code: 'ambient-env',
          operation: 'process.env',
          detail: 'Unproven capability.',
          source: { module: 'shared.ts', line: 3 },
          evidence: 'unproven',
          generators: ['a.genie.ts'],
        }
        const groups = summarizeInputReasons([
          reason,
          { ...reason, operation: 'process.cwd', generators: ['b.genie.ts'] },
          { ...reason, code: 'unknown-capability', generators: ['a.genie.ts', 'b.genie.ts'] },
          { ...reason, source: { module: 'shared.ts', line: 4 } },
          { ...reason, source: { module: 'dependency/subpath', line: null } },
        ])
        expect(groups).toHaveLength(4)
        expect(
          groups.find(
            (group) =>
              group.code === 'ambient-env' &&
              group.source.module === 'shared.ts' &&
              group.source.line === 3,
          ),
        ).toEqual({
          code: 'ambient-env',
          source: { module: 'shared.ts', line: 3 },
          occurrences: 2,
          generators: ['a.genie.ts', 'b.genie.ts'],
        })
        expect(groups.reduce((count, group) => count + group.occurrences, 0)).toBe(5)
        expect(summarizeInputReasons([])).toEqual([])
      }),
  )
})
