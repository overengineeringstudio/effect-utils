import { describe, expect, it } from 'vitest'

import { editorViewSchema } from './editor-view.ts'

describe('editor view record', () => {
  it('owns a stable versioned schema identifier', () => {
    expect(editorViewSchema).toBe('effect-utils/editor-view/v1')
  })
})
