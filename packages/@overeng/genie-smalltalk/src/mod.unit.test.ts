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
describe('Smalltalk declarations', () => {
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
})

const stBin = process.env.ST_BIN
const testWithSt = stBin !== undefined && stBin !== '' ? it : it.skip
testWithSt(
  'round-trips canonical mission through isolated st daemon',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-st-'))
    const socket = join(dir, 'daemon.sock')
    const gateway = join(dir, 'gateway.sock')
    const source = join(dir, 'mission.kdl')
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
            'person/genie-test',
          ],
          { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
        )
      const first = publish()
      expect(first.status, first.stderr).toBe(0)
      const second = publish()
      expect(second.status, second.stderr).toBe(0)
      expect(JSON.parse(second.stdout)).toMatchObject({ changed: false })
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const { promise, resolve } = Promise.withResolvers<void>()
        daemon.once('exit', () => resolve())
        daemon.kill('SIGTERM')
        await promise
      }
      rmSync(dir, { recursive: true, force: true })
    }
  },
  60000,
)
