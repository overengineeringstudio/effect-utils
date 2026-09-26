import { EventEmitter } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { storyGateReportEnvVar, storyGateRunCompleteMarker } from './completion-reporter.ts'
import { settledStoryMarker } from './constants.ts'
import {
  assertCaptureLiveness,
  assertionStoryKey,
  baselineCacheKey,
  classifyStability,
  clearStoryGateArtifacts,
  createVitestOutputCapture,
  hasCompleteReferenceCoverage,
  linkNodeModules,
  parseSettleRecords,
  referenceStoryKeys,
  isStoryGateOk,
  runVitest,
  registerProcessTreeSignalForwarding,
  selfInconsistentStoryKeys,
  slugStoryName,
  storyKey,
  terminateProcessTree,
} from './run.ts'

const clean = {
  added: [],
  removed: [],
  changed: [],
  uncovered: [],
  unsettled: [],
  baseline: { total: 39, passed: 28, failed: 11 },
  // A live harness: the browser emitted a settled marker per story. Every other
  // field here is a list, so this is the only one that says the run happened.
  settle: {
    settledStories: 39,
    unsettledStories: 0,
    boundMs: 2000,
    minMs: 30,
    medianMs: 45,
    maxMs: 120,
    totalMs: 1800,
  },
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

  it('refuses to pass when nothing settled, even with every other term clean', () => {
    // The pass-as-absence defect: if the gate annotations stop firing while
    // ordinary Storybook assertions still pass, no story is captured, so
    // added/removed/changed/uncovered/unsettled are ALL empty and
    // `baseline.passed` stays positive. Every other term in the verdict is
    // satisfied by a run that compared nothing, and the CLI prints "NOTHING
    // SETTLED — every number below is meaningless" while exiting 0.
    //
    // `settledStories` is emitted per story by the browser, so a harness that
    // never launched cannot fake it. Note `baseline.passed` is deliberately
    // left positive here: that is exactly why it does not cover this case.
    expect(isStoryGateOk({ ...clean, settle: { ...clean.settle, settledStories: 0 } })).toBe(false)
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
            projectName: 'story-gate-light',
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

describe('assertCaptureLiveness', () => {
  it('fails immediately when Vitest indexed files but executed zero stories', () => {
    expect(() =>
      assertCaptureLiveness({
        label: 'baseline probe 1/3',
        executedStories: 0,
        output: 'Test Files 0 passed (118)\\nTests no tests',
      }),
    ).toThrow(/baseline probe 1\/3 executed zero stories/)
  })

  it('fails when assertions ran without the Storybook lifecycle', () => {
    expect(() =>
      assertCaptureLiveness({
        label: 'working-tree comparison',
        executedStories: 118,
        output: 'Tests 118 passed (118)',
      }),
    ).toThrow(/118 assertions but emitted no story lifecycle records/)
  })

  it('accepts a capture only after the browser emits a lifecycle record', () => {
    expect(() =>
      assertCaptureLiveness({
        label: 'baseline probe 1/3',
        executedStories: 1,
        output:
          '[story-gate] settled {"id":"components-table--default","name":"Table > Default","elapsedMs":601,"shapes":["35:7377"]}',
      }),
    ).not.toThrow()
  })
})

describe('owned Vitest process lifecycle', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'kills the tree and re-raises %s on the parent',
    (signal) => {
      const events = new EventEmitter()
      const killed: string[] = []
      const reraised: Array<{ readonly pid: number; readonly signal: string }> = []
      registerProcessTreeSignalForwarding({
        killTree: () => killed.push('tree'),
        processControl: {
          pid: 41,
          once: (event, listener) => events.once(event, listener),
          removeListener: (event, listener) => events.removeListener(event, listener),
          kill: (pid, reraisedSignal) => {
            reraised.push({ pid, signal: reraisedSignal })
            return true
          },
        },
      })

      events.emit(signal)

      expect({ killed, reraised, listeners: events.listenerCount(signal) }).toEqual({
        killed: ['tree'],
        reraised: [{ pid: 41, signal }],
        listeners: 0,
      })
    },
  )

  it('kills the owned tree during an ordinary parent exit without changing its status', () => {
    const events = new EventEmitter()
    const killed: string[] = []
    const reraised: string[] = []
    registerProcessTreeSignalForwarding({
      killTree: () => killed.push('tree'),
      processControl: {
        pid: 41,
        once: (event, listener) => events.once(event, listener),
        removeListener: (event, listener) => events.removeListener(event, listener),
        kill: (_pid, signal) => {
          reraised.push(signal)
          return true
        },
      },
    })

    events.emit('exit')

    expect({ killed, reraised }).toEqual({ killed: ['tree'], reraised: [] })
  })

  it('uses taskkill tree and force flags on Windows', () => {
    const invocations: Array<{
      readonly command: string
      readonly args: readonly string[]
    }> = []
    terminateProcessTree({
      pid: 73,
      platform: 'win32',
      isRunning: () => true,
      runWindowsTreeKill: (command, args) => {
        invocations.push({ command, args })
        return { status: 0 }
      },
    })

    expect(invocations).toEqual([{ command: 'taskkill', args: ['/pid', '73', '/t', '/f'] }])
  })

  it('treats taskkill process-not-found as an already-complete teardown', () => {
    expect(() =>
      terminateProcessTree({
        pid: 73,
        platform: 'win32',
        // The exit event has not updated the ChildProcess yet.
        isRunning: () => true,
        runWindowsTreeKill: () => ({ status: 128 }),
      }),
    ).not.toThrow()
  })
})

describe('createVitestOutputCapture', () => {
  it('keeps lifecycle evidence while bounding diagnostics to the newest bytes', () => {
    const capture = createVitestOutputCapture({
      maxTailBytes: 8,
      maxLifecycleBytes: 1_024,
    })
    const lifecycle =
      '[story-gate] settled {"id":"components-menu--default","name":"Menu > Default","elapsedMs":601,"shapes":["2:493"]}'
    const split = 19
    capture.pushStdout(Buffer.from(lifecycle.slice(0, split)))
    capture.pushStdout(Buffer.from(`${lifecycle.slice(split)}\n01234567`))
    capture.pushStderr(Buffer.from('89abcdef'))

    expect(capture.finish()).toBe(`${lifecycle}\n89abcdef`)
  })

  it('rejects lifecycle output beyond its independent bound', () => {
    const capture = createVitestOutputCapture({
      maxTailBytes: 8,
      maxLifecycleBytes: 16,
    })
    capture.pushStdout(
      Buffer.from(
        '[story-gate] settled {"id":"components-menu--default","name":"Menu > Default"}\n',
      ),
    )

    expect(() => capture.finish()).toThrow(/lifecycle output exceeded 16 retained bytes/)
  })
})

const fakeVitest = ({
  report,
  lifecycle,
}: {
  readonly report: unknown
  readonly lifecycle: string | undefined
}): { readonly cwd: string; readonly argsFile: string; readonly reportFile: string } => {
  const cwd = mkdtempSync(join(tmpdir(), 'story-gate-vitest-'))
  const binDir = join(cwd, 'node_modules', '.bin')
  const argsFile = join(cwd, 'args.json')
  const reportFile = join(cwd, 'report.json')
  mkdirSync(binDir, { recursive: true })
  const executable = join(binDir, 'vitest')
  writeFileSync(
    executable,
    `#!${process.execPath}
const { writeFileSync } = require('node:fs')
writeFileSync(process.env[${JSON.stringify(storyGateReportEnvVar)}], ${JSON.stringify(
      JSON.stringify(report),
    )})
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)))
${lifecycle === undefined ? '' : `process.stdout.write(${JSON.stringify(`${lifecycle}\n`)})`}
require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:net').createServer().listen(0, '127.0.0.1')"], { stdio: ['ignore', 'inherit', 'inherit'] })
process.on('SIGTERM', () => {})
require('node:net').createServer().listen(0, '127.0.0.1')
process.stdout.write(${JSON.stringify(`${storyGateRunCompleteMarker}\n`)})
`,
  )
  chmodSync(executable, 0o755)
  return { cwd, argsFile, reportFile }
}
describe('runVitest completion protocol', () => {
  it('returns after the reporter completes even when Vitest keeps resources open', async () => {
    const fixture = fakeVitest({
      report: {
        testResults: [
          {
            name: '/repo/Button.stories.tsx',
            assertionResults: [
              {
                fullName: 'Default',
                title: 'Default',
                status: 'passed',
                failureMessages: [],
              },
            ],
          },
        ],
      },
      lifecycle:
        '[story-gate] settled {"id":"components-button--default","name":"Button > Default","elapsedMs":601,"shapes":["35:7377"]}',
    })
    try {
      const result = await runVitest({
        cwd: fixture.cwd,
        configFile: 'vitest.gate.config.ts',
        baselineDir: join(fixture.cwd, 'baseline'),
        manifest: undefined,
        reportFile: fixture.reportFile,
        updateMode: 'none',
        label: 'fake comparison',
      })
      const args: string[] = JSON.parse(readFileSync(fixture.argsFile, 'utf8'))
      expect(result.assertions).toHaveLength(1)
      expect(args).toContain('--update=none')
      const loaderArg = args.indexOf('--configLoader')
      expect(args.slice(loaderArg, loaderArg + 2)).toEqual(['--configLoader', 'runner'])
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true })
    }
  })

  it('rejects zero executed stories without waiting for the leaked child', async () => {
    const fixture = fakeVitest({ report: { testResults: [] }, lifecycle: undefined })
    try {
      await expect(
        runVitest({
          cwd: fixture.cwd,
          configFile: 'vitest.gate.config.ts',
          baselineDir: join(fixture.cwd, 'baseline'),
          manifest: undefined,
          reportFile: fixture.reportFile,
          updateMode: 'all',
          label: '118 indexed CSF files',
        }),
      ).rejects.toThrow(/118 indexed CSF files executed zero stories/)
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true })
    }
  })
})

