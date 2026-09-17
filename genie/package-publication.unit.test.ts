import { describe, expect, it } from 'vitest'

import manifest from '../nix/buck2-products/manifest.json' with { type: 'json' }
import { deriveBuck2PackagePin } from './package-publication.ts'

const producerCommit = 'a81f26a433fe751ed9918f9c0bfff6d4744e6c83'
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
        'sha512-xS9ZPedqG53FrL+7s+DGklDQkIt8NcrNyjGZxRH9r17dVWMXBc9pbqfUlFY5iUzqL0ZKBXW9QG0pb+vhmtZoGw==',
      url: 'https://github.com/overengineeringstudio/effect-utils/releases/download/buck2-package-v1-overeng-utils-7b1c61692ab180d65fe0f4e6f555ee8ad3ea22334ce90ed079254688b6192452/7b1c61692ab180d65fe0f4e6f555ee8ad3ea22334ce90ed079254688b6192452-overeng-utils.tgz',
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
