import { describe, expect, it } from 'vitest'

import type { SelectColor, SelectOptionConfig } from '@overeng/notion-effect-schema'

import {
  buildAddOptionsPayload,
  defaultStatusConvergePolicy,
  planStatusConvergence,
} from './status-converge.ts'

const opt = (id: string, name: string, color: SelectColor = 'default'): SelectOptionConfig => ({
  id,
  name,
  color,
})

const live = [opt('id-queued', 'Queued', 'gray'), opt('id-running', 'Running', 'yellow')]

describe('planStatusConvergence', () => {
  it('classifies a missing desired option as create (the only applyable write)', () => {
    const plan = planStatusConvergence({
      property: 'Status',
      liveOptions: live,
      desired: { options: ['Queued', 'Running', 'Published'], colors: { Published: 'green' } },
    })
    expect(plan.creates).toEqual([{ name: 'Published', color: 'green' }])
    expect(plan.decisions).toContainEqual({ _tag: 'create', name: 'Published', color: 'green' })
    expect(plan.blocked).toBe(false)
  })

  it('defaults the create color when none is authored', () => {
    const plan = planStatusConvergence({
      property: 'Status',
      liveOptions: live,
      desired: { options: ['Queued', 'Running', 'Done'] },
    })
    expect(plan.creates).toEqual([{ name: 'Done', color: 'default' }])
  })

  it('classifies a present, color-matching option as matches (no action)', () => {
    const plan = planStatusConvergence({
      property: 'Status',
      liveOptions: live,
      desired: { options: ['Queued'], colors: { Queued: 'gray' }, policy: { extras: 'ignore' } },
    })
    expect(plan.decisions).toContainEqual({ _tag: 'matches', name: 'Queued', id: 'id-queued' })
    expect(plan.creates).toEqual([])
  })

  it('classifies a live color mismatch as color-drift (UI-action-required, not applied)', () => {
    const plan = planStatusConvergence({
      property: 'Status',
      liveOptions: live,
      desired: { options: ['Queued'], colors: { Queued: 'blue' }, policy: { extras: 'ignore' } },
    })
    expect(plan.uiActionRequired).toContainEqual({
      _tag: 'color-drift',
      name: 'Queued',
      id: 'id-queued',
      liveColor: 'gray',
      desiredColor: 'blue',
    })
    // color-drift is never an applyable create
    expect(plan.creates).toEqual([])
  })

  it('fails closed on an extra remote option under the default policy', () => {
    const plan = planStatusConvergence({
      property: 'Status',
      liveOptions: live,
      desired: { options: ['Queued'] }, // Running is extra
    })
    expect(plan.decisions).toContainEqual({
      _tag: 'extra-remote',
      name: 'Running',
      id: 'id-running',
      policy: 'fail',
    })
    expect(plan.blocked).toBe(true)
  })

  it('does not block on extra remote options under ignore/warn policy', () => {
    for (const extras of ['ignore', 'warn'] as const) {
      const plan = planStatusConvergence({
        property: 'Status',
        liveOptions: live,
        desired: { options: ['Queued'], policy: { extras } },
      })
      expect(plan.blocked).toBe(false)
    }
  })

  it('reports a missing option as missing-unaddable when createMissing is off', () => {
    const plan = planStatusConvergence({
      property: 'Status',
      liveOptions: live,
      desired: {
        options: ['Queued', 'Running', 'New'],
        policy: { createMissing: false, extras: 'ignore' },
      },
    })
    expect(plan.creates).toEqual([])
    expect(plan.decisions).toContainEqual({ _tag: 'missing-unaddable', name: 'New' })
  })

  it('exposes fail-closed defaults', () => {
    expect(defaultStatusConvergePolicy).toEqual({ createMissing: true, extras: 'fail' })
  })
})

describe('buildAddOptionsPayload (REPLACE-trap guard)', () => {
  it('echoes every live option by id and appends the new ones', () => {
    const payload = buildAddOptionsPayload({
      liveOptions: live,
      creates: [{ name: 'Published', color: 'green' }],
    })
    expect(payload.options).toEqual([
      { id: 'id-queued' },
      { id: 'id-running' },
      { name: 'Published', color: 'green' },
    ])
  })

  it('never omits a live option (omission would delete it under REPLACE semantics)', () => {
    const payload = buildAddOptionsPayload({ liveOptions: live, creates: [] })
    const echoedIds = payload.options.flatMap((o) => ('id' in o ? [o.id] : []))
    expect(echoedIds).toEqual(live.map((o) => o.id))
  })
})
