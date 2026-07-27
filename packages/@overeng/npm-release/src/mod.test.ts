import { describe, expect, it } from 'vitest'

import {
  integrityFromBase64Sha512,
  type RemoteRegistryState,
  registryVerification,
  shouldPublishWithProvenance,
} from './mod.ts'

describe('registryVerification', () => {
  const base = { pkg: '@scope/pkg', version: '1.2.0', npmTag: 'latest' }
  const localIntegrity = 'sha512-local'

  it('accepts a release the registry serves under the expected version and dist-tag', () => {
    expect(
      registryVerification({
        ...base,
        localIntegrity,
        remote: { version: '1.2.0', integrity: localIntegrity, distTag: '1.2.0' },
      }),
    ).toEqual({ _tag: 'ok' })
  })

  it('treats a not-yet-visible version as pending so propagation can be retried', () => {
    expect(
      registryVerification({
        ...base,
        localIntegrity,
        remote: { version: undefined, integrity: undefined, distTag: '1.1.0' },
      })._tag,
    ).toBe('pending')
  })

  // The failure this package exists for: the version publishes fine, but the tag
  // still resolves to the previous release, so installs stay on the old version.
  it('flags a dist-tag still pointing at the previous release', () => {
    expect(
      registryVerification({
        ...base,
        localIntegrity,
        remote: { version: '1.2.0', integrity: localIntegrity, distTag: '1.1.0' },
      }),
    ).toEqual({
      _tag: 'pending',
      reason: '@scope/pkg: dist-tag "latest" points at 1.1.0, expected 1.2.0',
    })
  })

  it('flags an absent dist-tag, which leaves the published version unreachable', () => {
    const result = registryVerification({
      ...base,
      localIntegrity,
      remote: { version: '1.2.0', integrity: localIntegrity, distTag: undefined },
    })

    expect(result._tag).toBe('pending')
    expect(result).toMatchObject({ reason: expect.stringContaining('is absent') })
  })

  // Immutable on npm, so retrying can never resolve it.
  it('reports a differing tarball digest as an unrecoverable mismatch', () => {
    expect(
      registryVerification({
        ...base,
        localIntegrity,
        remote: { version: '1.2.0', integrity: 'sha512-other', distTag: '1.2.0' },
      })._tag,
    ).toBe('mismatch')
  })

  it('reports an unexpected served version as a mismatch rather than pending', () => {
    expect(
      registryVerification({
        ...base,
        localIntegrity,
        remote: { version: '9.9.9', integrity: localIntegrity, distTag: '1.2.0' },
      })._tag,
    ).toBe('mismatch')
  })

  // Repairing a partial release re-verifies packages it did not pack.
  it('skips the digest comparison when there is no locally packed artifact', () => {
    expect(
      registryVerification({
        ...base,
        localIntegrity: undefined,
        remote: { version: '1.2.0', integrity: 'sha512-whatever', distTag: '1.2.0' },
      }),
    ).toEqual({ _tag: 'ok' })
  })

  it('skips the digest comparison when the registry reports no integrity', () => {
    expect(
      registryVerification({
        ...base,
        localIntegrity,
        remote: { version: '1.2.0', integrity: undefined, distTag: '1.2.0' },
      }),
    ).toEqual({ _tag: 'ok' })
  })

  it('verifies the dist-tag the release used rather than assuming latest', () => {
    const remote: RemoteRegistryState = {
      version: '2.0.0-beta.1',
      integrity: localIntegrity,
      distTag: '2.0.0-beta.1',
    }

    expect(
      registryVerification({
        pkg: '@scope/pkg',
        version: '2.0.0-beta.1',
        npmTag: 'next',
        localIntegrity,
        remote,
      }),
    ).toEqual({ _tag: 'ok' })
  })
})

describe('shouldPublishWithProvenance', () => {
  it.each([
    { dryRun: false, isGithubActions: true, expected: true },
    { dryRun: true, isGithubActions: true, expected: false },
    { dryRun: false, isGithubActions: false, expected: false },
    { dryRun: true, isGithubActions: false, expected: false },
  ])(
    'dryRun=$dryRun isGithubActions=$isGithubActions -> $expected',
    ({ dryRun, isGithubActions, expected }) => {
      expect(shouldPublishWithProvenance({ dryRun, isGithubActions })).toBe(expected)
    },
  )
})

describe('integrityFromBase64Sha512', () => {
  it('formats a digest the way npm reports dist.integrity', () => {
    expect(integrityFromBase64Sha512('abc123==')).toBe('sha512-abc123==')
  })
})
