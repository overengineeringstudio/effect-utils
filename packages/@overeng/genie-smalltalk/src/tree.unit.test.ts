import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
        'team/owner/agent.ts': `${define}export default defineAgent(import.meta, (ctx: { workspace: string }) => ({ workspace: ctx.workspace, restart: 'always' }))`,
        'team/review/mission.ts': `${define}import owner from '../owner/agent.ts'\nexport const publish = false\nexport default defineMission(import.meta, { state: 'ready', goal: 'Review.', steps: [{ id: 'read', assignedTo: owner }, { id: 'legacy', assignedTo: 'agent/elsewhere' }] })`,
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
        'ops/cycle/mission.ts': `${define}export default defineMission(import.meta, { state: 'ready', goal: 'Cycle.', steps: [{ id: 'run', agentless: true }] })`,
        'ops/weekly/schedule.ts': `${define}import cycle from '../cycle/mission.ts'\nexport default defineSchedule(import.meta, { state: 'ready', goal: 'Weekly.', schedule: { id: 'tick', host: 'local', every: '7d', anchor: '2026-09-28T07:00:00Z', catchUp: 'latest', work: { mission: cycle, workspace: '/srv/runs' } }, steps: [{ id: 'retire', agentless: true }] })`,
      })
      const subjects = yield* load(root)
      expect(subjects[1]).toMatchObject({
        kind: 'schedule',
        id: 'ops/weekly',
        declaration: { intent: { schedule: { work: { mission: 'ops/cycle' } } } },
      })
    }),
  )

  it.effect.each([
    { files: { 'a/agent.kdl': 'version 2\nagent "a"\n', 'a/agent.ts': '' }, path: 'a/agent.ts' },
    {
      files: {
        'a/mission.kdl': 'version 2\nmission "a" state="ready" {\n  goal "g"\n}\n',
        'a/schedule.kdl': 'version 2\nmission "a" state="ready" {\n  schedule "s"\n}\n',
      },
      path: 'a/schedule.kdl',
    },
  ])('rejects a second declaration in one st namespace ($path)', ({ files, path }) =>
    Effect.gen(function* () {
      expect(yield* loadError(fixture(files))).toMatchObject({ _tag: 'SubjectTreeError', path })
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

  it.effect.each([
    ['node kind', 'version 2\nmission "a"\n'],
    ['node id', 'version 2\nagent "b"\n'],
    ['missing version', 'agent "a"\n'],
    ['extra node', 'version 2\nagent "a"\nagent "a/b"\n'],
  ])('rejects a KDL declaration whose %s disagrees with its path', ([, text]) =>
    Effect.gen(function* () {
      const error = yield* loadError(fixture({ 'a/agent.kdl': text }))
      expect(error).toMatchObject({ _tag: 'SubjectTreeError', path: 'a/agent.kdl' })
    }),
  )

  it.effect.each([
    ['mission.kdl', 'version 2\nmission "a" state="ready" {\n  schedule "s"\n}\n'],
    ['schedule.kdl', 'version 2\nmission "a" state="ready" {\n  goal "g"\n}\n'],
  ])('rejects a schedule declared as the wrong file kind (%s)', ([name, text]) =>
    Effect.gen(function* () {
      const error = yield* loadError(fixture({ [`a/${name}`]: text }))
      expect(error).toMatchObject({ _tag: 'SubjectTreeError', path: `a/${name}` })
    }),
  )

  it.effect.each([
    [
      'a definition of another kind',
      { 'a/agent.ts': `${define}export default defineMission(import.meta, { state: 'ready', goal: 'g', steps: [{ id: 's', agentless: true }] })` },
    ],
    [
      "another module's definition",
      {
        'b/agent.ts': `${define}export default defineAgent(import.meta, {})`,
        'a/agent.ts': `export { default } from '../b/agent.ts'`,
      },
    ],
    ['a declared id that differs from the path', { 'a/agent.ts': `export default { id: 'b' }` }],
    [
      'a mission reference as an assignee',
      {
        'm/mission.ts': `${define}export default defineMission(import.meta, { state: 'ready', goal: 'g', steps: [{ id: 's', agentless: true }] })`,
        'a/mission.ts': `${define}import m from '../m/mission.ts'\nexport default defineMission(import.meta, { state: 'ready', goal: 'g', steps: [{ id: 's', assignedTo: m as never }] })`,
      },
    ],
  ])('rejects a TS module with %s', ([, files]) =>
    Effect.gen(function* () {
      const error = yield* loadError(fixture(files))
      expect(error).toMatchObject({ _tag: 'SubjectTreeError', path: Object.keys(files).at(-1) })
    }),
  )

  it('rejects references of the wrong kind at compile time', () => {
    expectTypeOf<MissionRef>().not.toExtend<AgentRef>()
    expectTypeOf<AgentRef>().not.toExtend<MissionRef>()
    const work: MissionRef = { _tag: 'SubjectRef', kind: 'mission', url: 'file:///t/m/mission.ts' }
    defineMission(import.meta, {
      state: 'ready',
      goal: 'g',
      // @ts-expect-error a mission reference cannot be a step assignee
      steps: [{ id: 's', assignedTo: work }],
    })
  })
})
