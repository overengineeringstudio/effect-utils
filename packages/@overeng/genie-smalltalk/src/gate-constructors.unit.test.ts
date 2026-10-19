import { describe, expect, it } from 'vitest'

import {
  completed,
  doc,
  emit,
  failed,
  Fragment,
  gate,
  input,
  missionWire,
  node,
  omp,
  person,
  pr,
  Review,
  runId,
  step,
  t,
  terminal,
} from './mod.ts'

const reporter = { id: 'example/coordinator' }

describe('typed native gate constructors', () => {
  it('snapshots other constructor-owned records while retaining scoped identities', () => {
    const resume = { transcript: '/before.jsonl' }
    const harness = omp({ model: 'example-model', effort: 'high', resume })
    resume.transcript = '/after.jsonl'
    expect(harness.resume).toEqual({ transcript: '/before.jsonl' })
    expect(Object.isFrozen(resume)).toBe(false)
    expect(Object.isFrozen(harness)).toBe(true)
    expect(Object.isFrozen(harness.resume)).toBe(true)
    const reviewer = person('person/reviewer')
    expect(Object.isFrozen(reviewer)).toBe(true)
    expect(Reflect.set(reviewer, 'subject', 'person/changed')).toBe(false)
    const source = step({ id: 'source', agentless: true })
    for (const dependency of [completed(source), failed(source), terminal(source)]) {
      expect(Object.isFrozen(dependency)).toBe(true)
      expect(dependency.handle).toBe(source)
      expect(Reflect.set(dependency, 'state', 'changed')).toBe(false)
    }
    const child = { name: 'child', args: ['before'], props: { keep: 'before' } }
    const args = ['parent']
    const props = { keep: 'parent' }
    const parent = node({ name: 'parent', args, props, children: [child] })
    child.args[0] = 'after'
    child.props.keep = 'after'
    args[0] = 'after'
    props.keep = 'after'
    expect(Object.isFrozen(child)).toBe(false)
    expect(Object.isFrozen(child.args)).toBe(false)
    expect(Object.isFrozen(parent.children?.[0])).toBe(true)
    expect(parent.children?.[0]).toMatchObject({ args: ['before'], props: { keep: 'before' } })
    expect(parent.args).toEqual(['parent'])
    expect(parent.props).toEqual({ keep: 'parent' })
    expect(node({ name: 'outer', children: [parent] }).children?.[0]).toBe(parent)
  })

  it('snapshots nested human gate data without freezing caller inputs or losing provenance', () => {
    const reviewer = { kind: 'person' as const, subject: 'person/reviewer' }
    const review = [Review.subject('mission/example/proof')]
    const question = input.text('question')
    const options = { reviewer, review, question: t`Accept ${question}?` }
    const checkpoint = gate.human(options)
    const fragment = Fragment.steps({ id: 'review', agentless: true, gates: [checkpoint] })
    reviewer.subject = 'person/changed'
    review.push(Review.subject('mission/example/later'))
    expect(Object.isFrozen(reviewer)).toBe(false)
    expect(Object.isFrozen(review)).toBe(false)
    expect(Object.isFrozen(checkpoint)).toBe(true)
    expect(Object.isFrozen(checkpoint.reviewer)).toBe(true)
    expect(Object.isFrozen(checkpoint.review)).toBe(true)
    expect(checkpoint.reviewer.subject).toBe('person/reviewer')
    expect(checkpoint.review).toHaveLength(1)
    const authored = {
      id: 'example/snapshot',
      state: 'ready' as const,
      reportTo: reporter,
      goal: 'Preserve the checkpoint.',
      steps: fragment,
    }
    expect(() => missionWire(authored)).toThrow('Input question is not declared')
    const wire = missionWire({ ...authored, inputs: [question] })
    expect(wire.steps[0]).toMatchObject({
      gates: [{ reviewer: { subject: 'person/reviewer' }, question: 'Accept ${input.question}?' }],
    })
  })

  it('snapshots execution environments and freezes every gate constructor result', () => {
    const env = { KEEP: 'before' }
    const options = { command: 'true', host: 'local', workspace: '/work', env }
    const command = gate.exec(options)
    env.KEEP = 'after'
    options.command = 'false'
    expect(Object.isFrozen(env)).toBe(false)
    expect(command.env).toEqual({ KEEP: 'before' })
    expect(command.command).toBe('true')
    expect(Object.isFrozen(command.env)).toBe(true)
    const gates = [
      command,
      gate.fieldIs({ subject: 'exec/check', path: 'exit_code', value: 0 }),
      gate.merged({ target: pr({ repo: 'example/repository', number: 7 }) }),
      gate.ciPassed({ check: 'build', repo: 'example/repository', commit: 'a'.repeat(40) }),
      gate.document({ target: doc`doc/example/proof` }),
      gate.exists({ subject: 'resource/example/proof' }),
      gate.empty({ subject: 'queue/example' }),
      gate.has({ subject: 'message/example', text: 'proof' }),
      gate.lacks({ subject: 'message/example', text: 'failure' }),
    ]
    for (const value of gates) {
      const rendered = emit([gate.render(value)])
      expect(Object.isFrozen(value)).toBe(true)
      expect(Reflect.set(value, 'name', 'changed')).toBe(false)
      expect(emit([gate.render(value)])).toBe(rendered)
    }
  })

  it('renders native gates with explicit reference names as exact KDL', () => {
    const head = input.text('head')
    expect(
      emit([
        gate.render(
          gate.ciPassed({
            check: 'linux-gate',
            name: 'linux',
            repo: 'example/repository',
            commit: head,
          }),
        ),
        gate.render(
          gate.merged({ target: pr({ repo: 'example/repository', number: 7 }), name: 'merged' }),
        ),
        gate.render(gate.document({ target: doc`doc/example/${runId}/proof`, name: 'proof' })),
        gate.render(
          gate.human({ name: 'accept', reviewer: person('person/reviewer'), question: 'Accept?' }),
        ),
      ]),
    ).toBe(
      'version 2\n' +
        'gate "linux" {\n  ci-passed "linux-gate" commit="${input.head}" repo="example/repository"\n}\n' +
        'gate "merged" {\n  merged "example/repository#7"\n}\n' +
        'gate "proof" {\n  document "doc/example/${ST_MISSION_RUN}/proof"\n}\n' +
        'gate "accept" mode="approve" type="human" {\n  reviewer "person/reviewer"\n  question "Accept?"\n}\n',
    )
  })

  it('lowers execution time limits for every native execution gate', () => {
    const gates = [
      gate.exec({
        name: 'exec',
        command: 'true',
        host: 'local',
        workspace: '/work',
        timeLimit: '60000ms',
      }),
      gate.merged({
        name: 'merged',
        target: pr({ repo: 'example/repository', number: 7 }),
        timeLimit: '3600000ms',
      }),
      gate.ciPassed({
        name: 'ci',
        check: 'build',
        repo: 'example/repository',
        commit: 'a'.repeat(40),
        timeLimit: '1001ms',
      }),
    ]
    expect(emit(gates.map((value) => gate.render(value)))).toBe(
      'version 2\n' +
        'gate "exec" {\n  exec "true"\n  host "local"\n  workspace "/work"\n  time-limit "1m"\n}\n' +
        'gate "merged" {\n  merged "example/repository#7"\n  time-limit "1h"\n}\n' +
        `gate "ci" {\n  ci-passed "build" commit="${'a'.repeat(40)}" repo="example/repository"\n  time-limit "1001ms"\n}\n`,
    )
  })

  it('derives deterministic names without a repetition helper', () => {
    const checks = ['linux-gate', 'isolation-vm'].map((check) =>
      gate.ciPassed({ check: check, repo: 'example/repository', commit: 'a'.repeat(40) }),
    )
    expect(checks.map((value) => value.name)).toEqual([
      `ci-passed:example/repository:linux-gate:${'a'.repeat(40)}`,
      `ci-passed:example/repository:isolation-vm:${'a'.repeat(40)}`,
    ])
    expect(gate.merged({ target: pr({ repo: 'example/repository', number: 7 }) })).toEqual(
      gate.merged({ target: pr({ repo: 'example/repository', number: 7 }) }),
    )
  })

  it('derives bounded distinct names for long human questions', () => {
    const first = gate.human({ reviewer: person('person/reviewer'), question: 'a'.repeat(200) })
    const second = gate.human({ reviewer: person('person/reviewer'), question: 'b'.repeat(200) })
    expect(first.name).toBe(
      'human:666061bfb6242accd51ad83318fd8f173e7abf9f75c83be671aa0eae3d4967ec',
    )
    expect(new TextEncoder().encode(first.name).length).toBeLessThanOrEqual(160)
    expect(first.name).not.toBe(second.name)
    expect(() => gate.render(first)).not.toThrow()
  })

  it('uses the same human gate constructor at mission level', () => {
    const wire = missionWire({
      id: 'example/review',
      state: 'ready',
      reportTo: reporter,
      goal: 'Produce proof.',
      gates: [gate.human({ reviewer: person('person/reviewer'), question: 'Accept the proof?' })],
      steps: [{ id: 'proof', agentless: true }],
    })
    expect(wire.gates).toMatchObject([
      { kind: 'human', reviewer: { kind: 'person', subject: 'person/reviewer' } },
    ])
  })

  it('refuses an undeclared typed input in a text template', () => {
    const head = input.text('head')
    expect(() =>
      missionWire({
        id: 'example/review',
        state: 'ready',
        reportTo: reporter,
        goal: t`Review ${head}.`,
        steps: [{ id: 'proof', agentless: true }],
      }),
    ).toThrow('Input head is not declared by this mission')
  })

  it('preserves typed input references through the wire boundary', () => {
    const head = input.text('head')
    const wire = missionWire({
      id: 'example/review',
      state: 'ready',
      reportTo: reporter,
      inputs: [head],
      goal: t`Review ${head}.`,
      steps: [
        {
          id: 'proof',
          agentless: true,
          gates: [gate.ciPassed({ check: 'build', repo: 'example/repository', commit: head })],
        },
      ],
    })
    expect(wire.inputs).toEqual([{ name: 'head', kind: 'text' }])
    expect(wire.goal).toEqual(['Review ${input.head}.'])
  })
})