describe('project-scoped reference coverage', () => {
  it('keeps the same story in different themed projects while deduplicating a retry', () => {
    const record = (projectName: string, elapsedMs: number): string =>
      `${settledStoryMarker}${JSON.stringify({
        projectName,
        id: 'components-menu--default',
        name: 'Menu > Default',
        elapsedMs,
        shapes: ['2:493'],
      })}`
    const parsed = parseSettleRecords({
      marker: settledStoryMarker,
      output: [
        record('story-gate-light', 601),
        record('story-gate-dark', 602),
        record('story-gate-light', 603),
      ].join('\n'),
    })

    expect(
      parsed.records.map(({ projectName, elapsedMs }) => ({ projectName, elapsedMs })),
    ).toEqual([
      { projectName: 'story-gate-light', elapsedMs: 603 },
      { projectName: 'story-gate-dark', elapsedMs: 602 },
    ])
    expect(parsed.malformed).toEqual([])
  })

  it('uses resolved nested paths after matcher filename sanitization', () => {
    const root = '/cache/baseline'
    const lightPath = join(
      root,
      'story-gate-light',
      'stories',
      'nested',
      'Menu.stories.tsx',
      'components-menu-default.png',
    )
    const darkPath = join(
      root,
      'story-gate-dark',
      'stories',
      'nested',
      'Menu.stories.tsx',
      'components-menu-default.png',
    )
    // The lifecycle ID contains Storybook's double hyphen, while the matcher
    // resolves a nested path whose filename is sanitized to one hyphen.
    const lifecycle = ['story-gate-light', 'story-gate-dark'].map(
      (projectName) =>
        `${settledStoryMarker}${JSON.stringify({
          projectName,
          id: 'components-menu--default',
          name: 'Menu > Default',
          elapsedMs: 601,
          shapes: ['2:493'],
        })}`,
    )
    const settledStories = parseSettleRecords({
      marker: settledStoryMarker,
      output: lifecycle.join('\n'),
    }).records.length
    const requested = referenceStoryKeys({
      root,
      paths: [lightPath, darkPath, lightPath],
    })
    const actual = referenceStoryKeys({ root, paths: [darkPath, lightPath] })

    expect(requested.toSorted()).toEqual([
      'story-gate-dark/stories/nested/Menu.stories.tsx/components-menu-default',
      'story-gate-light/stories/nested/Menu.stories.tsx/components-menu-default',
    ])
    expect({
      exact: hasCompleteReferenceCoverage({
        settledStories,
        requestedStoryKeys: requested,
        referenceStoryKeys: actual,
      }),
      missingTheme: hasCompleteReferenceCoverage({
        settledStories,
        requestedStoryKeys: requested,
        referenceStoryKeys: actual.slice(0, 1),
      }),
      wrongTheme: hasCompleteReferenceCoverage({
        settledStories,
        requestedStoryKeys: requested,
        referenceStoryKeys: [
          actual[0] ?? '',
          'story-gate-sepia/stories/nested/Menu.stories.tsx/components-menu-default',
        ],
      }),
      empty: hasCompleteReferenceCoverage({
        settledStories: 0,
        requestedStoryKeys: [],
        referenceStoryKeys: [],
      }),
    }).toEqual({ exact: true, missingTheme: false, wrongTheme: false, empty: false })
  })
})

