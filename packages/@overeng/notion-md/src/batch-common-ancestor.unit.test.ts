import { describe, expect, it } from 'vitest'

import { commonAncestor } from './batch.ts'

describe('commonAncestor', () => {
  it('returns the single parent directory for one path', () => {
    expect(commonAncestor(['/tmp/docs'])).toBe('/tmp/docs')
  })

  it('returns the deepest shared directory for sibling trees', () => {
    expect(commonAncestor(['/repo/a/b/pages', '/repo/a/c/pages'])).toBe('/repo/a')
  })

  it('falls back to the filesystem root for unrelated paths', () => {
    expect(commonAncestor(['/x/y', '/z'])).toBe('/')
  })

  it('handles identical directories', () => {
    expect(commonAncestor(['/repo/a', '/repo/a', '/repo/a'])).toBe('/repo/a')
  })
})
