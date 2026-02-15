import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import type { LockedMember } from '../lock.ts'
import {
  matchLockedInputToMember,
  needsRevUpdate,
  normalizeGitHubUrl,
  normalizeGitUrl,
  urlsMatch,
} from './matcher.ts'
import {
  FlakeLock,
  GitHubLockedInput,
  GitLockedInput,
  parseLockedInput,
  updateLockedInputRev,
} from './schema.ts'

// =============================================================================
// Helper for full sync flow testing
// =============================================================================

/**
 * Simulates the full sync flow to test order preservation.
 * This mirrors the logic in syncSingleLockFile.
 */
const simulateSyncFlow = (
  lockFileContent: string,
  megarepoMembers: Record<string, LockedMember>,
): string => {
  // Parse raw JSON (preserves key order)
  const rawJson = JSON.parse(lockFileContent) as {
    nodes: Record<string, Record<string, unknown>>
    root: string
    version: number
  }

  // Validate with schema (like real code does)
  Schema.decodeUnknownSync(FlakeLock)(rawJson)

  // Process each node
  for (const [nodeName, node] of Object.entries(rawJson.nodes)) {
    const locked = node['locked'] as Record<string, unknown> | undefined
    if (locked === undefined) continue

    const match = matchLockedInputToMember({ locked, members: megarepoMembers })
    if (match !== undefined && needsRevUpdate({ locked, member: match.member })) {
      // Update using our order-preserving functions
      const newLocked = updateLockedInputRev({ locked, newRev: match.member.commit })
      // Preserve node key order
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(node)) {
        if (key === 'locked') {
          result['locked'] = newLocked
        } else {
          result[key] = node[key]
        }
      }
      rawJson.nodes[nodeName] = result
    }
  }

  return JSON.stringify(rawJson, null, 2)
}

// =============================================================================
// Test Helpers
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
// Schema Tests
// =============================================================================

