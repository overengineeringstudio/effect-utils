import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { NodeFileSystem } from '@effect/platform-node'
import { describe, expect, expectTypeOf, it } from '@effect/vitest'
import { Effect } from 'effect'

import { defineMission, loadSubjectTree, type AgentRef, type MissionRef } from './tree.ts'

const treeModule = new URL('./tree.ts', import.meta.url).href

/** Writes files below a fresh root; each test gets distinct module URLs. */
const fixture = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), 'genie-smalltalk-tree-'))
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

const define = `import { defineAgent, defineMission, defineSchedule } from '${treeModule}'\n`

describe('loadSubjectTree', () => {
  it.effect('derives IDs from paths, passes context and lowers typed references', () =>
    Effect.gen(function* () {
      const root = fixture({
        'team/owner/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: (ctx: { workspace: string }) => ({ workspace: ctx.workspace, restart: 'always' }) })`,
        'team/review/mission.ts': `${define}import owner from '../owner/agent.ts'\nexport const publish = false\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', goal: 'Review.', steps: [{ id: 'read', assignedTo: owner }, { id: 'legacy', assignedTo: 'agent/elsewhere' }] } })`,
        'team/plain/mission.ts': `export default (ctx: { workspace: string }) => ({ id: 'team/plain', state: 'ready', goal: ctx.workspace, steps: [{ id: 'only', agentless: true }] })`,
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
      expect(subjects[2]?.declaration).toMatchObject({ intent: { goal: '/srv/team' } })
      expect(subjects[3]?.declaration).toMatchObject({
        intent: { steps: [{ assignedTo: 'agent/team/owner' }, { assignedTo: 'agent/elsewhere' }] },
        exports: { publish: false },
      })
    }),
  )

  it.effect('lowers a typed mission reference to unpinned schedule work', () =>
    Effect.gen(function* () {
      const root = fixture({
        'ops/cycle/mission.ts': `${define}export default defineMission({ meta: import.meta, intent: { state: 'ready', goal: 'Cycle.', steps: [{ id: 'run', agentless: true }] } })`,
        'ops/weekly/schedule.ts': `${define}import cycle from '../cycle/mission.ts'\nexport default defineSchedule({ meta: import.meta, intent: { state: 'ready', goal: 'Weekly.', schedule: { id: 'tick', host: 'local', every: '7d', anchor: '2026-09-28T07:00:00Z', catchUp: 'latest', work: { mission: cycle, workspace: '/srv/runs' } }, steps: [{ id: 'retire', agentless: true }] } })`,
      })
      const subjects = yield* load(root)
      expect(subjects[1]).toMatchObject({
        kind: 'schedule',
        id: 'ops/weekly',
        declaration: { intent: { schedule: { work: { mission: 'ops/cycle' } } } },
      })
    }),
  )

  it.effect('loads a symlinked alias directory once under its canonical ID', () =>
    Effect.gen(function* () {
      const root = fixture({
        'a/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: {} })`,
        'm/mission.ts': `${define}import a from '../alias/agent.ts'\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', goal: 'g', steps: [{ id: 's', assignedTo: a }] } })`,
      })
      symlinkSync(join(root, 'a'), join(root, 'alias'))
      const subjects = yield* load(root)
      expect(subjects.map(({ id, path }) => ({ id, path }))).toEqual([
        { id: 'a', path: 'a/agent.ts' },
        { id: 'm', path: 'm/mission.ts' },
      ])
      expect(subjects[1]?.declaration).toMatchObject({
        intent: { steps: [{ assignedTo: 'agent/a' }] },
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

  const mission = `{ state: 'ready', goal: 'g', steps: [{ id: 's', agentless: true }] }`
  const rejections: ReadonlyArray<Case> = [
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
        'a/mission.ts': `${define}import m from '../m/mission.ts'\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', goal: 'g', steps: [{ id: 's', assignedTo: m as never }] } })`,
      },
      path: 'a/mission.ts',
      message: 'Reference must point at agent.ts, got mission.ts',
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

  it('rejects references of the wrong kind at compile time', () => {
    expectTypeOf<MissionRef>().not.toExtend<AgentRef>()
    expectTypeOf<AgentRef>().not.toExtend<MissionRef>()
    const work: MissionRef = { _tag: 'SubjectRef', kind: 'mission', url: 'file:///t/m/mission.ts' }
    defineMission({
      meta: import.meta,
      intent: {
        state: 'ready',
        goal: 'g',
        // @ts-expect-error a mission reference cannot be a step assignee
        steps: [{ id: 's', assignedTo: work }],
      },
    })
  })
})
