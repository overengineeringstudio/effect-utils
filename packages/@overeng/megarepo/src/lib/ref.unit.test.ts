import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  classifyRef,
  decodeRef,
  encodeRef,
  extractRefFromSymlinkPath,
  isCommitSha,
  isImmutableRef,
  looksLikeTag,
  parseSourceRef,
  refTypeToPathSegment,
} from './ref.ts'

describe('ref encoding', () => {
  test('encodeRef preserves simple refs', () => {
    expect(encodeRef('main')).toBe('main')
    expect(encodeRef('develop')).toBe('develop')
    expect(encodeRef('v1.0.0')).toBe('v1.0.0')
  })

  test('encodeRef encodes slashes', () => {
    expect(encodeRef('feature/foo')).toBe('feature%2Ffoo')
    expect(encodeRef('feature/foo/bar')).toBe('feature%2Ffoo%2Fbar')
  })

  test('encodeRef encodes percent signs', () => {
    expect(encodeRef('100%complete')).toBe('100%25complete')
  })

  test('decodeRef reverses encodeRef', () => {
    const refs = ['main', 'feature/foo', '100%complete', 'feature/foo/bar']
    for (const ref of refs) {
      expect(decodeRef(encodeRef(ref))).toBe(ref)
    }
  })

  test('decodeRef handles already-decoded refs', () => {
    expect(decodeRef('main')).toBe('main')
  })
})

describe('parseSourceRef', () => {
  test('parses source without ref', () => {
    const result = parseSourceRef('effect-ts/effect')
    expect(result.source).toBe('effect-ts/effect')
    expect(Option.isNone(result.ref)).toBe(true)
  })

  test('parses source with ref', () => {
    const result = parseSourceRef('effect-ts/effect#main')
    expect(result.source).toBe('effect-ts/effect')
    expect(Option.getOrNull(result.ref)).toBe('main')
  })

  test('parses source with tag ref', () => {
    const result = parseSourceRef('effect-ts/effect#v3.0.0')
    expect(result.source).toBe('effect-ts/effect')
    expect(Option.getOrNull(result.ref)).toBe('v3.0.0')
  })

  test('parses URL with ref', () => {
    const result = parseSourceRef('https://github.com/org/repo#feature/foo')
    expect(result.source).toBe('https://github.com/org/repo')
    expect(Option.getOrNull(result.ref)).toBe('feature/foo')
  })

  test('handles empty ref after hash', () => {
    const result = parseSourceRef('effect-ts/effect#')
    // Empty ref after # is treated as no ref, and trailing # is stripped from source
    expect(result.source).toBe('effect-ts/effect')
    expect(Option.isNone(result.ref)).toBe(true)
  })

  test('handles SSH URL with ref', () => {
    const result = parseSourceRef('git@github.com:owner/repo#main')
    expect(result.source).toBe('git@github.com:owner/repo')
    expect(Option.getOrNull(result.ref)).toBe('main')
  })
})

describe('isCommitSha', () => {
  test('recognizes valid commit SHA', () => {
    expect(isCommitSha('abc123def456789012345678901234567890abcd')).toBe(true)
    expect(isCommitSha('ABC123DEF456789012345678901234567890ABCD')).toBe(true)
  })

  test('rejects short hashes', () => {
    expect(isCommitSha('abc123')).toBe(false)
    expect(isCommitSha('abc123def456789012345678901234567890abc')).toBe(false) // 39 chars
  })

  test('rejects non-hex strings', () => {
    expect(isCommitSha('ghijklmnopqrstuvwxyzghijklmnopqrstuvwxyz')).toBe(false)
    expect(isCommitSha('main')).toBe(false)
  })
})

describe('looksLikeTag', () => {
  test('recognizes semver with v prefix', () => {
    expect(looksLikeTag('v1.0.0')).toBe(true)
    expect(looksLikeTag('v1.0')).toBe(true)
    expect(looksLikeTag('v0.1.0')).toBe(true)
    expect(looksLikeTag('v10.20.30')).toBe(true)
  })

  test('recognizes semver without v prefix', () => {
    expect(looksLikeTag('1.0.0')).toBe(true)
    expect(looksLikeTag('1.0')).toBe(true)
  })

  test('rejects branch names', () => {
    expect(looksLikeTag('main')).toBe(false)
    expect(looksLikeTag('develop')).toBe(false)
    expect(looksLikeTag('feature/foo')).toBe(false)
  })

  test('recognizes prefixed version tags', () => {
    // Tags like jq-1.6, release-v1.0 should be recognized
    expect(looksLikeTag('release-1.0')).toBe(true)
    expect(looksLikeTag('release-v1.0')).toBe(true)
    expect(looksLikeTag('jq-1.6')).toBe(true)
    expect(looksLikeTag('beta-2.0.0')).toBe(true)
  })

  test('recognizes multi-word prefixed tags', () => {
    // Multi-word prefixes like my-app-1.0.0, my-cool-app-v2.0
    expect(looksLikeTag('my-app-1.0.0')).toBe(true)
    expect(looksLikeTag('my-cool-app-v2.0')).toBe(true)
    expect(looksLikeTag('some-long-prefix-1.2.3')).toBe(true)
    expect(looksLikeTag('release-candidate-v3.0.0-rc.1')).toBe(true)
  })

  test('recognizes prefixes with numbers', () => {
    // Prefixes containing numbers like app2-v1.0.0
    expect(looksLikeTag('app2-v1.0.0')).toBe(true)
    expect(looksLikeTag('thing3-1.2.3')).toBe(true)
    expect(looksLikeTag('v8-10.0.0')).toBe(true)
    expect(looksLikeTag('node18-v1.0.0')).toBe(true)
  })

  test('recognizes semver prerelease tags', () => {
    // Prerelease versions like v1.0.0-rc.1, v1.2.3-beta.1
    expect(looksLikeTag('v1.0.0-rc.1')).toBe(true)
    expect(looksLikeTag('v1.2.3-beta.1')).toBe(true)
    expect(looksLikeTag('v1.0.0-alpha')).toBe(true)
    expect(looksLikeTag('1.0.0-rc1')).toBe(true)
    expect(looksLikeTag('2.0.0-beta.2')).toBe(true)
    // Prefixed prerelease
    expect(looksLikeTag('release-v1.2.3-beta.1')).toBe(true)
    expect(looksLikeTag('app-1.0.0-rc.1')).toBe(true)
  })

  test('rejects non-version strings', () => {
    expect(looksLikeTag('v1')).toBe(false) // needs at least major.minor
    expect(looksLikeTag('release')).toBe(false) // no version number
    expect(looksLikeTag('stable')).toBe(false) // no version number
  })
})

