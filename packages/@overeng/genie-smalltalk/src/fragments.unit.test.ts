import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'

import {
  Fragment,
  Launch,
  Mission,
  Review,
  Round,
  completed,
  emit,
  failed,
  gate,
  input,
  mission,
  missionWire,
  product,
  step,
  terminal,
  t,
  type MissionInput,
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

  it('snapshots mutable plain fragment steps and appended finalizers recursively', () => {
    const authored = {
      id: 'inspect',
      agentless: true,
      goal: ['Inspect the original plan.'] as [string],
      retry: { attempts: 2 },
      metadata: { _tag: 'Authored', labels: ['original'] },
    }
    const fragment = Fragment.steps(authored)
    const cleanup = { id: 'cleanup', agentless: true, retry: { attempts: 3 } }
    const assembled = Mission.withFinally({
      mission: Mission.withSteps({ mission: Mission.make(base), steps: fragment }),
      steps: [cleanup],
    })
    authored.id = 'changed'
    authored.goal[0] = 'Changed plan.'
    authored.retry.attempts = 9
    authored.metadata.labels.push('changed')
    cleanup.retry.attempts = 9

    expect(fragment[0]).not.toBe(authored)
    expect(fragment[0].id).toBe('inspect')
    expect(fragment[0].goal).toEqual(['Inspect the original plan.'])
    expect(fragment[0].retry.attempts).toBe(2)
    expect(fragment[0].metadata.labels).toEqual(['original'])
    expect(Object.isFrozen(fragment[0])).toBe(true)
    expect(Object.isFrozen(fragment[0].goal)).toBe(true)
    expect(Object.isFrozen(fragment[0].retry)).toBe(true)
    expect(Object.isFrozen(fragment[0].metadata.labels)).toBe(true)
    expect(Object.isFrozen(authored)).toBe(false)
    expect(assembled.finally?.[0]).toEqual({
      id: 'cleanup',
      agentless: true,
      retry: { attempts: 3 },
    })
  })

  it('isolates mission inputs, loops, completion frontiers and both round phases', () => {
    const work = { id: 'work', agentless: true, retry: { attempts: 2 } }
    const cleanup = { id: 'cleanup', agentless: true, retry: { attempts: 3 } }
    const roundInput = {
      completion: { dependsOn: ['work'] as [string] },
      steps: [work],
      finally: [cleanup] as [typeof cleanup],
    }
    const loop = { id: 'attempt', maxRounds: 2, round: roundInput }
    const authored = {
      ...base,
      goal: ['Original mission goal.'] as [string],
      reportTo: { id: 'example/coordinator' },
      inputs: [{ name: 'plan', kind: 'text' as const }],
      constraints: ['Original constraint.'],
      completion: { dependsOn: ['attempt'] as [string] },
      steps: [loop],
    } satisfies MissionInput<string>
    const round = Round.make(roundInput)
    const composed = Mission.make(authored)
    authored.goal[0] = 'Changed mission goal.'
    authored.reportTo.id = 'example/changed'
    authored.inputs[0]!.name = 'changed'
    authored.inputs.push({ name: 'added', kind: 'text' })
    authored.constraints.push('Changed constraint.')
    authored.completion.dependsOn[0] = 'changed'
    authored.steps.push({ ...loop, id: 'added' })
    loop.maxRounds = 9
    roundInput.completion.dependsOn[0] = 'changed'
    roundInput.steps.push({ ...work, id: 'added' })
    work.retry.attempts = 9
    cleanup.retry.attempts = 9

    expect(composed.goal).toEqual(['Original mission goal.'])
    expect(composed.reportTo).toEqual({ id: 'example/coordinator' })
    expect(composed.inputs).toEqual([{ name: 'plan', kind: 'text' }])
    expect(composed.constraints).toEqual(['Original constraint.'])
    expect(composed.completion).toEqual({ dependsOn: ['attempt'] })
    expect(composed.steps).toEqual([{ id: 'attempt', maxRounds: 2, round }])
    expect(round.completion).toEqual({ dependsOn: ['work'] })
    expect(round.steps).toEqual([{ id: 'work', agentless: true, retry: { attempts: 2 } }])
    expect(round.finally).toEqual([{ id: 'cleanup', agentless: true, retry: { attempts: 3 } }])
    expect(Object.isFrozen(composed.inputs?.[0])).toBe(true)
    expect(Object.isFrozen(composed.constraints)).toBe(true)
    expect(Object.isFrozen(composed.completion)).toBe(true)
    expect(Object.isFrozen(round.completion)).toBe(true)
    expect(Object.isFrozen(round.steps[0]?.retry)).toBe(true)
    expect(Object.isFrozen(round.finally?.[0]?.retry)).toBe(true)
  })

  it('retains branded handles and reference provenance inside snapshotted plain data', () => {
    const plan = input.text('plan')
    const artifact = product.resource({ kind: 'filesystem.file', fields: {} })
    const inspect = step({
      missionId: base.id,
      id: 'inspect',
      agentless: true,
      produces: { artifact },
    })
    const dependency = completed(inspect)
    const goal = t`Use ${plan} and ${artifact}`
    const effect = Effect.succeed('unchanged')
    const review = Review.subject(t`doc/example/${plan}`)
    const authored = {
      id: 'apply',
      agentless: true,
      goal,
      metadata: { plan, artifact, dependency, effect, review },
    }
    const fragment = Fragment.steps(inspect, authored)
    const round = Round.make({ completion: { when: 'all-steps-exhausted' }, steps: fragment })
    const composed = Mission.make({ ...base, inputs: [plan], steps: fragment })

    expect(fragment[0]).toBe(inspect)
    expect(fragment[1]).not.toBe(authored)
    expect(fragment[1].goal).toBe(goal)
    expect(fragment[1].metadata.plan).toBe(plan)
    expect(fragment[1].metadata.artifact).toBe(artifact)
    expect(fragment[1].metadata.dependency).toBe(dependency)
    expect(fragment[1].metadata.dependency.handle).toBe(inspect)
    expect(fragment[1].metadata.effect).toBe(effect)
    expect(fragment[1].metadata.review).toBe(review)
    expect(round.steps[0]).toBe(inspect)
    expect(composed.steps[0]).toBe(inspect)
    expect(composed.inputs?.[0]).toBe(plan)
    expect(missionWire(composed).steps[1]?.goal).toEqual([goal.text])
  })

  it('retains gate provenance so composition cannot hide undeclared inputs', () => {
    const head = input.text('head')
    const check = gate.ciPassed({ check: 'build', repo: 'example/repository', commit: head })
    const composed = Mission.make({
      ...base,
      steps: [{ id: 'inspect', agentless: true, gates: [check] }],
    })
    expect(composed.steps[0]).toMatchObject({ gates: [check] })
    expect(() => missionWire(composed)).toThrow('Input head is not declared by this mission')
  })

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
