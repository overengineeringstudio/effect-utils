import { Schema } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { childMission, emit, mission, missionWire, MissionSchema, runId, step } from './mod.ts'
import type { MissionProducer, StepInput } from './mod.ts'

const reporter = { id: 'example/coordinator' }
const revision = `example/child@${'a'.repeat(64)}`
const producerInput = {
  id: 'publish',
  assignedTo: reporter,
  goal: 'Publish the ready child mission.',
  produces: childMission`example/child/${runId}`,
} as const

const parent = {
  id: 'example/parent',
  state: 'ready',
  reportTo: reporter,
  goal: 'Publish and execute a child mission.',
} as const

const nativeProducer = {
  id: 'publish',
  assignedTo: reporter,
  goal: producerInput.goal,
  producesMission: producerInput.produces.id,
} as const
const nativeConsumer = {
  id: 'execute',
  agentless: true,
  dependsOn: [{ step: 'publish', state: 'completed' }],
  usesMission: { kind: 'output', outputOf: 'publish' },
} as const

const decodeParent = (steps: readonly unknown[]): void => {
  Schema.decodeUnknownSync(MissionSchema)({ ...parent, steps })
}

describe('native child missions', () => {
  it('renders typed producer and waitFor consumer as exact KDL', () => {
    const publish = step(producerInput)
    const execute = step({ id: 'execute', agentless: true, dependsOn: [publish], waitFor: publish })
    expectTypeOf(publish).toMatchTypeOf<MissionProducer>()
    expect(emit([mission({ ...parent, steps: [publish, execute] })])).toBe(
      'version 2\n' +
        'mission "example/parent" report-to="agent/example/coordinator" state="ready" {\n' +
        '  goal "Publish and execute a child mission."\n' +
        '  step "publish" {\n' +
        '    assigned-to "agent/example/coordinator"\n' +
        '    goal "Publish the ready child mission."\n' +
        '    produces-mission "example/child/${ST_MISSION_RUN}"\n' +
        '  }\n' +
        '  step "execute" {\n' +
        '    agentless\n' +
        '    depends-on {\n' +
        '      step "publish" "completed"\n' +
        '    }\n' +
        '    uses-mission output-of="publish"\n' +
        '  }\n' +
        '}\n',
    )
  })

  it('preserves validated child semantics across the explicit JSON wire boundary', () => {
    const publish = step(producerInput)
    const execute = step({ id: 'execute', agentless: true, dependsOn: [publish], waitFor: publish })
    const authored = { ...parent, steps: [publish, execute] }
    const wire = missionWire(authored)
    expect(emit([mission(JSON.parse(JSON.stringify(wire)))])).toBe(emit([mission(authored)]))
    expect(wire.steps).toMatchObject([nativeProducer, nativeConsumer])
  })

  it('requires a typed producer reference rather than an ordinary step', () => {
    expectTypeOf<StepInput<string>['waitFor']>().toMatchTypeOf<
      MissionProducer | { readonly kind: 'revision'; readonly revision: string } | undefined
    >()
  })

  it('renders an exact immutable revision without output-of', () => {
    expect(
      emit([step({ id: 'execute', agentless: true, waitFor: { kind: 'revision', revision } })]),
    ).toBe(`version 2\nstep "execute" {\n  agentless\n  uses-mission "${revision}"\n}\n`)
  })

  it('rejects a step that both produces and waits for a mission', () => {
    expect(() => step({ ...producerInput, waitFor: { kind: 'revision', revision } })).toThrow()
  })

  it('requires the waitFor consumer to be agentless', () => {
    const publish = step(producerInput)
    expect(() => step({ id: 'execute', dependsOn: [publish], waitFor: publish })).toThrow(
      'A child-mission waitFor step must be agentless',
    )
  })

  it('rejects a missing producer in native wire data', () => {
    expect(() => decodeParent([nativeConsumer])).toThrow()
  })

  it('rejects a native output target that does not produce a mission', () => {
    expect(() => decodeParent([{ id: 'publish', agentless: true }, nativeConsumer])).toThrow()
  })

  it.each(['failed', 'terminal'] as const)('requires completed, not %s', (state) => {
    expect(() =>
      decodeParent([
        nativeProducer,
        { ...nativeConsumer, dependsOn: [{ step: 'publish', state }] },
      ]),
    ).toThrow()
  })

  it('requires an explicit completed dependency', () => {
    const publish = step(producerInput)
    const execute = step({ id: 'execute', agentless: true, waitFor: publish })
    expect(() => mission({ ...parent, steps: [publish, execute] })).toThrow()
  })

  it('rejects a foreign producer handle even when its ID matches a local producer', () => {
    const foreign = step(producerInput)
    const publish = step(producerInput)
    const execute = step({ id: 'execute', agentless: true, dependsOn: [publish], waitFor: foreign })
    expect(() => mission({ ...parent, steps: [publish, execute] })).toThrow(
      'Mission output producer is not a handle in the same mission phase',
    )
  })

  it('does not consume normal-phase outputs from finalization', () => {
    const publish = step(producerInput)
    const execute = step({ id: 'execute', agentless: true, dependsOn: [publish], waitFor: publish })
    expect(() => mission({ ...parent, steps: [publish], finally: [execute] })).toThrow()
  })

  it.each(['example/child', 'example/child@abc', `example/child@${'g'.repeat(64)}`])(
    'rejects an unpinned or invalid revision %s',
    (invalid) => {
      expect(() =>
        step({ id: 'execute', waitFor: { kind: 'revision', revision: invalid } }),
      ).toThrow()
    },
  )

  it.each(['', '/child', 'child/', 'child//nested', 'child name'])(
    'rejects invalid produced mission ID %s',
    (id) => {
      expect(() => step({ id: 'publish', produces: childMission`${id}` })).toThrow()
    },
  )
})
