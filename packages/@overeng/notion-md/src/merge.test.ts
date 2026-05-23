import { describe, expect, it } from 'vitest'

import { planMarkdownUpdate, tryMergeMarkdownBodies } from './merge.ts'

describe('notion-md merge planning', () => {
  it('merges non-overlapping local and remote body edits', () => {
    const merged = tryMergeMarkdownBodies({
      baseBody: '# Probe\n\nLine A\nLine B',
      localBody: '# Probe\n\nLocal line A\nLine B',
      remoteBody: '# Probe\n\nLine A\nRemote line B',
    })

    expect(merged).toBe('# Probe\n\nLocal line A\nRemote line B\n')
  })

  it('preserves identical overlapping edits and rejects conflicting overlaps', () => {
    expect(
      tryMergeMarkdownBodies({
        baseBody: '# Probe\n\nBody',
        localBody: '# Probe\n\nSame body',
        remoteBody: '# Probe\n\nSame body',
      }),
    ).toBe('# Probe\n\nSame body\n')

    expect(
      tryMergeMarkdownBodies({
        baseBody: '# Probe\n\nBody',
        localBody: '# Probe\n\nLocal body',
        remoteBody: '# Probe\n\nRemote body',
      }),
    ).toBeUndefined()
  })

  it('uses targeted updates only when the base hunk is unique in remote content', () => {
    expect(
      planMarkdownUpdate({
        baseBody: '# Probe\n\nBody',
        remoteBody: '# Probe\n\nBody',
        desiredBody: '# Probe\n\nLocal body',
      }),
    ).toEqual({
      _tag: 'update_content',
      contentUpdates: [{ oldStr: 'B', newStr: 'Local b' }],
      expectedMarkdown: '# Probe\n\nLocal body\n',
    })

    expect(
      planMarkdownUpdate({
        baseBody: '# Probe\n\nRepeat\nRepeat',
        remoteBody: '# Probe\n\nRepeat\nRepeat',
        desiredBody: '# Probe\n\nRepeat\nChanged repeat',
      }),
    ).toEqual({
      _tag: 'replace_content',
      markdown: '# Probe\n\nRepeat\nChanged repeat\n',
    })
  })

  it('falls back to replace_content when a remote change invalidates the intended patch', () => {
    expect(
      planMarkdownUpdate({
        baseBody: '# Probe\n\nLine A\nLine B',
        remoteBody: '# Probe\n\nRemote line A\nLine B',
        desiredBody: '# Probe\n\nLocal line A\nLine B',
      }),
    ).toEqual({
      _tag: 'replace_content',
      markdown: '# Probe\n\nLocal line A\nLine B\n',
    })
  })
})
