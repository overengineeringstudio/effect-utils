import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { DesignA, DesignB, TimingSchema, UnsupportedLowering, renderExec, renderMission, renderSchedule, type NativeMission } from './bakeoff.ts'
import { emit, mission } from './mod.ts'

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

  it('rejects unsupported policy, hard-timeout and consent before rendering', () => {
    for (const options of [{ policy: {} }, { hardTimeout: '1m' }, { consent: {} }]) {
      expect(() => DesignA.mission({ native, ...options })).toThrow(UnsupportedLowering)
      expect(() => DesignB.mission(native, options)).toThrow(UnsupportedLowering)
    }
  })
})
