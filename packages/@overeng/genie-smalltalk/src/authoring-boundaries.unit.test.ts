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
import type { MissionInput, TextInput } from './mod.ts'

const reporter = { id: 'example/coordinator' }
const parent = {
  id: 'example/parent',
  state: 'ready',
  reportTo: reporter,
  goal: 'Prove authoring boundaries.',
} as const

const pin = `example/child@${'a'.repeat(64)}`

const textGates = (value: TextInput) => [
  gate.exists(t`resource/example/${value}`, { name: 'exists' }),
  gate.empty(t`mission-run/example/${value}`, { name: 'empty' }),
  gate.has(t`message/example/${value}`, t`contains ${value}`, { name: 'has' }),
  gate.lacks(t`doc/example/${value}`, t`absent ${value}`, { name: 'lacks' }),
  gate.fieldIs({
    subject: t`resource/example/${value}`,
    path: 'sha',
    value: t`${value}`,
    name: 'field',
  }),
  gate.exists('resource/example', { name: t`${value}` }),
  gate.human({
    name: 'review',
    reviewer: person('person/reviewer'),
    review: [t`resource/example/${value}`, doc`doc/example/${value}`],
  }),
  gate.exec({ name: 'exec', command: 'true', host: t`${value}`, workspace: t`/work/${value}` }),
  gate.exec({
    name: 'env',
    command: t`check ${value}`,
    host: 'dev3',
    workspace: '/work',
    env: { CHECK: value },
  }),
  gate.merged(t`example/repo#${value}`, {
    name: 'merged',
    host: t`${value}`,
    workspace: t`/work/${value}`,
  }),
  gate.ciPassed(t`check-${value}`, {
    name: 'ci',
    repo: t`example/${value}`,
    branch: t`${value}`,
    host: t`${value}`,
    workspace: t`/work/${value}`,
  }),
  gate.document(doc`doc/example/proof`, { name: t`proof-${value}` }),
]

const isolatedGateTexts: readonly [
  string,
  (value: TextInput) => Parameters<typeof gate.render>[0],
][] = [
  ['exists subject', (v) => gate.exists(t`resource/example/${v}`)],
  ['empty subject', (v) => gate.empty(t`mission-run/example/${v}`)],
  ['has subject', (v) => gate.has(t`message/example/${v}`, 'ready')],
  ['has text', (v) => gate.has('message/example', t`${v}`)],
  ['lacks subject', (v) => gate.lacks(t`doc/example/${v}`, 'ready')],
  ['lacks text', (v) => gate.lacks('doc/example', t`${v}`)],
  [
    'field subject',
    (v) => gate.fieldIs({ subject: t`resource/example/${v}`, path: 'sha', value: 'ready' }),
  ],
  [
    'field value',
    (v) => gate.fieldIs({ subject: 'resource/example', path: 'sha', value: t`${v}` }),
  ],
  ['explicit name', (v) => gate.exists('resource/example', { name: t`${v}` })],
  [
    'human review text',
    (v) => gate.human({ reviewer: person('person/reviewer'), review: [t`resource/example/${v}`] }),
  ],
  [
    'human review document',
    (v) => gate.human({ reviewer: person('person/reviewer'), review: [doc`doc/example/${v}`] }),
  ],
  ['exec host', (v) => gate.exec({ command: 'true', host: t`${v}`, workspace: '/work' })],
  ['exec workspace', (v) => gate.exec({ command: 'true', host: 'dev3', workspace: t`/work/${v}` })],
  ['exec command', (v) => gate.exec({ command: t`check ${v}`, host: 'dev3', workspace: '/work' })],
  [
    'exec env',
    (v) => gate.exec({ command: 'true', host: 'dev3', workspace: '/work', env: { CHECK: v } }),
  ],
  ['merged host', (v) => gate.merged(t`example/repo#7`, { host: t`${v}` })],
  ['merged workspace', (v) => gate.merged(t`example/repo#7`, { workspace: t`/work/${v}` })],
  ['CI check', (v) => gate.ciPassed(t`check-${v}`, { repo: 'example/repo', branch: 'main' })],
  ['CI repository', (v) => gate.ciPassed('build', { repo: t`example/${v}`, branch: 'main' })],
  ['CI branch', (v) => gate.ciPassed('build', { repo: 'example/repo', branch: t`${v}` })],
  [
    'CI host',
    (v) => gate.ciPassed('build', { repo: 'example/repo', branch: 'main', host: t`${v}` }),
  ],
  [
    'CI workspace',
    (v) =>
      gate.ciPassed('build', { repo: 'example/repo', branch: 'main', workspace: t`/work/${v}` }),
  ],
  ['document name', (v) => gate.document(doc`doc/example/proof`, { name: t`proof-${v}` })],
]

