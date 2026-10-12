import { describe, expect, it } from 'vitest'

import { fingerprint, fingerprintInputs } from './artifact-registry.ts'
import { semanticFingerprint } from './projection.ts'

// These values were computed before the PTY callsite inventory and catalog
// projection were collapsed onto this primitive. They must never change:
// committed catalogs, inventories, and generated provenance embed them.
describe('shared fingerprint vectors', () => {
  it.each([
    [{}, 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'],
    [
      { b: [3, { z: null, a: true }], a: '🚀' },
      'sha256:9c7686fb2bc493bfc89f6cdb795fa06dea9b30ca6af5b4d31141b4f14961aab3',
    ],
    [
      ['\u00e9', 'e\u0301', false, null],
      'sha256:b0ac97752082b530eca2465818f5039dfb6d9090cc382731e1d432ac1e74ef8c',
    ],
    [
      { '10': 'ten', '2': 'two', a: 0 },
      'sha256:5d484f585dfa9867bcdc616e75adee7c73f1c4c385d09dae23918f200e87ec65',
    ],
  ])('keeps semantic fingerprint %j', (value, expected) => {
    expect(semanticFingerprint(value)).toBe(expected)
  })
  it('keeps content and length-prefixed input fingerprints', () => {
    expect(fingerprint('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(fingerprintInputs([{ path: 'a', content: 'bc' }])).toBe(
      '5310a58788781ab25d5ad7c3f85035824b4eb7bdfa394e0ac2186271472b5492',
    )
  })
})
