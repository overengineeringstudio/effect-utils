import { describe, expect, it } from 'vitest'

import { editorViewSchema, workspaceDependencyAuthoritySchema } from './editor-view.ts'

describe('editor view record', () => {
  it('owns a stable versioned schema identifier', () => {
    expect(editorViewSchema).toBe('effect-utils/editor-view/v1')
  })

  it('owns a stable whole-workspace dependency authority schema', () => {
    expect(workspaceDependencyAuthoritySchema).toBe(
      'effect-utils/workspace-dependency-authority/v1',
    )
  })
})