const textPlacements = [
  'constraints',
  'exec',
  'plain-exec',
  'final-exec',
  'loop-exec',
  'loop-final-exec',
  'attention',
  'product',
] as const
const missionWithText = (
  value: TextInput,
  placement: (typeof textPlacements)[number],
): MissionInput<string> => {
  const command = {
    id: 'command',
    restart: 'never',
    host: t`${value}`,
    workspace: t`/work/${value}`,
    command: t`git checkout ${value}`,
  } as const
  const worker = { id: 'work', agentless: true, exec: command } as const
  const loopNode = {
    id: 'iterate',
    maxRounds: 1,
    round: { completion: { when: 'all-steps-exhausted' }, steps: [worker] },
  } as const
  switch (placement) {
    case 'constraints':
      return { ...parent, constraints: [t`Keep ${value} fixed.`], steps: [] }
    case 'exec':
      return { ...parent, steps: [step(worker)] }
    case 'plain-exec':
      return { ...parent, steps: [worker] }
    case 'final-exec':
      return { ...parent, steps: [], finally: [worker] }
    case 'loop-exec':
      return { ...parent, steps: [loopNode] }
    case 'loop-final-exec':
      return {
        ...parent,
        steps: [{ ...loopNode, round: { ...loopNode.round, steps: [], finally: [worker] } }],
      }
    case 'attention':
      return {
        ...parent,
        steps: [
          {
            ...loopNode,
            round: { ...loopNode.round, steps: [] },
            onExhausted: {
              outcome: 'fail',
              attention: {
                title: t`Check ${value}`,
                reviewer: person('person/reviewer'),
                severity: 'error',
              },
            },
          },
        ],
      }
    case 'product': {
      const receipt = product.resource({ kind: 'custom.proof', fields: { sha: t`${value}` } })
      return {
        ...parent,
        steps: [step({ id: 'produce', assignedTo: reporter, produces: { receipt } })],
      }
    }
  }
}

describe('authoring and native wire boundaries', () => {
  it('renders declared templates in native text predicates as exact KDL', () => {
    const value = input.text('value')
    const gates = textGates(value)
    const wire = missionWire({ ...parent, inputs: [value], gates, steps: [] })
    expect(emit(wire.gates!.slice(0, 5).map(gate.render))).toBe(
      'version 2\n' +
        'gate "exists" {\n  exists "resource/example/${input.value}"\n}\n' +
        'gate "empty" {\n  empty "mission-run/example/${input.value}"\n}\n' +
        'gate "has" {\n  has "message/example/${input.value}" "contains ${input.value}"\n}\n' +
        'gate "lacks" {\n  lacks "doc/example/${input.value}" "absent ${input.value}"\n}\n' +
        'gate "field" {\n  field "sha" "resource/example/${input.value}" "is" "${input.value}"\n}\n',
    )
    expect(JSON.stringify(wire)).not.toContain('"kind":"template"')
    expect(emit([mission(JSON.parse(JSON.stringify(wire)))])).toBe(
      emit([mission({ ...parent, inputs: [value], gates, steps: [] })]),
    )
  })

  it.each(isolatedGateTexts)('retains equal-name foreign input identity in %s', (_label, make) => {
    const declared = input.text('value')
    const foreign = input.text('value')
    expect(() =>
      missionWire({ ...parent, inputs: [declared], gates: [make(foreign)], steps: [] }),
    ).toThrow('Input value is not declared by this mission')
    expect(() =>
      missionWire({ ...parent, inputs: [declared], gates: [make(declared)], steps: [] }),
    ).not.toThrow()
  })

  it.each(textPlacements)(
    'materializes declared native text in %s and preserves wire rendering',
    (placement) => {
      const value = input.text('value')
      const authored = { ...missionWithText(value, placement), inputs: [value] }
      const wire = missionWire(authored)
      expect(JSON.stringify(wire)).not.toContain('"kind":"template"')
      expect(emit([mission(JSON.parse(JSON.stringify(wire)))])).toBe(emit([mission(authored)]))
      expect(JSON.stringify(wire)).toContain('${input.value}')
    },
  )

  it.each(textPlacements)('retains equal-name foreign input identity in %s', (placement) => {
    const declared = input.text('value')
    const foreign = input.text('value')
    expect(() =>
      missionWire({ ...missionWithText(foreign, placement), inputs: [declared] }),
    ).toThrow('Input value is not declared by this mission')
  })

  it('retains foreign product identity in text predicates and produced field values', () => {
    const foreign = product.field({ subject: 'message/example/foreign', fields: { text: 'ready' } })
    step({ id: 'foreign', produces: { foreign } })
    const receipt = product.resource({ kind: 'custom.proof', fields: { text: t`${foreign}` } })
    const produce = step({ id: 'produce', produces: { receipt } })
    expect(() => missionWire({ ...parent, steps: [produce] })).toThrow(
      'Product reference belongs to a step outside this mission',
    )
    expect(() =>
      missionWire({ ...parent, gates: [gate.exists(t`${foreign}`)], steps: [] }),
    ).toThrow('Product reference belongs to a step outside this mission')
  })

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
