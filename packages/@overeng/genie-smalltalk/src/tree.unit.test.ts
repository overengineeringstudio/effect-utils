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

/** A tree that fails to load, blaming the file at `path`. */
type Case = {
  readonly name: string
  readonly files: Readonly<Record<string, string>>
  readonly path: string
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

  const duplicates: ReadonlyArray<Case> = [
    {
      name: 'agent.kdl and agent.ts',
      files: { 'a/agent.kdl': 'version 2\nagent "a"\n', 'a/agent.ts': '' },
      path: 'a/agent.ts',
    },
    {
      name: 'mission and schedule',
      files: {
        'a/mission.kdl': 'version 2\nmission "a" state="ready" {\n  goal "g"\n}\n',
        'a/schedule.kdl': 'version 2\nmission "a" state="ready" {\n  schedule "s"\n}\n',
      },
      path: 'a/schedule.kdl',
    },
  ]
  it.effect.each(duplicates)('rejects $name in one st namespace', ({ files, path }) =>
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

  const kdlMismatches: ReadonlyArray<Case> = [
    {
      name: 'node kind',
      files: { 'a/agent.kdl': 'version 2\nmission "a"\n' },
      path: 'a/agent.kdl',
    },
    { name: 'node id', files: { 'a/agent.kdl': 'version 2\nagent "b"\n' }, path: 'a/agent.kdl' },
    { name: 'missing version', files: { 'a/agent.kdl': 'agent "a"\n' }, path: 'a/agent.kdl' },
    {
      name: 'extra node',
      files: { 'a/agent.kdl': 'version 2\nagent "a"\nagent "a/b"\n' },
      path: 'a/agent.kdl',
    },
    {
      name: 'scheduled mission.kdl',
      files: { 'a/mission.kdl': 'version 2\nmission "a" state="ready" {\n  schedule "s"\n}\n' },
      path: 'a/mission.kdl',
    },
    {
      name: 'unscheduled schedule.kdl',
      files: { 'a/schedule.kdl': 'version 2\nmission "a" state="ready" {\n  goal "g"\n}\n' },
      path: 'a/schedule.kdl',
    },
  ]
  it.effect.each(kdlMismatches)(
    'rejects a KDL $name that disagrees with its path',
    ({ files, path }) =>
      Effect.gen(function* () {
        expect(yield* loadError(fixture(files))).toMatchObject({ _tag: 'SubjectTreeError', path })
      }),
  )

  const moduleMismatches: ReadonlyArray<Case> = [
    {
      name: 'a definition of another kind',
      files: {
        'a/agent.ts': `${define}export default defineMission({ meta: import.meta, intent: { state: 'ready', goal: 'g', steps: [{ id: 's', agentless: true }] } })`,
      },
      path: 'a/agent.ts',
    },
    {
      name: "another module's definition",
      files: {
        'b/agent.ts': `${define}export default defineAgent({ meta: import.meta, intent: {} })`,
        'a/agent.ts': `export { default } from '../b/agent.ts'`,
      },
      path: 'a/agent.ts',
    },
    {
      name: 'a declared id that differs from the path',
      files: { 'a/agent.ts': `export default { id: 'b' }` },
      path: 'a/agent.ts',
    },
    {
      name: 'a mission reference as an assignee',
      files: {
        'm/mission.ts': `${define}export default defineMission({ meta: import.meta, intent: { state: 'ready', goal: 'g', steps: [{ id: 's', agentless: true }] } })`,
        'a/mission.ts': `${define}import m from '../m/mission.ts'\nexport default defineMission({ meta: import.meta, intent: { state: 'ready', goal: 'g', steps: [{ id: 's', assignedTo: m as never }] } })`,
      },
      path: 'a/mission.ts',
    },
  ]
  it.effect.each(moduleMismatches)('rejects a TS module with $name', ({ files, path }) =>
    Effect.gen(function* () {
      expect(yield* loadError(fixture(files))).toMatchObject({ _tag: 'SubjectTreeError', path })
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
