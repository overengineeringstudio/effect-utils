import { describe, expect, it } from 'vitest'

import { stripTrailingSlashesPreservingRoot } from './megarepo-traversal.ts'

describe('stripTrailingSlashesPreservingRoot', () => {
  it('preserves the filesystem root', () => {
    expect(stripTrailingSlashesPreservingRoot('/')).toBe('/')
  })

  it('removes trailing slashes from non-root paths', () => {
    expect(stripTrailingSlashesPreservingRoot('/tmp/megarepo/')).toBe('/tmp/megarepo')
    expect(stripTrailingSlashesPreservingRoot('/tmp/megarepo//')).toBe('/tmp/megarepo')
  })
})
