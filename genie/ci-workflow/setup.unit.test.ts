import { describe, expect, it } from 'bun:test'

import { namespaceRunner } from './setup.ts'

describe('namespaceRunner', () => {
  it('appends run-id affinity to runner profiles, including matrix-selected profiles', () => {
    expect(namespaceRunner({ profile: 'namespace-profile-linux-x86-64', runId: '42' })).toEqual([
      'namespace-profile-linux-x86-64;github.run-id=42',
    ])
    expect(
      namespaceRunner({ profile: '${{ matrix.runner }}', runId: '${{ github.run_id }}' }),
    ).toEqual(['${{ matrix.runner }};github.run-id=${{ github.run_id }}'])
  })

  it('keeps the separate features label for -with-features machine labels', () => {
    expect(
      namespaceRunner({ profile: 'nscloud-ubuntu-24.04-amd64-16x64-with-features', runId: '42' }),
    ).toEqual([
      'nscloud-ubuntu-24.04-amd64-16x64-with-features',
      'namespace-features:github.run-id=42',
    ])
  })
})
