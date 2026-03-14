import { describe, expect, it } from 'vitest'

import {
  parseNixFlakeUrl,
  serializeNixFlakeUrl,
  updateNixFlakeUrl,
  getRef,
  getRev,
  getDir,
  getOwnerRepo,
} from './flake-url.ts'

// =============================================================================
// parseNixFlakeUrl
// =============================================================================

describe('parseNixFlakeUrl', () => {
  it('should parse github:owner/repo', () => {
    const result = parseNixFlakeUrl('github:overengineeringstudio/effect-utils')
    expect(result).toMatchInlineSnapshot(`
      {
        "owner": "overengineeringstudio",
        "params": Map {},
        "ref": undefined,
        "repo": "effect-utils",
        "scheme": "github",
      }
    `)
  })

  it('should parse github:owner/repo/ref', () => {
    const result = parseNixFlakeUrl(
      'github:overengineeringstudio/effect-utils/schickling/2026-03-08-foo',
    )
    expect(result?.scheme).toBe('github')
    expect(result?.owner).toBe('overengineeringstudio')
    expect(result?.repo).toBe('effect-utils')
    expect(getRef(result!)).toBe('schickling/2026-03-08-foo')
  })

  it('should parse github:owner/repo?dir=path', () => {
    const result = parseNixFlakeUrl(
      'github:overengineeringstudio/effect-utils?dir=nix/playwright-flake',
    )
    expect(result?.scheme).toBe('github')
    expect(result?.owner).toBe('overengineeringstudio')
    expect(result?.repo).toBe('effect-utils')
    expect(getRef(result!)).toBeUndefined()
    expect(getDir(result!)).toBe('nix/playwright-flake')
  })

  it('should parse git+https URL with ref and rev', () => {
    const url =
      'git+https://github.com/overengineeringstudio/effect-utils?ref=schickling/2026-03-08-foo&rev=51a67f704ddac6afd3a5230e696dbc440257f07d'
    const result = parseNixFlakeUrl(url)
    expect(result?.scheme).toBe('git+https')
    expect(result?.owner).toBe('overengineeringstudio')
    expect(result?.repo).toBe('effect-utils')
    expect(getRef(result!)).toBe('schickling/2026-03-08-foo')
    expect(getRev(result!)).toBe('51a67f704ddac6afd3a5230e696dbc440257f07d')
  })

  it('should parse git+https URL without query params', () => {
    const result = parseNixFlakeUrl('git+https://github.com/overengineeringstudio/effect-utils')
    expect(result?.scheme).toBe('git+https')
    expect(getRef(result!)).toBeUndefined()
    expect(getRev(result!)).toBeUndefined()
  })

  it('should parse git+ssh URL with .git suffix', () => {
    const result = parseNixFlakeUrl(
      'git+ssh://git@github.com/overengineeringstudio/effect-utils.git',
    )
    expect(result?.scheme).toBe('git+ssh')
    expect(result?.owner).toBe('overengineeringstudio')
    expect(result?.repo).toBe('effect-utils')
    expect(result?.scheme === 'git+ssh' && result.dotGit).toBe(true)
  })

  it('should parse git+ssh URL with ref query param', () => {
    const url =
      'git+ssh://git@github.com/overengineeringstudio/private-shared?ref=schickling/feature'
    const result = parseNixFlakeUrl(url)
    expect(result?.scheme).toBe('git+ssh')
    expect(getRef(result!)).toBe('schickling/feature')
  })

  it('should return undefined for non-nix URLs', () => {
    expect(parseNixFlakeUrl('https://github.com/owner/repo')).toBeUndefined()
    expect(parseNixFlakeUrl('git@github.com:owner/repo')).toBeUndefined()
    expect(parseNixFlakeUrl('/local/path')).toBeUndefined()
  })

  it('should return undefined for malformed github: URLs', () => {
    expect(parseNixFlakeUrl('github:')).toBeUndefined()
    expect(parseNixFlakeUrl('github:owner')).toBeUndefined()
    expect(parseNixFlakeUrl('github:/repo')).toBeUndefined()
  })
})

// =============================================================================
// serializeNixFlakeUrl (round-trip)
// =============================================================================

describe('serializeNixFlakeUrl', () => {
  const roundTrip = (url: string) => {
    const parsed = parseNixFlakeUrl(url)
    expect(parsed).toBeDefined()
    return serializeNixFlakeUrl(parsed!)
  }

  it('should round-trip github:owner/repo', () => {
    expect(roundTrip('github:overengineeringstudio/effect-utils')).toBe(
      'github:overengineeringstudio/effect-utils',
    )
  })

  it('should round-trip github:owner/repo/ref', () => {
    const url = 'github:overengineeringstudio/effect-utils/schickling/2026-03-08-foo'
    expect(roundTrip(url)).toBe(url)
  })

  it('should round-trip github:owner/repo?dir=path', () => {
    const url = 'github:overengineeringstudio/effect-utils?dir=nix/playwright-flake'
    expect(roundTrip(url)).toBe(url)
  })

  it('should round-trip git+https with ref and rev', () => {
    const url =
      'git+https://github.com/overengineeringstudio/effect-utils?ref=schickling/2026-03-08-foo&rev=51a67f7'
    expect(roundTrip(url)).toBe(url)
  })

  it('should round-trip git+ssh with .git suffix', () => {
    const url = 'git+ssh://git@github.com/overengineeringstudio/effect-utils.git'
    expect(roundTrip(url)).toBe(url)
  })

  it('should round-trip git+ssh with ref', () => {
    const url = 'git+ssh://git@github.com/overengineeringstudio/private-shared?ref=main'
    expect(roundTrip(url)).toBe(url)
  })
})

