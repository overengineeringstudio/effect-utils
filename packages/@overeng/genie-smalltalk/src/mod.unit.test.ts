import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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
  mission,
  MissionSchema,
  node,
  omp,
  type OmpSchema,
  resource,
  schedule,
  step,
  StepSchema,
  smalltalkKdl,
} from './mod.ts'

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
          under: [{ target: reporter, reason: 'Delegated work.' }, { target: { id: 'other/manager' } }],
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
    expect(Schema.decodeSync(MissionSchema)({ ...fanInMission(), reportTo: importedSeat }).reportTo).toBe(
      importedSeat,
    )
    const kdl = emit([
      step({ id: 'inspect', assignedTo: importedSeat }),
      agent({ id: 'ops/worker', under: [{ target: importedSeat }] }),
    ])
    for (const metadata of ['harness', 'Mission watcher', 'KIT_SESSION_HOME', 'hold', 'returnFacts']) {
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
    expect(() => Schema.decodeUnknownSync(StepSchema)({ id: 'inspect', assignedTo: reference })).toThrow()
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
    expect(() => Schema.decodeUnknownSync(StepSchema)({ id: 'inspect', assignedTo: reference })).toThrow()
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
    expect(
      emit([agent({ id: 'ops/worker', under: [{ target: supervisor }] })]),
    ).toBe('version 2\nagent "ops/worker" {\n  under "agent/ops/supervisor"\n}\n')
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
  it.each(['pty', 'exec'] as const)('rejects excess restart on nested %s tasks at runtime', (kind) => {
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
          Schema.decodeUnknownSync(AgentSchema)({ id: 'ops/subordinate', under: [{ target: reference }] }),
        ).toThrow()
        expect(() =>
          Schema.decodeUnknownSync(MissionSchema)({ ...fanInMission(), reportTo: reference }),
        ).toThrow()
      }
    }
  })
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
testWithSt(
  'round-trips canonical mission and strict agent fields through isolated st daemon',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-st-'))
    const socket = join(dir, 'daemon.sock')
    const gateway = join(dir, 'gateway.sock')
    const source = join(dir, 'mission.kdl')
    const actor = process.env.ST_AGENT ?? 'person/genie-test'
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
    ])
      mkdirSync(path)
    writeFileSync(source, canonical())
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
        gateway,
      ],
      { env: isolatedEnv, stdio: 'pipe' },
    )
    try {
      for (let i = 0; i < 100 && existsSync(socket) === false && daemon.exitCode === null; i++)
        await new Promise((resolve) => setTimeout(resolve, 100))
      expect(existsSync(socket)).toBe(true)
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
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const { promise, resolve } = Promise.withResolvers<void>()
        daemon.once('exit', () => resolve())
        daemon.kill('SIGTERM')
        await promise
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  },
  60000,
)
