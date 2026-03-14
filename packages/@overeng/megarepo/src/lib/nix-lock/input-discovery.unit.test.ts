import { describe, expect, it } from 'vitest'

import {
  extractFlakeNixInputs,
  extractDevenvYamlInputs,
  extractLockFileInputs,
  matchUrlToMember,
} from './input-discovery.ts'
import type { LockedMember } from '../lock.ts'

// =============================================================================
// Helpers
// =============================================================================

const createLockedMember = (overrides: Partial<LockedMember> = {}): LockedMember => ({
  url: 'https://github.com/owner/repo',
  ref: 'main',
  commit: 'abc123def456789012345678901234567890abcd',
  pinned: false,
  lockedAt: '2024-01-15T10:30:00Z',
  ...overrides,
})

// =============================================================================
// extractFlakeNixInputs
// =============================================================================

describe('extractFlakeNixInputs', () => {
  it('should extract github: URL from flake.nix', () => {
    const content = `{
  inputs = {
    effect-utils.url = "github:overengineeringstudio/effect-utils/schickling/2026-03-08-foo";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
  };
}`
    const result = extractFlakeNixInputs(content)
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "inputName": "effect-utils",
          "url": "github:overengineeringstudio/effect-utils/schickling/2026-03-08-foo",
        },
        {
          "inputName": "nixpkgs",
          "url": "github:NixOS/nixpkgs/nixos-24.05",
        },
      ]
    `)
  })

  it('should extract git+ssh URL from flake.nix', () => {
    const content = `{
  inputs.private-shared.url = "git+ssh://git@github.com/overengineeringstudio/private-shared.git";
}`
    const result = extractFlakeNixInputs(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.inputName).toBe('private-shared')
    expect(result[0]!.url).toBe(
      'git+ssh://git@github.com/overengineeringstudio/private-shared.git',
    )
  })

  it('should extract git+https URL with query params', () => {
    const content = `{
  inputs.effect-utils.url = "git+https://github.com/overengineeringstudio/effect-utils?ref=main&rev=abc123";
}`
    const result = extractFlakeNixInputs(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.url).toBe(
      'git+https://github.com/overengineeringstudio/effect-utils?ref=main&rev=abc123',
    )
  })

  it('should handle empty content', () => {
    expect(extractFlakeNixInputs('')).toEqual([])
  })
})

// =============================================================================
// extractDevenvYamlInputs
// =============================================================================

describe('extractDevenvYamlInputs', () => {
  it('should extract inputs from devenv.yaml', () => {
    const content = `inputs:
  effect-utils:
    url: github:overengineeringstudio/effect-utils/schickling/2026-03-08-foo
    flake: true
  playwright:
    url: github:overengineeringstudio/effect-utils?dir=nix/playwright-flake
    flake: true

allowUnfree: true`
    const result = extractDevenvYamlInputs(content)
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "inputName": "effect-utils",
          "url": "github:overengineeringstudio/effect-utils/schickling/2026-03-08-foo",
        },
        {
          "inputName": "playwright",
          "url": "github:overengineeringstudio/effect-utils?dir=nix/playwright-flake",
        },
      ]
    `)
  })

  it('should extract git+https URL from devenv.yaml', () => {
    const content = `inputs:
  effect-utils:
    url: git+https://github.com/overengineeringstudio/effect-utils?ref=main&rev=abc123`
    const result = extractDevenvYamlInputs(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.url).toBe(
      'git+https://github.com/overengineeringstudio/effect-utils?ref=main&rev=abc123',
    )
  })

  it('should handle quoted URLs', () => {
    const content = `inputs:
  effect-utils:
    url: "github:overengineeringstudio/effect-utils/main"`
    const result = extractDevenvYamlInputs(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.url).toBe('github:overengineeringstudio/effect-utils/main')
  })

  it('should handle empty content', () => {
    expect(extractDevenvYamlInputs('')).toEqual([])
  })

  it('should not extract from non-inputs sections', () => {
    const content = `allowUnfree: true
packages:
  - some-package`
    expect(extractDevenvYamlInputs(content)).toEqual([])
  })
})

// =============================================================================
// extractLockFileInputs
// =============================================================================