describe('nix-lock schema', () => {
  describe('FlakeLock', () => {
    it('should decode a minimal flake.lock', () => {
      const input = {
        nodes: {
          root: {
            inputs: {},
          },
        },
        root: 'root',
        version: 7,
      }
      const result = Schema.decodeUnknownSync(FlakeLock)(input)
      expect(result.version).toBe(7)
      expect(result.root).toBe('root')
    })

    it('should decode a flake.lock with GitHub input', () => {
      const input = {
        nodes: {
          nixpkgs: {
            locked: {
              lastModified: 1704067200,
              narHash: 'sha256-abc123',
              owner: 'NixOS',
              repo: 'nixpkgs',
              rev: 'abc123',
              type: 'github',
            },
            original: {
              owner: 'NixOS',
              ref: 'nixos-24.05',
              repo: 'nixpkgs',
              type: 'github',
            },
          },
          root: {
            inputs: {
              nixpkgs: 'nixpkgs',
            },
          },
        },
        root: 'root',
        version: 7,
      }
      const result = Schema.decodeUnknownSync(FlakeLock)(input)
      expect(result.nodes['nixpkgs']?.locked?.['owner']).toBe('NixOS')
      expect(result.nodes['nixpkgs']?.locked?.['repo']).toBe('nixpkgs')
    })

    it('should decode a flake.lock with git input', () => {
      const input = {
        nodes: {
          'my-repo': {
            locked: {
              rev: 'def456',
              type: 'git',
              url: 'https://github.com/owner/my-repo',
            },
            original: {
              type: 'git',
              url: 'https://github.com/owner/my-repo',
            },
          },
          root: {
            inputs: {
              'my-repo': 'my-repo',
            },
          },
        },
        root: 'root',
        version: 7,
      }
      const result = Schema.decodeUnknownSync(FlakeLock)(input)
      expect(result.nodes['my-repo']?.locked?.['type']).toBe('git')
      expect(result.nodes['my-repo']?.locked?.['url']).toBe('https://github.com/owner/my-repo')
    })
  })

  describe('GitHubLockedInput', () => {
    it('should decode a GitHub locked input', () => {
      const input = {
        type: 'github',
        owner: 'NixOS',
        repo: 'nixpkgs',
        rev: 'abc123',
      }
      const result = Schema.decodeUnknownSync(GitHubLockedInput)(input)
      expect(result.type).toBe('github')
      expect(result.owner).toBe('NixOS')
      expect(result.repo).toBe('nixpkgs')
      expect(result.rev).toBe('abc123')
    })

    it('should decode with optional narHash and lastModified', () => {
      const input = {
        type: 'github',
        owner: 'NixOS',
        repo: 'nixpkgs',
        rev: 'abc123',
        narHash: 'sha256-xxx',
        lastModified: 1704067200,
      }
      const result = Schema.decodeUnknownSync(GitHubLockedInput)(input)
      expect(result.narHash).toBe('sha256-xxx')
      expect(result.lastModified).toBe(1704067200)
    })
  })

  describe('GitLockedInput', () => {
    it('should decode a git locked input', () => {
      const input = {
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'def456',
      }
      const result = Schema.decodeUnknownSync(GitLockedInput)(input)
      expect(result.type).toBe('git')
      expect(result.url).toBe('https://github.com/owner/repo')
      expect(result.rev).toBe('def456')
    })
  })

  describe('parseLockedInput', () => {
    it('should parse GitHub locked input', () => {
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'abc123',
        narHash: 'sha256-xxx',
        lastModified: 1704067200,
      }
      const result = parseLockedInput(locked)
      expect(result).toEqual({
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'abc123',
        url: undefined,
        narHash: 'sha256-xxx',
        lastModified: 1704067200,
      })
    })

    it('should parse git locked input', () => {
      const locked = {
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'def456',
      }
      const result = parseLockedInput(locked)
      expect(result).toEqual({
        type: 'git',
        owner: undefined,
        repo: undefined,
        url: 'https://github.com/owner/repo',
        rev: 'def456',
        narHash: undefined,
        lastModified: undefined,
      })
    })

    it('should return undefined for invalid input', () => {
      expect(parseLockedInput(undefined)).toBeUndefined()
      expect(parseLockedInput({})).toBeUndefined()
      expect(parseLockedInput({ notType: 'foo' })).toBeUndefined()
    })
  })

  describe('updateLockedInputRev', () => {
    it('should update rev and remove narHash and lastModified', () => {
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
        narHash: 'sha256-oldHash',
        lastModified: 1704067200,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev' })
      expect(result).toEqual({
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'new-rev',
        // narHash and lastModified should be removed
      })
      expect(result['narHash']).toBeUndefined()
      expect(result['lastModified']).toBeUndefined()
    })

    it('should preserve other fields', () => {
      const locked = {
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'old-rev',
        ref: 'main',
        shallow: true,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev' })
      expect(result).toEqual({
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'new-rev',
        ref: 'main',
        shallow: true,
      })
    })

    it('should preserve key order from original object', () => {
      // Nix natural order: lastModified, narHash, owner, repo, rev, type
      const locked = {
        lastModified: 1704067200,
        narHash: 'sha256-oldHash',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
        type: 'github',
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev' })
      const keys = Object.keys(result)
      // narHash and lastModified should be removed, but remaining keys preserve order
      expect(keys).toEqual(['owner', 'repo', 'rev', 'type'])
    })

    it('should preserve Nix natural key order (type first)', () => {
      // Another common Nix order: type, owner, repo, rev, narHash, lastModified
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
        narHash: 'sha256-oldHash',
        lastModified: 1704067200,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev' })
      const keys = Object.keys(result)
      expect(keys).toEqual(['type', 'owner', 'repo', 'rev'])
    })

    it('should handle missing rev in original (adds it at end)', () => {
      const locked = {
        type: 'path',
        path: '/some/path',
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev' })
      expect(result).toEqual({
        type: 'path',
        path: '/some/path',
        rev: 'new-rev',
      })
    })
  })

  describe('updateLockedInputRev with metadata', () => {
    it('should update rev and include new narHash and lastModified', () => {
      const locked = {
        lastModified: 1704067200,
        narHash: 'sha256-oldHash',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
        type: 'github',
      }
      const metadata = {
        narHash: 'sha256-newHash123',
        lastModified: 1704153600,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev', metadata })
      expect(result).toEqual({
        lastModified: 1704153600,
        narHash: 'sha256-newHash123',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'new-rev',
        type: 'github',
      })
    })

    it('should preserve key order from original object', () => {
      const locked = {
        lastModified: 1704067200,
        narHash: 'sha256-oldHash',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
        type: 'github',
      }
      const metadata = {
        narHash: 'sha256-newHash',
        lastModified: 1704153600,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev', metadata })
      const keys = Object.keys(result)
      // Key order should be preserved from original
      expect(keys).toEqual(['lastModified', 'narHash', 'owner', 'repo', 'rev', 'type'])
    })

    it('should add missing metadata fields at the end', () => {
      // Original doesn't have narHash/lastModified
      const locked = {
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
        type: 'github',
      }
      const metadata = {
        narHash: 'sha256-newHash',
        lastModified: 1704153600,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev', metadata })
      expect(result['narHash']).toBe('sha256-newHash')
      expect(result['lastModified']).toBe(1704153600)
      expect(result['rev']).toBe('new-rev')
    })

    it('should preserve other fields like ref and shallow', () => {
      const locked = {
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'old-rev',
        ref: 'main',
        shallow: true,
        narHash: 'sha256-old',
        lastModified: 1704067200,
      }
      const metadata = {
        narHash: 'sha256-new',
        lastModified: 1704153600,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev', metadata })
      expect(result).toEqual({
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'new-rev',
        ref: 'main',
        shallow: true,
        narHash: 'sha256-new',
        lastModified: 1704153600,
      })
    })
  })
})

// =============================================================================
// Matcher Tests
// =============================================================================

describe('nix-lock matcher', () => {
  describe('normalizeGitHubUrl', () => {
    it('should normalize HTTPS GitHub URLs', () => {
      expect(normalizeGitHubUrl('https://github.com/owner/repo')).toBe(
        'https://github.com/owner/repo',
      )
      expect(normalizeGitHubUrl('https://github.com/owner/repo.git')).toBe(
        'https://github.com/owner/repo',
      )
      expect(normalizeGitHubUrl('https://github.com/owner/repo/')).toBe(
        'https://github.com/owner/repo',
      )
    })

    it('should normalize SSH GitHub URLs', () => {
      expect(normalizeGitHubUrl('git@github.com:owner/repo')).toBe('https://github.com/owner/repo')
      expect(normalizeGitHubUrl('git@github.com:owner/repo.git')).toBe(
        'https://github.com/owner/repo',
      )
    })

    it('should return undefined for non-GitHub URLs', () => {
      expect(normalizeGitHubUrl('https://gitlab.com/owner/repo')).toBeUndefined()
      expect(normalizeGitHubUrl('/local/path')).toBeUndefined()
    })
  })

  describe('normalizeGitUrl', () => {
    it('should remove trailing .git and slashes', () => {
      expect(normalizeGitUrl('https://example.com/repo.git')).toBe('https://example.com/repo')
      expect(normalizeGitUrl('https://example.com/repo/')).toBe('https://example.com/repo')
      expect(normalizeGitUrl('https://example.com/repo.git/')).toBe('https://example.com/repo.git')
    })
  })

  describe('urlsMatch', () => {
    it('should match equivalent GitHub URLs', () => {
      expect(
        urlsMatch({
          url1: 'https://github.com/owner/repo',
          url2: 'https://github.com/owner/repo.git',
        }),
      ).toBe(true)
      expect(
        urlsMatch({ url1: 'https://github.com/owner/repo', url2: 'git@github.com:owner/repo' }),
      ).toBe(true)
      expect(
        urlsMatch({ url1: 'git@github.com:owner/repo.git', url2: 'https://github.com/owner/repo' }),
      ).toBe(true)
    })

    it('should be case-insensitive', () => {
      expect(
        urlsMatch({ url1: 'https://github.com/Owner/Repo', url2: 'https://github.com/owner/repo' }),
      ).toBe(true)
    })

    it('should not match different repos', () => {
      expect(
        urlsMatch({
          url1: 'https://github.com/owner/repo1',
          url2: 'https://github.com/owner/repo2',
        }),
      ).toBe(false)
      expect(
        urlsMatch({
          url1: 'https://github.com/owner1/repo',
          url2: 'https://github.com/owner2/repo',
        }),
      ).toBe(false)
    })
  })

  describe('matchLockedInputToMember', () => {
    it('should match GitHub input to member by URL', () => {
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'abc123',
      }
      const members = {
        effect: createLockedMember({
          url: 'https://github.com/effect-ts/effect',
          commit: 'def456',
        }),
      }
      const result = matchLockedInputToMember({ locked, members })
      expect(result).toEqual({
        memberName: 'effect',
        member: members['effect'],
      })
    })

    it('should match git input to member by URL', () => {
      const locked = {
        type: 'git',
        url: 'https://github.com/owner/my-lib',
        rev: 'abc123',
      }
      const members = {
        'my-lib': createLockedMember({
          url: 'https://github.com/owner/my-lib',
          commit: 'def456',
        }),
      }
      const result = matchLockedInputToMember({ locked, members })
      expect(result).toEqual({
        memberName: 'my-lib',
        member: members['my-lib'],
      })
    })

    it('should not match when URL does not match any member', () => {
      const locked = {
        type: 'github',
        owner: 'unknown',
        repo: 'repo',
        rev: 'abc123',
      }
      const members = {
        effect: createLockedMember({
          url: 'https://github.com/effect-ts/effect',
        }),
      }
      const result = matchLockedInputToMember({ locked, members })
      expect(result).toBeUndefined()
    })

    it('should not match path type inputs', () => {
      const locked = {
        type: 'path',
        path: '/some/local/path',
      }
      const members = {
        effect: createLockedMember(),
      }
      const result = matchLockedInputToMember({ locked, members })
      expect(result).toBeUndefined()
    })

    it('should return undefined for undefined locked', () => {
      const members = {
        effect: createLockedMember(),
      }
      const result = matchLockedInputToMember({ locked: undefined, members })
      expect(result).toBeUndefined()
    })
  })

  describe('needsRevUpdate', () => {
    it('should return true when revs differ', () => {
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
      }
      const member = createLockedMember({ commit: 'new-rev' })
      expect(needsRevUpdate({ locked, member })).toBe(true)
    })

    it('should return false when revs match', () => {
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'same-rev',
      }
      const member = createLockedMember({ commit: 'same-rev' })
      expect(needsRevUpdate({ locked, member })).toBe(false)
    })

    it('should return false when locked has no rev', () => {
      const locked = {
        type: 'path',
        path: '/some/path',
      }
      const member = createLockedMember()
      expect(needsRevUpdate({ locked, member })).toBe(false)
    })

    it('should return false for undefined locked', () => {
      const member = createLockedMember()
      expect(needsRevUpdate({ locked: undefined, member })).toBe(false)
    })
  })
})

// =============================================================================
// Full Sync Flow Tests (Order Preservation)
// =============================================================================

describe('nix-lock full sync flow', () => {
  describe('key order preservation', () => {
    it('should preserve Nix natural node order (inputs, locked, original)', () => {
      // This is the natural order Nix generates
      const lockFile = JSON.stringify(
        {
          nodes: {
            'effect-utils': {
              inputs: { nixpkgs: ['nixpkgs'] },
              locked: {
                lastModified: 1704067200,
                narHash: 'sha256-abc',
                owner: 'owner',
                repo: 'effect-utils',
                rev: 'old-rev',
                type: 'github',
              },
              original: { owner: 'owner', repo: 'effect-utils', type: 'github' },
            },
            root: { inputs: { 'effect-utils': 'effect-utils' } },
          },
          root: 'root',
          version: 7,
        },
        null,
        2,
      )

      const members = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/owner/effect-utils',
          commit: 'new-rev-12345',
        }),
      }

      const result = simulateSyncFlow(lockFile, members)
      const parsed = JSON.parse(result)

      // Check that node key order is preserved
      const nodeKeys = Object.keys(parsed.nodes['effect-utils'])
      expect(nodeKeys).toEqual(['inputs', 'locked', 'original'])

      // Check that locked key order is preserved (minus removed keys)
      const lockedKeys = Object.keys(parsed.nodes['effect-utils'].locked)
      expect(lockedKeys).toEqual(['owner', 'repo', 'rev', 'type'])

      // Verify the rev was updated
      expect(parsed.nodes['effect-utils'].locked.rev).toBe('new-rev-12345')

      // Verify narHash and lastModified were removed
      expect(parsed.nodes['effect-utils'].locked.narHash).toBeUndefined()
      expect(parsed.nodes['effect-utils'].locked.lastModified).toBeUndefined()
    })

    it('should preserve node order with flake: false at start', () => {
      const lockFile = JSON.stringify(
        {
          nodes: {
            'some-input': {
              flake: false,
              locked: {
                lastModified: 1704067200,
                narHash: 'sha256-abc',
                owner: 'owner',
                repo: 'some-input',
                rev: 'old-rev',
                type: 'github',
              },
              original: { owner: 'owner', repo: 'some-input', type: 'github' },
            },
            root: { inputs: { 'some-input': 'some-input' } },
          },
          root: 'root',
          version: 7,
        },
        null,
        2,
      )

      const members = {
        'some-input': createLockedMember({
          url: 'https://github.com/owner/some-input',
          commit: 'new-rev',
        }),
      }

      const result = simulateSyncFlow(lockFile, members)
      const parsed = JSON.parse(result)

      // flake should stay at the beginning
      const nodeKeys = Object.keys(parsed.nodes['some-input'])
      expect(nodeKeys).toEqual(['flake', 'locked', 'original'])
    })

    it('should not modify unrelated nodes', () => {
      const lockFile = JSON.stringify(
        {
          nodes: {
            nixpkgs: {
              locked: {
                lastModified: 1704067200,
                narHash: 'sha256-xyz',
                owner: 'NixOS',
                repo: 'nixpkgs',
                rev: 'nixpkgs-rev',
                type: 'github',
              },
              original: { owner: 'NixOS', repo: 'nixpkgs', type: 'github' },
            },
            'effect-utils': {
              inputs: { nixpkgs: ['nixpkgs'] },
              locked: {
                owner: 'owner',
                repo: 'effect-utils',
                rev: 'old-rev',
                type: 'github',
              },
              original: { owner: 'owner', repo: 'effect-utils', type: 'github' },
            },
            root: { inputs: {} },
          },
          root: 'root',
          version: 7,
        },
        null,
        2,
      )

      const members = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/owner/effect-utils',
          commit: 'new-rev',
        }),
      }

      const result = simulateSyncFlow(lockFile, members)
      const parsed = JSON.parse(result)

      // nixpkgs should be completely unchanged (including narHash/lastModified)
      expect(parsed.nodes['nixpkgs'].locked.narHash).toBe('sha256-xyz')
      expect(parsed.nodes['nixpkgs'].locked.lastModified).toBe(1704067200)
      expect(Object.keys(parsed.nodes['nixpkgs'])).toEqual(['locked', 'original'])
    })
  })
})
