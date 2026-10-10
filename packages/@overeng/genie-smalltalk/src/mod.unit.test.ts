import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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

const operator = person('person/schickling')
const owner = { id: 'example/owner' } satisfies typeof AgentSchema.Encoded
const worker = { id: 'example/worker' } satisfies typeof AgentSchema.Encoded
const gate = {
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
      step({ id: 'approve', agentless: true, gate: { ...gate, reviewer: owner } } as never),
    ).toThrow()
  })

  it('requires tags and does not declare unsupported policy fields', () => {
    type Gate = typeof GateSchema.Encoded
    expectTypeOf<Gate['kind']>().toEqualTypeOf<'field' | 'human'>()
    expectTypeOf<Omit<typeof gate, 'kind'>>().not.toMatchTypeOf<Gate>()
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
        step({ id: 'approve', agentless: true, gate: { ...gate, ...extra } } as never),
      ).toThrow()
    }
    expect(() =>
      step({
        id: 'verify',
        gate: { name: 'ok', field: { kind: 'exit_code', ref: 'exec/check', is: 0 } },
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
    expect(() => Schema.decodeUnknownSync(PersonReferenceSchema)({ kind: 'person', subject })).toThrow()
  })

  it('lowers a separate approve checkpoint before the risky step to exact KDL', () => {
    expect(
      emit([
        mission({
          id: 'home/berlin/cutover',
          state: 'ready',
          reportTo: owner,
          goal: 'Apply only the reviewed Berlin cutover plan.',
          steps: [
            {
              id: 'approve-cutover',
              agentless: true,
              timeout: '1d',
              gate: {
                ...gate,
                question: 'Apply the reviewed configuration and rollback plan?',
                review: [`doc/berlin-cutover@${'a'.repeat(64)}`, 'resource/example/rollback-plan'],
              },
            },
            {
              id: 'apply-cutover',
              assignedTo: worker,
              dependsOn: [{ step: 'approve-cutover', state: 'completed' }],
              goal: 'Apply precisely the approved plan.',
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
      emit([step({ id: 'draft', assignedTo: worker, gate: { ...gate, mode: 'feedback' } })]),
    ).toBe(`version 2
step "draft" {
  assigned-to "agent/example/worker"
  gate "Approve the bounded Berlin cutover" mode="feedback" type="human" {
    reviewer "person/schickling"
  }
}
`)
    expect(() =>
      step({ id: 'approve', agentless: true, gate: { ...gate, mode: 'feedback' } }),
    ).toThrow('feedback human gates require a worker step')
  })

  it('accepts explicit approve mode and rejects invalid modes and duplicate review targets', () => {
    expect(
      emit([step({ id: 'approve', agentless: true, gate: { ...gate, mode: 'approve' } })]),
    ).toBe(emit([step({ id: 'approve', agentless: true, gate })]))
    for (const invalid of [
      { mode: 'consultative' },
      { review: ['doc/plan', 'doc/plan'] },
      { question: '' },
      { reviewer: 'person/schickling' },
    ]) {
      expect(() =>
        step({ id: 'approve', agentless: true, gate: { ...gate, ...invalid } } as never),
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
    expect(
      emit([step({ id: 'inspect', assignedTo: operator, goal: 'Inspect the plan.' })]),
    ).toBe(
      'version 2\nstep "inspect" {\n  assigned-to "person/schickling"\n  goal "Inspect the plan."\n}\n',
    )
    expect(
      emit([
        step({
          id: 'verify',
          gate: {
            kind: 'field',
            name: 'Successful check',
            field: { kind: 'exit_code', ref: 'exec/check', is: 0 },
          },
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
      goal: 'Demonstrate KDL.',
      steps: [{ id: 'first', goal: 'Inspect input.', agentless: true }],
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
      goal: 'Delegate work.',
      steps: [{ id: 'inspect', assignedTo: reporter, goal: 'Inspect input.' }],
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
          expect(() => Schema.decodeUnknownSync(AgentSchema)(reference)).toThrow()
          expect(() => Schema.decodeUnknownSync(AgentReferenceSchema)(reference)).toThrow()
          expect(() =>
            Schema.decodeUnknownSync(StepSchema)({ id: 'inspect', assignedTo: reference }),
          ).toThrow()
          expect(() =>
            Schema.decodeUnknownSync(AgentSchema)({
              id: 'ops/subordinate',
              under: [{ target: reference }],
            }),
          ).toThrow()
          expect(() =>
            Schema.decodeUnknownSync(MissionSchema)({ ...fanInMission(), reportTo: reference }),
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
    {
      dependsOn: [
        { step: 'first', state: 'completed' },
        { step: 'second', state: 'failed' },
      ],
    },
    { dependsOn: { step: 'first', state: 'completed' } },
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
        goal: 'go',
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

const stBin = process.env.ST_BIN
const testWithSt = stBin !== undefined && stBin !== '' ? it : it.skip

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

/**
 * Native Linux Unix listeners bind any request whose process ancestry carries
 * `ST_AGENT=agent/...`; a bound harness cannot name a person on `/v1/reviews/`.
 * Person-attributed fixtures must therefore start outside every st harness.
 *
 * Mirrors d5e2302 `api.rs` `harness_ancestor`: the walk ends unbound at the first ancestor
 * whose `/proc` entries this user cannot read (for example a root-owned sshd), because the
 * daemon, running as the same user, stops there too. Any other read error fails the fixture.
 */
const boundHarnessAncestor = (): string | undefined => {
  if (process.platform !== 'linux') return undefined
  const readProc = (path: string) => {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') return undefined
      throw error
    }
  }
  const seen: Record<number, true> = {}
  for (let pid = process.pid; pid > 1 && seen[pid] === undefined; ) {
    seen[pid] = true
    const environment = readProc(`/proc/${pid}/environ`)
    if (environment === undefined) return undefined
    const agent = environment.split('\0').find((entry) => entry.startsWith('ST_AGENT=agent/'))
    if (agent !== undefined) return `${agent.slice('ST_AGENT='.length)} (pid ${pid})`
    const stat = readProc(`/proc/${pid}/stat`)
    if (stat === undefined) return undefined
    const parent = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[1])
    if (!Number.isInteger(parent)) throw new Error(`Unparseable /proc/${pid}/stat: ${stat}`)
    pid = parent
  }
  return undefined
}

const withIsolatedSt = async (
  { unbound }: { unbound: boolean },
  run: (st: IsolatedSt) => Promise<void>,
) => {
  if (unbound) {
    const bound = boundHarnessAncestor()
    expect(
      bound,
      `Person-attributed gate acceptance must run outside st harness ancestry; found ${bound}`,
    ).toBeUndefined()
  }
  const dir = mkdtempSync(join(tmpdir(), 'genie-st-'))
  const socket = join(dir, 'daemon.sock')
  const { ST_AGENT: _inheritedAgent, ...inherited } = process.env
  const isolatedEnv = {
    ...(unbound ? inherited : process.env),
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
  ])
    mkdirSync(path)
  const daemon = spawn(
    stBin!,
    [
      'up',
      '--node',
      'genie-test',
      '--state-dir',
      join(dir, 'state'),
      '--pty-root',
      join(dir, 'pty'),
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
        spawnSync(stBin!, ['--endpoint', `unix://${socket}`, '--json', ...args], {
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
    withIsolatedSt({ unbound: false }, async ({ dir, socket, isolatedEnv }) => {
      const source = join(dir, 'mission.kdl')
      const actor = process.env.ST_AGENT ?? 'person/genie-test'
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

const gateReviewer = 'person/schickling'
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
        goal: 'Exercise native current human review episodes without performing risky work.',
        steps: [
          {
            id: 'authorize',
            agentless: true,
            ...(checkpointTimeout === undefined ? {} : { timeout: checkpointTimeout }),
            gate: {
              name: 'Operator approves readiness',
              kind: 'human',
              reviewer: person(gateReviewer),
              mode: 'approve',
              question: gateQuestion,
            },
          },
          {
            id: 'risky',
            assignedTo: worker,
            dependsOn: [{ step: 'authorize', state: 'completed' }],
            goal: 'Become ready only after the current authorization checkpoint passes.',
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

testWithSt(
  'isolated human gate: critical silence holds readiness until the named reviewer approves',
  async () =>
    withIsolatedSt({ unbound: true }, async (st) => {
      const start = publishHumanFixture(st, 'acceptance/critical')
      const { run, review, card } = await pendingHumanEpisode(st, start())
      // Re-observe the same episode; unanswered critical review stays held, never approved.
      expect(
        (await nativeReviews(st)).filter((item) => item.request === review.request),
      ).toHaveLength(1)
      expect(nativeStep(nativeRun(st, run.subject), 'risky').status).toBe('pending')
      expect(await nativeResults(st, review)).toEqual([])
      expectRefused(
        st.command('alerts', 'approve', card.id, '--as', 'person/someone-else'),
        /wrong-reviewer|requires `person\/schickling`/u,
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
      expect(nativeStep(admitted, 'risky')).toMatchObject({ claimant: null, worker_reported: false })
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

testWithSt(
  'isolated human gate: an expired agentless checkpoint fails instead of approving',
  async () =>
    withIsolatedSt({ unbound: true }, async (st) => {
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

testWithSt(
  'isolated human gate: rejection fails the checkpoint without admitting its dependent',
  async () =>
    withIsolatedSt({ unbound: true }, async (st) => {
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

testWithSt(
  'isolated human gate: cancellation fences late decisions from a fresh run episode',
  async () =>
    withIsolatedSt({ unbound: true }, async (st) => {
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
      expect((await nativeResults(st, fresh.review)).map((claim) => claim.id)).toEqual([
        result.id,
      ])
      expect(nativeRun(st, old.run.subject).status).toBe('cancelled')
    }),
  120000,
)
