import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import {
  canonicalizeDistOverlayDeclarations,
  DistOverlayDeclaration,
} from './dist-overlay-schema.ts'

describe('dist overlay declarations', () => {
  it('strictly decodes normalized targets and destinations and canonicalizes by destination', () => {
    const decode = Schema.decodeUnknownSync(DistOverlayDeclaration, {
      errors: 'all',
      onExcessProperty: 'error',
    })
    expect(decode({ target: '//pkg:dist', destination: 'dist/pkg' })).toEqual({
      target: '//pkg:dist',
      destination: 'dist/pkg',
    })
    expect(() => decode({ target: '//pkg:dist', destination: '../dist' })).toThrow()
    expect(() => decode({ target: '//pkg:dist', destination: '' })).toThrow()
    expect(() => decode({ target: '//pkg:dist', destination: 'dist', extra: true })).toThrow()
    expect(
      canonicalizeDistOverlayDeclarations([
        { target: '//z:dist', destination: 'z/dist' },
        { target: '//a:dist', destination: 'a/dist' },
      ]),
    ).toEqual([
      { target: '//a:dist', destination: 'a/dist' },
      { target: '//z:dist', destination: 'z/dist' },
    ])
  })

  it.each([
    [
      [
        { target: '//a:dist', destination: 'dist' },
        { target: '//b:dist', destination: 'dist/nested' },
      ],
      /overlap/u,
    ],
    [[{ target: '//a:dist', destination: '.buck2' }], /capabilities/u],
    [[{ target: '//a:dist', destination: '.buck2/capabilities/tools' }], /capabilities/u],
    [
      [
        { target: '//a:dist', destination: 'Dist' },
        { target: '//b:dist', destination: 'dist/nested' },
      ],
      /overlap/u,
    ],
    [
      [
        { target: '//a:dist', destination: 'a' },
        { target: '//a:dist', destination: 'b' },
      ],
      /Duplicate dist overlay target/u,
    ],
  ])('rejects ambiguous destination ownership %#', (declarations, expected) => {
    expect(() => canonicalizeDistOverlayDeclarations(declarations)).toThrow(expected)
  })
})
