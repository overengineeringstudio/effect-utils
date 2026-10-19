import { describe, expect, it } from 'vitest'

import { doc, emit, gate, input, missionWire, person, pr, runId, t } from './mod.ts'

const reporter = { id: 'example/coordinator' }

describe('typed native gate constructors', () => {
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
