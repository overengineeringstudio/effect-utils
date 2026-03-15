import { describe, expect, test } from 'vitest'

import { abbreviateStorePath } from './store-path.ts'

describe('abbreviateStorePath', () => {
  test('branch ref', () => {
    expect(
      abbreviateStorePath('/Users/dev/.megarepo/github.com/alice/dev-workspace/refs/heads/main'),
    ).toBe('alice/dev-workspace@main')
  })

  test('branch with slash', () => {
    expect(
      abbreviateStorePath('/Users/dev/.megarepo/github.com/org/repo/refs/heads/feature/foo'),
    ).toBe('org/repo@feature/foo')
  })

  test('tag ref', () => {
    expect(abbreviateStorePath('/Users/dev/.megarepo/github.com/org/repo/refs/tags/v1.0.0')).toBe(
      'org/repo@v1.0.0',
    )
  })

  test('commit ref', () => {
    expect(
      abbreviateStorePath(
        '/Users/dev/.megarepo/github.com/org/repo/refs/commits/abc123def456789012345678901234567890abcd',
      ),
    ).toBe('org/repo@abc123def456789012345678901234567890abcd')
  })

  test('trailing slash', () => {
    expect(
      abbreviateStorePath('/Users/dev/.megarepo/github.com/alice/dev-workspace/refs/heads/main/'),
    ).toBe('alice/dev-workspace@main')
  })

  test('fallback to last path segment', () => {
    expect(abbreviateStorePath('/some/random/path/my-workspace')).toBe('my-workspace')
  })

  test('fallback root path', () => {
    expect(abbreviateStorePath('/')).toBe('/')
  })
})
