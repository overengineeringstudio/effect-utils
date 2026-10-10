import { Schema } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  type AgentReference,
  type AgentSchema,
  emit,
  type GateSchema,
  HumanGateSchema,
  mission,
  type MissionSchema,
  person,
  type PersonReference,
  PersonReferenceSchema,
  step,
  StepSchema,
} from './mod.ts'

const operator = person('person/schickling')
const owner = { id: 'example/owner' } satisfies typeof AgentSchema.Encoded
const worker = { id: 'example/worker' } satisfies typeof AgentSchema.Encoded
const gate = {
  kind: 'human',
  name: 'Approve the bounded Berlin cutover',
  reviewer: operator,
} satisfies typeof HumanGateSchema.Encoded

// These are authoring contracts, not assertions about person authentication.
describe('attributed human gates', () => {
  it('keeps person references distinct from imported agent references', () => {
    type Reviewer = (typeof HumanGateSchema.Encoded)['reviewer']
    type AssignedTo = NonNullable<(typeof StepSchema.Encoded)['assignedTo']>
    type UnderTarget = NonNullable<(typeof AgentSchema.Encoded)['under']>[number]['target']
    expectTypeOf<PersonReference>().not.toMatchTypeOf<AgentReference>()
    expectTypeOf<AgentReference>().not.toMatchTypeOf<PersonReference>()
    expectTypeOf<typeof owner>().not.toMatchTypeOf<Reviewer>()
    expectTypeOf<string>().not.toMatchTypeOf<Reviewer>()
    expectTypeOf<PersonReference>().toMatchTypeOf<AssignedTo>()
    expectTypeOf<PersonReference>().not.toMatchTypeOf<UnderTarget>()
    expectTypeOf<PersonReference>().not.toMatchTypeOf<(typeof MissionSchema.Encoded)['reportTo']>()
    expectTypeOf<Parameters<typeof person>[0]>().toEqualTypeOf<`person/${string}`>()
    expect(() =>
      step({ id: 'approve', agentless: true, gate: { ...gate, reviewer: owner } } as never),
    ).toThrow()
  })

  it('requires tags and does not declare unsupported policy fields', () => {
    type Gate = typeof GateSchema.Encoded
    expectTypeOf<Gate['kind']>().toEqualTypeOf<'field' | 'human'>()
    expectTypeOf<Omit<typeof gate, 'kind'>>().not.toMatchTypeOf<Gate>()
    expectTypeOf<
      Extract<
        'tier' | 'scope' | 'window' | 'fallback' | 'policy' | 'humanOnly',
        keyof typeof HumanGateSchema.Encoded
      >
    >().toBeNever()
    expectTypeOf<NonNullable<(typeof HumanGateSchema.Encoded)['mode']>>().toEqualTypeOf<
      'approve' | 'feedback'
    >()
    for (const extra of [
      { tier: 'critical' },
      { tier: 'consultative' },
      { scope: 'Berlin configuration' },
      { window: '1h' },
      { fallback: owner },
      { policy: 'consent/example' },
      { humanOnly: true },
    ]) {
      expect(() =>
        step({ id: 'approve', agentless: true, gate: { ...gate, ...extra } } as never),
      ).toThrow()
    }
    expect(() =>
      step({
        id: 'verify',
        gate: { name: 'ok', field: { kind: 'exit_code', ref: 'exec/check', is: 0 } },
      } as never),
    ).toThrow()
  })

  it.each([
    'person/',
    'person//operator',
    'person/operator/',
    'person/../operator',
    'agent/operator',
    'operator',
    'person/with spaces',
  ])('rejects invalid person subjects %s', (subject) => {
    expect(() => Schema.decodeUnknownSync(PersonReferenceSchema)({ kind: 'person', subject })).toThrow()
  })

  it('lowers a separate approve checkpoint before the risky step to exact KDL', () => {
    expect(
      emit([
        mission({
          id: 'home/berlin/cutover',
          state: 'ready',
          reportTo: owner,
          goal: 'Apply only the reviewed Berlin cutover plan.',
          steps: [
            {
              id: 'approve-cutover',
              agentless: true,
              timeout: '1d',
              gate: {
                ...gate,
                question: 'Apply the reviewed configuration and rollback plan?',
                review: [`doc/berlin-cutover@${'a'.repeat(64)}`, 'resource/example/rollback-plan'],
              },
            },
            {
              id: 'apply-cutover',
              assignedTo: worker,
              dependsOn: [{ step: 'approve-cutover', state: 'completed' }],
              goal: 'Apply precisely the approved plan.',
            },
          ],
        }),
      ]),
    ).toBe(`version 2
mission "home/berlin/cutover" report-to="agent/example/owner" state="ready" {
  goal "Apply only the reviewed Berlin cutover plan."
  step "approve-cutover" timeout="1d" {
    agentless
    gate "Approve the bounded Berlin cutover" mode="approve" type="human" {
      reviewer "person/schickling"
      question "Apply the reviewed configuration and rollback plan?"
      review "doc/berlin-cutover@${'a'.repeat(64)}"
      review "resource/example/rollback-plan"
    }
  }
  step "apply-cutover" {
    assigned-to "agent/example/worker"
    depends-on {
      step "approve-cutover" "completed"
    }
    goal "Apply precisely the approved plan."
  }
}
`)
  })

  it('lowers worker feedback without turning it into pre-work authorization', () => {
    expect(
      emit([step({ id: 'draft', assignedTo: worker, gate: { ...gate, mode: 'feedback' } })]),
    ).toBe(`version 2
step "draft" {
  assigned-to "agent/example/worker"
  gate "Approve the bounded Berlin cutover" mode="feedback" type="human" {
    reviewer "person/schickling"
  }
}
`)
    expect(() =>
      step({ id: 'approve', agentless: true, gate: { ...gate, mode: 'feedback' } }),
    ).toThrow('feedback human gates require a worker step')
  })

  it('accepts explicit approve mode and rejects invalid modes and duplicate review targets', () => {
    expect(
      emit([step({ id: 'approve', agentless: true, gate: { ...gate, mode: 'approve' } })]),
    ).toBe(emit([step({ id: 'approve', agentless: true, gate })]))
    for (const invalid of [
      { mode: 'consultative' },
      { review: ['doc/plan', 'doc/plan'] },
      { question: '' },
      { reviewer: 'person/schickling' },
    ]) {
      expect(() =>
        step({ id: 'approve', agentless: true, gate: { ...gate, ...invalid } } as never),
      ).toThrow()
    }
  })

  it('keeps imported agent IDs authoritative over preserved person-like metadata', () => {
    const importedWorker = { ...worker, kind: 'person', subject: operator.subject }
    const decoded = Schema.decodeSync(StepSchema)({ id: 'work', assignedTo: importedWorker })
    expect(decoded.assignedTo).toBe(importedWorker)
    expect(emit([step({ id: 'work', assignedTo: importedWorker })])).toBe(
      'version 2\nstep "work" {\n  assigned-to "agent/example/worker"\n}\n',
    )
  })

  it('lowers distinct person assignments and retains native field gate syntax', () => {
    expect(
      emit([step({ id: 'inspect', assignedTo: operator, goal: 'Inspect the plan.' })]),
    ).toBe(
      'version 2\nstep "inspect" {\n  assigned-to "person/schickling"\n  goal "Inspect the plan."\n}\n',
    )
    expect(
      emit([
        step({
          id: 'verify',
          gate: {
            kind: 'field',
            name: 'Successful check',
            field: { kind: 'exit_code', ref: 'exec/check', is: 0 },
          },
        }),
      ]),
    ).toBe(
      'version 2\nstep "verify" {\n  gate "Successful check" {\n    field "exit_code" "exec/check" "is" 0\n  }\n}\n',
    )
    expect(() => step({ id: 'inspect', agentless: true, assignedTo: operator })).toThrow()
  })
})
