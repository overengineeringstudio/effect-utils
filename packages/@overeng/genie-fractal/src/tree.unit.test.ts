import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { NodeFileSystem } from '@effect/platform-node'
import { describe, expect, expectTypeOf, it } from '@effect/vitest'
import { Effect } from 'effect'

import { agent, emit, person, type PersonReference } from './mod.ts'
import {
  defineMission,
  pinMission,
  loadSubjectTree,
  type AgentRef,
  type AgentIntent,
  type MissionRef,
  type MissionIntent,
  type PinnedMissionRef,
  type ScheduleIntent,
} from './tree.ts'

const treeModule = new URL('./tree.ts', import.meta.url).href

/** Writes files below a fresh root; each test gets distinct module URLs. */
const fixture = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), 'genie-fractal-tree-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

/** A tree that fails to load, blaming the file at `path` with a message containing `message`. */
type Case = {
  readonly name: string
  readonly files: Readonly<Record<string, string>>
  readonly path: string
  readonly message: string
}

const load = (root: string) =>
  loadSubjectTree({ root, context: { workspace: '/srv/team' } }).pipe(
    Effect.provide(NodeFileSystem.layer),
  )

const loadError = (root: string) => load(root).pipe(Effect.flip)

const define = `import { defineAgent, defineMission, defineSchedule, pinMission } from '${treeModule}'\n`

