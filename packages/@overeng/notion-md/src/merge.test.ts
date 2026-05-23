import { describe, expect, it } from '@effect/vitest'
import * as fc from 'effect/FastCheck'

import { canonicalizeMarkdown } from './hash.ts'
import { planMarkdownUpdate, tryMergeMarkdownBodies } from './merge.ts'

const applyMarkdownUpdate = (remoteBody: string, desiredBody: string): string => {
  const command = planMarkdownUpdate({
    baseBody: remoteBody,
    remoteBody,
    desiredBody,
  })
  if (command._tag === 'replace_content') return canonicalizeMarkdown(command.markdown)

  return canonicalizeMarkdown(
    command.contentUpdates.reduce(
      (body, update) =>
        update.replaceAllMatches === true
          ? body.replaceAll(update.oldStr, update.newStr)
          : body.replace(update.oldStr, update.newStr),
      canonicalizeMarkdown(remoteBody),
    ),
  )
}

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

  it.prop(
    'keeps local body when remote equals the base snapshot',
    [fc.string({ maxLength: 80 }), fc.string({ maxLength: 80 })],
    ([baseBody, localBody]) => {
      expect(
        tryMergeMarkdownBodies({
          baseBody,
          localBody,
          remoteBody: baseBody,
        }),
      ).toBe(canonicalizeMarkdown(localBody))
    },
    { fastCheck: { numRuns: 80 } },
  )

  it.prop(
    'keeps remote body when local equals the base snapshot',
    [fc.string({ maxLength: 80 }), fc.string({ maxLength: 80 })],
    ([baseBody, remoteBody]) => {
      expect(
        tryMergeMarkdownBodies({
          baseBody,
          localBody: baseBody,
          remoteBody,
        }),
      ).toBe(canonicalizeMarkdown(remoteBody))
    },
    { fastCheck: { numRuns: 80 } },
  )

  it.prop(
    'plans Markdown updates that transform the current remote body into the desired body',
    [fc.string({ maxLength: 80 }), fc.string({ maxLength: 80 })],
    ([remoteBody, desiredBody]) => {
      expect(applyMarkdownUpdate(remoteBody, desiredBody)).toBe(canonicalizeMarkdown(desiredBody))
    },
    { fastCheck: { numRuns: 80 } },
  )
})
