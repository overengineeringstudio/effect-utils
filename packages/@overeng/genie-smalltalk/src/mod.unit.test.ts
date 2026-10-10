import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Schema } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  agent,
  type AgentReference,
  AgentReferenceSchema,
  AgentSchema,
  type CodexSchema,
  emit,
  type GateSchema,
  HumanGateSchema,
  mission,
  MissionSchema,
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
  smalltalkKdl,
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
import { upstreamRepin, upstreamRepinKdl } from './upstream-repin.fixture.ts'

const operator = person('person/schickling')
const owner = { id: 'example/owner' } satisfies typeof AgentSchema.Encoded
const worker = { id: 'example/worker' } satisfies typeof AgentSchema.Encoded
const humanReviewGate = {
  kind: 'human',
  name: 'Approve the bounded Berlin cutover',
  reviewer: operator,
} satisfies typeof HumanGateSchema.Encoded

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
                    `doc/berlin-cutover@${'a'.repeat(64)}`,
                    'resource/example/rollback-plan',
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
      { review: ['doc/plan', 'doc/plan'] },
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
      ],
    },
  ],
})

describe('Smalltalk declarations', () => {
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
    { harness: { kind: 'omp', model: 'example-model' } },
    { harness: { kind: 'omp', model: 'example-model', effort: 'xhigh' } },
    { harness: { kind: 'codex', model: '', effort: 'high' } },
    {
      command: 'true',
      harness: { kind: 'omp', model: 'example-model', effort: 'high' },
    },
    { command: 'true', argv: ['true'] },
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
          pty: [{ id: 'shell', command: 'sh' }],
          exec: [{ id: 'check', host: 'local', workspace: '/tmp', argv: ['true'] }],
        }),
      ]),
    ).toBe(
      'version 2\nagent "ops/worker" {\n  restart "always"\n  pty "shell" {\n    command "sh"\n  }\n  exec "check" {\n    host "local"\n    workspace "/tmp"\n    argv "true"\n  }\n}\n',
    )
  })
  it.each(['pty', 'exec'] as const)(
    'rejects excess restart on nested %s tasks at runtime',
    (kind) => {
      for (const launch of [{ command: 'true' }, { argv: ['true'] }]) {
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
    input.steps[2]!.dependsOn = [{ step: 'first', state: 'completed' }]
    expect(emit([mission(input)])).toContain('depends-on {\n      step "first" "completed"\n    }')
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
  it('requires both routing fields in every harness authoring type', () => {
    expectTypeOf<Omit<typeof OmpSchema.Encoded, 'model'>>().not.toMatchTypeOf<
      typeof OmpSchema.Encoded
    >()
    expectTypeOf<Omit<typeof OmpSchema.Encoded, 'effort'>>().not.toMatchTypeOf<
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
      { model: 'example-model' },
      { effort: 'medium' },
      { model: '', effort: 'medium' },
      { model: 'example-model', effort: '' },
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
      smalltalkKdl([node({ name: 'bad', args: [Infinity] })]).validate?.({ cwd: '', location: '' }),
    ).toMatchObject([{ severity: 'error', rule: 'smalltalk-kdl' }])
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
        every: '0s',
        anchor: '2026-09-30T12:00:00Z',
        catchUp: 'latest',
        work: { mission: `demo@${'a'.repeat(64)}`, workspace: '/tmp' },
      }),
    ).toThrow()
    expect(() =>
      agent({ id: 'seat', command: 'true', harness: { kind: 'omp', model: 'x', effort: 'low' } }),
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
    expect(smalltalkKdl(nodes).stringify({ cwd: '', location: '' })).toContain(
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
        gate.ciPassed('build', { repo: 'acme/garden', commit, name: 'build' }),
        gate.merged(pr('acme/garden', 7), { name: 'merged' }),
        gate.document(doc`doc/report/${runId}`, { name: 'report' }),
        gate.human({ reviewer: operator, name: 'review', question: 'Is the exact report ready?' }),
      ],
    })
    const kdl = emit([declaration])
    expect(kdl).toContain('goal "Verify ${input.commit}."')
    expect(kdl).toContain('ci-passed "build" commit="${input.commit}" repo="acme/garden"')
    expect(kdl).toContain('merged "acme/garden#7"')
    expect(kdl).toContain('document "doc/report/${ST_MISSION_RUN}"')
    expect(kdl).toContain('gate "review" mode="approve" type="human"')
    expect(gate.merged(pr('acme/garden', 7)).name).toBe(gate.merged(pr('acme/garden', 7)).name)
    expect(gate.ciPassed('build', { repo: 'acme/garden', commit }).name).not.toBe(
      gate.ciPassed('test', { repo: 'acme/garden', commit }).name,
    )
  })
  it('retains every native gate, retry, completion and finalization in the synthetic graph', () => {
    const kdl = grammarCanonical()
    expect(kdl).toContain('goal "Bound goals to three."')
    expect(kdl).toContain('retry {\n      attempts 100\n      backoff "0s"')
    expect(kdl).toContain('completion {\n    depends-on {\n      step "last" "completed"')
    expect(kdl).toContain('finally {\n    step "cleanup"')
    expect(kdl).toContain('field "name" "resource/input" "starts-with" "input"')
    expect(kdl).toContain('lacks "file/local:/tmp/result" "error"')
  })
  it('renders public PR inputs and config-time fragments with the same ordered flow', () => {
    expect(emit([prLanding()])).toContain('input "commit" kind="text"')
    expect(emit([prLandingFragment({ number: 7, commit: 'abc' })])).toContain('repo="acme/garden"')
    expect(upstreamRepin()).toContain('loop "await-upstream" timeout="720h"')
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
    for (const [subject, error] of [
      [pr, 'not declared'],
      [foreign.products.report, 'outside this mission'],
    ] as const) {
      const gates = [gate.fieldIs({ name: 'ready', subject, path: 'state', value: 'ready' })]
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
            review: ['resource/garden', 'doc/report'],
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
          review: ['resource/a', 'resource/a'],
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
    if (ready(last)) return last
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 100)
    await promise
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}; last observation: ${JSON.stringify(last)}`)
}

const withIsolatedSt = async (
  { kind }: { kind: 'production' | 'fixture' },
  run: (st: IsolatedSt) => Promise<void>,
) => {
  const binary = kind === 'fixture' ? stFixtureBin : stBin
  if (binary === undefined || binary === '')
    throw new Error(
      `${kind === 'fixture' ? 'ST_FIXTURE_BIN' : 'ST_BIN'} is required for ${kind} mode`,
    )
  const dir = mkdtempSync(join(tmpdir(), 'genie-st-'))
  const socket = join(dir, 'daemon.sock')
  const stateDir = join(dir, 'state')
  const ptyRoot = join(dir, 'pty')
  const isolatedEnv = {
    ...process.env,
    HOME: join(dir, 'home'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_STATE_HOME: join(dir, 'xdg-state'),
    XDG_RUNTIME_DIR: join(dir, 'runtime'),
  }
  for (const path of [
    isolatedEnv.HOME,
    isolatedEnv.XDG_CONFIG_HOME,
    isolatedEnv.XDG_DATA_HOME,
    isolatedEnv.XDG_STATE_HOME,
    isolatedEnv.XDG_RUNTIME_DIR,
    stateDir,
    ptyRoot,
  ])
    mkdirSync(path, { mode: 0o700 })
  const configDir = join(isolatedEnv.XDG_CONFIG_HOME, 'st3')
  mkdirSync(configDir, { mode: 0o700 })
  const config = join(configDir, 'config.toml')
  writeFileSync(
    config,
    [
      'node = "genie-test"',
      `person = ${JSON.stringify(gateReviewer)}`,
      `state_dir = ${JSON.stringify(stateDir)}`,
      `pty_root = ${JSON.stringify(ptyRoot)}`,
      `socket = ${JSON.stringify(socket)}`,
      `client_gateway_socket = ${JSON.stringify(join(dir, 'gateway.sock'))}`,
      'peers = []',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  const daemon = spawn(
    binary,
    [
      'up',
      '--config',
      config,
      '--node',
      'genie-test',
      '--state-dir',
      stateDir,
      '--pty-root',
      ptyRoot,
      '--socket',
      socket,
      '--client-gateway-socket',
      join(dir, 'gateway.sock'),
    ],
    { env: isolatedEnv, stdio: 'pipe' },
  )
  const exited = Promise.withResolvers<void>()
  daemon.once('exit', () => exited.resolve())
  let daemonLog = ''
  let daemonError: Error | undefined
  daemon.on('error', (error) => {
    daemonError = error
    exited.resolve()
  })
  const capture = (chunk: Buffer) => {
    daemonLog = (daemonLog + chunk.toString()).slice(-16000)
  }
  daemon.stdout.on('data', capture)
  daemon.stderr.on('data', capture)
  try {
    await pollSt(
      async () => {
        if (daemonError !== undefined) throw daemonError
        if (daemon.exitCode !== null || daemon.signalCode !== null)
          throw new Error(`Isolated daemon exited during startup: ${daemonLog}`)
        return existsSync(socket)
      },
      Boolean,
      'isolated daemon socket',
    )
    const get = <T>(path: string): Promise<T> => {
      const { promise, resolve, reject } = Promise.withResolvers<T>()
      const req = request({ socketPath: socket, path, method: 'GET' }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('error', reject)
        response.on('end', () => {
          if (response.statusCode !== 200)
            reject(new Error(`${path} returned ${response.statusCode}: ${body}\n${daemonLog}`))
          else resolve(JSON.parse(body) as T)
        })
      })
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
      command: (...args) =>
        spawnSync(binary, ['--endpoint', `unix://${socket}`, '--json', ...args], {
          encoding: 'utf8',
          timeout: 30000,
          env: isolatedEnv,
        }),
    })
  } finally {
    if (daemon.pid !== undefined && daemon.exitCode === null && daemon.signalCode === null) {
      const timer = setTimeout(() => daemon.kill('SIGKILL'), 5000)
      daemon.kill('SIGTERM')
      await exited.promise
      clearTimeout(timer)
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
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
  'round-trips canonical mission and strict agent fields through isolated st daemon',
  async () =>
    withIsolatedSt({ kind: 'production' }, async ({ dir, socket, isolatedEnv }) => {
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
      const second = publish()
      expect(second.status, second.stderr).toBe(0)
      expect(JSON.parse(second.stdout)).toMatchObject({ changed: false })
      const seatSource = join(dir, 'agent.kdl')
      const launch = { id: 'garden/orchard', workspace: dir, command: 'true' }
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
      const shown = spawnSync(
        stBin!,
        ['--endpoint', `unix://${socket}`, 'subject', 'show', 'agent/garden/orchard', '--kdl'],
        { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
      )
      expect(shown.status, shown.stderr).toBe(0)
      expect(shown.stdout).toMatch(/^\s*handles-faults\s*$/mu)
      const reapplied = applySeat(shown.stdout)
      expect(reapplied.status, reapplied.stderr).toBe(0)
      expect(JSON.parse(reapplied.stdout)).toMatchObject({ changed: false })
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
      const automaticShown = spawnSync(
        stBin!,
        ['--endpoint', `unix://${socket}`, 'subject', 'show', 'agent/garden/orchard', '--kdl'],
        { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
      )
      expect(automaticShown.status, automaticShown.stderr).toBe(0)
      expect(automaticShown.stdout).not.toContain('rollout')
      expect(automaticShown.stdout).not.toContain('handles-faults')
      const fixtureSeats = applySeat(
        emit([
          agent({ id: 'example/owner', workspace: dir, command: 'true', rollout: 'manual' }),
          agent({ id: 'example/updater', workspace: dir, command: 'true', rollout: 'manual' }),
          agent({ id: 'team/worker', workspace: dir, command: 'true', rollout: 'manual' }),
          agent({ id: reporter.id, workspace: dir, command: 'true', rollout: 'manual' }),
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
            expect.objectContaining({ name: 'locator', arguments: ['acme/garden@feature/proof'] }),
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
    }),
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
  async () =>
    withIsolatedSt({ kind: 'fixture' }, async (st) => {
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
  async () =>
    withIsolatedSt({ kind: 'fixture' }, async (st) => {
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
  async () =>
    withIsolatedSt({ kind: 'fixture' }, async (st) => {
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
  async () =>
    withIsolatedSt({ kind: 'fixture' }, async (st) => {
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
