import { describe, expect, it } from 'vitest'

import manifest from '../nix/buck2-products/manifest.json' with { type: 'json' }
import { deriveBuck2PackagePin } from './package-publication.ts'

const producerCommit = '9d58d20faa068e4fa10345d19db241abe48cdbec'
const lock = {
  members: {
    'effect-utils': {
      commit: producerCommit,
    },
  },
}

describe('deriveBuck2PackagePin', () => {
  it('derives the published utils URL and integrity from the locked producer', () => {
    expect(
      deriveBuck2PackagePin({
        lock,
        manifest,
        packageName: '@overeng/utils',
      }),
    ).toEqual({
      integrity:
        'sha512-zD2EdAQEmFXRcdtNf86nLp1L4of0S4cLZH2v6+Swid0XDuuxg23M+ThlMYpHrQj4iCSME8m7XvC3BN1oCIVVbA==',
      url: 'https://github.com/overengineeringstudio/effect-utils/releases/download/buck2-package-v1-overeng-utils-5ec4fb7b529fb020ab4159491fe46ad8a36c9a8859370236f426eba925953f2b/5ec4fb7b529fb020ab4159491fe46ad8a36c9a8859370236f426eba925953f2b-overeng-utils.tgz',
    })
  })

  it('rejects a manifest from a different producer commit', () => {
    expect(() =>
      deriveBuck2PackagePin({
        lock: {
          members: {
            'effect-utils': {
              commit: '0000000000000000000000000000000000000000',
            },
          },
        },
        manifest,
        packageName: '@overeng/utils',
      }),
    ).toThrow(/producer commit/)
  })

  it('rejects descriptor and release binding drift', () => {
    const changedManifest = structuredClone(manifest)
    const entry = changedManifest.products.find(
      ({ descriptor }) => descriptor.productName === '@overeng/utils',
    )
    if (entry === undefined) throw new Error('utils fixture is missing')
    entry.release.url = 'https://example.invalid/mutable.tgz'

    expect(() =>
      deriveBuck2PackagePin({
        lock,
        manifest: changedManifest,
        packageName: '@overeng/utils',
      }),
    ).toThrow(/release binding/)
  })
})
