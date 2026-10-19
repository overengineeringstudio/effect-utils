import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'

import {
  Fragment,
  Launch,
  Mission,
  Round,
  completed,
  emit,
  failed,
  mission,
  missionWire,
  product,
  step,
  terminal,
  t,
} from './mod.ts'

const base = {
  id: 'example/release',
  state: 'ready',
  reportTo: { id: 'example/coordinator' },
  goal: 'Review and release the exact plan.',
  steps: [],
} as const

const command = (id: string) =>
  step({
    id,
    agentless: true,
    exec: {
      id: 'run',
      host: 'local',
      workspace: 'repo',
      launch: Launch.argv({ argv: ['git', 'status'] }),
      restart: 'never',
    },
  })

describe('immutable fragments and scoped rounds', () => {
  it.effect('composes without changing reusable fragments or handle identity', () =>
    Effect.sync(() => {
      const inspect = command('inspect')
      const fragment = Fragment.steps(inspect)
      const initial = Mission.make(base)
      const assembled = Mission.withSteps({ mission: initial, steps: fragment })
      expect(initial.steps).toEqual([])
      expect(assembled.steps[0]).toBe(inspect)
      expect(fragment[0]).toBe(inspect)
      expect(Object.isFrozen(fragment)).toBe(true)
      expect(Object.isFrozen(assembled)).toBe(true)
      expect(Object.isFrozen(assembled.steps)).toBe(true)
      expect(Object.isFrozen(inspect)).toBe(true)
      expect(missionWire(assembled).steps).toHaveLength(1)
    }),
  )

  it.effect('lowers round handles, failure dependencies and both finalizer phases', () =>
    Effect.sync(() => {
      const inspect = command('inspect')
      const repair = step({ id: 'repair', agentless: true, dependsOn: failed(inspect) })
      const settle = step({ id: 'settle', agentless: true, dependsOn: terminal(inspect) })
      const roundCleanup = command('round-cleanup')
      const missionCleanup = command('mission-cleanup')
      const input = Mission.withFinally({
        mission: Mission.withSteps({
          mission: Mission.make(base),
          steps: [
            {
              id: 'attempt',
              maxRounds: 2,
              round: Round.make({
                completion: { when: 'all-steps-exhausted' },
                steps: [inspect, repair, settle],
                finally: [roundCleanup],
              }),
            },
          ],
        }),
        steps: [missionCleanup],
      })
      const wire = missionWire(input)
      const loop = wire.steps[0]!
      expect('round' in loop).toBe(true)
      if (!('round' in loop)) throw new TypeError('Expected loop')
      expect(loop.round.steps[1]?.dependsOn).toEqual([{ step: 'inspect', state: 'failed' }])
      expect(loop.round.steps[2]?.dependsOn).toEqual([{ step: 'inspect', state: 'terminal' }])
      expect(loop.round.finally?.[0].id).toBe('round-cleanup')
      expect(wire.finally?.[0].id).toBe('mission-cleanup')
      expect(emit([mission(wire)])).toBe(emit([mission(input)]))
    }),
  )

  it.effect('rejects a handle dependency crossing round and mission phases', () =>
    Effect.sync(() => {
      const inspect = command('inspect')
      const apply = step({ id: 'apply', agentless: true, dependsOn: completed(inspect) })
      expect(() =>
        missionWire({
          ...base,
          steps: [
            inspect,
            {
              id: 'attempt',
              maxRounds: 2,
              round: { completion: { when: 'all-steps-exhausted' }, steps: [apply] },
            },
          ],
        }),
      ).toThrow('same mission phase')
    }),
  )

  it.effect('rejects duplicate use of one handle in distinct phases', () =>
    Effect.sync(() => {
      const inspect = command('inspect')
      expect(() => missionWire({ ...base, steps: [inspect], finally: [inspect] })).toThrow(
        'only one mission phase',
      )
    }),
  )

  it.effect('does not let a round product escape its native mission scope', () =>
    Effect.sync(() => {
      const inspect = step({
        id: 'inspect',
        agentless: true,
        produces: { plan: product.resource({ kind: 'filesystem.file', fields: {} }) },
      })
      const apply = step({ id: 'apply', agentless: true, goal: t`Use ${inspect.products.plan}` })
      expect(() =>
        missionWire({
          ...base,
          steps: [
            {
              id: 'attempt',
              maxRounds: 2,
              round: { completion: { when: 'all-steps-exhausted' }, steps: [inspect] },
            },
            apply,
          ],
        }),
      ).toThrow('outside this mission scope')
    }),
  )

  it.effect.prop(
    'round lowering is stable across the native boundary',
    [Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))],
    ([maxRounds]) =>
      Effect.sync(() => {
        const input = {
          ...base,
          steps: [
            {
              id: 'attempt',
              maxRounds,
              round: {
                completion: { when: 'all-steps-exhausted' as const },
                steps: [command('inspect')],
                finally: [command('cleanup')] as const,
              },
            },
          ],
        }
        const wire = missionWire(input)
        expect(missionWire(wire)).toEqual(wire)
        expect(emit([mission(wire)])).toBe(emit([mission(input)]))
      }),
  )
})