// =============================================================================
// updateNixFlakeUrl
// =============================================================================

describe('updateNixFlakeUrl', () => {
  describe('github: scheme', () => {
    it('should update ref (path-embedded)', () => {
      const url = 'github:overengineeringstudio/effect-utils/main'
      const result = updateNixFlakeUrl({ url, updates: { ref: 'schickling/feature' } })
      expect(result).toBe('github:overengineeringstudio/effect-utils/schickling/feature')
    })

    it('should add ref to bare URL', () => {
      const url = 'github:overengineeringstudio/effect-utils'
      const result = updateNixFlakeUrl({ url, updates: { ref: 'schickling/feature' } })
      expect(result).toBe('github:overengineeringstudio/effect-utils/schickling/feature')
    })

    it('should remove ref with null', () => {
      const url = 'github:overengineeringstudio/effect-utils/main'
      const result = updateNixFlakeUrl({ url, updates: { ref: null } })
      expect(result).toBe('github:overengineeringstudio/effect-utils')
    })

    it('should preserve ?dir= when updating ref', () => {
      const url = 'github:overengineeringstudio/effect-utils?dir=nix/playwright-flake'
      const result = updateNixFlakeUrl({ url, updates: { ref: 'schickling/feature' } })
      expect(result).toBe(
        'github:overengineeringstudio/effect-utils/schickling/feature?dir=nix/playwright-flake',
      )
    })
  })

  describe('git+https scheme', () => {
    it('should update ref query param', () => {
      const url = 'git+https://github.com/overengineeringstudio/effect-utils?ref=main&rev=abc123'
      const result = updateNixFlakeUrl({ url, updates: { ref: 'schickling/feature' } })
      expect(result).toBe(
        'git+https://github.com/overengineeringstudio/effect-utils?ref=schickling/feature&rev=abc123',
      )
    })

    it('should update rev query param', () => {
      const url = 'git+https://github.com/overengineeringstudio/effect-utils?ref=main&rev=abc123'
      const result = updateNixFlakeUrl({ url, updates: { rev: 'def456' } })
      expect(result).toBe(
        'git+https://github.com/overengineeringstudio/effect-utils?ref=main&rev=def456',
      )
    })

    it('should update both ref and rev', () => {
      const url = 'git+https://github.com/overengineeringstudio/effect-utils?ref=main&rev=abc123'
      const result = updateNixFlakeUrl({ url, updates: { ref: 'feature', rev: 'def456' } })
      expect(result).toBe(
        'git+https://github.com/overengineeringstudio/effect-utils?ref=feature&rev=def456',
      )
    })

    it('should remove rev with null', () => {
      const url = 'git+https://github.com/overengineeringstudio/effect-utils?ref=main&rev=abc123'
      const result = updateNixFlakeUrl({ url, updates: { rev: null } })
      expect(result).toBe('git+https://github.com/overengineeringstudio/effect-utils?ref=main')
    })

    it('should add ref to URL without query params', () => {
      const url = 'git+https://github.com/overengineeringstudio/effect-utils'
      const result = updateNixFlakeUrl({ url, updates: { ref: 'feature' } })
      expect(result).toBe('git+https://github.com/overengineeringstudio/effect-utils?ref=feature')
    })
  })

  describe('git+ssh scheme', () => {
    it('should add ref to git+ssh URL', () => {
      const url = 'git+ssh://git@github.com/overengineeringstudio/effect-utils.git'
      const result = updateNixFlakeUrl({ url, updates: { ref: 'feature' } })
      expect(result).toBe(
        'git+ssh://git@github.com/overengineeringstudio/effect-utils.git?ref=feature',
      )
    })
  })

  it('should return the original URL if parsing fails', () => {
    const url = 'https://example.com/something'
    expect(updateNixFlakeUrl({ url, updates: { ref: 'feature' } })).toBe(url)
  })
})

// =============================================================================
// Helper functions
// =============================================================================

describe('getOwnerRepo', () => {
  it('should extract owner/repo from all schemes', () => {
    const github = parseNixFlakeUrl('github:owner/repo/ref')!
    expect(getOwnerRepo(github)).toEqual({ owner: 'owner', repo: 'repo' })

    const https = parseNixFlakeUrl('git+https://github.com/Org/Repo')!
    expect(getOwnerRepo(https)).toEqual({ owner: 'Org', repo: 'Repo' })

    const ssh = parseNixFlakeUrl('git+ssh://git@github.com/org/repo.git')!
    expect(getOwnerRepo(ssh)).toEqual({ owner: 'org', repo: 'repo' })
  })
})
