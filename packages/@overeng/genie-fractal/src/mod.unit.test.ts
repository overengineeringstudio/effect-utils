import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

import { Effect, Schema } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  agent,
  type AgentReference,
  AgentReferenceSchema,
  AgentSchema,
  type CodexSchema,
  emit,
  type GateSchema,
  type HumanGateSchema,
  Launch,
  Review,
  Timing,
  mission,
  MissionSchema,
  missionWire,
  node,
  omp,
  person,
  type PersonReference,
  PersonReferenceSchema,
  type OmpSchema,
  resource,
  schedule,
  step,
  StepSchema,
  fractalKdl,
} from './mod.ts'
import type { FieldIsInput, StepDependency, StepHandle } from './mod.ts'
import {
  childMission,
  completed,
  completion,
  doc,
  document,
  failed,
  gate,
  input,
  loop,
  observer,
  pr,
  product,
  runId,
  subscription,
  t,
  terminal,
} from './mod.ts'
import { prLanding, prLandingFragment } from './pr-landing.fixture.ts'
import { ScratchDaemon, scratchDaemonLayer, type ScratchCommandResult } from './testing.ts'
import { upstreamRepin, upstreamRepinKdl } from './upstream-repin.fixture.ts'

const operator = person('person/schickling')
const owner = { id: 'example/owner' } satisfies typeof AgentSchema.Encoded
const worker = { id: 'example/worker' } satisfies typeof AgentSchema.Encoded
const humanReviewGate = {
  kind: 'human',
  name: 'Approve the bounded Berlin cutover',
  reviewer: operator,
} satisfies typeof HumanGateSchema.Encoded

describe('mission lanes', () => {
  const base = {
    id: 'example/lanes',
    state: 'ready',
    reportTo: owner,
    goal: 'Verify the host.',
    steps: [],
  } as const

  it('accepts optional lane children and distinct run-owned names', () => {
    const value = {
      ...base,
      lanes: [
        {
          name: 'host-proof',
          entries: 'resource/github/example/repo/ci/pull-request/',
        },
        { name: 'approval', approver: 'person/reviewer' },
        { name: 'unconfigured' },
      ],
    }
    expect(Schema.decodeSync(MissionSchema)(value).lanes).toEqual(value.lanes)
  })

  it.each([
    ['entries without a trailing slash', [{ name: 'proof', entries: 'resource/proof' }]],
    ['approver without person/', [{ name: 'proof', approver: 'agent/reviewer' }]],
    ['duplicate names', [{ name: 'proof' }, { name: 'proof' }]],
    ['empty name', [{ name: '' }]],
    ['name containing a slash', [{ name: 'host/proof' }]],
    ['name containing whitespace', [{ name: 'host proof' }]],
    ['name exceeding the UTF-8 byte limit', [{ name: 'é'.repeat(81) }]],
  ])('rejects %s', (_, lanes) => {
    expect(() => Schema.decodeSync(MissionSchema)({ ...base, lanes })).toThrow()
  })

  it('renders lanes before execution, omitting absent children', () => {
    expect(
      emit([
        mission({
          ...base,
          lanes: [
            {
              name: 'host-proof',
              entries: 'resource/github/example/repo/ci/pull-request/',
            },
            { name: 'approval', approver: 'person/reviewer' },
            { name: 'unconfigured' },
          ],
          steps: [
            {
              id: 'verify',
              exec: {
                id: 'host-proof',
                host: 'example-host',
                workspace: '/workspace',
                launch: Launch.shell({ command: 'true' }),
                restart: 'never',
              },
            },
          ],
        }),
      ]),
    ).toMatchInlineSnapshot(`
      "version 2
      mission "example/lanes" report-to="agent/example/owner" state="ready" {
        goal "Verify the host."
        lane "host-proof" {
          entries "resource/github/example/repo/ci/pull-request/"
        }
        lane "approval" {
          approver "person/reviewer"
        }
        lane "unconfigured" {
        }
        step "verify" {
          exec "host-proof" {
            host "example-host"
            workspace "/workspace"
            command "true"
            restart "never"
          }
        }
      }
      "
    `)
  })
})

describe('agent principals', () => {
  it('emits exactly one person principal child without properties or a body', () => {
    expect(emit([agent({ id: 'example/worker', principal: person('person/operator') })])).toBe(
      `version 2
agent "example/worker" {
  principal "person/operator"
}
`,
    )
  })

  it('emits no principal child when unset', () => {
    expect(emit([agent({ id: 'example/worker' })])).toBe(
      `version 2
agent "example/worker" {
}
`,
    )
  })

  it('rejects an agent reference as principal', () => {
    type Principal = NonNullable<(typeof AgentSchema.Type)['principal']>
    expectTypeOf<Principal>().toEqualTypeOf<PersonReference>()
    expectTypeOf<AgentReference>().not.toExtend<Principal>()
    expect(() =>
      Schema.decodeUnknownSync(AgentSchema)({ id: 'example/worker', principal: owner }),
    ).toThrow()
  })

  it.each([
    'person/',
    'person//operator',
    'person/operator/',
    'person/../operator',
    'agent/operator',
    'operator',
    'person/with spaces',
  ])('rejects malformed principal person subject %s', (subject) => {
    expect(() =>
      Schema.decodeSync(AgentSchema)({
        id: 'example/worker',
        principal: { kind: 'person', subject },
      }),
    ).toThrow()
  })
})

// These are authoring contracts, not assertions about person authentication.
describe('attributed human gates', () => {
  it('keeps person references distinct from imported agent references', () => {
    type Reviewer = (typeof HumanGateSchema.Encoded)['reviewer']
    type AssignedTo = NonNullable<(typeof StepSchema.Encoded)['assignedTo']>
    type UnderTarget = NonNullable<(typeof AgentSchema.Encoded)['under']>[number]['target']
    expectTypeOf<PersonReference>().not.toMatchTypeOf<AgentReference>()
    expectTypeOf<AgentReference>().not.toMatchTypeOf<PersonReference>()
    expectTypeOf<typeof owner>().not.toMatchTypeOf<Reviewer>()
    expectTypeOf<string>().not.toMatchTypeOf<Reviewer>()
    expectTypeOf<PersonReference>().toMatchTypeOf<AssignedTo>()
    expectTypeOf<PersonReference>().not.toMatchTypeOf<UnderTarget>()
    expectTypeOf<PersonReference>().not.toMatchTypeOf<(typeof MissionSchema.Encoded)['reportTo']>()
    expectTypeOf<Parameters<typeof person>[0]>().toEqualTypeOf<`person/${string}`>()
    expect(() =>
      step({
        id: 'approve',
        agentless: true,
        gates: [{ ...humanReviewGate, reviewer: owner }],
      } as never),
    ).toThrow()
  })

  it('requires tags and does not declare unsupported policy fields', () => {
    type Gate = typeof GateSchema.Encoded
    expectTypeOf<Gate['kind']>().toEqualTypeOf<
      | 'field'
      | 'human'
      | 'exists'
      | 'document'
      | 'empty'
      | 'has'
      | 'lacks'
      | 'merged'
      | 'ci-passed'
      | 'exec'
    >()
    expectTypeOf<Omit<typeof humanReviewGate, 'kind'>>().not.toMatchTypeOf<Gate>()
    expectTypeOf<
      Extract<
        'tier' | 'scope' | 'window' | 'fallback' | 'policy' | 'humanOnly',
        keyof typeof HumanGateSchema.Encoded
      >
    >().toBeNever()
    expectTypeOf<NonNullable<(typeof HumanGateSchema.Encoded)['mode']>>().toEqualTypeOf<
      'approve' | 'feedback'
    >()
    for (const extra of [
      { tier: 'critical' },
      { tier: 'consultative' },
      { scope: 'Berlin configuration' },
      { window: '1h' },
      { fallback: owner },
      { policy: 'consent/example' },
      { humanOnly: true },
    ]) {
      expect(() =>
        step({
          id: 'approve',
          agentless: true,
          gates: [{ ...humanReviewGate, ...extra }],
        } as never),
      ).toThrow()
    }
    expect(() =>
      step({
        id: 'verify',
        gates: [{ name: 'ok', field: { kind: 'exit_code', ref: 'exec/check', is: 0 } }],
      } as never),
    ).toThrow()
  })

  it.each([
    'person/',
    'person//operator',
    'person/operator/',
    'person/../operator',
    'agent/operator',
    'operator',
    'person/with spaces',
  ])('rejects invalid person subjects %s', (subject) => {
    expect(() => Schema.decodeSync(PersonReferenceSchema)({ kind: 'person', subject })).toThrow()
  })

  it('lowers a separate approve checkpoint before the risky step to exact KDL', () => {
    expect(
      emit([
        mission({
          id: 'home/berlin/cutover',
          state: 'ready',
          reportTo: owner,
          goal: ['Apply only the reviewed Berlin cutover plan.'],
          steps: [
            {
              id: 'approve-cutover',
              agentless: true,
              timeout: '1d',
              gates: [
                {
                  ...humanReviewGate,
                  question: 'Apply the reviewed configuration and rollback plan?',
                  review: [
                    Review.pinned(`doc/berlin-cutover@${'a'.repeat(64)}`),
                    Review.subject('resource/example/rollback-plan'),
                  ],
                },
              ],
            },
            {
              id: 'apply-cutover',
              assignedTo: worker,
              dependsOn: [{ step: 'approve-cutover', state: 'completed' }],
              goal: ['Apply precisely the approved plan.'],
            },
          ],
        }),
      ]),
    ).toBe(`version 2
mission "home/berlin/cutover" report-to="agent/example/owner" state="ready" {
  goal "Apply only the reviewed Berlin cutover plan."
  step "approve-cutover" timeout="1d" {
    agentless
    gate "Approve the bounded Berlin cutover" mode="approve" type="human" {
      reviewer "person/schickling"
      question "Apply the reviewed configuration and rollback plan?"
      review "doc/berlin-cutover@${'a'.repeat(64)}"
      review "resource/example/rollback-plan"
    }
  }
  step "apply-cutover" {
    assigned-to "agent/example/worker"
    depends-on {
      step "approve-cutover" "completed"
    }
    goal "Apply precisely the approved plan."
  }
}
`)
  })

  it('lowers worker feedback without turning it into pre-work authorization', () => {
    expect(
      emit([
        step({
          id: 'draft',
          assignedTo: worker,
          gates: [{ ...humanReviewGate, mode: 'feedback' }],
        }),
      ]),
    ).toBe(`version 2
step "draft" {
  assigned-to "agent/example/worker"
  gate "Approve the bounded Berlin cutover" mode="feedback" type="human" {
    reviewer "person/schickling"
  }
}
`)
    expect(() =>
      step({ id: 'approve', agentless: true, gates: [{ ...humanReviewGate, mode: 'feedback' }] }),
    ).toThrow('feedback human gates require a worker step')
  })

  it('accepts explicit approve mode and rejects invalid modes and duplicate review targets', () => {
    expect(
      emit([
        step({ id: 'approve', agentless: true, gates: [{ ...humanReviewGate, mode: 'approve' }] }),
      ]),
    ).toBe(emit([step({ id: 'approve', agentless: true, gates: [humanReviewGate] })]))
    for (const invalid of [
      { mode: 'consultative' },
      { review: [Review.subject('doc/plan'), Review.subject('doc/plan')] },
      { question: '' },
      { reviewer: 'person/schickling' },
    ]) {
      expect(() =>
        step({
          id: 'approve',
          agentless: true,
          gates: [{ ...humanReviewGate, ...invalid }],
        } as never),
      ).toThrow()
    }
  })

  it('keeps imported agent IDs authoritative over preserved person-like metadata', () => {
    const importedWorker = { ...worker, kind: 'person', subject: operator.subject }
    const decoded = Schema.decodeSync(StepSchema)({ id: 'work', assignedTo: importedWorker })
    expect(decoded.assignedTo).toBe(importedWorker)
    expect(emit([step({ id: 'work', assignedTo: importedWorker })])).toBe(
      'version 2\nstep "work" {\n  assigned-to "agent/example/worker"\n}\n',
    )
  })

  it('lowers distinct person assignments and retains native field gate syntax', () => {
    expect(emit([step({ id: 'inspect', assignedTo: operator, goal: ['Inspect the plan.'] })])).toBe(
      'version 2\nstep "inspect" {\n  assigned-to "person/schickling"\n  goal "Inspect the plan."\n}\n',
    )
    expect(
      emit([
        step({
          id: 'verify',
          gates: [
            {
              kind: 'field',
              name: 'Successful check',
              path: 'exit_code',
              subject: 'exec/check',
              operator: 'is',
              value: 0,
            },
          ],
        }),
      ]),
    ).toBe(
      'version 2\nstep "verify" {\n  gate "Successful check" {\n    field "exit_code" "exec/check" "is" 0\n  }\n}\n',
    )
    expect(() => step({ id: 'inspect', agentless: true, assignedTo: operator })).toThrow()
  })
})

