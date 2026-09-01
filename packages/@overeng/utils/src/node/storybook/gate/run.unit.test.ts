import { describe, expect, it } from 'vitest'

import { isStoryGateOk } from './run.ts'

const clean = {
  added: [],
  removed: [],
  changed: [],
  uncovered: [],
  baseline: { total: 39, passed: 28, failed: 11 },
} as const

describe('isStoryGateOk', () => {
  it('passes a clean comparison over a partly-failing baseline', () => {
    // 11 of 39 already failing is debt, not breakage: there is still a majority
    // of working stories for a regression to show up against.
    expect(isStoryGateOk(clean)).toBe(true)
  })

  it('refuses to pass when nothing passed at the baseline', () => {
    // The defect this guards: with every story failing at the baseline they all
    // land in `preExisting`, the regression list is empty by construction, and
    // the gate reported success over a total loss of styling. Measured at
    // 212/212 failed on one app and 708/942 on another.
    expect(isStoryGateOk({ ...clean, baseline: { total: 212, passed: 0, failed: 212 } })).toBe(
      false,
    )
  })

  it('refuses to pass when a story has no baseline image', () => {
    // An uncovered story was never compared, so an empty regression list says
    // nothing about it. It is never debt.
    expect(isStoryGateOk({ ...clean, uncovered: ['src/stories/Button.stories.tsx/x.png'] })).toBe(
      false,
    )
  })

  it('fails on added, removed and changed stories', () => {
    expect({
      added: isStoryGateOk({ ...clean, added: ['New'] }),
      removed: isStoryGateOk({ ...clean, removed: ['Gone'] }),
      changed: isStoryGateOk({
        ...clean,
        changed: [{ story: 'Default', kind: 'pixels', detail: '85 pixels (ratio 0.01) differ.' }],
      }),
    }).toEqual({ added: false, removed: false, changed: false })
  })
})
