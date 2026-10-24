import { describe, expect, it } from 'bun:test'

import {
  capabilityGeneration,
  capabilityReferences,
  retainedCapabilityGenerations,
  retainedCapabilityTools,
} from './buck2-capability-publish.ts'

const a = 'a'.repeat(64)
const b = 'b'.repeat(64)
const c = 'c'.repeat(64)
const d = 'd'.repeat(64)

describe('capability publication identity', () => {
  it('reads the exact generated Starlark literal without evaluating definitions', () => {
    expect(capabilityGeneration(`GENERATION = "${a}"\nCAPABILITIES = {}\n`)).toBe(a)
  })

  it.each([
    'CAPABILITIES = {}\n',
    'GENERATION = "../escape"\n',
    `GENERATION = "${'A'.repeat(64)}"\n`,
    `GENERATION = "${a}"\nGENERATION = "${b}"\n`,
    `GENERATION = "${a}" + "suffix"\n`,
  ])('rejects a missing, unsafe, ambiguous, or computed identity', (defs) => {
    expect(() => capabilityGeneration(defs)).toThrow('exactly one SHA-256 GENERATION')
  })
})

describe('daemon-free capability retention', () => {
  it('keeps the current generation plus the two most recent other publications', () => {
    expect([
      ...retainedCapabilityGenerations({
        publications: [
          { generation: a, sequence: 1 },
          { generation: b, sequence: 2 },
          { generation: c, sequence: 3 },
          { generation: d, sequence: 4 },
        ],
        current: d,
      }),
    ]).toEqual([d, c, b])
  })

  it('retains a re-published old generation as current, not only numerically newest receipts', () => {
    expect([
      ...retainedCapabilityGenerations({
        publications: [
          { generation: a, sequence: 1 },
          { generation: b, sequence: 2 },
          { generation: c, sequence: 3 },
          { generation: d, sequence: 4 },
        ],
        current: a,
      }),
    ]).toEqual([a, d, c])
  })

  it('never duplicates current or invents unused historical generations', () => {
    expect([
      ...retainedCapabilityGenerations({
        publications: [{ generation: a, sequence: 5 }],
        current: a,
      }),
    ]).toEqual([a])
    expect([...retainedCapabilityGenerations({ publications: [], current: a })]).toEqual([a])
  })

  it('orders receipt-free migrated generations deterministically', () => {
    expect([
      ...retainedCapabilityGenerations({
        publications: [
          { generation: c, sequence: 0 },
          { generation: b, sequence: 0 },
          { generation: a, sequence: 0 },
        ],
        current: d,
      }),
    ]).toEqual([d, a, b])
  })
})

describe('per-tool publication references', () => {
  const archiveA = `tools/x86_64-linux/archive-tool/${a}`
  const archiveB = `tools/x86_64-linux/archive-tool/${b}`
  const directory = `tools/x86_64-linux/support-directory/${c}`

  it('canonicalizes duplicate references without introducing generation paths', () => {
    expect(capabilityReferences([directory, archiveA, archiveA])).toEqual([archiveA, directory])
  })

  it('accepts the authoritative capability token alphabet for tool IDs', () => {
    const reference = `tools/x86_64-linux/Archive.Tool_2+native-tool/${a}`
    expect(capabilityReferences([reference])).toEqual([reference])
  })

  it.each([
    undefined,
    {},
    ['generations/' + a],
    [`tools/x86_64-linux/../${a}`],
    [`tools/x86_64-linux/./${a}`],
    [`tools/x86_64-linux/archive-tool/${a}/executable`],
    [`tools/x86_64-linux/archive-tool/${'A'.repeat(64)}`],
    [42],
  ])('rejects malformed or unsafe reference sets', (value) => {
    expect(() => capabilityReferences(value)).toThrow('Invalid capability tool reference set')
  })

  it('retains shared tool identities until every retaining generation is gone', () => {
    const references = new Map([
      [a, [archiveA, directory]],
      [b, [archiveB, directory]],
      [c, [archiveB, directory]],
    ])
    expect([...retainedCapabilityTools({ references, retained: new Set([b, c]) })]).toEqual([
      archiveB,
      directory,
    ])
    expect([...retainedCapabilityTools({ references, retained: new Set([a, b]) })]).toEqual([
      archiveA,
      directory,
      archiveB,
    ])
  })

  it('allows legacy generations with no new-layout action references', () => {
    expect([
      ...retainedCapabilityTools({
        references: new Map([
          [a, []],
          [b, [archiveB]],
        ]),
        retained: new Set([a]),
      }),
    ]).toEqual([])
  })
})