describe('canonical launch and review authoring', () => {
  it.each([true, false, undefined])(
    'preserves native completion-report policy %s',
    (reportCompleted) => {
      const input = {
        id: 'example/reporting',
        state: 'ready' as const,
        reportTo: owner,
        goal: 'Retain completion reporting policy.',
        steps: [],
        ...(reportCompleted === undefined ? {} : { reportCompleted }),
      }
      expect(missionWire(input).reportCompleted).toBe(reportCompleted)
      const rendered = emit([mission(input)])
      if (reportCompleted === undefined) expect(rendered).not.toContain('report-completed')
      else expect(rendered).toContain(`report-completed=#${reportCompleted}`)
    },
  )
  it.each([
    Launch.shell({ command: 'true', cwd: '/tmp' }),
    Launch.argv({ argv: ['true'], unset: ['ONE', 'TWO'] }),
  ])('rejects task-only launch options at root agent admission %j', (launch) => {
    expect(() => agent({ id: 'example/root', launch })).toThrow()
    expect(() => Schema.decodeSync(AgentSchema)({ id: 'example/root', launch })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(AgentReferenceSchema)({ id: 'example/root', launch }),
    ).toThrow()
    expect(() => agent({ id: 'example/root', exec: [{ id: 'child', launch }] })).not.toThrow()
  })
  it('lowers argv execution options and immutable reviews to exact native KDL', () => {
    const hash = 'b'.repeat(64)
    expect(
      emit([
        step({
          id: 'check',
          agentless: true,
          exec: {
            id: 'verify',
            host: 'local',
            workspace: '/work/example',
            restart: 'never',
            launch: Launch.argv({
              argv: ['git', 'status', '--short'],
              cwd: '/work/example/src',
              env: { ZED: 'last', ALPHA: 'first' },
              unset: ['GIT_DIR', 'GIT_WORK_TREE'],
            }),
          },
          gates: [
            {
              kind: 'human',
              name: 'review',
              reviewer: operator,
              review: [
                Review.file({ host: 'local', path: '/work/example/plan.md' }),
                Review.pinned(`doc/example/plan@${hash}`),
              ],
            },
          ],
        }),
      ]),
    ).toBe(`version 2
step "check" {
  agentless
  exec "verify" {
    host "local"
    workspace "/work/example"
    argv "git" "status" "--short"
    cwd "/work/example/src"
    env {
      ALPHA "first"
      ZED "last"
    }
    unset "GIT_DIR" "GIT_WORK_TREE"
    restart "never"
  }
  gate "review" mode="approve" type="human" {
    reviewer "person/schickling"
    review "file/local:/work/example/plan.md"
    review "doc/example/plan@${hash}"
  }
}
`)
  })

  it('rejects removed command, argv and raw review authoring paths', () => {
    for (const legacy of [{ command: 'true' }, { argv: ['true'] }]) {
      expect(() => agent({ id: 'legacy', ...legacy } as never)).toThrow()
      for (const kind of ['pty', 'exec']) {
        expect(() =>
          agent({ id: 'legacy', [kind]: [{ id: 'task', ...legacy }] } as never),
        ).toThrow()
      }
      expect(() =>
        step({
          id: 'legacy',
          agentless: true,
          exec: { id: 'task', host: 'local', workspace: '/tmp', restart: 'never', ...legacy },
        } as never),
      ).toThrow()
    }
    expect(() =>
      gate.human({ reviewer: operator, review: ['resource/example'] } as never),
    ).toThrow()
  })

  it('lowers one-shot timing without recurring catch-up fields', () => {
    expect(
      emit([
        schedule({
          id: 'once',
          host: 'local',
          work: { mission: 'demo', workspace: '/work/demo' },
          timing: Timing.at('2026-10-19T09:00:00+02:00'),
        }),
      ]),
    ).toBe(`version 2
schedule "once" {
  host "local"
  at "2026-10-19T07:00:00Z"
  work {
    mission "demo"
    workspace "/work/demo"
  }
}
`)
  })
})

describe('compact native time rendering', () => {
  it('lowers every duration surface without changing canonical mission values', () => {
    const input = {
      id: 'compact-time',
      state: 'ready',
      reportTo: owner,
      goal: 'Preserve exact native timing.',
      timeout: '172800000ms',
      stalledAfter: '3600000ms',
      steps: [
        {
          id: 'wait',
          timeout: '90000ms',
          agentless: true,
          retry: { attempts: 2, backoff: '1501ms' },
          gates: [
            gate.exec({
              name: 'ready',
              command: 'true',
              host: 'local',
              workspace: '/work',
              timeLimit: '60000ms',
            }),
          ],
        },
        {
          id: 'poll',
          timeout: '86400000ms',
          maxRounds: 2,
          until: [gate.exists({ name: 'result', subject: 'resource/result' })],
          round: {
            completion: { dependsOn: ['retry'] },
            steps: [
              {
                id: 'retry',
                agentless: true,
                retry: { attempts: 2, backoff: '0ms' },
              },
            ],
          },
          onExhausted: { outcome: 'fail' },
        },
      ],
    } as const
    const wire = missionWire(input)
    expect(wire.timeout).toBe('172800000ms')
    expect(wire.stalledAfter).toBe('3600000ms')
    expect(wire.steps[0]).toMatchObject({
      timeout: '90000ms',
      retry: { backoff: '1501ms' },
      gates: [{ timeLimit: '60000ms' }],
    })
    const kdl = emit([
      mission(input),
      agent({ id: 'compact-time/worker', shutdownTimeout: '30000ms' }),
      schedule({
        id: 'compact-time-every',
        host: 'local',
        timing: Timing.every({
          every: '7200000ms',
          anchor: '2026-10-19T00:00:00.000Z',
          catchUp: 'latest',
        }),
        work: { mission: 'compact-time', workspace: '/work' },
      }),
      schedule({
        id: 'compact-time-once',
        host: 'local',
        timing: Timing.at('2026-10-19T00:00:00.123Z'),
        work: { mission: 'compact-time', workspace: '/work' },
      }),
    ])
    for (const native of [
      'timeout="2d"',
      'stalled-after="1h"',
      'step "wait" timeout="90s"',
      'backoff "1501ms"',
      'time-limit "1m"',
      'loop "poll" timeout="1d"',
      'backoff "0ms"',
      'shutdown-timeout "30s"',
      'every "2h"',
      'anchor "2026-10-19T00:00:00Z"',
      'at "2026-10-19T00:00:00.123Z"',
    ]) {
      expect(kdl).toContain(native)
    }
  })
})

const reporter = {
  id: 'ops/watcher',
  name: 'Mission watcher',
  harness: { kind: 'omp', model: 'example-model', effort: 'medium' },
} satisfies typeof AgentSchema.Encoded

const canonical = () =>
  emit([
    mission({
      id: 'demo',
      state: 'ready',
      reportTo: reporter,
      goal: ['Demonstrate KDL.'],
      steps: [{ id: 'first', goal: ['Inspect input.'], agentless: true }],
    }),
    mission(fanInMission()),
  ])
const scheduleWork = { mission: `demo@${'a'.repeat(64)}`, workspace: '/work/demo' }
const calendarTiming = { at: '08:00', timezone: 'Europe/Berlin', catchUp: 'latest' } as const
const calendarSchedule = {
  id: 'daily',
  host: 'local',
  timing: Timing.calendar(calendarTiming),
  work: scheduleWork,
} as const
describe('Calendar schedules', () => {
  it('rejects unknown zones in the callable Intl timezone validator', () => {
    expect(() => Intl.DateTimeFormat(undefined, { timeZone: 'Mars/Olympus' })).toThrow(RangeError)
    expect(() =>
      schedule({
        ...calendarSchedule,
        timing: Timing.calendar({ ...calendarTiming, timezone: 'Mars/Olympus' }),
      }),
    ).toThrow('unknown IANA timezone')
  })
  it('renders the documented Berlin daily calendar schedule without interval fields', () => {
    expect(emit([schedule(calendarSchedule)])).toBe(
      `version 2
schedule "daily" {
  host "local"
  calendar {
    at "08:00"
    timezone "Europe/Berlin"
  }
  catch-up "latest"
  work {
    mission "${scheduleWork.mission}"
    workspace "/work/demo"
  }
}
`,
    )
  })
  it.each(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const)(
    'renders a weekly %s calendar using st DAY HH:MM syntax',
    (day) => {
      expect(
        emit([
          schedule({
            ...calendarSchedule,
            timing: Timing.calendar({ ...calendarTiming, at: '09:00', days: [day] }),
          }),
        ]),
      ).toContain(`calendar {\n    at "${day} 09:00"\n    timezone "Europe/Berlin"\n  }`)
    },
  )
  it('renders canonical interval timing and rejects former schedule authoring paths', () => {
    const interval = {
      id: 'cycle',
      host: 'local',
      timing: Timing.every({ every: '6h', anchor: '2026-01-01T00:00:00Z', catchUp: 'latest' }),
      work: scheduleWork,
    } as const
    const rendered = emit([schedule(interval)])
    expect(rendered).toContain('  every "6h"\n  anchor "2026-01-01T00:00:00Z"\n')
    expect(rendered).not.toContain('calendar')
    for (const legacy of [
      { every: '6h', anchor: '2026-01-01T00:00:00Z', catchUp: 'latest' },
      { _tag: 'every', every: '6h', anchor: '2026-01-01T00:00:00Z', catchUp: 'latest' },
      { _tag: 'calendar', at: '08:00', timezone: 'Europe/Berlin', catchUp: 'latest' },
    ]) {
      expect(() =>
        schedule({ id: 'legacy', host: 'local', work: scheduleWork, ...legacy } as never),
      ).toThrow()
    }
  })
  it('renders a calendar schedule nested in a mission', () => {
    expect(
      emit([
        mission({
          id: 'demo',
          state: 'ready',
          reportTo: reporter,
          goal: 'Daily work.',
          schedule: calendarSchedule,
          steps: [{ id: 'first', goal: 'Inspect input.', agentless: true }],
        }),
      ]),
    ).toContain('  schedule "daily" {\n    host "local"\n    calendar {\n      at "08:00"')
  })
  it.each(['24:00', '12:60', '8:00', '08:0', '08:00:00', 'Mon 08:00', '', ' 08:00'])(
    'rejects invalid calendar time %j',
    (at) => {
      expect(() =>
        schedule({ ...calendarSchedule, timing: Timing.calendar({ ...calendarTiming, at }) }),
      ).toThrow()
    },
  )
  it.each(['Mars/Olympus', '', '+02:00'])('rejects invalid timezone %j', (timezone) => {
    expect(() =>
      schedule({ ...calendarSchedule, timing: Timing.calendar({ ...calendarTiming, timezone }) }),
    ).toThrow()
  })
  it.each([
    { timezone: undefined },
    { days: [] },
    { days: ['Mon', 'Tue'] },
    { days: ['Monday'] },
    { days: 'Mon' },
    { every: '6h' },
    { anchor: '2026-01-01T00:00:00Z' },
    { _tag: undefined },
    { catchUp: 'all', maxCatchUp: 2 },
    { misfire: 'skip' },
  ])('rejects unsupported or conflicting calendar fields %j', (fields) => {
    expect(() =>
      schedule({ ...calendarSchedule, timing: { ...calendarSchedule.timing, ...fields } } as never),
    ).toThrow()
  })
  it.each(['00:00', '23:59'])('accepts boundary calendar time %s', (at) => {
    expect(
      emit([
        schedule({
          ...calendarSchedule,
          timing: Timing.calendar({ ...calendarTiming, at, timezone: 'UTC' }),
        }),
      ]),
    ).toContain(`at "${at}"`)
  })
})

const fanInMission = () => ({
  id: 'fan-in',
  state: 'ready' as const,
  reportTo: reporter,
  goal: 'Join independent work.',
  steps: [
    { id: 'first', agentless: true as const },
    { id: 'second', agentless: true as const },
    {
      id: 'join',
      agentless: true as const,
      dependsOn: [
        { step: 'first', state: 'completed' as const },
        { step: 'second', state: 'completed' as const },
      ] as const,
    },
  ],
})

