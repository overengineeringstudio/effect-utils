import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { agent, emit, mission, node, omp, resource, schedule, smalltalkKdl } from './mod.ts'

const canonical = () =>
  emit([
    mission({
      id: 'demo',
      state: 'ready',
      goal: 'Demonstrate KDL.',
      steps: [{ id: 'first', goal: 'Inspect input.', agentless: true }],
    }),
  ])

const scheduleWork = { mission: `demo@${'a'.repeat(64)}`, workspace: '/work/demo' }
const calendarSchedule = {
  id: 'daily',
  host: 'local',
  _tag: 'calendar',
  at: '08:00',
  timezone: 'Europe/Berlin',
  catchUp: 'latest',
  work: scheduleWork,
} as const
describe('Smalltalk declarations', () => {
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
      expect(emit([schedule({ ...calendarSchedule, at: '09:00', days: [day] })])).toContain(
        `calendar {\n    at "${day} 09:00"\n    timezone "Europe/Berlin"\n  }`,
      )
    },
  )
  it('supports both tagged and existing untagged interval declarations', () => {
    const interval = {
      id: 'cycle',
      host: 'local',
      every: '6h',
      anchor: '2026-01-01T00:00:00Z',
      catchUp: 'latest',
      work: scheduleWork,
    } as const
    const rendered = emit([schedule(interval)])
    expect(emit([schedule({ ...interval, _tag: 'every' })])).toBe(rendered)
    expect(rendered).toContain('  every "6h"\n  anchor "2026-01-01T00:00:00Z"\n')
    expect(rendered).not.toContain('calendar')
  })
  it('renders a calendar schedule nested in a mission', () => {
    expect(
      emit([
        mission({
          id: 'demo',
          state: 'ready',
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
      expect(() => schedule({ ...calendarSchedule, at })).toThrow()
    },
  )
  it.each(['Mars/Olympus', '', '+02:00'])('rejects invalid timezone %j', (timezone) => {
    expect(() => schedule({ ...calendarSchedule, timezone })).toThrow()
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
    expect(() => schedule({ ...calendarSchedule, ...fields } as never)).toThrow()
  })
  it.each(['00:00', '23:59'])('accepts boundary calendar time %s', (at) => {
    expect(emit([schedule({ ...calendarSchedule, at, timezone: 'UTC' })])).toContain(
      `at "${at}"`,
    )
  })
  it('resumes an exact Codex session without overriding provider defaults', () => {
    const seat = agent({
      id: 'example/codex',
      env: { CODEX_HOME: '/srv/codex' },
      harness: {
        kind: 'codex',
        args: ['--config', 'key=value'],
        resume: { session: 'native-thread' },
      },
    })
    expect(emit([seat])).toBe(
      'version 2\nagent "example/codex" {\n  env {\n    CODEX_HOME "/srv/codex"\n    ST3_NATIVE_RESUME_SESSION "native-thread"\n  }\n  harness "codex" {\n    args "--config" "key=value"\n  }\n}\n',
    )
    expect(() =>
      agent({
        id: 'example/codex',
        env: { ST3_NATIVE_RESUME_SESSION: 'different-thread' },
        harness: { kind: 'codex', resume: { session: 'native-thread' } },
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
        goal: 'go',
        steps: [{ id: 'a', agentless: true, assignedTo: 'agent/a' }],
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