describe('clearStoryGateArtifacts', () => {
  it('removes stale diagnostics without touching the derived baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'story-gate-artifacts-'))
    const baselineDir = join(root, 'baseline')
    const artifactsDir = `${baselineDir}-artifacts/story-gate-dark`
    const browserFailuresDir = join(artifactsDir, 'browser-failures', 'stories')
    const attachmentsDir = join(artifactsDir, 'attachments')
    try {
      mkdirSync(baselineDir, { recursive: true })
      mkdirSync(artifactsDir, { recursive: true })
      mkdirSync(browserFailuresDir, { recursive: true })
      mkdirSync(attachmentsDir, { recursive: true })
      writeFileSync(join(baselineDir, 'reference.png'), 'reference')
      writeFileSync(join(artifactsDir, 'diff.png'), 'stale diff')
      writeFileSync(join(browserFailuresDir, 'interaction-1.png'), 'stale browser failure')
      writeFileSync(join(attachmentsDir, 'visual-diff.png'), 'stale attachment')

      clearStoryGateArtifacts(baselineDir)

      expect({
        baseline: readFileSync(join(baselineDir, 'reference.png'), 'utf8'),
        artifactsRemain: existsSync(`${baselineDir}-artifacts`),
      }).toEqual({ baseline: 'reference', artifactsRemain: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
      sameFile: keys.has(storyKey({ file: 'Book.stories.tsx', slug: slugStoryName('Default') })),
      otherFile: keys.has(storyKey({ file: 'Avatar.stories.tsx', slug: slugStoryName('Default') })),
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

  it('names a capture missing from some of the set as non-reproducible', () => {
    // This test previously asserted the OPPOSITE — that such a key is left
    // unclassified — on the grounds that `added`/`removed`/`uncovered` already
    // carry it. That reasoning holds only for the KEPT capture: those three
    // compare the retained baseline directory against the compare run, and the
    // intermediate probes are deleted before that comparison ever happens.
    //
    // So a story that captured in probe 1 but not in probes 2 and 3 was watched
    // failing to reproduce ON THE SAME TREE and then reported by nothing. It is
    // an instability, not a coverage gap, and it is the one kind no comparison
    // of hashes can express because the disagreement is about the capture
    // existing at all.
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
      inconsistentPresence: outcome.inconsistentPresence,
    }).toEqual({
      reproduced: 1,
      // Kept empty on purpose: a presence disagreement must not be reported as
      // a byte disagreement, or whoever reads it goes looking for a race in the
      // render when the capture never happened.
      differedOnSecond: [],
      differedOnThird: [],
      inconsistentPresence: ['light/vanishes.png'],
    })
  })

  it('sees a capture that appears only after the first probe', () => {
    // The same blind spot in the other direction: iteration used to be over
    // capture 1's keys, so a story that rendered nothing on the first capture
    // and then appeared on the second and third was never even examined.
    const outcome = classifyStability({
      captures: [
        new Map([['light/present.png', 'a']]),
        new Map([
          ['light/present.png', 'a'],
          ['light/appears-late.png', 'a'],
        ]),
        new Map([
          ['light/present.png', 'a'],
          ['light/appears-late.png', 'a'],
        ]),
      ],
      captureMs: [1000, 1100, 1200],
    })
    expect({
      reproduced: outcome.reproduced,
      inconsistentPresence: outcome.inconsistentPresence,
    }).toEqual({ reproduced: 1, inconsistentPresence: ['light/appears-late.png'] })
  })
})

describe('assertionStoryKey', () => {
  it('does not let one file\u2019s baseline debt subtract another file\u2019s regression', () => {
    // The false green this removes. `preExisting` was built from the bare
    // `fullName`, so a baseline failure called `Default` in Book.stories.tsx
    // matched a NEWLY failing `Default` in Avatar.stories.tsx and the real
    // regression was skipped as somebody else's debt.
    const baselineDebt = new Set(
      [{ file: 'Book.stories.tsx', fullName: 'Default', status: 'failed' }].map(assertionStoryKey),
    )
    expect({
      sameFile: baselineDebt.has(
        assertionStoryKey({ file: 'Book.stories.tsx', fullName: 'Default' }),
      ),
      otherFile: baselineDebt.has(
        assertionStoryKey({ file: 'Avatar.stories.tsx', fullName: 'Default' }),
      ),
    }).toEqual({ sameFile: true, otherFile: false })
  })

  it('joins against a capture key for the same story', () => {
    // Both sides of the subtraction must land on one identity: the capture key
    // ends in the story ID, the assertion carries the bare story NAME.
    const captures = selfInconsistentStoryKeys([
      'story-gate/src/stories/NumberField.stories.tsx/components-numberfield--with-hint.png',
    ])
    expect(
      captures.has(assertionStoryKey({ file: 'NumberField.stories.tsx', fullName: 'With Hint' })),
    ).toBe(true)
  })
})

describe('linkNodeModules', () => {
  it('reuses a persisted derived tree without following borrowed dependency links', () => {
    const root = mkdtempSync(join(tmpdir(), 'story-gate-node-modules-'))
    const repoRoot = join(root, 'repo')
    const rootNodeModules = join(repoRoot, 'node_modules')
    const worktreeDir = join(rootNodeModules, '.cache', 'overeng-story-gate', 'tree-baseline')
    const packages = ['persisted', 'fresh', 'real'] as const
    try {
      for (const packageName of packages) {
        const source = join(repoRoot, 'packages', packageName, 'node_modules')
        const derivedPackage = join(worktreeDir, 'packages', packageName)
        mkdirSync(source, { recursive: true })
        mkdirSync(derivedPackage, { recursive: true })
        writeFileSync(join(derivedPackage, 'package.json'), '{}')
      }
      symlinkSync(rootNodeModules, join(worktreeDir, 'node_modules'), 'dir')
      symlinkSync(
        join(repoRoot, 'packages', 'persisted', 'node_modules'),
        join(worktreeDir, 'packages', 'persisted', 'node_modules'),
        'dir',
      )
      const realDependencies = join(worktreeDir, 'packages', 'real', 'node_modules')
      mkdirSync(realDependencies)
      writeFileSync(join(realDependencies, 'sentinel.txt'), 'real dependencies')

      linkNodeModules({ repoRoot, worktreeDir })
      linkNodeModules({ repoRoot, worktreeDir })

      expect({
        root: readlinkSync(join(worktreeDir, 'node_modules')),
        persisted: readlinkSync(join(worktreeDir, 'packages', 'persisted', 'node_modules')),
        fresh: readlinkSync(join(worktreeDir, 'packages', 'fresh', 'node_modules')),
        real: readFileSync(join(realDependencies, 'sentinel.txt'), 'utf8'),
      }).toEqual({
        root: rootNodeModules,
        persisted: join(repoRoot, 'packages', 'persisted', 'node_modules'),
        fresh: join(repoRoot, 'packages', 'fresh', 'node_modules'),
        real: 'real dependencies',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('baselineCacheKey', () => {
  const base = {
    baselineSha: 'abc123',
    packagePath: 'packages/@overeng/effect-schema-form-aria',
    configFile: 'vitest.gate.config.ts',
    sourceRoots: ['src', 'stories', '.storybook'],
    baselineCaptures: 3,
  }

  it('gives two packages at the same commit different baselines', () => {
    // The defect: the cache root is shared by the whole repository and the entry
    // was keyed by commit alone, so the first package to write `<sha>/.complete`
    // handed its own screenshots, settle records and theme matrix to every other
    // package's gate at that ref. The completeness check cannot see it — the
    // entry IS complete, it is just a baseline of something else.
    expect(baselineCacheKey(base)).not.toBe(
      baselineCacheKey({ ...base, packagePath: 'packages/@overeng/tui-react' }),
    )
  })

  it('separates entries that captured different things at the same commit', () => {
    expect({
      config: baselineCacheKey({ ...base, configFile: 'vitest.other.config.ts' }),
      roots: baselineCacheKey({ ...base, sourceRoots: ['src'] }),
      captures: baselineCacheKey({ ...base, baselineCaptures: 2 }),
    }).toEqual({
      config: expect.not.stringMatching(baselineCacheKey(base)),
      roots: expect.not.stringMatching(baselineCacheKey(base)),
      captures: expect.not.stringMatching(baselineCacheKey(base)),
    })
  })

  it('keeps the commit readable and ignores sourceRoots order', () => {
    // The sha stays a prefix so a cache directory is still greppable by ref, and
    // argument ORDER must not invalidate an otherwise identical entry.
    expect({
      prefixed: baselineCacheKey(base).startsWith('abc123-'),
      orderStable:
        baselineCacheKey(base) ===
        baselineCacheKey({ ...base, sourceRoots: ['.storybook', 'stories', 'src'] }),
    }).toEqual({ prefixed: true, orderStable: true })
  })
})
