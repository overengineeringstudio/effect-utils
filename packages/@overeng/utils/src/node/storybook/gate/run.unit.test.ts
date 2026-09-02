import { describe, expect, it } from 'vitest'

import {
  classifyStability,
  isStoryGateOk,
  selfInconsistentStoryKeys,
  slugStoryName,
  storyKey,
} from './run.ts'

const clean = {
  added: [],
  removed: [],
  changed: [],
  uncovered: [],
  unsettled: [],
  baseline: { total: 39, passed: 28, failed: 11 },
  themeAxis: { projects: ['story-gate-light', 'story-gate-dark'], comparable: 39, differing: 38 },
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

  it('refuses to pass when a story never reached a quiet DOM', () => {
    // A story that never settled was excluded from the comparison by
    // OBSERVATION, so passing would report green over a story nobody compared —
    // the same shape as `uncovered`. The remedy is visible: fix the story, or
    // declare it unstable and put the decision on the record.
    expect(
      isStoryGateOk({
        ...clean,
        unsettled: [
          {
            id: 'components-select--with-error',
            name: 'Select > With Error',
            elapsedMs: 20_031,
            shapes: ['41:2180', '43:2320'],
            reason: 'shape-never-quiet',
          },
        ],
      }),
    ).toBe(false)
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

  it('refuses to pass when both theme projects rendered the same thing', () => {
    // The defect this guards: the theme toolbar global never reached the
    // element the overrides were keyed on, so both projects captured the light
    // palette and the gate reported green double-coverage over an axis that did
    // not vary. Two projects, 39 comparable stories, zero differing.
    expect(
      isStoryGateOk({
        ...clean,
        themeAxis: { ...clean.themeAxis, differing: 0 },
      }),
    ).toBe(false)
  })

  it('accepts a target that declares a single colour scheme', () => {
    // Measured counterexample: a site pinning one scheme has 0 of 57 probes
    // differing, correctly. Failing it would punish a correct target for a
    // property of the target, and the guard would get switched off.
    expect(
      isStoryGateOk({
        ...clean,
        themeAxis: { ...clean.themeAxis, comparable: 57, differing: 0 },
        themeVaries: false,
      }),
    ).toBe(true)
  })

  it('does not demand variation from a single-project run', () => {
    expect(
      isStoryGateOk({
        ...clean,
        themeAxis: { projects: ['story-gate'], comparable: 39, differing: 0 },
      }),
    ).toBe(true)
  })

  it('does not report a healthy axis from stories that differ from themselves', () => {
    // `comparable` is the post-exclusion count. A suite where every story is
    // nondeterministic excludes everything, and zero comparable stories is not
    // evidence of a working axis — but it is also not evidence of a broken one,
    // so the verdict defers rather than inventing a failure the counts cannot
    // support. The empty set is visible in `selfInconsistent`.
    expect(
      isStoryGateOk({
        ...clean,
        themeAxis: { ...clean.themeAxis, comparable: 0, differing: 0 },
      }),
    ).toBe(true)
  })
})

describe('selfInconsistentStoryKeys', () => {
  it('keys a capture by its story file and story slug', () => {
    // The two sides of this join speak different namespaces: a capture key ends
    // in the story ID, a Vitest assertion carries the bare story NAME. Measured
    // shapes, from a real run:
    //   capture   story-gate/src/stories/NumberField.stories.tsx/components-numberfield--with-hint.png
    //   assertion fullName 'With Hint'
    expect(
      selfInconsistentStoryKeys([
        'story-gate/src/stories/NumberField.stories.tsx/components-numberfield--with-hint.png',
      ]).has(storyKey({ file: 'NumberField.stories.tsx', slug: slugStoryName('With Hint') })),
    ).toBe(true)
  })

  it('does not let one file\u2019s nondeterminism suppress another file\u2019s regression', () => {
    // The defect a name-only key would introduce, and it is a FALSE GREEN
    // rather than noise: `Default` exists in many story files, so keying on the
    // name alone would let a nondeterministic `Default` in one file silently
    // absorb a real change to `Default` in every other file.
    const keys = selfInconsistentStoryKeys([
      'story-gate/src/stories/Book.stories.tsx/components-book--default.png',
    ])
    expect({
      sameFile: keys.has(
        storyKey({ file: 'Book.stories.tsx', slug: slugStoryName('Default') }),
      ),
      otherFile: keys.has(
        storyKey({ file: 'Avatar.stories.tsx', slug: slugStoryName('Default') }),
      ),
    }).toEqual({ sameFile: true, otherFile: false })
  })

  it('slugs a story name the way Storybook derives the id suffix', () => {
    expect({
      spaces: slugStoryName('With Error'),
      punctuation: slugStoryName('Optional & Disabled'),
      collapsed: slugStoryName('All   Sizes'),
    }).toEqual({ spaces: 'with-error', punctuation: 'optional-disabled', collapsed: 'all-sizes' })
  })
})

describe('classifyStability', () => {
  it('separates a capture the pair check catches from one only a third capture sees', () => {
    // The measured false negative this exists for: `Avatar > All Sizes` passed
    // the two-capture probe and then differed on a third capture of the
    // IDENTICAL tree. Collapsed into one self-inconsistent count that story is
    // indistinguishable from one the pair caught, and the two have different
    // causes — the pair catches a DOM that was still moving, the third catches
    // a render that was quiet and still did not reproduce.
    const outcome = classifyStability({
      captures: [
        new Map([
          ['light/steady.png', 'a'],
          ['light/pair-catches.png', 'a'],
          ['light/third-only.png', 'a'],
        ]),
        new Map([
          ['light/steady.png', 'a'],
          ['light/pair-catches.png', 'MOVED'],
          ['light/third-only.png', 'a'],
        ]),
        new Map([
          ['light/steady.png', 'a'],
          ['light/pair-catches.png', 'MOVED'],
          ['light/third-only.png', 'MOVED'],
        ]),
      ],
      captureMs: [1000, 1100, 1200],
    })
    expect({
      reproduced: outcome.reproduced,
      differedOnSecond: outcome.differedOnSecond,
      differedOnThird: outcome.differedOnThird,
      thirdCaptureMs: outcome.thirdCaptureMs,
    }).toEqual({
      reproduced: 1,
      differedOnSecond: ['light/pair-catches.png'],
      differedOnThird: ['light/third-only.png'],
      thirdCaptureMs: 1200,
    })
  })

  it('reports the third-capture class as unmeasured rather than zero when two captures were taken', () => {
    // `differedOnThird: []` from a two-capture run and from a three-capture run
    // are the same value meaning opposite things: "nothing looked there" versus
    // "something looked and found nothing". `thirdCaptureMs` is the only thing
    // separating them, so a reader trusting the empty list on its own repeats
    // the original false negative with more confidence than before.
    const outcome = classifyStability({
      captures: [new Map([['light/a.png', 'a']]), new Map([['light/a.png', 'a']])],
      captureMs: [1000, 1100],
    })
    expect({
      reproduced: outcome.reproduced,
      differedOnThird: outcome.differedOnThird,
      thirdCaptureMs: outcome.thirdCaptureMs,
    }).toEqual({ reproduced: 1, differedOnThird: [], thirdCaptureMs: undefined })
  })

  it('leaves a capture missing from any set unclassified rather than counting it unstable', () => {
    // A key present in one capture and absent from another is a coverage
    // defect, not an instability one, and `added`/`removed`/`uncovered` already
    // carry it. Folding it in here would inflate the instability count with a
    // different problem and send whoever reads it looking for a race that is
    // not there.
    const outcome = classifyStability({
      captures: [
        new Map([
          ['light/present.png', 'a'],
          ['light/vanishes.png', 'a'],
        ]),
        new Map([['light/present.png', 'a']]),
        new Map([['light/present.png', 'a']]),
      ],
      captureMs: [1000, 1100, 1200],
    })
    expect({
      reproduced: outcome.reproduced,
      differedOnSecond: outcome.differedOnSecond,
      differedOnThird: outcome.differedOnThird,
    }).toEqual({ reproduced: 1, differedOnSecond: [], differedOnThird: [] })
  })
})
