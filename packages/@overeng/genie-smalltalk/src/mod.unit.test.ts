import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { agent, completion, doc, emit, gate, loop, mission, node, observer, resource, schedule, smalltalkKdl, step, subscription } from './mod.ts'
import { upstreamRepin, upstreamRepinKdl } from './upstream-repin.fixture.ts'

const guideText = 'This immutable guide is ready.\n'
const guideHash = createHash('sha256').update(guideText).digest('hex')
const canonical = () =>
  emit([
    mission({
      id: 'demo',
      state: 'ready',
      goals: ['Demonstrate KDL.', 'Preserve all goals.', 'Bound goals to three.'],
      gates: [{ name: 'exists', kind: 'exists', subject: 'resource/input' }],
      docs: [{ id: 'example/guide', hash: guideHash }],
      completion: { dependsOn: [{ step: 'last', state: 'completed' }] },
      finally: [
        { id: 'cleanup', agentless: true, gates: [{ name: 'cleanup', kind: 'exec', command: 'true', host: 'local', workspace: '${ST_WORKSPACE}', env: { RESULT: 'ok' }, timeLimit: '1m' }] },
        { id: 'after-cleanup', agentless: true, dependsOn: [{ step: 'cleanup', state: 'terminal' }] },
      ],
      steps: [
        { id: 'first', goals: ['Inspect input.'], agentless: true, retry: { attempts: 100, backoff: '0s' },
          documents: [`doc/example/guide@${guideHash}`],
          gates: [
            { name: 'state', kind: 'field', path: 'state', subject: 'resource/input', operator: 'is', value: 'ready' },
            { name: 'prefix', kind: 'field', path: 'name', subject: 'resource/input', operator: 'starts-with', value: 'input' },
            { name: 'empty', kind: 'empty', subject: 'mission-run/previous' },
            { name: 'has', kind: 'has', subject: 'message/guide', text: 'ready' },
            { name: 'lacks', kind: 'lacks', subject: 'file/local:/tmp/result', text: 'error' },
            { name: 'merged', kind: 'merged', locator: 'acme/garden#7' },
            { name: 'ci', kind: 'ci-passed', check: 'build', repo: 'acme/garden', ref: { branch: 'main' } },
          ] },
        { id: 'second', agentless: true, dependsOn: [{ step: 'first', state: 'failed' }] },
        { id: 'last', agentless: true, dependsOn: [{ step: 'first', state: 'completed' }, { step: 'second', state: 'terminal' }] },
      ],
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
        goals: ['go'],
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
  it.each([0, 101, 1.5])('rejects invalid retry attempts %s', (attempts) => {
    expect(() => step({ id: 'a', retry: { attempts } })).toThrow()
  })
  it.each([1e19, -1e19, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe integral field values %s', (value) => {
    expect(() => gate({ name: 'number', kind: 'field', path: 'count', subject: 'resource/result', operator: 'is', value })).toThrow()
  })
  it.each([0, 101, 1.5])('rejects invalid loop bounds %s', (maxRounds) => {
    expect(() => loop({ id: 'wait', maxRounds, round: { completion: { when: 'all-steps-exhausted' }, steps: [] } })).toThrow()
  })
  it('rejects conflicting completion and final completion frontiers', () => {
    expect(() => completion({ when: 'all-steps-exhausted', dependsOn: [{ step: 'a', state: 'completed' }] } as never)).toThrow()
    expect(() => mission({ id: 'a', state: 'ready', goals: ['a'], steps: [],
      finally: [{ id: 'cleanup', agentless: true }],
      completion: { dependsOn: [{ step: 'cleanup', state: 'terminal' }] },
    })).toThrow()
    expect(() => mission({ id: 'a', state: 'ready', goals: ['a'], steps: [{ id: 'work' }],
      finally: [{ id: 'cleanup', dependsOn: [{ step: 'work', state: 'completed' }] }],
    })).toThrow()
    expect(() => loop({ id: 'wait', maxRounds: 2, round: { steps: [] } } as never)).toThrow()
    expect(() => loop({ id: 'wait', maxRounds: 2, round: { completion: { when: 'all-steps-exhausted' }, steps: [] },
      onExhausted: { outcome: 'succeed', attention: { title: 'wrong phase', reviewer: 'person/a', severity: 'warning' } },
    } as never)).toThrow()
    expect(() => gate({ name: 'env', kind: 'exec', command: 'true', host: 'local', workspace: '/tmp', env: { 'bad-key': 'x' } })).toThrow()
  })
  it.each(['ST_WORKSPACE', 'ST_MISSION', 'ST_GATE', 'ST_LOOP_ROUND', 'ST3_SUBJECT'])('rejects reserved exec-gate context key %s', (key) => {
    expect(() => gate({ name: 'env', kind: 'exec', command: 'true', host: 'local', workspace: '/tmp', env: { [key]: 'x' } })).toThrow()
  })
  it.each(['doc/guide', 'doc/guide@abc', `doc/../guide@${'a'.repeat(64)}`])('rejects unpinned or malformed step document %s', (reference) => {
    expect(() => step({ id: 'read', documents: [reference] })).toThrow()
  })
  it('rejects invalid document hashes and observer/subscription field selections', () => {
    expect(() => doc({ id: 'guide', hash: 'abc' })).toThrow()
    expect(() => gate({ name: 'guide', kind: 'document', subject: 'resource/guide' })).toThrow()
    expect(() => observer({ id: 'ref', resource: 'resource/ref', provider: 'github.ref', locator: 'acme/garden@main', fields: [] } as never)).toThrow()
    expect(() => observer({ id: 'ref', resource: 'resource/ref', provider: 'github.ref', locator: 'acme/garden@main', fields: ['head', 'head'] })).toThrow()
    expect(() => subscription({ id: 'changed', observer: 'resource/ref', to: 'agent/worker', on: ['head'], delivery: 'message' })).toThrow()
    expect(() => subscription({ id: 'changed', observer: 'observer/ref', to: 'agent/worker', on: [], delivery: 'message' } as never)).toThrow()
  })
  it.each(['acme/garden', '/garden@main', 'acme/@main', 'acme/garden@', 'acme/extra/garden@main'])('rejects malformed github.ref locator %s', (locator) => {
    expect(() => observer({ id: 'ref', resource: 'resource/ref', provider: 'github.ref', locator, fields: ['head'] })).toThrow()
  })
  it.each(['state', 'checks', ''])('rejects unsupported github.ref field %s', (field) => {
    expect(() => observer({ id: 'ref', resource: 'resource/ref', provider: 'github.ref', locator: 'acme/garden@main', fields: [field] } as never)).toThrow()
  })
  it('rejects excessive goals, duplicate gates and missing dependencies', () => {
    expect(() => step({ id: 'a', goals: ['a', 'b', 'c', 'd'] })).toThrow()
    expect(() => step({ id: 'a', gates: [
      { name: 'same', kind: 'exists', subject: 'resource/a' },
      { name: 'same', kind: 'exists', subject: 'resource/b' },
    ] })).toThrow()
    expect(() => mission({ id: 'a', state: 'ready', goals: ['a'], steps: [
      { id: 'a', dependsOn: [{ step: 'missing', state: 'terminal' }] },
    ] })).toThrow()
  })
  it('lowers predicates and built-ins without conflating them', () => {
    expect(gate({ name: 'prefix', kind: 'field', path: 'facts.head', subject: 'resource/ref', operator: 'starts-with', value: 'abc' }).children).toEqual([
      node({ name: 'field', args: ['facts.head', 'resource/ref', 'starts-with', 'abc'] }),
    ])
    expect(gate({ name: 'ci', kind: 'ci-passed', check: 'build', repo: 'acme/garden', ref: { commit: 'abc' } }).children).toEqual([
      node({ name: 'ci-passed', args: ['build'], props: { repo: 'acme/garden', commit: 'abc' } }),
    ])
    expect(() => gate({ name: 'ci', kind: 'ci-passed', check: 'build', repo: 'acme/garden', ref: { commit: 'abc', branch: 'main' } } as never)).toThrow()
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
            '--no-gate-check',
            '--as',
            actor,
          ],
          { encoding: 'utf8', timeout: 30000, env: isolatedEnv },
        )
      const documentFile = join(dir, 'guide.txt')
      writeFileSync(documentFile, guideText)
      const storedGuide = spawnSync(stBin!, [
        '--endpoint', `unix://${socket}`, 'documents', 'put', documentFile, '--as', 'doc/example/guide',
      ], { encoding: 'utf8', timeout: 30000, env: isolatedEnv })
      expect(storedGuide.status, storedGuide.stderr).toBe(0)
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
      const fixtureSeat = applySeat(emit([agent({ id: 'example/updater', workspace: dir, command: 'true', restart: 'never' })]))
      expect(fixtureSeat.status, fixtureSeat.stderr).toBe(0)
      // Re-publication uses st's normalized mission revision, not whitespace comparison.
      writeFileSync(source, upstreamRepinKdl)
      const originalFixture = publish()
      expect(originalFixture.status, originalFixture.stderr).toBe(0)
      writeFileSync(source, upstreamRepin())
      const typedFixture = publish()
      expect(typedFixture.status, typedFixture.stderr).toBe(0)
      expect(JSON.parse(typedFixture.stdout)).toMatchObject({ changed: false })
      writeFileSync(source, emit([mission({
        id: 'watch-proof', state: 'ready', goals: ['Keep the ref watch owned by this run.'],
        resources: [{ id: 'ref', kind: 'vcs.ref' }],
        observers: [{ id: 'watch', resource: 'resource/ref', provider: 'github.ref',
          locator: 'acme/garden@feature/proof', fields: ['head', 'ancestors'], every: '1h' }],
        subscriptions: [{ id: 'changes', observer: 'observer/watch', to: 'agent/example/updater',
          on: ['head'], delivery: 'message', when: { path: 'head', operator: 'starts-with', value: 'git:' } }],
        steps: [{ id: 'wait', agentless: true, documents: [`doc/example/guide@${guideHash}`],
          gates: [
            { name: 'guide', kind: 'document', subject: 'doc/example/guide' },
            { name: 'pinned-guide', kind: 'document', subject: `doc/example/guide@${guideHash}` },
            { name: 'hold', kind: 'field', path: 'state', subject: 'resource/ref', operator: 'is', value: 'waiting-for-proof' },
          ] }],
      })]))
      const publishedWatch = publish()
      expect(publishedWatch.status, publishedWatch.stderr).toBe(0)
      const startedWatch = spawnSync(stBin!, [
        '--endpoint', `unix://${socket}`, 'missions', 'start', 'watch-proof',
        '--id', 'watch-proof', '--workspace', dir, '--as', actor,
      ], { encoding: 'utf8', timeout: 30000, env: isolatedEnv })
      expect(startedWatch.status, startedWatch.stderr).toBe(0)
      const showOwned = (subject: string) => spawnSync(stBin!, [
        '--endpoint', `unix://${socket}`, '--json', 'subject', 'show', subject,
      ], { encoding: 'utf8', timeout: 30000, env: isolatedEnv })
      let ownedObserver = showOwned('observer/watch-proof/watch')
      // The external daemon reconciles on its real process clock; fake JS timers cannot drive it.
      for (let attempt = 0; attempt < 100 && JSON.parse(ownedObserver.stdout).status.subjects[0]?.desired == null; attempt++) {
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, 100)
        await promise
        ownedObserver = showOwned('observer/watch-proof/watch')
      }
      expect(ownedObserver.status, ownedObserver.stderr).toBe(0)
      expect(JSON.parse(ownedObserver.stdout)).toMatchObject({ status: { subjects: [
        { subject: 'observer/watch-proof/watch', desired: { children: expect.arrayContaining([
          expect.objectContaining({ name: 'provider', arguments: ['github.ref'] }),
          expect.objectContaining({ name: 'locator', arguments: ['acme/garden@feature/proof'] }),
          expect.objectContaining({ name: 'field', arguments: ['head'] }),
          expect.objectContaining({ name: 'field', arguments: ['ancestors'] }),
        ]) } },
      ] } })
      const ownedSubscription = showOwned('subscription/watch-proof/changes')
      expect(ownedSubscription.status, ownedSubscription.stderr).toBe(0)
      expect(JSON.parse(ownedSubscription.stdout)).toMatchObject({ status: { subjects: [
        { subject: 'subscription/watch-proof/changes', desired: { children: expect.arrayContaining([
          expect.objectContaining({ name: 'observer', arguments: ['observer/watch-proof/watch'] }),
        ]) } },
      ] } })
      const checkEnv = (env: Readonly<Record<string, string>>) => {
        writeFileSync(source, emit([mission({
          id: 'environment-proof', state: 'ready', goals: ['Verify the actual exec-gate environment.'], steps: [],
          gates: [{ name: 'environment', kind: 'exec', host: 'local', workspace: dir, timeLimit: '5s',
            command: 'if test "$ANSWER" = green; then exit 0; else exit 3; fi', env }],
        })]))
        return spawnSync(stBin!, ['--endpoint', `unix://${socket}`, 'missions', 'check', source, '--workspace', dir],
          { encoding: 'utf8', timeout: 30000, env: isolatedEnv })
      }
      const supplied = checkEnv({ ANSWER: 'green', PATH: process.env.PATH ?? '/bin' })
      expect(supplied.status, supplied.stderr).toBe(0)
      const absent = checkEnv({})
      expect(absent.status, absent.stderr).toBe(1)
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
