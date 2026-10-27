import { Schema, SchemaAST } from 'effect'
import { describe, expect, it } from 'vitest'

import * as Fractal from '@overeng/genie-fractal'
import * as Testing from '@overeng/genie-fractal/testing'
import * as Tree from '@overeng/genie-fractal/tree'

import * as legacy from './mod.ts'
import * as legacyTesting from './testing.ts'
import * as legacyTree from './tree.ts'

describe('genie-smalltalk compatibility alias', () => {
  it('reexports every root value with the same schema and function identity', () => {
    expect(Object.keys(legacy).sort()).toEqual([...Object.keys(Fractal), 'smalltalkKdl'].sort())
    for (const [name, value] of Object.entries(Fractal)) {
      expect(Reflect.get(legacy, name), name).toBe(value)
    }
    expect(legacy.smalltalkKdl).toBe(Fractal.fractalKdl)
    expect(legacy.smalltalkKdl).toBe(legacy.fractalKdl)

    const subject = Schema.decodeSync(legacy.SubjectId)('example/compatibility')
    expect(Schema.decodeSync(Fractal.SubjectId)(subject)).toBe(subject)
    expect(legacy.person('person/reviewer')).toEqual(Fractal.person('person/reviewer'))

    const nodes = [legacy.node({ name: 'mission', args: [subject] })]
    const output = legacy.smalltalkKdl(nodes)
    const context = { cwd: '', location: '' }
    expect(output.data).toBe(nodes)
    expect(output.stringify(context)).toBe('version 2\nmission "example/compatibility"\n')
    expect(output.stringify(context)).toBe(Fractal.fractalKdl(nodes).stringify(context))
    expect(output.validate?.(context)).toEqual([])
  })

  it('shares the actual tree exports and interoperable mission references', () => {
    expect(Object.keys(legacyTree).sort()).toEqual(Object.keys(Tree).sort())
    for (const [name, value] of Object.entries(Tree)) {
      expect(Reflect.get(legacyTree, name), name).toBe(value)
    }

    const subject = legacyTree.defineMission({
      meta: { url: new URL('./compatibility/mission.ts', import.meta.url).href },
      intent: {
        state: 'ready',
        reportTo: { id: 'example/owner' },
        goal: 'Prove alias interoperability.',
        steps: [],
      },
    })
    const revision = 'a'.repeat(64)
    const pinned = Tree.pinMission({ subject, revision })
    expect(pinned.subject).toBe(subject)
    expect(legacyTree.pinMission({ subject, revision })).toEqual(pinned)
    expect(
      new legacyTree.SubjectTreeError({ path: 'mission.ts', message: 'invalid declaration' }),
    ).toBeInstanceOf(Tree.SubjectTreeError)
  })

  it('shares testing services, errors, and the daemon layer factory without starting a daemon', () => {
    expect(Object.keys(legacyTesting).sort()).toEqual(Object.keys(Testing).sort())
    for (const [name, value] of Object.entries(Testing)) {
      expect(Reflect.get(legacyTesting, name), name).toBe(value)
    }
    expect(legacyTesting.ScratchDaemon).toBe(Testing.ScratchDaemon)
    expect(legacyTesting.scratchDaemonLayer).toBe(Testing.scratchDaemonLayer)
    expect(new legacyTesting.ScratchDaemonError({ message: 'not started' })).toBeInstanceOf(
      Testing.ScratchDaemonError,
    )
  })

  it.each([
    [Fractal.SubjectId, 'Fractal.SubjectId'],
    [Fractal.AgentSchema, 'Fractal.Agent'],
    [Fractal.MissionSchema, 'Fractal.Mission'],
    [Fractal.OmpSchema, 'Fractal.Omp'],
  ] as const)('uses the new diagnostic identifier %s', (schema, identifier) => {
    expect(SchemaAST.resolveIdentifier(schema.ast)).toBe(identifier)
  })
})
