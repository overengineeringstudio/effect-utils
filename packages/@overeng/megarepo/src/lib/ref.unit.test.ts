import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  classifyRef,
  decodeRef,
  encodeRef,
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