describe('Fractal declarations', () => {
  it('requires a typed agent declaration rather than a string or omitted report', () => {
    expectTypeOf<string>().not.toMatchTypeOf<(typeof MissionSchema.Encoded)['reportTo']>()
    expectTypeOf<Omit<typeof MissionSchema.Encoded, 'reportTo'>>().not.toMatchTypeOf<
      typeof MissionSchema.Encoded
    >()
    const { reportTo: _reportTo, ...unreported } = fanInMission()
    expect(() => Schema.decodeUnknownSync(MissionSchema)(unreported)).toThrow()
  })
  it.each([
    'agent/ops/watcher',
    'person/operator',
    'none',
    undefined,
    { id: '' },
    { id: '../bad' },
    { id: 'ops//watcher' },
  ])('rejects invalid reporting references %j', (reportTo) => {
    expect(() => Schema.decodeUnknownSync(MissionSchema)({ ...fanInMission(), reportTo })).toThrow()
  })
  it('renders only the native mission-level report property and retains imported kit metadata', () => {
    const importedSeat = { ...reporter, hold: { reason: 'Not deployed yet.' } }
    const input = { ...fanInMission(), reportTo: importedSeat }
    const decoded = Schema.decodeSync(MissionSchema)(input)
    expect(decoded.reportTo).toBe(importedSeat)
    const declaration = mission(input)
    expect(declaration.props['report-to']).toBe('agent/ops/watcher')
    expect(declaration.children?.some((entry) => entry.name === 'report-to')).toBe(false)
    expect(emit([declaration])).not.toContain('Mission watcher')
    expect(emit([declaration])).not.toContain('harness')
  })
  it.each([
    ['1ms', '1ms', '1ms'],
    ['30s', '30000ms', '30s'],
    ['45m', '2700000ms', '45m'],
    ['2h', '7200000ms', '2h'],
    ['1d', '86400000ms', '1d'],
    ['45 minutes', '2700000ms', '45m'],
  ])(
    'renders mission stalledAfter %s as native duration %s (%s)',
    (stalledAfter, normalized, native) => {
      const input = { ...fanInMission(), timeout: '2d', stalledAfter }
      const decoded = Schema.decodeSync(MissionSchema)(input)
      expect(decoded.stalledAfter).toBe(normalized)
      const declaration = mission(input)
      expect(declaration.props['stalled-after']).toBe(native)
      expect(declaration.props.timeout).toBe('2d')
      expect(emit([declaration])).toContain(`stalled-after="${native}"`)
      expect(declaration.children?.some((entry) => entry.name === 'stalled-after')).toBe(false)
      expect(missionWire(input).stalledAfter).toBe(normalized)
      expect(missionWire(input).timeout).toBe('172800000ms')
    },
  )
  it('omits the native stalled-after property when no duration is authored', () => {
    expect(mission(fanInMission()).props).not.toHaveProperty('stalled-after')
  })
  it.each(['0ms', '0s', '-1m', '1.5h', '0.0001 seconds', '45', '', 45000])(
    'rejects invalid mission stalledAfter %j',
    (stalledAfter) => {
      expect(() =>
        Schema.decodeUnknownSync(MissionSchema)({ ...fanInMission(), stalledAfter }),
      ).toThrow()
    },
  )
  it.each([true, false])('renders mission reportStalls %j as a native boolean', (reportStalls) => {
    const input = { ...fanInMission(), reportStalls, stalledAfter: '45m' }
    expect(Schema.decodeSync(MissionSchema)(input).reportStalls).toBe(reportStalls)
    const declaration = mission(input)
    expect(declaration.props['report-stalls']).toBe(reportStalls)
    expect(emit([declaration])).toContain(`report-stalls=#${reportStalls}`)
    expect(missionWire(input).reportStalls).toBe(reportStalls)
  })
  it('omits report-stalls when the native default is requested', () => {
    expect(mission(fanInMission()).props).not.toHaveProperty('report-stalls')
  })
  it.each(['true', 'false', 0, 1, null])('rejects invalid reportStalls %j', (reportStalls) => {
    expect(() =>
      Schema.decodeUnknownSync(MissionSchema)({ ...fanInMission(), reportStalls }),
    ).toThrow()
  })
  it('requires imported objects for step assignment and under targets', () => {
    type AssignedTo = NonNullable<(typeof StepSchema.Encoded)['assignedTo']>
    type UnderTarget = NonNullable<(typeof AgentSchema.Encoded)['under']>[number]['target']
    expectTypeOf<string>().not.toMatchTypeOf<AssignedTo>()
    expectTypeOf<`agent/${string}`>().not.toMatchTypeOf<AssignedTo>()
    expectTypeOf<string>().not.toMatchTypeOf<UnderTarget>()
    expectTypeOf<`agent/${string}`>().not.toMatchTypeOf<UnderTarget>()
    expectTypeOf<typeof reporter>().toMatchTypeOf<AssignedTo>()
    expectTypeOf<typeof reporter>().toMatchTypeOf<UnderTarget>()
    expectTypeOf<typeof reporter>().toMatchTypeOf<AgentReference>()
  })
  it('lowers imported references to exact native IDs without referenced launch metadata', () => {
    const input = {
      id: 'assigned',
      state: 'ready',
      reportTo: reporter,
      goal: ['Delegate work.'],
      steps: [{ id: 'inspect', assignedTo: reporter, goal: ['Inspect input.'] }],
    } satisfies typeof MissionSchema.Encoded
    expect(emit([mission(input)])).toBe(
      'version 2\nmission "assigned" report-to="agent/ops/watcher" state="ready" {\n  goal "Delegate work."\n  step "inspect" {\n    assigned-to "agent/ops/watcher"\n    goal "Inspect input."\n  }\n}\n',
    )
    expect(
      emit([
        agent({
          id: 'ops/worker',
          under: [
            { target: reporter, reason: 'Delegated work.' },
            { target: { id: 'other/manager' } },
          ],
        }),
      ]),
    ).toBe(
      'version 2\nagent "ops/worker" {\n  under "agent/ops/watcher" reason="Delegated work."\n  under "agent/other/manager"\n}\n',
    )
  })
  it('retains imported object identity and kit metadata for every reference position', () => {
    const importedSeat = {
      ...reporter,
      env: { KIT_SESSION_HOME: '/sessions/kit' },
      hold: { reason: 'Not deployed yet.' },
      returnFacts: { assignedTo: 'Worker owns this boundary.' },
    }
    expect(Schema.decodeSync(AgentReferenceSchema)(importedSeat)).toBe(importedSeat)
    const assigned = Schema.decodeSync(StepSchema)({ id: 'inspect', assignedTo: importedSeat })
    const subordinate = Schema.decodeSync(AgentSchema)({
      id: 'ops/worker',
      under: [{ target: importedSeat }],
    })
    expect(assigned.assignedTo).toBe(importedSeat)
    expect(subordinate.under?.[0]?.target).toBe(importedSeat)
    expect(
      Schema.decodeSync(MissionSchema)({ ...fanInMission(), reportTo: importedSeat }).reportTo,
    ).toBe(importedSeat)
    const kdl = emit([
      step({ id: 'inspect', assignedTo: importedSeat }),
      agent({ id: 'ops/worker', under: [{ target: importedSeat }] }),
    ])
    for (const metadata of [
      'harness',
      'Mission watcher',
      'KIT_SESSION_HOME',
      'hold',
      'returnFacts',
    ]) {
      expect(kdl).not.toContain(metadata)
    }
  })
  it.each([
    'agent/ops/watcher',
    'ops/watcher',
    'person/operator',
    '',
    { id: '' },
    { id: '../bad' },
    { id: 'ops//watcher' },
    { id: '/ops/watcher' },
    { id: 'ops/watcher/' },
    { id: 'ops/../watcher' },
    { id: 'ops watcher' },
    { id: 'a'.repeat(513) },
    { id: 1 },
    {},
    null,
  ])('rejects invalid imported agent references in every position %j', (reference) => {
    expect(() => Schema.decodeUnknownSync(AgentReferenceSchema)(reference)).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(StepSchema)({ id: 'inspect', assignedTo: reference }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(AgentSchema)({ id: 'ops/worker', under: [{ target: reference }] }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(MissionSchema)({ ...fanInMission(), reportTo: reference }),
    ).toThrow()
  })
  it.each([
    { harness: { kind: 'omp', model: '' } },
    { harness: { kind: 'codex', model: '', effort: 'high' } },
    {
      launch: Launch.shell({ command: 'true' }),
      harness: { kind: 'omp', model: 'example-model', effort: 'high' },
    },
    { launch: { _tag: 'Shell', command: 'true', argv: ['true'] } },
    { checkout: { repository: 'repo', base: 'main', branch: 'work' } },
  ])('validates the complete referenced launch declaration %j', (launch) => {
    const reference = { id: 'ops/invalid', ...launch }
    expect(() => Schema.decodeSync(AgentReferenceSchema)(reference)).toThrow()
    expect(() => Schema.decodeSync(StepSchema)({ id: 'inspect', assignedTo: reference })).toThrow()
    expect(() =>
      Schema.decodeSync(AgentSchema)({ id: 'ops/worker', under: [{ target: reference }] }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(MissionSchema)({ ...fanInMission(), reportTo: reference }),
    ).toThrow()
  })
  it('validates imported supervisors recursively without losing reference identity', () => {
    const supervisor = { id: 'ops/supervisor', under: [{ target: reporter }] }
    expect(Schema.decodeSync(AgentReferenceSchema)(supervisor)).toBe(supervisor)
    expect(emit([agent({ id: 'ops/worker', under: [{ target: supervisor }] })])).toBe(
      'version 2\nagent "ops/worker" {\n  under "agent/ops/supervisor"\n}\n',
    )
    expect(() =>
      Schema.decodeUnknownSync(AgentReferenceSchema)({
        ...supervisor,
        under: [{ target: { id: 'ops/invalid', harness: { kind: 'omp' } } }],
      }),
    ).toThrow()
  })
  it('omits restart from nested task authoring types while retaining root restart', () => {
    type PtyTask = NonNullable<(typeof AgentSchema.Encoded)['pty']>[number]
    type ExecTask = NonNullable<(typeof AgentSchema.Encoded)['exec']>[number]
    expectTypeOf<Extract<'restart', keyof PtyTask>>().toBeNever()
    expectTypeOf<Extract<'restart', keyof ExecTask>>().toBeNever()
    expectTypeOf<Extract<'restart', keyof typeof AgentSchema.Encoded>>().toEqualTypeOf<'restart'>()
    expect(
      emit([
        agent({
          id: 'ops/worker',
          restart: 'always',
          pty: [{ id: 'shell', launch: Launch.shell({ command: 'sh' }) }],
          exec: [
            {
              id: 'check',
              host: 'local',
              workspace: '/tmp',
              launch: Launch.argv({ argv: ['true'] }),
            },
          ],
        }),
      ]),
    ).toBe(
      'version 2\nagent "ops/worker" {\n  restart "always"\n  pty "shell" {\n    command "sh"\n  }\n  exec "check" {\n    host "local"\n    workspace "/tmp"\n    argv "true"\n  }\n}\n',
    )
  })
  it.each(['pty', 'exec'] as const)(
    'rejects excess restart on nested %s tasks at runtime',
    (kind) => {
      for (const launch of [
        { launch: Launch.shell({ command: 'true' }) },
        { launch: Launch.argv({ argv: ['true'] }) },
      ]) {
        for (const restart of ['never', 'always', undefined]) {
          const reference = { id: 'ops/worker', [kind]: [{ id: 'task', ...launch, restart }] }
          expect(() => agent(reference)).toThrow()
          expect(() => Schema.decodeSync(AgentSchema)(reference)).toThrow()
          expect(() => Schema.decodeSync(AgentReferenceSchema)(reference)).toThrow()
          expect(() =>
            Schema.decodeSync(StepSchema)({ id: 'inspect', assignedTo: reference }),
          ).toThrow()
          expect(() =>
            Schema.decodeSync(AgentSchema)({
              id: 'ops/subordinate',
              under: [{ target: reference }],
            }),
          ).toThrow()
          expect(() =>
            Schema.decodeSync(MissionSchema)({ ...fanInMission(), reportTo: reference }),
          ).toThrow()
        }
      }
    },
  )
  it('renders AND fan-in as multiple ordered step entries in one depends-on block', () => {
    expect(emit([mission(fanInMission())])).toBe(
      'version 2\nmission "fan-in" report-to="agent/ops/watcher" state="ready" {\n  goal "Join independent work."\n  step "first" {\n    agentless\n  }\n  step "second" {\n    agentless\n  }\n  step "join" {\n    agentless\n    depends-on {\n      step "first" "completed"\n      step "second" "completed"\n    }\n  }\n}\n',
    )
  })
  it('preserves singleton dependency KDL with list authoring', () => {
    const input = fanInMission()
    const join = { ...input.steps[2]!, dependsOn: [{ step: 'first', state: 'completed' }] as const }
    expect(emit([mission({ ...input, steps: [...input.steps.slice(0, 2), join] })])).toContain(
      'depends-on {\n      step "first" "completed"\n    }',
    )
  })
  it.each([
    { dependsOn: [] },
    {
      dependsOn: [
        { step: 'first', state: 'completed' },
        { step: 'missing', state: 'completed' },
      ],
    },
  ])('rejects invalid dependency lists %j', ({ dependsOn }) => {
    const input = fanInMission()
    expect(() =>
      mission({
        ...input,
        steps: [...input.steps.slice(0, 2), { id: 'join', agentless: true, dependsOn }],
      } as never),
    ).toThrow()
  })
  it('resumes an exact Codex session while preserving explicit model and effort', () => {
    const seat = agent({
      id: 'example/codex',
      env: { CODEX_HOME: '/srv/codex' },
      harness: {
        kind: 'codex',
        model: 'example-model',
        effort: 'xhigh',
        args: ['--config', 'key=value'],
        resume: { session: 'native-thread' },
      },
    })
    expect(emit([seat])).toBe(
      'version 2\nagent "example/codex" {\n  env {\n    CODEX_HOME "/srv/codex"\n    ST3_NATIVE_RESUME_SESSION "native-thread"\n  }\n  harness "codex" {\n    model "example-model"\n    effort "xhigh"\n    args "--config" "key=value"\n  }\n}\n',
    )
    expect(() =>
      agent({
        id: 'example/codex',
        env: { ST3_NATIVE_RESUME_SESSION: 'different-thread' },
        harness: {
          kind: 'codex',
          model: 'example-model',
          effort: 'xhigh',
          resume: { session: 'native-thread' },
        },
      }),
    ).toThrow()
  })
  it('renders explicit Codex model and effort while retaining OMP selection', () => {
    expect(
      emit([
        agent({
          id: 'example/codex',
          harness: { kind: 'codex', model: 'example-model', effort: 'xhigh' },
        }),
      ]),
    ).toContain('harness "codex" {\n    model "example-model"\n    effort "xhigh"\n')
    expect(
      emit([
        agent({
          id: 'example/omp',
          harness: { kind: 'omp', model: 'example-model', effort: 'high' },
        }),
      ]),
    ).toContain('harness "omp" {\n    model "example-model"\n    effort "high"\n')
  })
  it('decodes and renders an OMP role selector without adding effort', () => {
    const harness = { kind: 'omp', model: '@generalist_root' } as const
    const declaration = { id: 'example/omp', harness }
    expect(Schema.decodeSync(AgentSchema)(declaration)).toEqual(declaration)
    expect(omp({ model: '@generalist_root' })).toEqual(harness)
    const expected =
      'version 2\nagent "example/omp" {\n  harness "omp" {\n' +
      '    model "@generalist_root"\n  }\n}\n'
    expect(emit([agent(declaration)])).toBe(expected)
    expect(emit([agent({ ...declaration, harness: omp({ model: '@generalist_root' }) })])).toBe(
      expected,
    )
  })
  it.each(['low', 'medium', 'high', 'xhigh'] as const)(
    'renders OMP effort %s through the canonical helper and direct schema',
    (effort) => {
      const harness = omp({ model: 'example-model', effort })
      const direct = { kind: 'omp' as const, model: 'example-model', effort }
      const expected =
        `version 2\nagent "example/omp" {\n  harness "omp" {\n` +
        `    model "example-model"\n    effort "${effort}"\n  }\n}\n`
      expect(emit([agent({ id: 'example/omp', harness })])).toBe(expected)
      expect(emit([agent({ id: 'example/omp', harness: direct })])).toBe(expected)
    },
  )
  it.each(['', 'extra-high', 'XHIGH'])('rejects unsupported OMP effort %j', (effort) => {
    expect(() => omp({ model: 'example-model', effort } as never)).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(AgentSchema)({
        id: 'example/omp',
        harness: { kind: 'omp', model: '@generalist_root', effort },
      }),
    ).toThrow()
    expect(() =>
      agent({
        id: 'example/omp',
        harness: { kind: 'omp', model: '@generalist_root', effort },
      } as never),
    ).toThrow()
  })
  it('requires model for OMP and both routing fields for Codex', () => {
    expectTypeOf<Omit<typeof OmpSchema.Encoded, 'model'>>().not.toMatchTypeOf<
      typeof OmpSchema.Encoded
    >()
    expectTypeOf<Omit<typeof OmpSchema.Encoded, 'effort'>>().toMatchTypeOf<
      typeof OmpSchema.Encoded
    >()
    expectTypeOf<Omit<typeof CodexSchema.Encoded, 'model'>>().not.toMatchTypeOf<
      typeof CodexSchema.Encoded
    >()
    expectTypeOf<Omit<typeof CodexSchema.Encoded, 'effort'>>().not.toMatchTypeOf<
      typeof CodexSchema.Encoded
    >()
  })
  it.each(['omp', 'codex'])('rejects absent or empty %s routing fields', (kind) => {
    for (const routing of [
      {},
      { effort: 'medium' },
      { model: '', effort: 'medium' },
      { model: 'example-model', effort: '' },
      ...(kind === 'codex' ? [{ model: 'example-model' }] : []),
    ]) {
      expect(() => agent({ id: 'seat', harness: { kind, ...routing } } as never)).toThrow()
      expect(() =>
        mission({
          ...fanInMission(),
          reportTo: { id: 'ops/watcher', harness: { kind, ...routing } },
        } as never),
      ).toThrow()
    }
  })
  it('does not expose root role or persona/runtime selectors', () => {
    expectTypeOf<
      Extract<'role' | 'persona' | 'runtime', keyof typeof AgentSchema.Encoded>
    >().toBeNever()
    for (const selector of [
      { role: 'orchestrator' },
      { role: 'worker' },
      { persona: 'generalist' },
      { runtime: 'generalist' },
    ]) {
      expect(() => agent({ id: 'seat', ...selector } as never)).toThrow()
    }
  })
  it('serializes KDL v2 values, quoted identifiers and stable property ordering', () => {
    expect(
      emit([
        node({
          name: 'quoted key',
          args: ['a\n"b', true, false, 12],
          props: { z: true, a: 'x' },
          children: [node({ name: 'nested' })],
        }),
      ]),
    ).toBe('version 2\n"quoted key" "a\\n\\"b" #true #false 12 a="x" z=#true {\n  nested\n}\n')
    expect(() => emit([node({ name: 'bad', args: [Infinity] })])).toThrow()
    expect(
      fractalKdl([node({ name: 'bad', args: [Infinity] })]).validate?.({ cwd: '', location: '' }),
    ).toMatchObject([{ severity: 'error', rule: 'fractal-kdl' }])
  })
  it('rejects invalid or excess authored fields before rendering', () => {
    expect(() =>
      mission({
        id: 'demo',
        state: 'ready',
        reportTo: reporter,
        goal: ['go'],
        steps: [{ id: 'a', agentless: true, assignedTo: reporter }],
      }),
    ).toThrow()
    expect(() => agent({ id: 'demo', workspace: '/tmp', surprise: true } as never)).toThrow()
    expect(() =>
      schedule({
        id: 'night',
        host: 'local',
        timing: Timing.every({ every: '0s', anchor: '2026-09-30T12:00:00Z', catchUp: 'latest' }),
        work: { mission: `demo@${'a'.repeat(64)}`, workspace: '/tmp' },
      }),
    ).toThrow()
    expect(() =>
      agent({
        id: 'seat',
        launch: Launch.shell({ command: 'true' }),
        harness: { kind: 'omp', model: 'x', effort: 'low' },
      }),
    ).toThrow()
    expect(() =>
      agent({ id: 'seat', checkout: { repository: 'repo', base: 'main', branch: 'work' } }),
    ).toThrow()
  })
  it.each([
    {
      resume: { transcript: '/sessions/with spaces/"quoted".jsonl' },
      args: ['--resume', '/sessions/with spaces/"quoted".jsonl'],
    },
    { resume: 'latest' as const, args: ['--continue'] },
    { resume: undefined, args: undefined },
  ])('selects exactly one OMP recovery mode: $resume', ({ resume, args }) => {
    const harness = omp({
      model: 'example',
      effort: 'medium',
      ...(resume === undefined ? {} : { resume }),
    })
    const seat = agent({ id: 'seat', harness })
    const launch = seat.children?.find((child) => child.name === 'harness')
    expect(launch?.children?.filter((child) => child.name === 'args')).toEqual(
      args === undefined ? [] : [node({ name: 'args', args })],
    )
    if (args !== undefined) {
      expect(emit([seat])).toContain(`args ${args.map((arg) => JSON.stringify(arg)).join(' ')}\n`)
    }
  })
  it('rejects ambiguous recovery intent and free-form harness arguments', () => {
    for (const resume of [
      '',
      'continue',
      { transcript: '' },
      { transcript: '/sessions/demo.jsonl', latest: true },
    ]) {
      expect(() =>
        agent({
          id: 'seat',
          harness: { kind: 'omp', model: 'example', effort: 'medium', resume },
        } as never),
      ).toThrow()
    }
    expect(() =>
      agent({
        id: 'seat',
        harness: {
          kind: 'omp',
          model: 'example',
          effort: 'medium',
          args: ['--resume', '/sessions/demo.jsonl'],
        },
      } as never),
    ).toThrow()
  })
  it('preserves explicit false properties in a valid Genie fixture', () => {
    const nodes = [
      resource({ id: 'repo', kind: 'vcs.repository' }),
      agent({
        id: 'seat',
        workspace: '/tmp/seat',
        create: false,
        harness: { kind: 'omp', model: 'example', effort: 'medium' },
      }),
    ]
    expect(fractalKdl(nodes).stringify({ cwd: '', location: '' })).toContain(
      'workspace "/tmp/seat" create=#false',
    )
  })
  it('emits manual rollout and fault handling as strict agent children', () => {
    expect(
      emit([
        agent({
          id: 'garden/orchard',
          restart: 'never',
          rollout: 'manual',
          freshContext: true,
          handlesFaults: true,
        }),
      ]),
    ).toBe(
      'version 2\nagent "garden/orchard" {\n  restart "never"\n  rollout "manual"\n  fresh-context\n  handles-faults\n}\n',
    )
    expect(emit([agent({ id: 'garden/orchard' })])).toBe('version 2\nagent "garden/orchard" {\n}\n')
  })
  it.each(['automatic', 'auto', '', 1, true, ['manual'], { value: 'manual' }])(
    'rejects invalid rollout policy %j',
    (rollout) => {
      expect(() => agent({ id: 'garden/orchard', rollout } as never)).toThrow()
    },
  )
  it.each([false, 'true', 1])('rejects non-bare fault handling flag %j', (handlesFaults) => {
    expect(() => agent({ id: 'garden/orchard', handlesFaults } as never)).toThrow()
  })
  const cycle = (mission: string) =>
    schedule({
      id: 'cycle',
      host: 'local',
      timing: Timing.every({ every: '6h', anchor: '2026-01-01T00:00:00Z', catchUp: 'latest' }),
      work: { mission, workspace: '/work/cycles' },
    })
  it.each(['fabric/cycle', `fabric/cycle@${'a'.repeat(64)}`])(
    'emits scheduled work for mission %s',
    (mission) => {
      expect(emit([cycle(mission)])).toBe(
        `version 2\nschedule "cycle" {\n  host "local"\n  every "6h"\n  anchor "2026-01-01T00:00:00Z"\n  catch-up "latest"\n  work {\n    mission "${mission}"\n    workspace "/work/cycles"\n  }\n}\n`,
      )
    },
  )
  it.each([
    'fabric/cycle@',
    `fabric/cycle@${'a'.repeat(63)}`,
    'a@b',
    '/fabric',
    'fabric/',
    'a b',
    '',
  ])('rejects scheduled mission reference %j', (mission) => {
    expect(() => cycle(mission)).toThrow()
  })
})

const guideText = 'This immutable guide is ready.\n'
const guideHash = createHash('sha256').update(guideText).digest('hex')
const grammarCanonical = () =>
  emit([
    mission({
      id: 'demo',
      state: 'ready',
      reportTo: owner,
      goal: ['Demonstrate KDL.', 'Preserve all goals.', 'Bound goals to three.'],
      gates: [{ name: 'exists', kind: 'exists', subject: 'resource/input' }],
      docs: [{ id: 'example/guide', hash: guideHash }],
      completion: { dependsOn: [{ step: 'last', state: 'completed' }] },
      finally: [
        {
          id: 'cleanup',
          agentless: true,
          gates: [
            {
              name: 'cleanup',
              kind: 'exec',
              command: 'true',
              host: 'local',
              workspace: '${ST_WORKSPACE}',
              env: { RESULT: 'ok' },
              timeLimit: '1m',
            },
          ],
        },
        {
          id: 'after-cleanup',
          agentless: true,
          dependsOn: [{ step: 'cleanup', state: 'terminal' }],
        },
      ],
      steps: [
        {
          id: 'first',
          goal: ['Inspect input.'],
          agentless: true,
          retry: { attempts: 100, backoff: '0s' },
          documents: [`doc/example/guide@${guideHash}`],
          gates: [
            {
              name: 'state',
              kind: 'field',
              path: 'state',
              subject: 'resource/input',
              operator: 'is',
              value: 'ready',
            },
            {
              name: 'prefix',
              kind: 'field',
              path: 'name',
              subject: 'resource/input',
              operator: 'starts-with',
              value: 'input',
            },
            { name: 'empty', kind: 'empty', subject: 'mission-run/previous' },
            { name: 'has', kind: 'has', subject: 'message/guide', text: 'ready' },
            { name: 'lacks', kind: 'lacks', subject: 'file/local:/tmp/result', text: 'error' },
            { name: 'merged', kind: 'merged', locator: 'acme/garden#7' },
            {
              name: 'ci',
              kind: 'ci-passed',
              check: 'build',
              repo: 'acme/garden',
              ref: { branch: 'main' },
            },
          ],
        },
        { id: 'second', agentless: true, dependsOn: [{ step: 'first', state: 'failed' }] },
        {
          id: 'last',
          agentless: true,
          dependsOn: [
            { step: 'first', state: 'completed' },
            { step: 'second', state: 'terminal' },
          ],
        },
      ],
    }),
  ])

describe('native mission grammar', () => {
  it('keeps scalar and singleton goal/dependency declarations byte-identical', () => {
    const declaration = (
      goal: typeof MissionSchema.Encoded.goal,
      dependsOn: NonNullable<typeof StepSchema.Encoded.dependsOn>,
    ) =>
      emit([
        mission({
          id: 'scalar-parity',
          state: 'ready',
          reportTo: owner,
          goal,
          steps: [
            { id: 'first', agentless: true },
            { id: 'second', agentless: true, dependsOn },
          ],
        }),
      ])
    const expected = declaration('Preserve the native graph.', 'first')
    for (const dependsOn of [
      'first',
      { step: 'first', state: 'completed' },
      ['first'],
      [{ step: 'first', state: 'completed' }],
    ] as const) {
      expect(declaration('Preserve the native graph.', dependsOn)).toBe(expected)
      expect(declaration(['Preserve the native graph.'], dependsOn)).toBe(expected)
    }
    const first = step({ id: 'first', missionId: 'handle-parity' })
    expect(emit([step({ id: 'second', missionId: 'handle-parity', dependsOn: [first] })])).toBe(
      emit([step({ id: 'second', missionId: 'handle-parity', dependsOn: [completed(first)] })]),
    )
    expect(() => step({ id: 'empty', goal: [] } as never)).toThrow()
    expect(() =>
      mission({
        id: 'old-key',
        state: 'ready',
        reportTo: owner,
        goals: ['Not an authoring alias.'],
        steps: [],
      } as never),
    ).toThrow()
  })
  it('renders final native gate constructors and typed interpolation without an exec shim', () => {
    const commit = input.text('commit')
    const declaration = mission({
      id: 'constructor-parity',
      state: 'ready',
      reportTo: owner,
      inputs: [commit],
      goal: t`Verify ${commit}.`,
      steps: [],
      gates: [
        gate.ciPassed({ check: 'build', repo: 'acme/garden', commit, name: 'build' }),
        gate.merged({ target: pr({ repo: 'acme/garden', number: 7 }), name: 'merged' }),
        gate.document({ target: doc`doc/report/${runId}`, name: 'report' }),
        gate.human({ reviewer: operator, name: 'review', question: 'Is the exact report ready?' }),
      ],
    })
    const kdl = emit([declaration])
    expect(kdl).toContain('goal "Verify ${input.commit}."')
    expect(kdl).toContain('ci-passed "build" commit="${input.commit}" repo="acme/garden"')
    expect(kdl).toContain('merged "acme/garden#7"')
    expect(kdl).toContain('document "doc/report/${ST_MISSION_RUN}"')
    expect(kdl).toContain('gate "review" mode="approve" type="human"')
    expect(gate.merged({ target: pr({ repo: 'acme/garden', number: 7 }) }).name).toBe(
      gate.merged({ target: pr({ repo: 'acme/garden', number: 7 }) }).name,
    )
    expect(gate.ciPassed({ check: 'build', repo: 'acme/garden', commit }).name).not.toBe(
      gate.ciPassed({ check: 'test', repo: 'acme/garden', commit }).name,
    )
  })
  it('retains every native gate, retry, completion and finalization in the synthetic graph', () => {
    const kdl = grammarCanonical()
    expect(kdl).toContain('goal "Bound goals to three."')
    expect(kdl).toContain('retry {\n      attempts 100\n      backoff "0ms"')
    expect(kdl).toContain('completion {\n    depends-on {\n      step "last" "completed"')
    expect(kdl).toContain('finally {\n    step "cleanup"')
    expect(kdl).toContain('field "name" "resource/input" "starts-with" "input"')
    expect(kdl).toContain('lacks "file/local:/tmp/result" "error"')
  })
  it('renders public PR inputs and config-time fragments with the same ordered flow', () => {
    expect(emit([prLanding()])).toContain('input "commit" kind="text"')
    expect(emit([prLandingFragment({ number: 7, commit: 'abc' })])).toContain('repo="acme/garden"')
    expect(upstreamRepin()).toContain('loop "await-upstream" timeout="30d"')
    expect(upstreamRepinKdl).toContain('report-to="agent/example/owner"')
  })
  it('preserves native mission-level assignment without injecting it into steps', () => {
    const imported = { ...owner, hold: { reason: 'Synthetic undeployed seat.' } }
    const declaration = mission({
      id: 'default-worker',
      state: 'ready',
      reportTo: owner,
      assignedTo: imported,
      goal: ['Delegate the graph.'],
      steps: [{ id: 'work' }, { id: 'checkpoint', agentless: true }],
    })
    expect(declaration.children?.filter((value) => value.name === 'assigned-to')).toEqual([
      node({ name: 'assigned-to', args: ['agent/example/owner'] }),
    ])
    expect(
      declaration.children
        ?.filter((value) => value.name === 'step')
        .every((value) => value.children?.every((nested) => nested.name !== 'assigned-to')),
    ).toBe(true)
    expect(emit([declaration])).not.toContain('Synthetic undeployed')
  })

  it('accepts hyphenated resource input names in subject gates', () => {
    const pr = input.resource({ name: 'pull-request', kind: 'vcs.pull-request' })
    const review = step({
      id: 'review',
      gates: [gate.fieldIs({ name: 'open', subject: pr, path: 'state', value: 'open' })],
    })
    const kdl = emit([
      mission({
        id: 'review-pr',
        state: 'ready',
        reportTo: owner,
        goal: ['Review the PR.'],
        inputs: [pr],
        steps: [review],
      }),
    ])
    expect(kdl).toContain('input "pull-request" kind="resource"')
    expect(kdl).toContain('field "state" "${input.pull-request}" "is" "open"')
  })
  it('preserves named product types and lowers field constraints to graph products', () => {
    const work = step({
      id: 'work',
      produces: {
        report: product.resource({ kind: 'custom.garden.report', fields: { state: 'published' } }),
        receipt: product.field({ subject: 'message/receipt', fields: { text: 'ready' } }),
      },
    })
    expectTypeOf<keyof typeof work.products>().toEqualTypeOf<'report' | 'receipt'>()
    expectTypeOf<{
      name: string
      subject: typeof work.products.report
      path: 'staet'
      value: string
    }>().not.toExtend<FieldIsInput<typeof work.products.report.fields>>()
    expect(emit([work])).toContain('resource "mission-run/${ST_MISSION_RUN}/work/report"')
    expect(
      emit([
        gate.render(
          gate.fieldIs({
            name: 'ready',
            subject: work.products.report,
            path: 'state',
            value: 'published',
          }),
        ),
      ]),
    ).toContain(
      'field "state" "resource/mission-run/${ST_MISSION_RUN}/work/report" "is" "published"',
    )
    expect(() => step({ id: 'empty', produces: {} })).toThrow()
    expect(() =>
      step({
        id: 'duplicate',
        produces: {
          a: product.resource({
            kind: 'custom.garden.report',
            subject: 'resource/report',
            fields: {},
          }),
          b: product.resource({
            kind: 'custom.garden.report',
            subject: 'resource/report',
            fields: {},
          }),
        },
      }),
    ).toThrow()
    expect(() =>
      step({ id: 'missing-kind', produces: { a: { fields: {}, subject: 'resource/a' } } } as never),
    ).toThrow()
  })
  it('rejects aliasing one product handle under multiple output names', () => {
    const report = product.resource({ kind: 'custom.garden.report', fields: { state: 'ready' } })
    expect(() => step({ id: 'work', produces: { a: report, b: report } })).toThrow(
      'multiple produces keys',
    )
    const work = step({ id: 'work', produces: { report } })
    expect(
      emit([
        gate.render(
          gate.fieldIs({
            name: 'ready',
            subject: work.products.report,
            path: 'state',
            value: 'ready',
          }),
        ),
      ]),
    ).toContain('/work/report')
  })
  it('validates typed references in plain steps and every loop gate placement', () => {
    const pr = input.resource({ name: 'pr', kind: 'vcs.pull-request' })
    const foreign = step({
      id: 'foreign',
      produces: {
        report: product.resource({ kind: 'custom.garden.report', fields: { state: 'ready' } }),
      },
    })
    for (const [fieldGate, error] of [
      [gate.fieldIs({ name: 'ready', subject: pr, path: 'state', value: 'ready' }), 'not declared'],
      [
        gate.fieldIs({
          name: 'ready',
          subject: foreign.products.report,
          path: 'state',
          value: 'ready',
        }),
        'outside this mission',
      ],
    ] as const) {
      const gates = [fieldGate]
      const raw = { id: 'work', gates }
      expect(() =>
        mission({ id: 'raw', state: 'ready', reportTo: owner, goal: ['Review.'], steps: [raw] }),
      ).toThrow(error)
      expect(() =>
        mission({
          id: 'raw',
          state: 'ready',
          reportTo: owner,
          goal: ['Review.'],
          steps: [],
          finally: [raw],
        }),
      ).toThrow(error)
      for (const placement of ['until', 'steps', 'finally'] as const) {
        const round = {
          completion: { when: 'all-steps-exhausted' as const },
          steps: placement === 'steps' ? [raw] : [],
          ...(placement === 'finally' ? { finally: [raw] as [typeof raw] } : {}),
        }
        const loopInput = {
          id: 'rounds',
          maxRounds: 2,
          round,
          ...(placement === 'until' ? { until: gates as [(typeof gates)[number]] } : {}),
        }
        expect(() =>
          mission({
            id: 'raw',
            state: 'ready',
            reportTo: owner,
            goal: ['Review.'],
            steps: [loopInput],
          }),
        ).toThrow(error)
        expect(() => loop(loopInput)).toThrow('require mission assembly')
      }
    }
    const open = gate.fieldIs({ name: 'open', subject: pr, path: 'state', value: 'open' })
    expect(
      emit([
        mission({
          id: 'raw-valid',
          state: 'ready',
          reportTo: owner,
          goal: ['Review.'],
          inputs: [pr],
          steps: [
            { id: 'work', gates: [open] },
            {
              id: 'rounds',
              maxRounds: 2,
              until: [open],
              round: {
                completion: { when: 'all-steps-exhausted' },
                steps: [{ id: 'work', gates: [open] }],
                finally: [{ id: 'cleanup', gates: [open] }],
              },
            },
          ],
        }),
      ]),
    ).toContain('${input.pr}')
  })
  it('rejects undeclared input identity, duplicate input names and foreign product handles', () => {
    const pr = input.resource({ name: 'pr', kind: 'vcs.pull-request' })
    const otherPr = input.resource({ name: 'pr', kind: 'vcs.pull-request' })
    const review = step({
      id: 'review',
      gates: [gate.fieldIs({ name: 'open', subject: pr, path: 'state', value: 'open' })],
    })
    expect(() =>
      mission({
        id: 'inputs',
        state: 'ready',
        reportTo: owner,
        goal: ['Review.'],
        inputs: [otherPr],
        steps: [review],
      }),
    ).toThrow('not declared')
    expect(() =>
      mission({
        id: 'inputs',
        state: 'ready',
        reportTo: owner,
        goal: ['Review.'],
        inputs: [pr, otherPr],
        steps: [review],
      }),
    ).toThrow()
    const foreign = step({
      id: 'foreign',
      produces: {
        report: product.resource({ kind: 'custom.garden.report', fields: { state: 'ready' } }),
      },
    })
    expect(() =>
      mission({
        id: 'inputs',
        state: 'ready',
        reportTo: owner,
        goal: ['Review.'],
        steps: [],
        gates: [
          gate.fieldIs({
            name: 'foreign',
            subject: foreign.products.report,
            path: 'state',
            value: 'ready',
          }),
        ],
      }),
    ).toThrow('outside this mission')
    const text = input.text('note')
    expect(
      emit([
        mission({
          id: 'text',
          state: 'ready',
          reportTo: owner,
          goal: ['Check the note.'],
          inputs: [text],
          steps: [],
          gates: [
            gate.exec({
              name: 'note',
              command: 'test -n "$NOTE"',
              host: 'local',
              workspace: '${ST_WORKSPACE}',
              env: { NOTE: text },
            }),
          ],
        }),
      ]),
    ).toContain('NOTE "${input.note}"')
  })
  it('renders native human reviewer requests and rejects ambiguous review targets', () => {
    expect(
      emit([
        gate.render(
          gate.human({
            name: 'approve',
            reviewer: person('person/reviewer'),
            mode: 'feedback',
            question: 'Is this ready?',
            review: [Review.subject('resource/garden'), Review.subject('doc/report')],
          }),
        ),
      ]),
    ).toBe(
      'version 2\ngate "approve" mode="feedback" type="human" {\n  reviewer "person/reviewer"\n  question "Is this ready?"\n  review "resource/garden"\n  review "doc/report"\n}\n',
    )
    expect(() =>
      gate.render(gate.human({ name: 'bad', reviewer: { id: 'team/worker' } } as never)),
    ).toThrow()
    expect(() =>
      gate.render(
        gate.human({
          name: 'bad',
          reviewer: person('person/reviewer'),
          review: [Review.subject('resource/a'), Review.subject('resource/a')],
        }),
      ),
    ).toThrow()
    expect(() =>
      gate.render({
        name: 'bad',
        kind: 'human',
        reviewer: person('person/reviewer'),
        mode: 'unknown',
      } as never),
    ).toThrow()
  })
  it('restricts feedback review to worker step gates', () => {
    const feedback = gate.human({
      name: 'review',
      reviewer: person('person/reviewer'),
      mode: 'feedback',
    })
    expect(() =>
      mission({
        id: 'feedback',
        state: 'ready',
        reportTo: owner,
        goal: ['Review.'],
        gates: [feedback],
        steps: [],
      }),
    ).toThrow('feedback-gate-needs-step')
    expect(() =>
      loop({
        id: 'review',
        maxRounds: 2,
        until: [feedback],
        round: { completion: { when: 'all-steps-exhausted' }, steps: [] },
      }),
    ).toThrow('feedback-gate-needs-step')
    expect(() => step({ id: 'review', agentless: true, gates: [feedback] })).toThrow(
      'feedback human gates require a worker step',
    )
    expect(() =>
      mission({
        id: 'feedback',
        state: 'ready',
        reportTo: owner,
        goal: ['Review.'],
        steps: [{ id: 'review', agentless: true, gates: [feedback] }],
      }),
    ).toThrow('feedback human gates require a worker step')
    const worker = step({
      id: 'review',
      assignedTo: { id: 'team/worker' },
      gates: [feedback],
    })
    expect(
      emit([
        mission({
          id: 'feedback',
          state: 'ready',
          reportTo: owner,
          goal: ['Review.'],
          steps: [worker],
        }),
      ]),
    ).toContain('gate "review" mode="feedback" type="human"')
  })
  it('lowers handle dependencies and resolved agents to the plain mission grammar', () => {
    const first = step({
      id: 'first',
      missionId: 'handles',
      assignedTo: { id: 'team/worker' },
    })
    const second = step({
      id: 'second',
      missionId: 'handles',
      dependsOn: [completed(first), failed(first), terminal(first)],
    })
    expect(
      emit([
        mission({
          id: 'handles',
          state: 'ready',
          reportTo: owner,
          goal: ['Land work.'],
          steps: [first, second],
        }),
      ]),
    ).toBe(
      emit([
        mission({
          id: 'handles',
          state: 'ready',
          reportTo: owner,
          goal: ['Land work.'],
          steps: [
            { id: 'first', assignedTo: { id: 'team/worker' } },
            {
              id: 'second',
              dependsOn: [
                { step: 'first', state: 'completed' },
                { step: 'first', state: 'failed' },
                { step: 'first', state: 'terminal' },
              ],
            },
          ],
        }),
      ]),
    )
    expectTypeOf<StepHandle<'handles'>>().not.toExtend<StepHandle<'other'>>()
    expectTypeOf<{ id: 'empty'; dependsOn: readonly [] }>().not.toExtend<
      Parameters<typeof step>[0]
    >()
    expectTypeOf<typeof first>().not.toExtend<
      Parameters<typeof mission<'other'>>[0]['steps'][number]
    >()
    expectTypeOf<StepDependency<'handles'>>().not.toExtend<
      Extract<
        NonNullable<Parameters<typeof step<'other'>>[0]['dependsOn']>,
        readonly unknown[]
      >[number]
    >()
  })
  it('rejects foreign handles even when a local step has the same explicit ID', () => {
    const foreign = step({ id: 'review' })
    const local = step({ id: 'review' })
    const land = step({ id: 'land', dependsOn: [completed(foreign)] })
    expect(() =>
      mission({
        id: 'landing',
        state: 'ready',
        reportTo: owner,
        goal: ['Land.'],
        steps: [local, land],
      }),
    ).toThrow('same mission phase')
    mission({ id: 'other', state: 'ready', reportTo: owner, goal: ['Review.'], steps: [foreign] })
    expect(() =>
      mission({
        id: 'landing',
        state: 'ready',
        reportTo: owner,
        goal: ['Land.'],
        steps: [foreign, land],
      }),
    ).toThrow('already belongs')
    const scoped = step({ id: 'review', missionId: 'other' })
    expect(() =>
      mission({
        id: 'landing',
        state: 'ready',
        reportTo: owner,
        goal: ['Land.'],
        steps: [scoped],
      } as never),
    ).toThrow('belongs to mission')
    expect(() =>
      step({ id: 'review', assignedTo: { kind: 'mission', id: 'work' } } as never),
    ).toThrow()
    expect(() =>
      step({ id: 'review', assignedTo: { kind: 'agent', id: 'work' } } as never),
    ).toThrow()
    expect(() =>
      step({ id: 'review', assignedTo: { kind: 'agent', url: 'file:///tree/agent.ts' } } as never),
    ).toThrow()
  })
  it.each([0, 101, 1.5])('rejects invalid retry attempts %s', (attempts) => {
    expect(() => step({ id: 'a', retry: { attempts } })).toThrow()
  })
  it.each([1e19, -1e19, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe integral field values %s',
    (value) => {
      expect(() =>
        gate.render({
          name: 'number',
          kind: 'field',
          path: 'count',
          subject: 'resource/result',
          operator: 'is',
          value,
        }),
      ).toThrow()
    },
  )
  it.each([0, 101, 1.5])('rejects invalid loop bounds %s', (maxRounds) => {
    expect(() =>
      loop({
        id: 'wait',
        maxRounds,
        round: { completion: { when: 'all-steps-exhausted' }, steps: [] },
      }),
    ).toThrow()
  })
  it('rejects conflicting completion and final completion frontiers', () => {
    expect(() =>
      completion({
        when: 'all-steps-exhausted',
        dependsOn: [{ step: 'a', state: 'completed' }],
      } as never),
    ).toThrow()
    expect(() =>
      mission({
        id: 'a',
        state: 'ready',
        reportTo: owner,
        goal: ['a'],
        steps: [],
        finally: [{ id: 'cleanup', agentless: true }],
        completion: { dependsOn: [{ step: 'cleanup', state: 'terminal' }] },
      }),
    ).toThrow()
    expect(() =>
      mission({
        id: 'a',
        state: 'ready',
        reportTo: owner,
        goal: ['a'],
        steps: [{ id: 'work' }],
        finally: [{ id: 'cleanup', dependsOn: [{ step: 'work', state: 'completed' }] }],
      }),
    ).toThrow()
    expect(() => loop({ id: 'wait', maxRounds: 2, round: { steps: [] } } as never)).toThrow()
    expect(() =>
      loop({
        id: 'wait',
        maxRounds: 2,
        round: { completion: { when: 'all-steps-exhausted' }, steps: [] },
        onExhausted: {
          outcome: 'succeed',
          attention: { title: 'wrong phase', reviewer: person('person/a'), severity: 'warning' },
        },
      } as never),
    ).toThrow()
    expect(() =>
      gate.render({
        name: 'env',
        kind: 'exec',
        command: 'true',
        host: 'local',
        workspace: '/tmp',
        env: { 'bad-key': 'x' },
      }),
    ).toThrow()
  })
  it.each(['ST_WORKSPACE', 'ST_MISSION', 'ST_GATE', 'ST_LOOP_ROUND', 'ST3_SUBJECT'])(
    'rejects reserved exec-gate context key %s',
    (key) => {
      expect(() =>
        gate.render({
          name: 'env',
          kind: 'exec',
          command: 'true',
          host: 'local',
          workspace: '/tmp',
          env: { [key]: 'x' },
        }),
      ).toThrow()
    },
  )
  it.each(['doc/guide', 'doc/guide@abc', `doc/../guide@${'a'.repeat(64)}`])(
    'rejects unpinned or malformed step document %s',
    (reference) => {
      expect(() => step({ id: 'read', documents: [reference] })).toThrow()
    },
  )
  it('rejects invalid document hashes and observer/subscription field selections', () => {
    expect(() => document({ id: 'guide', hash: 'abc' })).toThrow()
    expect(() =>
      gate.render({ name: 'guide', kind: 'document', subject: 'resource/guide' }),
    ).toThrow()
    expect(() =>
      observer({
        id: 'ref',
        resource: 'resource/ref',
        provider: 'github.ref',
        locator: 'acme/garden@main',
        fields: [],
      } as never),
    ).toThrow()
    expect(() =>
      observer({
        id: 'ref',
        resource: 'resource/ref',
        provider: 'github.ref',
        locator: 'acme/garden@main',
        fields: ['head', 'head'],
      }),
    ).toThrow()
    expect(() =>
      subscription({
        id: 'changed',
        observer: 'resource/ref',
        to: 'agent/worker',
        on: ['head'],
        delivery: 'message',
      }),
    ).toThrow()
    expect(() =>
      subscription({
        id: 'changed',
        observer: 'observer/ref',
        to: 'agent/worker',
        on: [],
        delivery: 'message',
      } as never),
    ).toThrow()
  })
  it.each(['acme/garden', '/garden@main', 'acme/@main', 'acme/garden@', 'acme/extra/garden@main'])(
    'rejects malformed github.ref locator %s',
    (locator) => {
      expect(() =>
        observer({
          id: 'ref',
          resource: 'resource/ref',
          provider: 'github.ref',
          locator,
          fields: ['head'],
        }),
      ).toThrow()
    },
  )
  it.each(['state', 'checks', ''])('rejects unsupported github.ref field %s', (field) => {
    expect(() =>
      observer({
        id: 'ref',
        resource: 'resource/ref',
        provider: 'github.ref',
        locator: 'acme/garden@main',
        fields: [field],
      } as never),
    ).toThrow()
  })
  it.each(['ST_WORKSPACE', 'ST_MISSION', 'ST_GATE', 'ST_LOOP_ROUND', 'ST3_SUBJECT'])(
    'rejects reserved exec-gate context key %s',
    (key) => {
      expect(() =>
        gate.render({
          name: 'env',
          kind: 'exec',
          command: 'true',
          host: 'local',
          workspace: '/tmp',
          env: { [key]: 'x' },
        }),
      ).toThrow()
    },
  )
  it('rejects excessive goals, duplicate gates and missing dependencies', () => {
    expect(() => step({ id: 'a', goal: ['a', 'b', 'c', 'd'] })).toThrow()
    expect(() =>
      step({
        id: 'a',
        gates: [
          { name: 'same', kind: 'exists', subject: 'resource/a' },
          { name: 'same', kind: 'exists', subject: 'resource/b' },
        ],
      }),
    ).toThrow()
    expect(() =>
      mission({
        id: 'a',
        state: 'ready',
        reportTo: owner,
        goal: ['a'],
        steps: [{ id: 'a', dependsOn: [{ step: 'missing', state: 'terminal' }] }],
      }),
    ).toThrow()
  })
  it('lowers predicates and built-ins without conflating them', () => {
    expect(
      gate.render({
        name: 'prefix',
        kind: 'field',
        path: 'facts.head',
        subject: 'resource/ref',
        operator: 'starts-with',
        value: 'abc',
      }).children,
    ).toEqual([node({ name: 'field', args: ['facts.head', 'resource/ref', 'starts-with', 'abc'] })])
    expect(
      gate.render({
        name: 'ci',
        kind: 'ci-passed',
        check: 'build',
        repo: 'acme/garden',
        ref: { commit: 'abc' },
      }).children,
    ).toEqual([
      node({ name: 'ci-passed', args: ['build'], props: { repo: 'acme/garden', commit: 'abc' } }),
    ])
    expect(() =>
      gate.render({
        name: 'ci',
        kind: 'ci-passed',
        check: 'build',
        repo: 'acme/garden',
        ref: { commit: 'abc', branch: 'main' },
      } as never),
    ).toThrow()
  })
})
const stBin = process.env.ST_BIN
const testWithSt = stBin !== undefined && stBin !== '' ? it : it.skip

// Explicitly opt in to upstream's separate test-support executable, never a production fallback.
// It exercises gate semantics with synthetic person attribution, not production authentication.
const stFixtureBin = process.env.ST_FIXTURE_BIN
const testWithStFixture = stFixtureBin !== undefined && stFixtureBin !== '' ? it : it.skip

// This person exists only in each private scratch daemon's config, never in a live fleet.
const gateReviewer = 'person/genie-human-gate-test'

type IsolatedSt = {
  dir: string
  socket: string
  isolatedEnv: NodeJS.ProcessEnv
  command: (...args: string[]) => SpawnSyncReturns<string>
  runCommand: (args: ReadonlyArray<string>) => Promise<ScratchCommandResult>
  get: <T>(path: string) => Promise<T>
}

/**
 * Polls real daemon projections until a condition is observed. The isolated daemon has no
 * deterministic clock seam; the elapsed time never stands in for the asserted condition.
 */
const pollSt = async <T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  description: string,
  timeoutMs = 20000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  let last: T
  do {
    last = await read()
    if (ready(last) === true) return last
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 100)
    await promise
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}; last observation: ${JSON.stringify(last)}`)
}

const withIsolatedSt = async (
  { kind, signal }: { kind: 'production' | 'fixture'; signal: AbortSignal },
  run: (st: IsolatedSt) => Promise<void>,
) => {
  const binary = kind === 'fixture' ? stFixtureBin : stBin
  if (binary === undefined || binary === '')
    throw new Error(
      `${kind === 'fixture' ? 'ST_FIXTURE_BIN' : 'ST_BIN'} is required for ${kind} mode`,
    )
  return Effect.runPromise(
    Effect.gen(function* () {
      const daemon = yield* ScratchDaemon
      const runPromise = Effect.runPromiseWith(yield* Effect.context())
      const dir = daemon.directory
      const socket = daemon.socket
      const isolatedEnv = daemon.env
      yield* Effect.promise(async (scopeSignal) => {
        const get = <T>(path: string): Promise<T> => {
          scopeSignal.throwIfAborted()
          const { promise, resolve, reject } = Promise.withResolvers<T>()
          const req = request(
            { socketPath: socket, path, method: 'GET', signal: scopeSignal },
            (response) => {
              let body = ''
              response.setEncoding('utf8')
              response.on('data', (chunk: string) => {
                body += chunk
              })
              response.on('error', reject)
              response.on('end', () => {
                if (response.statusCode !== 200)
                  reject(new Error(`${path} returned ${response.statusCode}: ${body}`))
                else resolve(JSON.parse(body) as T)
              })
            },
          )
          req.on('error', reject)
          req.setTimeout(5000, () => req.destroy(new Error(`Timed out reading ${path}`)))
          req.end()
          return promise
        }
        await run({
          dir,
          socket,
          isolatedEnv,
          get,
          runCommand: (args) => runPromise(daemon.run(args), { signal: scopeSignal }),
          command: (...args) => {
            scopeSignal.throwIfAborted()
            return spawnSync(daemon.binary, ['--endpoint', daemon.endpoint, '--json', ...args], {
              encoding: 'utf8',
              timeout: 30000,
              env: isolatedEnv,
            })
          },
        })
      })
    }).pipe(
      Effect.provide(
        scratchDaemonLayer({
          binary,
          node: 'genie-test',
          person: gateReviewer,
          // Native conformance explicitly exercises host shell commands.
          ...(process.env.PATH === undefined ? {} : { path: process.env.PATH }),
        }),
      ),
      Effect.scoped,
    ),
    { signal },
  )
}

const stJson = <T>(st: IsolatedSt, ...args: string[]): T => {
  const result = st.command(...args)
  expect(
    result.status,
    `${args.join(' ')}: ${result.error ?? ''}\n${result.stderr}\n${result.stdout}`,
  ).toBe(0)
  return JSON.parse(result.stdout) as T
}

testWithSt(
  'admits canonical task launches through native grammar and rejects invalid native options',
  async ({ signal }) =>
    withIsolatedSt({ kind: 'production', signal }, async ({ dir, command }) => {
      const taskLaunch = Launch.argv({
        argv: ['true'],
        cwd: dir,
        env: { KEEP: 'yes' },
        unset: ['REMOVE_ONE', 'REMOVE_TWO'],
      })
      const agentSource = join(dir, 'launch-agent.kdl')
      const apply = (text: string) => {
        writeFileSync(agentSource, text)
        return command('agents', 'apply', agentSource, '--as', gateReviewer)
      }
      const validAgent = emit([
        agent({
          id: 'grammar/tasks',
          workspace: dir,
          exec: [{ id: 'check', launch: taskLaunch }],
          pty: [{ id: 'terminal', launch: taskLaunch }],
        }),
      ])
      const admitted = apply(validAgent)
      expect(admitted.status, admitted.stderr).toBe(0)
      const repeatedUnset = apply(
        validAgent.replaceAll(
          'unset "REMOVE_ONE" "REMOVE_TWO"',
          'unset "REMOVE_ONE"; unset "REMOVE_TWO"',
        ),
      )
      expect(repeatedUnset.status).not.toBe(0)
      for (const option of [`cwd ${JSON.stringify(dir)}`, 'unset "REMOVE_ONE" "REMOVE_TWO"']) {
        const invalidRoot = apply(
          `version 2\nagent "grammar/root" { command "true"; ${option}; }\n`,
        )
        expect(invalidRoot.status).not.toBe(0)
      }
      const missionSource = join(dir, 'launch-mission.kdl')
      writeFileSync(
        missionSource,
        emit([
          mission({
            id: 'grammar/launch',
            state: 'ready',
            reportTo: { id: 'grammar/tasks' },
            reportCompleted: false,
            goal: 'Validate native task launch grammar without running work.',
            steps: [
              {
                id: 'check',
                agentless: true,
                exec: {
                  id: 'check',
                  host: 'local',
                  workspace: dir,
                  restart: 'never',
                  launch: taskLaunch,
                },
              },
            ],
          }),
        ]),
      )
      const published = command(
        'missions',
        'publish',
        missionSource,
        '--no-gate-check',
        '--as',
        gateReviewer,
      )
      expect(published.status, published.stderr).toBe(0)
    }),
  30000,
)

testWithSt(
  'plans native OMP role launch without a thinking override',
  async ({ signal }) =>
    withIsolatedSt({ kind: 'production', signal }, async ({ dir, command, get }) => {
      const source = join(dir, 'role.kdl')
      writeFileSync(
        source,
        emit([
          agent({
            id: 'garden/role',
            workspace: dir,
            rollout: 'manual',
            harness: omp({ model: '@generalist_root' }),
          }),
        ]),
      )
      const applied = command('agents', 'apply', source, '--as', gateReviewer)
      expect(applied.status, applied.stderr).toBe(0)
      const desired = await get<{
        member: { launch: { type: string; value: Array<string> } }
      }>('/v1/desired/agent/garden/role')
      const launch = desired.member.launch
      expect(launch.type).toBe('argv')
      expect(launch.value.slice(launch.value.indexOf('--') + 1)).toEqual([
        'omp',
        '--model',
        '@generalist_root',
      ])
      expect(launch.value).not.toContain('--thinking')
    }),
  30000,
)

testWithSt(
  'round-trips canonical mission and strict agent fields through isolated st daemon',
  async ({ signal }) =>
    withIsolatedSt(
      { kind: 'production', signal },
      async ({ dir, socket, isolatedEnv, runCommand }) => {
        const source = join(dir, 'mission.kdl')
        const actor = process.env.ST_AGENT ?? gateReviewer
        writeFileSync(source, canonical())
        const publish = () =>
          spawnSync(
            stBin!,
            [
              '--endpoint',
              `unix://${socket}`,
              '--json',
              'missions',
              'publish',
              source,
              '--no-gate-check',
              '--as',
              actor,
            ],
            { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
          )
        const first = publish()
        expect(first.status, first.stderr).toBe(0)
        const second = await runCommand([
          '--json',
          'missions',
          'publish',
          source,
          '--no-gate-check',
          '--as',
          actor,
        ])
        expect(second.status, second.stderr).toBe(0)
        expect(JSON.parse(second.stdout)).toMatchObject({ changed: false })
        const seatSource = join(dir, 'agent.kdl')
        const launch = {
          id: 'garden/orchard',
          workspace: dir,
          launch: Launch.shell({ command: 'true' }),
        }
        const seat = emit([agent({ ...launch, rollout: 'manual', handlesFaults: true })])
        const applySeat = (declaration: string) => {
          writeFileSync(seatSource, declaration)
          return spawnSync(
            stBin!,
            [
              '--endpoint',
              `unix://${socket}`,
              '--json',
              'agents',
              'apply',
              seatSource,
              '--as',
              actor,
            ],
            { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
          )
        }
        const applied = applySeat(seat)
        expect(applied.status, applied.stderr).toBe(0)
        const shown = await runCommand(['subject', 'show', 'agent/garden/orchard', '--kdl'])
        expect(shown.status, shown.stderr).toBe(0)
        expect(shown.stdout).toMatch(/^\s*handles-faults\s*$/mu)
        const reapplied = applySeat(shown.stdout)
        expect(reapplied.status, reapplied.stderr).toBe(0)
        expect(JSON.parse(reapplied.stdout)).toMatchObject({ changed: false })
        const xhigh = applySeat(
          emit([
            agent({
              id: 'garden/xhigh',
              workspace: dir,
              rollout: 'manual',
              harness: omp({ model: 'example-model', effort: 'xhigh' }),
            }),
          ]),
        )
        expect(xhigh.status, xhigh.stderr).toBe(0)
        const xhighShown = spawnSync(
          stBin!,
          ['--endpoint', `unix://${socket}`, 'subject', 'show', 'agent/garden/xhigh', '--kdl'],
          { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
        )
        expect(xhighShown.status, xhighShown.stderr).toBe(0)
        expect(xhighShown.stdout).toContain('harness "omp"')
        expect(xhighShown.stdout).toMatch(/^\s*effort "xhigh"\s*$/mu)
        const xhighReapplied = applySeat(xhighShown.stdout)
        expect(xhighReapplied.status, xhighReapplied.stderr).toBe(0)
        expect(JSON.parse(xhighReapplied.stdout)).toMatchObject({ changed: false })
        for (const field of [
          'rollout "automatic"',
          'rollout 1',
          'rollout "manual"; rollout "manual"',
          'rollout "manual" { ignored; }',
          'rollout "manual" ignored="value"',
        ]) {
          const invalid = applySeat(seat.replace('rollout "manual"', field))
          expect(invalid.status, field).not.toBe(0)
        }
        for (const field of [
          'handles-faults #true',
          'handles-faults ignored="value"',
          'handles-faults; handles-faults',
        ]) {
          const invalid = applySeat(seat.replace('handles-faults', field))
          expect(invalid.status, field).not.toBe(0)
        }
        const automatic = applySeat(emit([agent(launch)]))
        expect(automatic.status, automatic.stderr).toBe(0)
        expect(JSON.parse(automatic.stdout)).toMatchObject({ changed: true })
        const automaticShown = await runCommand([
          'subject',
          'show',
          'agent/garden/orchard',
          '--kdl',
        ])
        expect(automaticShown.status, automaticShown.stderr).toBe(0)
        expect(automaticShown.stdout).not.toContain('rollout')
        expect(automaticShown.stdout).not.toContain('handles-faults')
        const fixtureSeats = applySeat(
          emit([
            agent({
              id: 'example/owner',
              workspace: dir,
              launch: Launch.shell({ command: 'true' }),
              rollout: 'manual',
            }),
            agent({
              id: 'example/updater',
              workspace: dir,
              launch: Launch.shell({ command: 'true' }),
              rollout: 'manual',
            }),
            agent({
              id: 'team/worker',
              workspace: dir,
              launch: Launch.shell({ command: 'true' }),
              rollout: 'manual',
            }),
            agent({
              id: reporter.id,
              workspace: dir,
              launch: Launch.shell({ command: 'true' }),
              rollout: 'manual',
            }),
          ]),
        )
        expect(fixtureSeats.status, fixtureSeats.stderr).toBe(0)
        const documentFile = join(dir, 'guide.txt')
        writeFileSync(documentFile, guideText)
        const storedGuide = spawnSync(
          stBin!,
          [
            '--endpoint',
            `unix://${socket}`,
            'documents',
            'put',
            documentFile,
            '--as',
            'doc/example/guide',
          ],
          { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
        )
        expect(storedGuide.status, storedGuide.stderr).toBe(0)
        writeFileSync(source, grammarCanonical())
        const grammarPublished = publish()
        expect(grammarPublished.status, grammarPublished.stderr).toBe(0)
        const grammarRepeated = publish()
        expect(grammarRepeated.status, grammarRepeated.stderr).toBe(0)
        expect(JSON.parse(grammarRepeated.stdout)).toMatchObject({ changed: false })
        // Compare independent native KDL and the typed fixture by normalized revision.
        writeFileSync(source, upstreamRepinKdl)
        const originalFixture = publish()
        expect(originalFixture.status, originalFixture.stderr).toBe(0)
        writeFileSync(source, upstreamRepin())
        const typedFixture = publish()
        expect(typedFixture.status, typedFixture.stderr).toBe(0)
        expect(JSON.parse(typedFixture.stdout)).toMatchObject({ changed: false })
        const childProducer = step({
          id: 'publish-child',
          produces: childMission`example/child/${runId}`,
        })
        const childConsumer = step({
          id: 'run-child',
          agentless: true,
          dependsOn: [childProducer],
          waitFor: childProducer,
        })
        writeFileSync(
          source,
          emit([
            mission({
              id: 'child-output-proof',
              state: 'ready',
              reportTo: reporter,
              assignedTo: reporter,
              goal: ['Publish and use one attempt-bound child revision.'],
              steps: [childProducer, childConsumer],
            }),
          ]),
        )
        const childPublished = publish()
        expect(childPublished.status, childPublished.stderr).toBe(0)
        const childRepeated = publish()
        expect(childRepeated.status, childRepeated.stderr).toBe(0)
        expect(JSON.parse(childRepeated.stdout)).toMatchObject({ changed: false })
        writeFileSync(source, emit([prLanding()]))
        const inputPublished = publish()
        expect(inputPublished.status, inputPublished.stderr).toBe(0)
        const observePr = (state: string) =>
          spawnSync(
            stBin!,
            [
              '--endpoint',
              `unix://${socket}`,
              '--json',
              'claim',
              'resource/acme/garden/pr-7',
              'resource.observed',
              '--field',
              'kind=vcs.pull-request',
              '--field',
              `state=${state}`,
              '--field',
              'number=7',
            ],
            { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
          )
        const observedPr = observePr('open')
        expect(observedPr.status, observedPr.stderr).toBe(0)
        const claimId = JSON.parse(observedPr.stdout).id
        const startLanding = (values: readonly string[], id = 'input-proof') =>
          spawnSync(
            stBin!,
            [
              '--endpoint',
              `unix://${socket}`,
              '--json',
              'missions',
              'start',
              'pr-landing',
              '--id',
              id,
              '--workspace',
              dir,
              '--as',
              actor,
              ...values.flatMap((value) => ['--input', value]),
            ],
            { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
          )
        const values = [
          'pr=resource/acme/garden/pr-7',
          `commit=${'a'.repeat(40)}`,
          'locator=acme/garden#7',
        ]
        expect(startLanding([values[0]!]).status).not.toBe(0)
        expect(startLanding([...values, 'surprise=wrong']).status).not.toBe(0)
        const startedLanding = startLanding(values)
        expect(startedLanding.status, startedLanding.stderr).toBe(0)
        const StartedMission = Schema.Struct({
          mission_run: Schema.Struct({ subject: Schema.String }),
        })
        const inputRun = Schema.decodeUnknownSync(StartedMission)(JSON.parse(startedLanding.stdout))
        const pinnedPr = {
          kind: 'resource',
          subject: 'resource/acme/garden/pr-7',
          value: `resource/acme/garden/pr-7@${claimId}`,
          claim_id: claimId,
        }
        expect(JSON.parse(startedLanding.stdout)).toMatchObject({
          mission_run: {
            inputs: {
              pr: pinnedPr,
              commit: { kind: 'text', value: 'a'.repeat(40) },
              locator: { kind: 'text', value: 'acme/garden#7' },
            },
          },
        })
        const capacityRejected = startLanding(values, 'input-proof-second')
        expect(capacityRejected.status).not.toBe(0)
        expect(capacityRejected.stderr).toContain('reached its active run limit')
        const laterObservation = observePr('closed')
        expect(laterObservation.status, laterObservation.stderr).toBe(0)
        const inputShown = spawnSync(
          stBin!,
          [
            '--endpoint',
            `unix://${socket}`,
            '--json',
            'subject',
            'show',
            inputRun.mission_run.subject,
          ],
          { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
        )
        expect(inputShown.status, inputShown.stderr).toBe(0)
        expect(JSON.parse(inputShown.stdout)).toMatchObject({
          status: { subjects: [{ actual: { inputs: { pr: pinnedPr } } }] },
        })
        writeFileSync(
          source,
          emit([
            mission({
              id: 'watch-proof',
              state: 'ready',
              reportTo: reporter,
              goal: ['Keep the ref watch owned by this run.'],
              resources: [{ id: 'ref', kind: 'vcs.ref' }],
              observers: [
                {
                  id: 'watch',
                  resource: 'resource/ref',
                  provider: 'github.ref',
                  locator: 'acme/garden@feature/proof',
                  fields: ['head', 'ancestors'],
                  every: '1h',
                },
              ],
              subscriptions: [
                {
                  id: 'changes',
                  observer: 'observer/watch',
                  to: 'agent/example/updater',
                  on: ['head'],
                  delivery: 'message',
                  when: { path: 'head', operator: 'starts-with', value: 'git:' },
                },
              ],
              steps: [
                {
                  id: 'wait',
                  agentless: true,
                  documents: [`doc/example/guide@${guideHash}`],
                  gates: [
                    { name: 'guide', kind: 'document', subject: 'doc/example/guide' },
                    {
                      name: 'pinned-guide',
                      kind: 'document',
                      subject: `doc/example/guide@${guideHash}`,
                    },
                    {
                      name: 'hold',
                      kind: 'field',
                      path: 'state',
                      subject: 'resource/ref',
                      operator: 'is',
                      value: 'waiting-for-proof',
                    },
                  ],
                },
              ],
            }),
          ]),
        )
        const watchPublished = publish()
        expect(watchPublished.status, watchPublished.stderr).toBe(0)
        const watchStarted = spawnSync(
          stBin!,
          [
            '--endpoint',
            `unix://${socket}`,
            '--json',
            'missions',
            'start',
            'watch-proof',
            '--id',
            'watch-proof',
            '--workspace',
            dir,
            '--as',
            actor,
          ],
          { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
        )
        expect(watchStarted.status, watchStarted.stderr).toBe(0)
        const watchRun = Schema.decodeUnknownSync(StartedMission)(JSON.parse(watchStarted.stdout))
        const watchRunId = watchRun.mission_run.subject.slice('mission-run/'.length)
        const observerSubject = `observer/${watchRunId}/watch`
        const subscriptionSubject = `subscription/${watchRunId}/changes`
        const OwnedProjection = Schema.Struct({
          status: Schema.Struct({
            subjects: Schema.Array(
              Schema.Struct({
                subject: Schema.String,
                desired: Schema.optionalKey(
                  Schema.NullOr(
                    Schema.Struct({
                      children: Schema.Array(
                        Schema.Struct({
                          name: Schema.String,
                          arguments: Schema.Array(Schema.String),
                        }),
                      ),
                    }),
                  ),
                ),
              }),
            ),
          }),
        })
        const showOwned = (subject: string) => {
          const result = spawnSync(
            stBin!,
            ['--endpoint', `unix://${socket}`, '--json', 'subject', 'show', subject],
            { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
          )
          expect(result.status, result.stderr).toBe(0)
          return Schema.decodeUnknownSync(OwnedProjection)(JSON.parse(result.stdout)).status
            .subjects[0]
        }
        const ownedObserver = await pollSt(
          async () => showOwned(observerSubject),
          (value) => value?.desired != null,
          'run-scoped ref observer',
        )
        expect(ownedObserver).toMatchObject({
          subject: observerSubject,
          desired: {
            children: expect.arrayContaining([
              expect.objectContaining({ name: 'provider', arguments: ['github.ref'] }),
              expect.objectContaining({
                name: 'locator',
                arguments: ['acme/garden@feature/proof'],
              }),
              expect.objectContaining({ name: 'field', arguments: ['head'] }),
              expect.objectContaining({ name: 'field', arguments: ['ancestors'] }),
            ]),
          },
        })
        const ownedSubscription = await pollSt(
          async () => showOwned(subscriptionSubject),
          (value) => value?.desired != null,
          'run-scoped ref subscription',
        )
        expect(ownedSubscription).toMatchObject({
          subject: subscriptionSubject,
          desired: {
            children: expect.arrayContaining([
              expect.objectContaining({ name: 'observer', arguments: [observerSubject] }),
            ]),
          },
        })
        const checkEnv = (env: Readonly<Record<string, string>>) => {
          writeFileSync(
            source,
            emit([
              mission({
                id: 'environment-proof',
                state: 'ready',
                reportTo: reporter,
                goal: ['Verify the actual exec-gate environment.'],
                steps: [],
                gates: [
                  gate.exec({
                    name: 'environment',
                    host: 'local',
                    workspace: dir,
                    timeLimit: '5s',
                    command: 'if test "$ANSWER" = green; then exit 0; else exit 3; fi',
                    env,
                  }),
                ],
              }),
            ]),
          )
          return spawnSync(
            stBin!,
            ['--endpoint', `unix://${socket}`, 'missions', 'check', source, '--workspace', dir],
            { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
          )
        }
        const supplied = checkEnv({ ANSWER: 'green', PATH: process.env.PATH ?? '/bin' })
        expect(supplied.status, supplied.stderr).toBe(0)
        expect(checkEnv({}).status).toBe(1)
      },
    ),
  60000,
)

// Human gate acceptance; plan and blocked edges: ../HUMAN_GATE_ACCEPTANCE.md.
type NativeStep = {
  subject: string
  step: string
  definition_hash: string
  status: string
  attempt: number
  claimant: string | null
  worker_reported: boolean
}
type NativeRun = {
  subject: string
  generation: string
  revision: string
  status: string
  steps: NativeStep[]
}
type NativeReview = {
  operation: string
  request: string
  owner: string
  mission_run: string
  generation: string
  reviewer: string
  mode: string
  question: string
  attempt: number
  decisions: string[]
}
type NativeClaim = {
  id: string
  subject: string
  kind: string
  actor: string | null
  body: { fields: Record<string, unknown>; evidence: string[] }
}
type NativeCard = {
  kind: string
  id: string
  episode: string
  attention_kind: string
  source_id: string
  person_id: string
  review_mode: string | null
  mission_run_id: string | null
  actions: string[]
}

const gateQuestion = 'Allow the isolated risky worker to become ready?'
const closedReview = /review-not-requested|is not open|no pending human review/u
const nativeStep = (run: NativeRun, id: string) => {
  const found = run.steps.find((candidate) => candidate.step === id)
  expect(found, `${run.subject} must contain step ${id}`).toBeDefined()
  return found!
}
const nativeRun = (st: IsolatedSt, subject: string) =>
  stJson<NativeRun>(st, 'missions', 'show', subject)
const nativeReviews = (st: IsolatedSt) =>
  st.get<NativeReview[]>(`/v1/reviews?reviewer=${encodeURIComponent(gateReviewer)}`)
const nativeCards = (st: IsolatedSt) => {
  const page = stJson<{ value: { items: NativeCard[]; page: { has_more: boolean } } }>(
    st,
    'alerts',
    'ls',
    '--as',
    gateReviewer,
    '--limit',
    '200',
  )
  expect(page.value.page.has_more).toBe(false)
  return page.value.items.filter((item) => item.kind === 'attention')
}
/** Every recorded answer bound to this exact native request episode. */
const nativeResults = async (st: IsolatedSt, review: NativeReview) => {
  const page = await st.get<{ claims: NativeClaim[]; next_cursor: number | null }>(
    `/v1/claims?subject=${encodeURIComponent(review.operation)}&limit=500`,
  )
  expect(page.next_cursor).toBeNull()
  return page.claims.filter(
    (claim) => claim.kind === 'gate.result' && claim.body.fields.request === review.request,
  )
}

/**
 * Publishes an agentless critical approval checkpoint before a risky worker step.
 * Every mutation names the person explicitly; this is R1 attribution, not a person credential.
 */
const publishHumanFixture = (st: IsolatedSt, id: string, checkpointTimeout?: string) => {
  const seat = (seatId: string) =>
    ({
      id: seatId,
      command: 'true',
      workspace: st.dir,
      restart: 'never',
      rollout: 'manual',
    }) as const
  const worker = seat('acceptance/worker')
  const observer = seat('acceptance/observer')
  const seats = join(st.dir, 'human-gate-agents.kdl')
  writeFileSync(seats, emit([agent(worker), agent(observer)]))
  stJson(st, 'agents', 'apply', seats, '--as', gateReviewer)
  const source = join(st.dir, `${id.replace('/', '-')}.kdl`)
  writeFileSync(
    source,
    emit([
      mission({
        id,
        state: 'ready',
        reportTo: observer,
        goal: ['Exercise native current human review episodes without performing risky work.'],
        steps: [
          {
            id: 'authorize',
            agentless: true,
            ...(checkpointTimeout === undefined ? {} : { timeout: checkpointTimeout }),
            gates: [
              {
                name: 'Operator approves readiness',
                kind: 'human',
                reviewer: person(gateReviewer),
                mode: 'approve',
                question: gateQuestion,
              },
            ],
          },
          {
            id: 'risky',
            assignedTo: worker,
            dependsOn: [{ step: 'authorize', state: 'completed' }],
            goal: ['Become ready only after the current authorization checkpoint passes.'],
          },
        ],
      }),
    ]),
  )
  stJson(st, 'missions', 'publish', source, '--as', gateReviewer)
  return () =>
    stJson<{ mission_run: NativeRun }>(
      st,
      'missions',
      'start',
      `mission/${id}`,
      '--workspace',
      st.dir,
      '--as',
      gateReviewer,
    ).mission_run
}

/** Captures the current native request, its exact binding, and its person attention card. */
const pendingHumanEpisode = async (st: IsolatedSt, started: NativeRun) => {
  const reviews = await pollSt(
    () => nativeReviews(st),
    (items) => items.some((item) => item.mission_run === started.subject),
    `human request for ${started.subject}`,
  )
  const review = reviews.find((item) => item.mission_run === started.subject)!
  const run = nativeRun(st, started.subject)
  const checkpoint = nativeStep(run, 'authorize')
  expect(review).toMatchObject({
    owner: checkpoint.subject,
    generation: run.generation,
    reviewer: gateReviewer,
    mode: 'approve',
    question: gateQuestion,
    attempt: checkpoint.attempt,
    decisions: ['approved', 'rejected'],
  })
  expect(checkpoint.status).toBe('working')
  expect(nativeStep(run, 'risky')).toMatchObject({
    status: 'pending',
    claimant: null,
    worker_reported: false,
  })
  const requested = await st.get<NativeClaim>(
    `/v1/claims/by-id/${encodeURIComponent(review.request)}`,
  )
  expect(requested).toMatchObject({
    id: review.request,
    subject: review.operation,
    kind: 'gate.requested',
    body: {
      fields: {
        owner: checkpoint.subject,
        reviewer: gateReviewer,
        mode: 'approve',
        mission_revision: run.revision,
        step_definition: checkpoint.definition_hash,
        attempt: checkpoint.attempt,
      },
    },
  })
  const cards = await pollSt(
    async () => nativeCards(st),
    (items) => items.some((item) => item.episode === review.request),
    `attention card for ${review.request}`,
  )
  const card = cards.find((item) => item.episode === review.request)!
  expect(card.id).toMatch(/^attention\//u)
  expect(card).toMatchObject({
    attention_kind: 'human-gate',
    source_id: checkpoint.subject,
    person_id: gateReviewer,
    review_mode: 'approve',
    mission_run_id: run.subject,
  })
  expect(card.actions).toEqual(expect.arrayContaining(['review.approve', 'review.reject']))
  expect(card.actions).not.toContain('review.request-changes')
  expect(stJson(st, 'alerts', 'show', card.id, '--as', gateReviewer)).toMatchObject({
    episode: review.request,
    kind: 'human-gate',
    subject: checkpoint.subject,
    person: gateReviewer,
  })
  expect(await nativeResults(st, review)).toEqual([])
  return { run, review, card }
}

const expectEpisodeClosed = async (st: IsolatedSt, review: NativeReview) => {
  await pollSt(
    () => nativeReviews(st),
    (items) => items.every((item) => item.request !== review.request),
    `closed human request ${review.request}`,
  )
  await pollSt(
    async () => nativeCards(st),
    (items) => items.every((item) => item.episode !== review.request),
    `removed attention card for ${review.request}`,
  )
}

const expectRefused = (result: SpawnSyncReturns<string>, pattern: RegExp) => {
  expect(result.status, result.stdout).not.toBe(0)
  expect(result.stderr).toMatch(pattern)
}

testWithStFixture(
  'isolated human gate: critical silence holds readiness until the named reviewer approves',
  async ({ signal }) =>
    withIsolatedSt({ kind: 'fixture', signal }, async (st) => {
      const start = publishHumanFixture(st, 'acceptance/critical')
      const { run, review, card } = await pendingHumanEpisode(st, start())
      // Re-observe the same episode; unanswered critical review stays held, never approved.
      expect(
        (await nativeReviews(st)).filter((item) => item.request === review.request),
      ).toHaveLength(1)
      expect(nativeStep(nativeRun(st, run.subject), 'risky').status).toBe('pending')
      expect(await nativeResults(st, review)).toEqual([])
      expectRefused(
        st.command('alerts', 'approve', card.id, '--as', 'person/genie-human-gate-other-test'),
        /wrong-reviewer|requires `person\/genie-human-gate-test`/u,
      )
      expect(await nativeResults(st, review)).toEqual([])
      const result = stJson<NativeClaim>(st, 'alerts', 'approve', card.id, '--as', gateReviewer)
      expect(result).toMatchObject({
        subject: review.operation,
        kind: 'gate.result',
        actor: gateReviewer,
        body: {
          fields: { request: review.request, decision: 'approved', verdict: 'pass' },
          evidence: expect.arrayContaining([review.request]),
        },
      })
      const admitted = await pollSt(
        async () => nativeRun(st, run.subject),
        (value) => nativeStep(value, 'risky').status === 'ready',
        'approved dependent worker readiness',
      )
      expect(nativeStep(admitted, 'authorize').status).toBe('completed')
      expect(nativeStep(admitted, 'risky')).toMatchObject({
        claimant: null,
        worker_reported: false,
      })
      await expectEpisodeClosed(st, review)
      expectRefused(
        st.command(
          'alerts',
          'reject',
          card.id,
          '--reason',
          'Late conflicting decision.',
          '--as',
          gateReviewer,
        ),
        closedReview,
      )
      expect((await nativeResults(st, review)).map((claim) => claim.id)).toEqual([result.id])
      expect(nativeStep(nativeRun(st, run.subject), 'risky').status).toBe('ready')
    }),
  120000,
)

testWithStFixture(
  'isolated human gate: an expired agentless checkpoint fails instead of approving',
  async ({ signal }) =>
    withIsolatedSt({ kind: 'fixture', signal }, async (st) => {
      const start = publishHumanFixture(st, 'acceptance/timeout', '2s')
      const { run, review, card } = await pendingHumanEpisode(st, start())
      const failed = await pollSt(
        async () => nativeRun(st, run.subject),
        (value) => value.status === 'failed',
        'agentless checkpoint timeout failure',
        90000,
      )
      expect(nativeStep(failed, 'authorize').status).toBe('failed')
      expect(nativeStep(failed, 'risky')).toMatchObject({
        status: 'cancelled',
        claimant: null,
        worker_reported: false,
      })
      expect(await nativeResults(st, review)).toEqual([])
      await expectEpisodeClosed(st, review)
      expectRefused(st.command('alerts', 'approve', card.id, '--as', gateReviewer), closedReview)
      expect(await nativeResults(st, review)).toEqual([])
      expect(nativeRun(st, run.subject).status).toBe('failed')
    }),
  150000,
)

testWithStFixture(
  'isolated human gate: rejection fails the checkpoint without admitting its dependent',
  async ({ signal }) =>
    withIsolatedSt({ kind: 'fixture', signal }, async (st) => {
      const start = publishHumanFixture(st, 'acceptance/rejected')
      const { run, review, card } = await pendingHumanEpisode(st, start())
      expectRefused(
        st.command('alerts', 'reject', card.id, '--as', gateReviewer),
        /missing-review-reason|needs a reason|--reason/u,
      )
      const reason = 'The isolated plan is not authorized.'
      const result = stJson<NativeClaim>(
        st,
        'alerts',
        'reject',
        card.id,
        '--reason',
        reason,
        '--as',
        gateReviewer,
      )
      expect(result).toMatchObject({
        kind: 'gate.result',
        actor: gateReviewer,
        body: {
          fields: { request: review.request, decision: 'rejected', verdict: 'fail', reason },
          evidence: expect.arrayContaining([review.request]),
        },
      })
      const stopped = await pollSt(
        async () => nativeRun(st, run.subject),
        (value) => value.status === 'failed',
        'rejected mission failure',
      )
      expect(nativeStep(stopped, 'authorize').status).toBe('failed')
      expect(nativeStep(stopped, 'risky')).toMatchObject({
        status: 'cancelled',
        claimant: null,
        worker_reported: false,
      })
      await expectEpisodeClosed(st, review)
      expectRefused(st.command('alerts', 'approve', card.id, '--as', gateReviewer), closedReview)
      expect((await nativeResults(st, review)).map((claim) => claim.id)).toEqual([result.id])
      expect(nativeRun(st, run.subject).status).toBe('failed')
    }),
  120000,
)

testWithStFixture(
  'isolated human gate: cancellation fences late decisions from a fresh run episode',
  async ({ signal }) =>
    withIsolatedSt({ kind: 'fixture', signal }, async (st) => {
      const start = publishHumanFixture(st, 'acceptance/stale')
      const old = await pendingHumanEpisode(st, start())
      stJson(
        st,
        'missions',
        'cancel',
        old.run.subject,
        '--reason',
        'Close the old authorization episode.',
        '--as',
        gateReviewer,
      )
      await pollSt(
        async () => nativeRun(st, old.run.subject),
        (value) => value.status === 'cancelled',
        'cancelled old run',
      )
      await expectEpisodeClosed(st, old.review)
      const fresh = await pendingHumanEpisode(st, start())
      expect(fresh.run.subject).not.toBe(old.run.subject)
      expect(fresh.review.request).not.toBe(old.review.request)
      expect(fresh.review.operation).not.toBe(old.review.operation)
      expect(fresh.card.id).not.toBe(old.card.id)
      expectRefused(
        st.command('alerts', 'approve', old.card.id, '--as', gateReviewer),
        closedReview,
      )
      expect(await nativeResults(st, old.review)).toEqual([])
      expect(await nativeResults(st, fresh.review)).toEqual([])
      expect(nativeRun(st, old.run.subject).status).toBe('cancelled')
      expect(nativeStep(nativeRun(st, fresh.run.subject), 'risky').status).toBe('pending')
      expect(
        (await nativeReviews(st)).filter((item) => item.request === fresh.review.request),
      ).toHaveLength(1)
      const result = stJson<NativeClaim>(
        st,
        'alerts',
        'approve',
        fresh.card.id,
        '--as',
        gateReviewer,
      )
      await pollSt(
        async () => nativeRun(st, fresh.run.subject),
        (value) => nativeStep(value, 'risky').status === 'ready',
        'fresh episode dependent readiness',
      )
      await expectEpisodeClosed(st, fresh.review)
      expect(await nativeResults(st, old.review)).toEqual([])
      expect((await nativeResults(st, fresh.review)).map((claim) => claim.id)).toEqual([result.id])
      expect(nativeRun(st, old.run.subject).status).toBe('cancelled')
    }),
  120000,
)
