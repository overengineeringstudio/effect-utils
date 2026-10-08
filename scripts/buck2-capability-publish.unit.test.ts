import { describe, expect, it } from 'bun:test'

import { capabilityGeneration, retainedCapabilityGenerations } from './buck2-capability-publish.ts'

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