describe('extractLockFileInputs', () => {
  it('should extract GitHub-type inputs from lock file', () => {
    const content = JSON.stringify({
      nodes: {
        'effect-utils': {
          locked: {
            type: 'github',
            owner: 'overengineeringstudio',
            repo: 'effect-utils',
            rev: 'abc123',
            narHash: 'sha256-xxx',
            lastModified: 1704067200,
          },
          original: {
            type: 'github',
            owner: 'overengineeringstudio',
            repo: 'effect-utils',
          },
        },
        root: { inputs: { 'effect-utils': 'effect-utils' } },
      },
      root: 'root',
      version: 7,
    })
    const result = extractLockFileInputs(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.inputName).toBe('effect-utils')
    expect(result[0]!.url).toBe('github:overengineeringstudio/effect-utils')
  })

  it('should extract git-type inputs from lock file', () => {
    const content = JSON.stringify({
      nodes: {
        'my-repo': {
          locked: {
            type: 'git',
            url: 'https://github.com/owner/my-repo',
            rev: 'def456',
          },
        },
        root: { inputs: { 'my-repo': 'my-repo' } },
      },
      root: 'root',
      version: 7,
    })
    const result = extractLockFileInputs(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.url).toBe('https://github.com/owner/my-repo')
  })

  it('should skip root and path-type nodes', () => {
    const content = JSON.stringify({
      nodes: {
        root: { inputs: {} },
        'local-thing': {
          locked: { type: 'path', path: '/some/path' },
        },
      },
      root: 'root',
      version: 7,
    })
    const result = extractLockFileInputs(content)
    expect(result).toEqual([])
  })

  it('should skip transitive dependencies not listed in root.inputs', () => {
    const content = JSON.stringify({
      nodes: {
        'effect-utils': {
          locked: {
            type: 'github',
            owner: 'overengineeringstudio',
            repo: 'effect-utils',
            rev: 'abc123',
            narHash: 'sha256-xxx',
            lastModified: 1704067200,
          },
        },
        'transitive-dep': {
          locked: {
            type: 'github',
            owner: 'someorg',
            repo: 'transitive-dep',
            rev: 'def456',
            narHash: 'sha256-yyy',
            lastModified: 1704067200,
          },
        },
        root: { inputs: { 'effect-utils': 'effect-utils' } },
      },
      root: 'root',
      version: 7,
    })
    const result = extractLockFileInputs(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.inputName).toBe('effect-utils')
  })

  it('should use input name (key) not node name (value) when they differ', () => {
    const content = JSON.stringify({
      nodes: {
        'effect-utils_2': {
          locked: {
            type: 'github',
            owner: 'overengineeringstudio',
            repo: 'effect-utils',
            rev: 'abc123',
            narHash: 'sha256-xxx',
            lastModified: 1704067200,
          },
        },
        root: { inputs: { 'effect-utils': 'effect-utils_2' } },
      },
      root: 'root',
      version: 7,
    })
    const result = extractLockFileInputs(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.inputName).toBe('effect-utils')
    expect(result[0]!.url).toBe('github:overengineeringstudio/effect-utils')
  })

  it('should handle invalid JSON gracefully', () => {
    expect(extractLockFileInputs('not json')).toEqual([])
  })
})

// =============================================================================
// matchUrlToMember
// =============================================================================

describe('matchUrlToMember', () => {
  const members: Record<string, LockedMember> = {
    'effect-utils': createLockedMember({
      url: 'https://github.com/overengineeringstudio/effect-utils',
    }),
    livestore: createLockedMember({
      url: 'https://github.com/livestorejs/livestore',
    }),
  }

  it('should match github: URL to member', () => {
    expect(
      matchUrlToMember({
        url: 'github:overengineeringstudio/effect-utils/main',
        members,
      }),
    ).toBe('effect-utils')
  })

  it('should match github: URL with ?dir= to member', () => {
    expect(
      matchUrlToMember({
        url: 'github:overengineeringstudio/effect-utils?dir=nix/playwright-flake',
        members,
      }),
    ).toBe('effect-utils')
  })

  it('should match git+https URL to member', () => {
    expect(
      matchUrlToMember({
        url: 'git+https://github.com/overengineeringstudio/effect-utils?ref=main',
        members,
      }),
    ).toBe('effect-utils')
  })

  it('should match git+ssh URL to member', () => {
    expect(
      matchUrlToMember({
        url: 'git+ssh://git@github.com/overengineeringstudio/effect-utils.git',
        members,
      }),
    ).toBe('effect-utils')
  })

  it('should be case-insensitive', () => {
    expect(
      matchUrlToMember({
        url: 'github:Overengineeringstudio/Effect-Utils',
        members,
      }),
    ).toBe('effect-utils')
  })

  it('should return undefined for non-matching URLs', () => {
    expect(
      matchUrlToMember({
        url: 'github:unknown/repo',
        members,
      }),
    ).toBeUndefined()
  })

  it('should return undefined for non-parseable URLs', () => {
    expect(
      matchUrlToMember({
        url: 'https://example.com/not-a-flake',
        members,
      }),
    ).toBeUndefined()
  })
})
