import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import type { LockedMember } from '../lock.ts'
import { parseNixFlakeUrl, getRev, updateNixFlakeUrl } from './flake-url.ts'
import { extractFlakeNixInputs, extractDevenvYamlInputs, matchUrlToMember } from './input-discovery.ts'
import { getByDotPath, setByDotPath } from './mod.ts'
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
    if (match !== undefined && needsRevUpdate({ locked, member: match.member }) === true) {
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

// =============================================================================
// Source File Rev Sync Tests
// =============================================================================

/**
 * Simulates the source file rev sync logic (pure, no Effect).
 * Mirrors the core of syncSourceFileRevs.
 */
const simulateSourceFileRevSync = ({
  content,
  fileType,
  megarepoMembers,
}: {
  content: string
  fileType: 'flake.nix' | 'devenv.yaml'
  megarepoMembers: Record<string, LockedMember>
}): {
  updatedContent: string
  updatedInputs: Array<{
    inputName: string
    memberName: string
    oldRev: string
    newRev: string
  }>
} => {
  const inputs =
    fileType === 'flake.nix'
      ? extractFlakeNixInputs(content)
      : extractDevenvYamlInputs(content)

  const updatedInputs: Array<{
    inputName: string
    memberName: string
    oldRev: string
    newRev: string
  }> = []
  let updatedContent = content

  for (const input of inputs) {
    const memberName = matchUrlToMember({ url: input.url, members: megarepoMembers })
    if (memberName === undefined) continue

    const member = megarepoMembers[memberName]
    if (member === undefined) continue

    const parsed = parseNixFlakeUrl(input.url)
    if (parsed === undefined) continue

    const currentRev = getRev(parsed)
    if (currentRev === undefined) continue
    if (currentRev === member.commit) continue

    const newUrl = updateNixFlakeUrl(input.url, { rev: member.commit })

    updatedInputs.push({
      inputName: input.inputName,
      memberName,
      oldRev: currentRev,
      newRev: member.commit,
    })

    updatedContent = updatedContent.replaceAll(input.url, newUrl)
  }

  return { updatedContent, updatedInputs }
}

describe('source file rev sync', () => {
  describe('flake.nix', () => {
    it('should update &rev= in git+https URLs', () => {
      const content = `{
  inputs.effect-utils.url = "git+https://github.com/overengineeringstudio/effect-utils?ref=schickling/2026-03-08-foo&rev=51a67f704ddac6afd3a5230e696dbc440257f07d";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
}`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/overengineeringstudio/effect-utils',
          commit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(1)
      expect(result.updatedInputs[0]).toEqual({
        inputName: 'effect-utils',
        memberName: 'effect-utils',
        oldRev: '51a67f704ddac6afd3a5230e696dbc440257f07d',
        newRev: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      })
      expect(result.updatedContent).toContain('&rev=aaaa1111bbbb2222cccc3333dddd4444eeee5555')
      expect(result.updatedContent).not.toContain('51a67f704ddac6afd3a5230e696dbc440257f07d')
      // nixpkgs should be unchanged
      expect(result.updatedContent).toContain('github:NixOS/nixpkgs/nixos-24.05')
    })

    it('should update ?rev= in git+ssh URLs', () => {
      const content = `{
  inputs.my-lib.url = "git+ssh://git@github.com/owner/my-lib?rev=oldrev1234567890123456789012345678901234";
}`

      const members: Record<string, LockedMember> = {
        'my-lib': createLockedMember({
          url: 'https://github.com/owner/my-lib',
          commit: 'newrev1234567890123456789012345678901234',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(1)
      expect(result.updatedContent).toContain('?rev=newrev1234567890123456789012345678901234')
    })

    it('should skip URLs without rev', () => {
      const content = `{
  inputs.effect-utils.url = "github:overengineeringstudio/effect-utils/main";
}`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/overengineeringstudio/effect-utils',
          commit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(0)
      expect(result.updatedContent).toBe(content)
    })

    it('should skip when rev already matches', () => {
      const content = `{
  inputs.effect-utils.url = "git+https://github.com/owner/effect-utils?ref=main&rev=aaaa1111bbbb2222cccc3333dddd4444eeee5555";
}`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/owner/effect-utils',
          commit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(0)
      expect(result.updatedContent).toBe(content)
    })

    it('should update multiple inputs in one file', () => {
      const content = `{
  inputs.lib-a.url = "git+https://github.com/owner/lib-a?ref=main&rev=old_a_rev_01234567890123456789012345678";
  inputs.lib-b.url = "git+https://github.com/owner/lib-b?ref=dev&rev=old_b_rev_01234567890123456789012345678";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
}`

      const members: Record<string, LockedMember> = {
        'lib-a': createLockedMember({
          url: 'https://github.com/owner/lib-a',
          commit: 'new_a_rev_01234567890123456789012345678',
        }),
        'lib-b': createLockedMember({
          url: 'https://github.com/owner/lib-b',
          commit: 'new_b_rev_01234567890123456789012345678',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(2)
      expect(result.updatedContent).toContain('&rev=new_a_rev_01234567890123456789012345678')
      expect(result.updatedContent).toContain('&rev=new_b_rev_01234567890123456789012345678')
      expect(result.updatedContent).not.toContain('old_a_rev')
      expect(result.updatedContent).not.toContain('old_b_rev')
    })

    it('should skip inputs that do not match any megarepo member', () => {
      const content = `{
  inputs.unknown-lib.url = "git+https://github.com/someone/unknown-lib?rev=abc123def456789012345678901234567890abcd";
}`

      const members: Record<string, LockedMember> = {
        'my-lib': createLockedMember({
          url: 'https://github.com/owner/my-lib',
          commit: 'new-commit',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(0)
      expect(result.updatedContent).toBe(content)
    })

    it('should preserve ref and other params when updating rev', () => {
      const content = `{
  inputs.effect-utils.url = "git+https://github.com/owner/effect-utils?ref=schickling/branch&rev=oldrev12345678901234567890123456789012&dir=packages/core";
}`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/owner/effect-utils',
          commit: 'newrev12345678901234567890123456789012',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(1)
      expect(result.updatedContent).toContain('ref=schickling/branch')
      expect(result.updatedContent).toContain('rev=newrev12345678901234567890123456789012')
      expect(result.updatedContent).toContain('dir=packages/core')
    })
  })

  describe('devenv.yaml', () => {
    it('should update &rev= in devenv.yaml URLs', () => {
      const content = `inputs:
  effect-utils:
    url: git+https://github.com/overengineeringstudio/effect-utils?ref=schickling/2026-03-08-foo&rev=51a67f704ddac6afd3a5230e696dbc440257f07d
    flake: true
  nixpkgs:
    url: github:NixOS/nixpkgs/nixos-24.05
`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/overengineeringstudio/effect-utils',
          commit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'devenv.yaml',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(1)
      expect(result.updatedInputs[0]).toEqual({
        inputName: 'effect-utils',
        memberName: 'effect-utils',
        oldRev: '51a67f704ddac6afd3a5230e696dbc440257f07d',
        newRev: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      })
      expect(result.updatedContent).toContain('&rev=aaaa1111bbbb2222cccc3333dddd4444eeee5555')
      expect(result.updatedContent).not.toContain('51a67f704ddac6afd3a5230e696dbc440257f07d')
      // nixpkgs should be unchanged
      expect(result.updatedContent).toContain('github:NixOS/nixpkgs/nixos-24.05')
    })

    it('should skip devenv.yaml URLs without rev', () => {
      const content = `inputs:
  effect-utils:
    url: github:overengineeringstudio/effect-utils/main
    flake: true
`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/overengineeringstudio/effect-utils',
          commit: 'new-commit',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'devenv.yaml',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(0)
      expect(result.updatedContent).toBe(content)
    })

    it('should handle quoted URLs in devenv.yaml', () => {
      const content = `inputs:
  effect-utils:
    url: "git+https://github.com/owner/effect-utils?ref=main&rev=oldrev12345678901234567890123456789012"
`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/owner/effect-utils',
          commit: 'newrev12345678901234567890123456789012',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'devenv.yaml',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(1)
      expect(result.updatedContent).toContain('rev=newrev12345678901234567890123456789012')
    })
  })
})

// =============================================================================
// Shared Lock Source Helpers Tests
// =============================================================================

describe('shared lock source helpers', () => {
  describe('getByDotPath', () => {
    it('should resolve a simple path', () => {
      const obj = { a: { b: { c: 42 } } }
      expect(getByDotPath(obj, '.a.b.c')).toBe(42)
    })

    it('should resolve a path without leading dot', () => {
      const obj = { a: { b: 'hello' } }
      expect(getByDotPath(obj, 'a.b')).toBe('hello')
    })

    it('should return the nested object at a partial path', () => {
      const obj = { nodes: { devenv: { locked: { rev: 'abc', type: 'github' } } } }
      expect(getByDotPath(obj, '.nodes.devenv.locked')).toEqual({ rev: 'abc', type: 'github' })
    })

    it('should return undefined for missing path', () => {
      const obj = { a: { b: 1 } }
      expect(getByDotPath(obj, '.a.c.d')).toBeUndefined()
    })

    it('should return undefined for null/undefined input', () => {
      expect(getByDotPath(undefined, '.a')).toBeUndefined()
      expect(getByDotPath(null, '.a')).toBeUndefined()
    })

    it('should return the root object for empty path', () => {
      const obj = { a: 1 }
      expect(getByDotPath(obj, '')).toEqual({ a: 1 })
    })
  })

  describe('setByDotPath', () => {
    it('should set a value at a simple path', () => {
      const obj = { a: { b: { c: 1 } } }
      const result = setByDotPath(obj, '.a.b.c', 42)
      expect(getByDotPath(result, '.a.b.c')).toBe(42)
    })

    it('should create intermediate objects', () => {
      const obj = {}
      const result = setByDotPath(obj, '.a.b.c', 'hello')
      expect(getByDotPath(result, '.a.b.c')).toBe('hello')
    })

    it('should not mutate the original object', () => {
      const obj = { a: { b: { c: 1 } } }
      const result = setByDotPath(obj, '.a.b.c', 42)
      expect(obj.a.b.c).toBe(1)
      expect(getByDotPath(result, '.a.b.c')).toBe(42)
    })

    it('should set a complex value (object)', () => {
      const obj = { nodes: { devenv: { locked: { rev: 'old', type: 'github' } } } }
      const newLocked = { rev: 'new', type: 'github', lastModified: 123 }
      const result = setByDotPath(obj, '.nodes.devenv.locked', newLocked)
      expect(getByDotPath(result, '.nodes.devenv.locked')).toEqual(newLocked)
    })

    it('should preserve sibling keys', () => {
      const obj = { nodes: { devenv: { locked: { rev: 'old' }, original: { type: 'github' } } } }
      const result = setByDotPath(obj, '.nodes.devenv.locked', { rev: 'new' })
      expect(getByDotPath(result, '.nodes.devenv.original')).toEqual({ type: 'github' })
    })
  })
})

// =============================================================================
// Shared Lock Source Sync (integration-style pure tests)
// =============================================================================

describe('shared lock source sync logic', () => {
  /**
   * Simulates the shared lock source sync for a set of devenv.lock contents.
   * Pure function that mirrors the core logic without filesystem effects.
   */
  const simulateSharedLockSourceSync = ({
    sharedLockSources,
    memberLocks,
    excludeMembers = new Set<string>(),
  }: {
    sharedLockSources: Record<string, { source: string; path: string }>
    memberLocks: Record<string, string>
    excludeMembers?: ReadonlySet<string>
  }): {
    updatedLocks: Record<string, string>
    results: Array<{
      label: string
      sourceMember: string
      path: string
      updatedMembers: string[]
      skippedMembers: string[]
    }>
  } => {
    const updatedLocks: Record<string, string> = { ...memberLocks }
    const results: Array<{
      label: string
      sourceMember: string
      path: string
      updatedMembers: string[]
      skippedMembers: string[]
    }> = []

    for (const [label, config] of Object.entries(sharedLockSources)) {
      const sourceContent = memberLocks[config.source]
      if (sourceContent === undefined) {
        results.push({ label, sourceMember: config.source, path: config.path, updatedMembers: [], skippedMembers: [] })
        continue
      }

      let sourceJson: unknown
      try { sourceJson = JSON.parse(sourceContent) } catch {
        results.push({ label, sourceMember: config.source, path: config.path, updatedMembers: [], skippedMembers: [] })
        continue
      }

      const sourceValue = getByDotPath(sourceJson, config.path)
      if (sourceValue === undefined) {
        results.push({ label, sourceMember: config.source, path: config.path, updatedMembers: [], skippedMembers: [] })
        continue
      }

      const updatedMembers: string[] = []
      const skippedMembers: string[] = []

      for (const memberName of Object.keys(memberLocks)) {
        if (memberName === config.source) continue
        if (excludeMembers.has(memberName)) {
          skippedMembers.push(memberName)
          continue
        }

        let targetJson: unknown
        try { targetJson = JSON.parse(updatedLocks[memberName]!) } catch {
          skippedMembers.push(memberName)
          continue
        }

        const currentValue = getByDotPath(targetJson, config.path)
        if (JSON.stringify(currentValue) === JSON.stringify(sourceValue)) continue

        const updatedJson = setByDotPath(targetJson, config.path, sourceValue)
        updatedLocks[memberName] = JSON.stringify(updatedJson, null, 2) + '\n'
        updatedMembers.push(memberName)
      }

      results.push({ label, sourceMember: config.source, path: config.path, updatedMembers, skippedMembers })
    }

    return { updatedLocks, results }
  }

  it('should copy lock entry from source to target member', () => {
    const sourceLock = JSON.stringify({
      nodes: { devenv: { locked: { rev: 'source-rev', type: 'github', lastModified: 999 } } },
      root: 'root',
      version: 7,
    })
    const targetLock = JSON.stringify({
      nodes: { devenv: { locked: { rev: 'old-rev', type: 'github', lastModified: 111 } } },
      root: 'root',
      version: 7,
    })

    const { updatedLocks, results } = simulateSharedLockSourceSync({
      sharedLockSources: {
        devenv: { source: 'repo-a', path: '.nodes.devenv.locked' },
      },
      memberLocks: { 'repo-a': sourceLock, 'repo-b': targetLock },
    })

    expect(results[0]!.updatedMembers).toEqual(['repo-b'])
    const updatedTarget = JSON.parse(updatedLocks['repo-b']!)
    expect(updatedTarget.nodes.devenv.locked).toEqual({
      rev: 'source-rev',
      type: 'github',
      lastModified: 999,
    })
  })

  it('should skip the source member itself', () => {
    const lock = JSON.stringify({
      nodes: { devenv: { locked: { rev: 'rev1' } } },
      root: 'root',
      version: 7,
    })

    const { results } = simulateSharedLockSourceSync({
      sharedLockSources: {
        devenv: { source: 'repo-a', path: '.nodes.devenv.locked' },
      },
      memberLocks: { 'repo-a': lock },
    })

    expect(results[0]!.updatedMembers).toEqual([])
  })

  it('should skip excluded members', () => {
    const sourceLock = JSON.stringify({
      nodes: { devenv: { locked: { rev: 'new' } } },
      root: 'root',
      version: 7,
    })
    const targetLock = JSON.stringify({
      nodes: { devenv: { locked: { rev: 'old' } } },
      root: 'root',
      version: 7,
    })

    const { results } = simulateSharedLockSourceSync({
      sharedLockSources: {
        devenv: { source: 'repo-a', path: '.nodes.devenv.locked' },
      },
      memberLocks: { 'repo-a': sourceLock, 'repo-b': targetLock },
      excludeMembers: new Set(['repo-b']),
    })

    expect(results[0]!.updatedMembers).toEqual([])
    expect(results[0]!.skippedMembers).toEqual(['repo-b'])
  })

  it('should handle missing source member gracefully', () => {
    const targetLock = JSON.stringify({
      nodes: { devenv: { locked: { rev: 'old' } } },
      root: 'root',
      version: 7,
    })

    const { results } = simulateSharedLockSourceSync({
      sharedLockSources: {
        devenv: { source: 'nonexistent', path: '.nodes.devenv.locked' },
      },
      memberLocks: { 'repo-b': targetLock },
    })

    expect(results[0]!.updatedMembers).toEqual([])
  })

  it('should handle missing path in source gracefully', () => {
    const sourceLock = JSON.stringify({
      nodes: { other: { locked: { rev: 'abc' } } },
      root: 'root',
      version: 7,
    })
    const targetLock = JSON.stringify({
      nodes: { devenv: { locked: { rev: 'old' } } },
      root: 'root',
      version: 7,
    })

    const { results } = simulateSharedLockSourceSync({
      sharedLockSources: {
        devenv: { source: 'repo-a', path: '.nodes.devenv.locked' },
      },
      memberLocks: { 'repo-a': sourceLock, 'repo-b': targetLock },
    })

    expect(results[0]!.updatedMembers).toEqual([])
  })

  it('should skip members where value already matches', () => {
    const lock = JSON.stringify({
      nodes: { devenv: { locked: { rev: 'same-rev', type: 'github' } } },
      root: 'root',
      version: 7,
    })

    const { results } = simulateSharedLockSourceSync({
      sharedLockSources: {
        devenv: { source: 'repo-a', path: '.nodes.devenv.locked' },
      },
      memberLocks: { 'repo-a': lock, 'repo-b': lock },
    })

    expect(results[0]!.updatedMembers).toEqual([])
  })

  it('should copy to multiple target members', () => {
    const sourceLock = JSON.stringify({
      nodes: { devenv: { locked: { rev: 'new-rev' } } },
      root: 'root',
      version: 7,
    })
    const targetLock = JSON.stringify({
      nodes: { devenv: { locked: { rev: 'old-rev' } } },
      root: 'root',
      version: 7,
    })

    const { results, updatedLocks } = simulateSharedLockSourceSync({
      sharedLockSources: {
        devenv: { source: 'repo-a', path: '.nodes.devenv.locked' },
      },
      memberLocks: { 'repo-a': sourceLock, 'repo-b': targetLock, 'repo-c': targetLock },
    })

    expect(results[0]!.updatedMembers).toEqual(['repo-b', 'repo-c'])
    expect(JSON.parse(updatedLocks['repo-b']!).nodes.devenv.locked.rev).toBe('new-rev')
    expect(JSON.parse(updatedLocks['repo-c']!).nodes.devenv.locked.rev).toBe('new-rev')
  })
})
