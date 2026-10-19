import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { DesignA, DesignB, TimingSchema, UnsupportedLowering, renderExec, renderMission, renderSchedule, type NativeMission } from './bakeoff.ts'
import { childMission, emit, input, mission, product, runId, step, t, type MissionInput } from './mod.ts'

const native: NativeMission = {
  id: 'example/bakeoff', state: 'ready', reportTo: { id: 'example/coordinator' },
  goal: 'Retain every native field', timeout: '5m', stalledAfter: '2m', reportStalls: false,
  constraints: ['Do not publish'], completion: { when: 'all-steps-exhausted' },
  steps: [{ id: 'receipt', agentless: true, timeout: '1m', exec: {
    id: 'publish', host: 'local', workspace: '/tmp/example', command: 'printf receipt', restart: 'never',
  }, gates: [{ kind: 'human', name: 'accept', reviewer: { kind: 'person', subject: 'person/reviewer' } }] }],
  finally: [{ id: 'cleanup', agentless: true, goal: 'Clean up' }],
}

describe('whole-surface scratch APIs', () => {
  it('preserves unchanged native rendering in both designs', () => {
    const expected = emit([mission(native)])
    expect(emit([renderMission(DesignA.mission({ native }))])).toBe(expected)
    expect(emit([renderMission(DesignB.from(native).build())])).toBe(expected)
  })

  it('shares exact argv/env/unset/cwd lowering', () => {
    const argv = ['/wrapper', 'env', '-u', 'REMOVE', 'program', 'a b', '$literal'] as const
    const common = { id: 'worker', host: 'local', workspace: '/tmp/example', restart: 'never' } as const
    const options = { env: { KEEP: 'value' }, unset: ['OTHER'], cwd: '/tmp/example/subdir' }
    const a = DesignA.exec({ ...common, launch: DesignA.launch.argv(argv, options) })
    const b = DesignB.exec({ ...common, argv, ...options })
    expect(emit([renderExec(a)])).toBe(emit([renderExec(b)]))
    expect(renderExec(a).children?.find((child) => child.name === 'argv')?.args).toEqual(argv)
    expect(() => DesignA.launch.shell('true', { env: { X: 'set' }, unset: ['X'] })).toThrow()
  })

  it('reuses fragments and maps validated review values without changing other gates', () => {
    const targets = [DesignA.review.subject('mission-run/example'), DesignA.review.document(`doc/example/plan@${'a'.repeat(64)}`)]
    const step = native.steps[0]!
    if ('maxRounds' in step) throw new TypeError('Expected a step fixture')
    const fragment = DesignA.step({ native: step, review: targets })
    const a = DesignA.mission({ native, steps: [fragment] })
    const b = DesignB.from(native).withSteps(fragment).build()
    expect(emit([renderMission(a)])).toBe(emit([renderMission(b)]))
    expect(emit([renderMission(a)])).toContain(`review "doc/example/plan@${'a'.repeat(64)}"`)
    expect(() => DesignA.review.document('doc/example/unpinned')).toThrow()
    expect(DesignA.review.subject('file/local:/tmp/proof')).toEqual({ _tag: 'subject', subject: 'file/local:/tmp/proof' })
    expect(DesignA.review.subject('${input.subject}')).toEqual({ _tag: 'subject', subject: '${input.subject}' })
    expect(() => DesignA.review.document('doc/example@bad')).toThrow()
    expect(() => DesignA.review.subject('not-a-subject')).toThrow()
  })

  it('supports at/every/calendar while rejecting one-shot catch-up', () => {
    const common = { id: 'schedule', host: 'local', work: { mission: native.id, workspace: '/tmp/example' } } as const
    const at = '2026-10-20T08:00:00Z'
    expect(emit([renderSchedule(DesignA.schedule({ ...common, timing: DesignA.timing.at(at) }))]))
      .toBe(emit([renderSchedule(DesignB.schedule({ ...common, at }))]))
    for (const timing of [DesignA.timing.every('1h', at, { kind: 'all', max: 2 }), DesignA.timing.calendar({ at: '08:00', timezone: 'Europe/Berlin', catchUp: { kind: 'skip' } })]) {
      expect(renderSchedule(DesignA.schedule({ ...common, timing })).name).toBe('schedule')
    }
    expect(() => Schema.decodeUnknownSync(TimingSchema, { onExcessProperty: 'error' })({ _tag: 'at', at, catchUp: { kind: 'latest' } })).toThrow()
    expect(() => DesignB.schedule({ ...common, at, catchUp: { kind: 'latest' } })).toThrow()
  })

  it('lowers launch and review fragments in loop rounds and their finalizers', () => {
    const roundStep = native.steps[0]!
    if ('round' in roundStep) throw new TypeError('Expected native step')
    const finalStep = { ...roundStep, id: 'round-cleanup' }
    const loop = {
      id: 'retry-round', maxRounds: 2, round: {
        completion: { when: 'all-steps-exhausted' }, steps: [roundStep], finally: [finalStep],
      },
    } as const
    const review = [DesignA.review.document(`doc/example/plan@${'b'.repeat(64)}`)]
    const aRound = {
      steps: [DesignA.step({ native: roundStep, launch: DesignA.launch.argv(['/round-worker', 'a b']), review })],
      finally: [DesignA.step({ native: finalStep, launch: DesignA.launch.shell('printf cleanup'), review })],
    }
    const bRound = {
      steps: [DesignB.step(roundStep, { launch: DesignB.launch({ argv: ['/round-worker', 'a b'] }), review })],
      finally: [DesignB.step(finalStep, { launch: DesignB.launch({ command: 'printf cleanup' }), review })],
    }
    const a = emit([renderMission(DesignA.mission({ native, steps: [DesignA.loop({ native: loop, round: aRound })] }))])
    const b = emit([renderMission(DesignB.from(native).withSteps(DesignB.loop(loop, bRound)).build())])
    expect(a).toBe(b)
    expect(a).toContain('argv \"/round-worker\" \"a b\"')
    expect(a).toContain('command \"printf cleanup\"')
    expect(a.split('review "doc/example/plan@').length - 1).toBe(2)
    expect(a).toContain('max-rounds 2')
  })

  it('preserves genuine typed input/product/dependency and child-mission composition in both APIs', () => {
    const value = input.text('value')
    const receipt = product.resource({ kind: 'custom.proof', fields: { text: t`${value}` } })
    const produce = step({ missionId: 'example/typed', id: 'produce', agentless: true, goal: t`Produce ${value}`, produces: { receipt } })
    const consume = step({ missionId: 'example/typed', id: 'consume', agentless: true, dependsOn: produce, goal: t`Consume ${produce.products.receipt}` })
    const publish = step({ missionId: 'example/typed', id: 'publish-child', agentless: true, produces: childMission`example/child/${runId}` })
    const execute = step({ missionId: 'example/typed', id: 'execute-child', agentless: true, dependsOn: publish, waitFor: publish })
    const authored = {
      id: 'example/typed', state: 'ready', reportTo: { id: 'example/coordinator' }, inputs: [value],
      goal: t`Preserve ${value}`, steps: [produce, consume, publish, execute],
    } as const satisfies MissionInput<'example/typed'>
    const expected = emit([mission(authored)])
    const handles = [produce, consume, publish, execute]
    const a = DesignA.authored({ native: authored, steps: handles.map((handle) => DesignA.fromHandle(handle)) })
    const b = DesignB.fromAuthored(authored).withSteps(...handles.map((handle) => DesignB.fromHandle(handle))).build()
    expect(emit([renderMission(a)])).toBe(expected)
    expect(emit([renderMission(b)])).toBe(expected)
    expect(expected).toContain('uses-mission output-of=\"publish-child\"')
    const foreign = input.text('value')
    const wrongOwner: MissionInput<string> = { ...authored, id: 'example/foreign' }
    for (const build of [
      () => DesignA.authored({ native: { ...authored, inputs: [foreign] } }),
      () => DesignB.fromAuthored({ ...authored, inputs: [foreign] }).build(),
      () => DesignA.authored({ native: wrongOwner }),
      () => DesignB.fromAuthored(wrongOwner).build(),
      () => DesignA.authored({ native: { ...authored, steps: [consume] } }),
      () => DesignB.fromAuthored({ ...authored, steps: [consume] }).build(),
    ]) expect(build).toThrow()
  })

  it('rejects unsupported policy, hard-timeout and consent before rendering', () => {
    for (const options of [{ policy: {} }, { hardTimeout: '1m' }, { consent: {} }]) {
      expect(() => DesignA.mission({ native, ...options })).toThrow(UnsupportedLowering)
      expect(() => DesignB.mission(native, options)).toThrow(UnsupportedLowering)
    }
  })
})
