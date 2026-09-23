import { describe, expect, it } from 'vitest'

import { parseSemconvModelVersion, parseWeaverVersionPins } from './weaver-check-runner.ts'

describe('Weaver check runner', () => {
  it('parses the coupled Weaver and semconv pins', () => {
    expect(
      parseWeaverVersionPins({
        flakeNix: 'version = "0.24.2";\nsemconvVersion = "1.37.0";',
        registrySource:
          "export const PINNED_WEAVER_VERSION = '0.24.2'\nexport const PINNED_UPSTREAM_SEMCONV_VERSION = 'v1.37.0'",
      }),
    ).toEqual({
      flake: { weaver: '0.24.2', semconv: '1.37.0' },
      registry: { weaver: '0.24.2', semconv: 'v1.37.0' },
    })
  })

  it('derives the semantic conventions version from the exact model closure', () => {
    expect(parseSemconvModelVersion('/nix/store/0123456789-semconv-model-1.37.0')).toBe('1.37.0')
    expect(() => parseSemconvModelVersion('/nix/store/0123456789-semconv-model')).toThrow(
      'Could not parse semantic conventions model version',
    )
  })

  it('fails closed when a pin is absent', () => {
    expect(() => parseWeaverVersionPins({ flakeNix: '', registrySource: '' })).toThrow(
      'Could not parse flake Weaver version',
    )
  })
})