describe('classifyRef', () => {
  test('classifies commit SHA', () => {
    expect(classifyRef('abc123def456789012345678901234567890abcd')).toBe('commit')
  })

  test('classifies semver tag', () => {
    expect(classifyRef('v1.0.0')).toBe('tag')
    expect(classifyRef('1.0.0')).toBe('tag')
  })

  test('classifies branch', () => {
    expect(classifyRef('main')).toBe('branch')
    expect(classifyRef('develop')).toBe('branch')
    expect(classifyRef('feature/foo')).toBe('branch')
  })
})

describe('refTypeToPathSegment', () => {
  test('maps ref types to path segments', () => {
    expect(refTypeToPathSegment('commit')).toBe('commits')
    expect(refTypeToPathSegment('tag')).toBe('tags')
    expect(refTypeToPathSegment('branch')).toBe('heads')
  })
})

describe('isImmutableRef', () => {
  test('commits and tags are immutable', () => {
    expect(isImmutableRef('commit')).toBe(true)
    expect(isImmutableRef('tag')).toBe(true)
  })

  test('branches are mutable', () => {
    expect(isImmutableRef('branch')).toBe(false)
  })
})

describe('extractRefFromSymlinkPath', () => {
  test('extracts simple branch name', () => {
    const result = extractRefFromSymlinkPath(
      '/Users/foo/.megarepo/github.com/org/repo/refs/heads/main',
    )
    expect(result).toEqual({ ref: 'main', type: 'branch' })
  })

  test('extracts branch name with trailing slash', () => {
    const result = extractRefFromSymlinkPath(
      '/Users/foo/.megarepo/github.com/org/repo/refs/heads/main/',
    )
    expect(result).toEqual({ ref: 'main', type: 'branch' })
  })

  test('extracts URL-encoded branch name with slash', () => {
    const result = extractRefFromSymlinkPath(
      '/Users/foo/.megarepo/github.com/org/repo/refs/heads/refactor%2Fgenie-igor-ci',
    )
    expect(result).toEqual({ ref: 'refactor/genie-igor-ci', type: 'branch' })
  })

  test('extracts deeply nested URL-encoded branch name', () => {
    const result = extractRefFromSymlinkPath(
      '/Users/foo/.megarepo/github.com/org/repo/refs/heads/feature%2Fteam%2Fproject',
    )
    expect(result).toEqual({ ref: 'feature/team/project', type: 'branch' })
  })

  test('extracts tag name', () => {
    const result = extractRefFromSymlinkPath(
      '/Users/foo/.megarepo/github.com/org/repo/refs/tags/v1.0.0',
    )
    expect(result).toEqual({ ref: 'v1.0.0', type: 'tag' })
  })

  test('extracts tag name with trailing slash', () => {
    const result = extractRefFromSymlinkPath(
      '/Users/foo/.megarepo/github.com/org/repo/refs/tags/v1.0.0/',
    )
    expect(result).toEqual({ ref: 'v1.0.0', type: 'tag' })
  })

  test('extracts commit SHA', () => {
    const result = extractRefFromSymlinkPath(
      '/Users/foo/.megarepo/github.com/org/repo/commits/abc123def456789012345678901234567890abcd',
    )
    expect(result).toEqual({ ref: 'abc123def456789012345678901234567890abcd', type: 'commit' })
  })

  test('extracts short commit SHA', () => {
    // Short SHAs are still valid in commit paths
    const result = extractRefFromSymlinkPath(
      '/Users/foo/.megarepo/github.com/org/repo/commits/abc123',
    )
    expect(result).toEqual({ ref: 'abc123', type: 'commit' })
  })

  test('returns undefined for non-megarepo paths', () => {
    expect(extractRefFromSymlinkPath('/some/random/path')).toBeUndefined()
    expect(extractRefFromSymlinkPath('/Users/foo/Code/repo')).toBeUndefined()
    expect(extractRefFromSymlinkPath('')).toBeUndefined()
  })

  test('returns undefined for partial megarepo paths', () => {
    // Missing refs/heads prefix
    expect(
      extractRefFromSymlinkPath('/Users/foo/.megarepo/github.com/org/repo/main'),
    ).toBeUndefined()
    // Just the store root
    expect(extractRefFromSymlinkPath('/Users/foo/.megarepo/github.com/org/repo')).toBeUndefined()
  })

  test('handles real-world megarepo store paths', () => {
    // Actual path format from the bug report
    const result = extractRefFromSymlinkPath(
      '/Users/schickling/.megarepo/github.com/livestorejs/livestore/refs/heads/dev',
    )
    expect(result).toEqual({ ref: 'dev', type: 'branch' })
  })
})