describe('loadSubjectTree', () => {
  it.effect('derives IDs from paths, passes context and lowers typed references', () =>
    Effect.gen(function* () {
      const root = fixture({
        'team/owner/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: (ctx: { workspace: string }) => ({ workspace: ctx.workspace, restart: 'always' }) })`,
        'team/review/mission.ts': `${define}import owner from '../owner/agent.ts'\nexport const publish = false\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: owner, goal: 'Review.', steps: [{ id: 'read', assignedTo: owner }, { id: 'imported', assignedTo: { id: 'elsewhere' } }] } })`,
        'team/plain/mission.ts': `export default (ctx: { workspace: string }) => ({ id: 'team/plain', state: 'ready', reportTo: { id: 'team/owner' }, goal: ctx.workspace, steps: [{ id: 'only', agentless: true }] })`,
        'team/kdl/agent.kdl': 'version 2\nagent "team/kdl" {\n  restart "never"\n}\n',
        'team/notes.ts': 'export default 1',
      })
      const subjects = yield* load(root)
      expect(subjects.map(({ kind, id, path }) => ({ kind, id, path }))).toEqual([
        { kind: 'agent', id: 'team/kdl', path: 'team/kdl/agent.kdl' },
        { kind: 'agent', id: 'team/owner', path: 'team/owner/agent.ts' },
        { kind: 'mission', id: 'team/plain', path: 'team/plain/mission.ts' },
        { kind: 'mission', id: 'team/review', path: 'team/review/mission.ts' },
      ])
      expect(subjects[1]?.declaration).toMatchObject({
        _tag: 'Module',
        intent: { id: 'team/owner', workspace: '/srv/team', restart: 'always' },
      })
      expect(subjects[2]?.declaration).toMatchObject({ intent: { goal: ['/srv/team'] } })
      expect(subjects[3]?.declaration).toMatchObject({
        intent: {
          reportTo: { id: 'team/owner' },
          steps: [{ assignedTo: { id: 'team/owner' } }, { assignedTo: { id: 'elsewhere' } }],
        },
        exports: { publish: false },
      })
    }),
  )

  it.effect('decodes a person principal from an agent module and round-trips its KDL', () =>
    Effect.gen(function* () {
      expectTypeOf<PersonReference>().toExtend<NonNullable<AgentIntent['principal']>>()
      const principal = person('person/operator')
      const root = fixture({
        'team/worker/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: { principal: { kind: 'person', subject: 'person/operator' } } })`,
      })
      const subjects = yield* load(root)
      const declaration = subjects[0]?.declaration
      expect(declaration).toMatchObject({
        _tag: 'Module',
        intent: { id: 'team/worker', principal },
      })
      if (declaration?._tag !== 'Module' || 'principal' in declaration.intent === false) {
        return yield* Effect.die('Expected an agent module with a principal')
      }
      expect(emit([agent(declaration.intent)])).toBe(
        emit([agent({ id: 'team/worker', principal })]),
      )
    }),
  )

  it.effect('rejects an imported agent reference as principal during tree decoding', () =>
    Effect.gen(function* () {
      const root = fixture({
        'team/owner/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: {} })`,
        'team/worker/agent.ts': `${define}import owner from '../owner/agent.ts'\nexport default defineAgent({ meta: import.meta, intent: { principal: owner } })`,
      })
      expect(yield* loadError(root)).toMatchObject({
        path: 'team/worker/agent.ts',
        message: 'Invalid agent declaration',
      })
    }),
  )

  it.effect('lowers a typed mission reference to unpinned schedule work', () =>
    Effect.gen(function* () {
      const root = fixture({
        'ops/cycle/mission.ts': `${define}export default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: { id: 'ops/owner' }, goal: 'Cycle.', steps: [{ id: 'run', agentless: true }] } })`,
        'ops/weekly/schedule.ts': `${define}import cycle from '../cycle/mission.ts'\nexport default defineSchedule({ meta: import.meta, intent: { state: 'ready', reportTo: { id: 'ops/owner' }, goal: 'Weekly.', schedule: { id: 'tick', host: 'local', timing: { _tag: 'Every', every: '7d', anchor: '2026-09-28T07:00:00Z', catchUp: 'latest' }, work: { mission: cycle, workspace: '/srv/runs' } }, steps: [{ id: 'retire', agentless: true }] } })`,
      })
      const subjects = yield* load(root)
      expect(subjects[1]).toMatchObject({
        kind: 'schedule',
        id: 'ops/weekly',
        declaration: { intent: { schedule: { work: { mission: 'ops/cycle' } } } },
      })
    }),
  )

  it.effect(
    'retains exact source binding and explicit immutable pins, never latest-head work',
    () =>
      Effect.gen(function* () {
        const hash = 'a'.repeat(64)
        const root = fixture({
          'ops/cycle/mission.ts': `${define}export default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: { id: 'ops/owner' }, goal: 'Cycle.', steps: [{ id: 'run', agentless: true }] } })`,
          'ops/source/schedule.ts': `${define}import cycle from '../cycle/mission.ts'\nexport default defineSchedule({ meta: import.meta, intent: { state: 'ready', reportTo: { id: 'ops/owner' }, goal: 'Pinned.', schedule: { id: 'tick', host: 'local', timing: { _tag: 'At', at: '2026-10-20T07:00:00Z' }, work: { mission: pinMission({ subject: cycle }), workspace: '/srv/runs' } }, steps: [{ id: 'retire', agentless: true }] } })`,
          'ops/exact/schedule.ts': `${define}import cycle from '../cycle/mission.ts'\nexport default defineSchedule({ meta: import.meta, intent: { state: 'ready', reportTo: { id: 'ops/owner' }, goal: 'Pinned.', schedule: { id: 'tick', host: 'local', timing: { _tag: 'At', at: '2026-10-20T07:00:00Z' }, work: { mission: pinMission({ subject: cycle, revision: '${hash}' }), workspace: '/srv/runs' } }, steps: [{ id: 'retire', agentless: true, waitFor: pinMission({ subject: cycle, revision: '${hash}' }) }] } })`,
        })
        const subjects = yield* load(root)
        expect(subjects.find(({ id }) => id === 'ops/source')?.declaration).toMatchObject({
          intent: { schedule: { work: { mission: `ops/cycle@${'0'.repeat(64)}` } } },
        })
        expect(subjects.find(({ id }) => id === 'ops/exact')?.declaration).toMatchObject({
          intent: {
            schedule: { work: { mission: `ops/cycle@${hash}` } },
            steps: [{ usesMission: { kind: 'revision', revision: `ops/cycle@${hash}` } }],
          },
        })
      }),
  )

  it.effect('lowers imported subject review targets without traversing definition intent', () =>
    Effect.gen(function* () {
      const root = fixture({
        'owner/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: {} })`,
        'work/mission.ts': `${define}import owner from '../owner/agent.ts'\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: owner, goal: 'Review.', steps: [{ id: 'run', assignedTo: owner, gates: [{ name: 'review', kind: 'human', reviewer: { kind: 'person', subject: 'person/reviewer' }, review: [{ _tag: 'Subject', subject: owner }] }] }] } })`,
      })
      expect((yield* load(root)).find(({ id }) => id === 'work')?.declaration).toMatchObject({
        intent: { steps: [{ gates: [{ review: [{ _tag: 'Subject', subject: 'agent/owner' }] }] }] },
      })
    }),
  )

  it.effect('lowers imported subject reviews in loop until gates', () =>
    Effect.gen(function* () {
      const authoring = new URL('./mod.ts', import.meta.url).href
      const root = fixture({
        'owner/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: () => ({}) })`,
        'source/mission.ts': `${define}export default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: { id: 'owner' }, goal: 'Source.', steps: [{ id: 'run', agentless: true }] } })`,
        'work/mission.ts': `${define}import { Review } from '${authoring}'\nimport owner from '../owner/agent.ts'\nimport source from '../source/mission.ts'\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: owner, goal: 'Review.', steps: [{ id: 'loop', maxRounds: 2, onExhausted: { outcome: 'fail' }, until: [{ name: 'review', kind: 'human', reviewer: { kind: 'person', subject: 'person/reviewer' }, review: [Review.subject(owner), Review.subject(source)] }], round: { steps: [{ id: 'run', agentless: true }], completion: { when: 'all-steps-exhausted' } } }] } })`,
      })
      expect((yield* load(root)).find(({ id }) => id === 'work')?.declaration).toMatchObject({
        intent: {
          steps: [
            {
              until: [
                {
                  review: [
                    { _tag: 'Subject', subject: 'agent/owner' },
                    { _tag: 'Subject', subject: 'mission/source' },
                  ],
                },
              ],
            },
          ],
        },
      })
    }),
  )

  it.effect(
    'rejects pinned waitFor together with native usesMission instead of overwriting it',
    () =>
      Effect.gen(function* () {
        const root = fixture({
          'source/mission.ts': `${define}export default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: { id: 'owner' }, goal: 'Source.', steps: [{ id: 'run', agentless: true }] } })`,
          'work/mission.ts': `${define}import source from '../source/mission.ts'\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: { id: 'owner' }, goal: 'Wait.', steps: [{ id: 'wait', agentless: true, waitFor: pinMission({ subject: source, revision: '${'a'.repeat(64)}' }), usesMission: { kind: 'revision', revision: 'source@${'b'.repeat(64)}' } }] } })`,
        })
        expect(yield* loadError(root)).toMatchObject({
          path: 'work/mission.ts',
          message: 'A step cannot specify both pinned waitFor and usesMission',
        })
      }),
  )

  it('makes pinned waitFor and native usesMission exclusive in mission and round step types', () => {
    type PinnedWait = { id: string; agentless: true; waitFor: PinnedMissionRef }
    type NativeWait = {
      id: string
      agentless: true
      usesMission: { kind: 'revision'; revision: string }
    }
    type MissionStep = MissionIntent['steps'][number]
    type RoundStep = Extract<MissionStep, { readonly round: unknown }>['round']['steps'][number]
    expectTypeOf<PinnedWait>().toExtend<MissionStep>()
    expectTypeOf<NativeWait>().toExtend<MissionStep>()
    expectTypeOf<PinnedWait & NativeWait>().not.toExtend<MissionStep>()
    expectTypeOf<PinnedWait>().toExtend<RoundStep>()
    expectTypeOf<NativeWait>().toExtend<RoundStep>()
    expectTypeOf<PinnedWait & NativeWait>().not.toExtend<RoundStep>()
  })

  it('rejects malformed native hashes at the pin constructor', () => {
    const ref: MissionRef = {
      _tag: 'SubjectRef',
      kind: 'mission',
      url: 'file:///tree/m/mission.ts',
    }
    for (const hash of ['', 'latest', 'a'.repeat(63), 'g'.repeat(64)]) {
      expect(() => pinMission({ subject: ref, revision: hash })).toThrow('64-hex native revision')
    }
  })

  it.effect('rejects an imported reference whose canonical module lies outside the tree', () =>
    Effect.gen(function* () {
      const outside = fixture({
        'owner/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: {} })`,
      })
      const root = fixture({
        'work/mission.ts': `${define}import owner from '${join(outside, 'owner/agent.ts')}'\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: owner, goal: 'g', steps: [{ id: 's', agentless: true }] } })`,
      })
      expect(yield* loadError(root)).toMatchObject({
        path: 'work/mission.ts',
        message: expect.stringContaining('not a valid subject ID inside the tree'),
      })
    }),
  )

  it.effect('loads a symlinked alias directory once under its canonical ID', () =>
    Effect.gen(function* () {
      const root = fixture({
        'a/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: {} })`,
        'm/mission.ts': `${define}import a from '../alias/agent.ts'\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: a, goal: 'g', steps: [{ id: 's', assignedTo: a }] } })`,
      })
      symlinkSync(join(root, 'a'), join(root, 'alias'))
      const subjects = yield* load(root)
      expect(subjects.map(({ id, path }) => ({ id, path }))).toEqual([
        { id: 'a', path: 'a/agent.ts' },
        { id: 'm', path: 'm/mission.ts' },
      ])
      expect(subjects[1]?.declaration).toMatchObject({
        intent: { reportTo: { id: 'a' }, steps: [{ assignedTo: { id: 'a' } }] },
      })
    }),
  )

  it.effect('orders canonical paths when an alias sorts before its target', () =>
    Effect.gen(function* () {
      const root = fixture({
        'b/agent.kdl': 'version 2\nagent "b"\n',
        'z/agent.kdl': 'version 2\nagent "z"\n',
      })
      symlinkSync(join(root, 'z'), join(root, 'a'))
      const subjects = yield* load(root)
      expect(subjects.map(({ path }) => path)).toEqual(['b/agent.kdl', 'z/agent.kdl'])
    }),
  )

  it.effect('lowers typed supervisors, loop workers and final workers', () =>
    Effect.gen(function* () {
      const root = fixture({
        'owner/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: {} })`,
        'worker/agent.ts': `${define}import owner from '../owner/agent.ts'\nexport default defineAgent({ meta: import.meta, intent: { under: [{ target: owner, reason: 'Delegation.' }] } })`,
        'work/mission.ts': `${define}import owner from '../owner/agent.ts'\nimport worker from '../worker/agent.ts'\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: owner, assignedTo: worker, goal: 'g', steps: [{ id: 'loop', maxRounds: 2, onExhausted: { outcome: 'fail' }, round: { steps: [{ id: 'run', assignedTo: worker }], completion: { when: 'all-steps-exhausted' } } }], finally: [{ id: 'finish', assignedTo: worker }] } })`,
      })
      const subjects = yield* load(root)
      expect(subjects.find(({ id }) => id === 'worker')?.declaration).toMatchObject({
        intent: { under: [{ target: { id: 'owner' }, reason: 'Delegation.' }] },
      })
      expect(subjects.find(({ id }) => id === 'work')?.declaration).toMatchObject({
        intent: {
          reportTo: { id: 'owner' },
          assignedTo: { id: 'worker' },
          steps: [{ round: { steps: [{ assignedTo: { id: 'worker' } }] } }],
          finally: [{ assignedTo: { id: 'worker' } }],
        },
      })
    }),
  )

  it.effect('materializes current authoring templates and scoped step handles', () =>
    Effect.gen(function* () {
      const authoring = new URL('./mod.ts', import.meta.url).href
      const root = fixture({
        'work/mission.ts': `${define}import { input, step, t } from '${authoring}'\nconst head = input.text('head')\nconst first = step({ id: 'first', agentless: true, goal: t\`Review \${head}.\` })\nconst second = step({ id: 'second', agentless: true, dependsOn: first })\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: { id: 'owner' }, inputs: [head], goal: t\`Check \${head}.\`, steps: [first, second] } })`,
      })
      expect((yield* load(root))[0]?.declaration).toMatchObject({
        intent: {
          goal: ['Check ${input.head}.'],
          steps: [
            { id: 'first', goal: ['Review ${input.head}.'] },
            { id: 'second', dependsOn: [{ step: 'first', state: 'completed' }] },
          ],
        },
      })
    }),
  )

  it.effect('preserves scoped child-mission waitFor handles during reference lowering', () =>
    Effect.gen(function* () {
      const authoring = new URL('./mod.ts', import.meta.url).href
      const root = fixture({
        'owner/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: {} })`,
        'work/mission.ts': `${define}import { childMission, step } from '${authoring}'\nimport owner from '../owner/agent.ts'\nconst publish = step({ id: 'publish', assignedTo: { id: 'owner' }, produces: childMission\`child\` })\nconst execute = step({ id: 'execute', agentless: true, dependsOn: publish, waitFor: publish })\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: owner, goal: 'Run child.', steps: [publish, execute] } })`,
      })
      expect((yield* load(root)).find(({ id }) => id === 'work')?.declaration).toMatchObject({
        intent: {
          steps: [
            { id: 'publish', producesMission: 'child' },
            {
              id: 'execute',
              dependsOn: [{ step: 'publish', state: 'completed' }],
              usesMission: { kind: 'output', outputOf: 'publish' },
            },
          ],
        },
      })
    }),
  )

  it.effect('rejects a symlinked declaration outside the tree', () =>
    Effect.gen(function* () {
      const outside = fixture({ 'x/agent.kdl': 'version 2\nagent "x"\n' })
      const root = fixture({})
      symlinkSync(join(outside, 'x'), join(root, 'ext'))
      expect(yield* loadError(root)).toMatchObject({
        _tag: 'SubjectTreeError',
        path: 'ext/agent.kdl',
        message: expect.stringContaining('not a valid subject ID inside the tree'),
      })
    }),
  )

  it.effect('allows a seat and a mission at the same path', () =>
    Effect.gen(function* () {
      const subjects = yield* load(
        fixture({
          'a/agent.kdl': 'version 2\nagent "a"\n',
          'a/mission.kdl': 'version 2\nmission "a" state="ready" {\n  goal "g"\n}\n',
        }),
      )
      expect(subjects.map((subject) => subject.kind)).toEqual(['agent', 'mission'])
    }),
  )

  const mission = `{ state: 'ready', reportTo: { id: 'owner' }, goal: 'g', steps: [{ id: 's', agentless: true }] }`
  const rejections: ReadonlyArray<Case> = [
    {
      name: 'a mission without required reporting',
      files: {
        'a/mission.ts': `${define}export default defineMission({ meta: import.meta, intent: { state: 'ready', goal: 'g', steps: [{ id: 's', agentless: true }] } })`,
      },
      path: 'a/mission.ts',
      message: 'Invalid mission declaration',
    },
    {
      name: 'a legacy string assignee',
      files: {
        'a/mission.ts': `${define}export default defineMission({ meta: import.meta, intent: { ...${mission}, steps: [{ id: 's', assignedTo: 'agent/owner' }] } })`,
      },
      path: 'a/mission.ts',
      message: 'Invalid mission declaration',
    },
    {
      name: 'an excess mission property',
      files: {
        'a/mission.ts': `${define}export default defineMission({ meta: import.meta, intent: { ...${mission}, unexpected: true } })`,
      },
      path: 'a/mission.ts',
      message: 'Invalid mission declaration',
    },
    {
      name: 'agent.kdl and agent.ts in one directory',
      files: {
        'a/agent.kdl': 'version 2\nagent "a"\n',
        'a/agent.ts': `export default { id: 'a' }`,
      },
      path: 'a/agent.ts',
      message: 'Duplicate subject agent/a',
    },
    {
      name: 'mission and schedule in one directory',
      files: {
        'a/mission.kdl': 'version 2\nmission "a" state="ready" {\n  goal "g"\n}\n',
        'a/schedule.kdl': 'version 2\nmission "a" state="ready" {\n  schedule "s"\n}\n',
      },
      path: 'a/schedule.kdl',
      message: 'Duplicate subject mission/a',
    },
    ...(
      [
        ['a KDL node of another kind', 'version 2\nmission "a"\n'],
        ['a KDL node with another id', 'version 2\nagent "b"\n'],
        ['KDL without a version', 'agent "a"\n'],
        ['KDL with an extra node', 'version 2\nagent "a"\nagent "a/b"\n'],
      ] as const
    ).map(([name, text]) => ({
      name,
      files: { 'a/agent.kdl': text },
      path: 'a/agent.kdl',
      message: 'KDL declaration must be `version 2` followed by exactly one `agent "a"` node',
    })),
    {
      name: 'a scheduled mission.kdl',
      files: { 'a/mission.kdl': 'version 2\nmission "a" state="ready" {\n  schedule "s"\n}\n' },
      path: 'a/mission.kdl',
      message: 'must be declared in schedule.ts or schedule.kdl',
    },
    {
      name: 'an unscheduled schedule.kdl',
      files: { 'a/schedule.kdl': 'version 2\nmission "a" state="ready" {\n  goal "g"\n}\n' },
      path: 'a/schedule.kdl',
      message: 'A schedule file must declare a mission with a schedule',
    },
    {
      name: 'an unscheduled schedule.ts',
      files: { 'a/schedule.ts': `export default { id: 'a', ...${mission} }` },
      path: 'a/schedule.ts',
      message: 'A schedule file must declare a mission with a schedule',
    },
    {
      name: 'a TS definition of another kind',
      files: {
        'a/agent.ts': `${define}export default defineMission({ meta: import.meta, intent: ${mission} })`,
      },
      path: 'a/agent.ts',
      message: 'Module must export its own agent definition, got mission',
    },
    {
      name: "another module's TS definition",
      files: {
        'b/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: {} })`,
        'a/agent.ts': `export { default } from '../b/agent.ts'`,
      },
      path: 'a/agent.ts',
      message: 'Module must export its own agent definition, got agent from',
    },
    {
      name: 'a TS id that differs from the path',
      files: { 'a/agent.ts': `export default { id: 'b' }` },
      path: 'a/agent.ts',
      message: 'Declared id b must equal the subject directory a',
    },
    {
      name: 'a mission reference as a TS assignee',
      files: {
        'm/mission.ts': `${define}export default defineMission({ meta: import.meta, intent: ${mission} })`,
        'a/mission.ts': `${define}import m from '../m/mission.ts'\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', reportTo: { id: 'owner' }, goal: 'g', steps: [{ id: 's', assignedTo: m as never }] } })`,
      },
      path: 'a/mission.ts',
      message: 'Reference must point at agent.ts, got mission.ts',
    },
    {
      name: 'a forged pin with a malformed native revision',
      files: {
        'm/mission.ts': `${define}export default defineMission({ meta: import.meta, intent: ${mission} })`,
        'a/mission.ts': `${define}import m from '../m/mission.ts'\nexport default defineMission({ meta: import.meta, intent: { ...${mission}, steps: [{ id: 's', agentless: true, waitFor: { _tag: 'PinnedMissionRef', subject: m, revision: 'latest' } }] } })`,
      },
      path: 'a/mission.ts',
      message: 'Pinned mission revision must be a 64-hex native revision',
    },
    {
      name: 'a forged mission pin pointing to an agent',
      files: {
        'owner/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: {} })`,
        'a/mission.ts': `${define}import owner from '../owner/agent.ts'\nexport default defineMission({ meta: import.meta, intent: { ...${mission}, steps: [{ id: 's', agentless: true, waitFor: pinMission({ subject: owner, revision: '${'a'.repeat(64)}' }) }] } })`,
      },
      path: 'a/mission.ts',
      message: 'Reference must point at mission.ts, got agent.ts',
    },
    {
      name: 'source-receipt pin used outside the schedule binding flow',
      files: {
        'm/mission.ts': `${define}export default defineMission({ meta: import.meta, intent: ${mission} })`,
        'a/mission.ts': `${define}import m from '../m/mission.ts'\nexport default defineMission({ meta: import.meta, intent: { ...${mission}, steps: [{ id: 's', agentless: true, waitFor: pinMission({ subject: m }) }] } })`,
      },
      path: 'a/mission.ts',
      message: 'waitFor needs an explicit native revision; source receipt binding is schedule-only',
    },
  ]
  it.effect.each(rejections)('rejects $name', ({ files, path, message }) =>
    Effect.gen(function* () {
      expect(yield* loadError(fixture(files))).toMatchObject({
        _tag: 'SubjectTreeError',
        path,
        message: expect.stringContaining(message),
      })
    }),
  )

  it('preserves all canonical timing variants with typed mission work', () => {
    type Common = {
      id: string
      host: 'local'
      work: { mission: MissionRef | PinnedMissionRef; workspace: string }
    }
    expectTypeOf<
      Common & { timing: { _tag: 'Every'; every: string; anchor: '2026-10-20T00:00:00Z' } }
    >().toExtend<ScheduleIntent['schedule']>()
    expectTypeOf<
      Common & { timing: { _tag: 'Calendar'; at: string; timezone: string } }
    >().toExtend<ScheduleIntent['schedule']>()
    expectTypeOf<Common & { timing: { _tag: 'At'; at: '2026-10-20T00:00:00Z' } }>().toExtend<
      ScheduleIntent['schedule']
    >()
    expectTypeOf<Common>().not.toExtend<ScheduleIntent['schedule']>()
  })

  it('rejects references of the wrong kind at compile time', () => {
    expectTypeOf<MissionRef>().not.toExtend<AgentRef>()
    expectTypeOf<AgentRef>().not.toExtend<MissionRef>()
    const work: MissionRef = { _tag: 'SubjectRef', kind: 'mission', url: 'file:///t/m/mission.ts' }
    defineMission({
      meta: import.meta,
      intent: {
        state: 'ready',
        reportTo: { id: 'owner' },
        goal: 'g',
        // @ts-expect-error a mission reference cannot be a step assignee
        steps: [{ id: 's', assignedTo: work }],
      },
    })
  })
})
