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
  FlakeLockNode,
  GitHubLockedInput,
  GitLockedInput,
  parseLockedInput,
  updateLockedInputRev,
} from './schema.ts'

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
      const result = updateLockedInputRev(locked, 'new-rev')
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
      const result = updateLockedInputRev(locked, 'new-rev')
      expect(result).toEqual({
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'new-rev',
        ref: 'main',
        shallow: true,
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
      expect(normalizeGitHubUrl('git@github.com:owner/repo')).toBe(
        'https://github.com/owner/repo',
      )
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
        urlsMatch('https://github.com/owner/repo', 'https://github.com/owner/repo.git'),
      ).toBe(true)
      expect(urlsMatch('https://github.com/owner/repo', 'git@github.com:owner/repo')).toBe(true)
      expect(
        urlsMatch('git@github.com:owner/repo.git', 'https://github.com/owner/repo'),
      ).toBe(true)
    })

    it('should be case-insensitive', () => {
      expect(
        urlsMatch('https://github.com/Owner/Repo', 'https://github.com/owner/repo'),
      ).toBe(true)
    })

    it('should not match different repos', () => {
      expect(
        urlsMatch('https://github.com/owner/repo1', 'https://github.com/owner/repo2'),
      ).toBe(false)
      expect(
        urlsMatch('https://github.com/owner1/repo', 'https://github.com/owner2/repo'),
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
      const result = matchLockedInputToMember(locked, members)
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
      const result = matchLockedInputToMember(locked, members)
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
      const result = matchLockedInputToMember(locked, members)
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
      const result = matchLockedInputToMember(locked, members)
      expect(result).toBeUndefined()
    })

    it('should return undefined for undefined locked', () => {
      const members = {
        effect: createLockedMember(),
      }
      const result = matchLockedInputToMember(undefined, members)
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
      expect(needsRevUpdate(locked, member)).toBe(true)
    })

    it('should return false when revs match', () => {
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'same-rev',
      }
      const member = createLockedMember({ commit: 'same-rev' })
      expect(needsRevUpdate(locked, member)).toBe(false)
    })

    it('should return false when locked has no rev', () => {
      const locked = {
        type: 'path',
        path: '/some/path',
      }
      const member = createLockedMember()
      expect(needsRevUpdate(locked, member)).toBe(false)
    })

    it('should return false for undefined locked', () => {
      const member = createLockedMember()
      expect(needsRevUpdate(undefined, member)).toBe(false)
    })
  })
})
