import { describe, expect, it } from 'vitest'

import {
  childMission,
  doc,
  emit,
  gate,
  input,
  mission,
  missionWire,
  person,
  product,
  step,
  t,
} from './mod.ts'

const reporter = { id: 'example/coordinator' }
const parent = {
  id: 'example/parent',
  state: 'ready',
  reportTo: reporter,
  goal: 'Prove authoring boundaries.',
} as const

const pin = `example/child@${'a'.repeat(64)}`

describe('authoring and native wire boundaries', () => {
  it('requires agentless for an exact revision waitFor too', () => {
    expect(() =>
      step({ id: 'execute', assignedTo: reporter, waitFor: { kind: 'revision', revision: pin } }),
    ).toThrow('A child-mission waitFor step must be agentless')
  })

  it('preserves native mission IDs containing @ in an exact revision', () => {
    const revision = `example/child@variant@${'a'.repeat(64)}`
    expect(
      emit([step({ id: 'execute', agentless: true, waitFor: { kind: 'revision', revision } })]),
    ).toContain(`uses-mission "${revision}"`)
  })

  it('does not treat escaped native input examples as declared-input references', () => {
    expect(
      emit([
        mission({
          ...parent,
          goal: 'Explain $${input.example} literally.',
          steps: [{ id: 'explain', agentless: true, goal: 'Also preserve $${input.other}.' }],
        }),
      ]),
    ).toContain('Explain $${input.example} literally.')
  })

  it('rejects equal-name foreign input identities in a root text template', () => {
    const declared = input.text('commit')
    const foreign = input.text('commit')
    expect(() =>
      missionWire({
        ...parent,
        inputs: [declared],
        goal: t`Review ${foreign}.`,
        steps: [{ id: 'review', agentless: true }],
      }),
    ).toThrow('Input commit is not declared by this mission')
  })

  it('rejects equal-name foreign input identities in a document template', () => {
    const declared = input.text('commit')
    const foreign = input.text('commit')
    expect(() =>
      missionWire({
        ...parent,
        inputs: [declared],
        gates: [gate.document(doc`doc/example/${foreign}`)],
        steps: [{ id: 'review', agentless: true }],
      }),
    ).toThrow('Input commit is not declared by this mission')
  })

  it('rejects equal-name foreign input identities in a child mission template', () => {
    const declared = input.text('commit')
    const foreign = input.text('commit')
    const publish = step({
      id: 'publish',
      assignedTo: reporter,
      produces: childMission`example/${foreign}`,
    })
    expect(() => missionWire({ ...parent, inputs: [declared], steps: [publish] })).toThrow(
      'Input commit is not declared by this mission',
    )
  })

  it('retains foreign product provenance through a text template', () => {
    const receipt = product.field({ subject: 'message/example/receipt', fields: { text: 'ready' } })
    step({ id: 'foreign', produces: { receipt } })
    const local = step({ id: 'local', agentless: true, goal: t`Review ${receipt}.` })
    expect(() => missionWire({ ...parent, steps: [local] })).toThrow(
      'Product reference belongs to a step outside this mission',
    )
  })

  it('retains exact template ownership in human questions and dynamic merged locators', () => {
    const declared = input.text('locator')
    const foreign = input.text('locator')
    const local = step({ id: 'land', agentless: true, gates: [gate.merged(t`${foreign}`)] })
    expect(() => missionWire({ ...parent, inputs: [declared], steps: [local] })).toThrow(
      'Input locator is not declared by this mission',
    )
    expect(() =>
      missionWire({
        ...parent,
        inputs: [declared],
        gates: [
          gate.human({ reviewer: person('person/reviewer'), question: t`Review ${foreign}?` }),
        ],
        steps: [{ id: 'review', agentless: true }],
      }),
    ).toThrow('Input locator is not declared by this mission')
  })

  it('projects imported agent metadata before JSON, including loop and final workers', () => {
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const imported = { id: reporter.id, kit: { counter: 1n, cycle } }
    const wire = missionWire({
      ...parent,
      reportTo: imported,
      assignedTo: imported,
      steps: [
        step({ id: 'normal', assignedTo: imported }),
        {
          id: 'iterate',
          maxRounds: 1,
          round: {
            completion: { when: 'all-steps-exhausted' },
            steps: [{ id: 'round', assignedTo: imported }],
            finally: [{ id: 'round-final', assignedTo: imported }],
          },
        },
      ],
      finally: [{ id: 'final', assignedTo: imported }],
    })
    expect(wire.reportTo).toEqual(reporter)
    expect(wire.assignedTo).toEqual(reporter)
    expect(() => JSON.stringify(wire)).not.toThrow()
    expect(JSON.stringify(wire)).not.toContain('kit')
    expect(emit([mission(wire)])).toBe(
      emit([
        mission({
          ...parent,
          reportTo: imported,
          assignedTo: imported,
          steps: [
            { id: 'normal', assignedTo: imported },
            {
              id: 'iterate',
              maxRounds: 1,
              round: {
                completion: { when: 'all-steps-exhausted' },
                steps: [{ id: 'round', assignedTo: imported }],
                finally: [{ id: 'round-final', assignedTo: imported }],
              },
            },
          ],
          finally: [{ id: 'final', assignedTo: imported }],
        }),
      ]),
    )
  })
})
