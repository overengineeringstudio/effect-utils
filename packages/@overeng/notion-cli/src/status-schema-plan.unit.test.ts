import { describe, expect, it } from 'vitest'

import type { SelectOptionConfig, StatusPropertySchema } from '@overeng/notion-effect-schema'

import { planStatusSchema } from './status-schema-plan.ts'

const option = ({
  id,
  name,
  color = 'default',
}: {
  readonly id: string
  readonly name: string
  readonly color?: SelectOptionConfig['color']
}): SelectOptionConfig => ({ id, name, color })

const statusProperty = ({
  options,
  groups = [],
}: {
  readonly options: readonly SelectOptionConfig[]
  readonly groups?: StatusPropertySchema['status']['groups']
}): StatusPropertySchema => ({
  id: 'status',
  name: 'Status',
  description: null,
  _tag: 'status',
  status: {
    options,
    groups,
  },
})

describe('planStatusSchema', () => {
  it('plans missing options as additive candidates while preserving all live options', () => {
    const livePublished = option({ id: 'live-published', name: 'Published', color: 'green' })
    const desiredBlocked = option({ id: 'desired-blocked', name: 'Blocked', color: 'red' })

    const plan = planStatusSchema({
      live: statusProperty({ options: [livePublished] }),
      desired: statusProperty({ options: [livePublished, desiredBlocked] }),
    })

    expect(plan.missingOptions).toEqual([desiredBlocked])
    expect(plan.unsupportedDrift).toEqual([])
    expect(plan.canApplySafely).toBe(true)
    expect(plan.applyOptions).toEqual([livePublished, desiredBlocked])
  })

  it('reports color drift instead of treating it as applyable', () => {
    const plan = planStatusSchema({
      live: statusProperty({
        options: [option({ id: 'published', name: 'Published', color: 'green' })],
      }),
      desired: statusProperty({
        options: [option({ id: 'published', name: 'Published', color: 'blue' })],
      }),
    })

    expect(plan.missingOptions).toEqual([])
    expect(plan.unsupportedDrift).toMatchObject([{ kind: 'color_changed' }])
    expect(plan.canApplySafely).toBe(false)
    expect(plan.applyOptions).toEqual([
      option({ id: 'published', name: 'Published', color: 'green' }),
    ])
  })

  it('reports same-id name drift as an unsupported rename', () => {
    const plan = planStatusSchema({
      live: statusProperty({
        options: [option({ id: 'running', name: 'Running' })],
      }),
      desired: statusProperty({
        options: [option({ id: 'running', name: 'Wird veroeffentlicht' })],
      }),
    })

    expect(plan.missingOptions).toEqual([])
    expect(plan.unsupportedDrift).toMatchObject([{ kind: 'rename_or_identity_mismatch' }])
    expect(plan.canApplySafely).toBe(false)
  })

  it('reports same-name id drift as an identity mismatch', () => {
    const plan = planStatusSchema({
      live: statusProperty({
        options: [option({ id: 'remote-running', name: 'Running' })],
      }),
      desired: statusProperty({
        options: [option({ id: 'desired-running', name: 'Running' })],
      }),
    })

    expect(plan.missingOptions).toEqual([])
    expect(plan.unsupportedDrift).toMatchObject([{ kind: 'rename_or_identity_mismatch' }])
    expect(plan.canApplySafely).toBe(false)
    expect(plan.applyOptions).toEqual([option({ id: 'remote-running', name: 'Running' })])
  })

  it('reports extra remote options instead of omitting them from the apply payload', () => {
    const remoteExtra = option({ id: 'remote-extra', name: 'Legacy' })
    const desiredPublished = option({ id: 'published', name: 'Published' })

    const plan = planStatusSchema({
      live: statusProperty({ options: [desiredPublished, remoteExtra] }),
      desired: statusProperty({ options: [desiredPublished] }),
    })

    expect(plan.unsupportedDrift).toMatchObject([{ kind: 'extra_remote_option' }])
    expect(plan.canApplySafely).toBe(false)
    expect(plan.applyOptions).toEqual([desiredPublished, remoteExtra])
  })

  it('reports group drift as report-only', () => {
    const published = option({ id: 'published', name: 'Published' })
    const plan = planStatusSchema({
      live: statusProperty({
        options: [published],
        groups: [{ id: 'group-1', name: 'Complete', color: 'green', option_ids: ['published'] }],
      }),
      desired: statusProperty({
        options: [published],
        groups: [{ id: 'group-1', name: 'Done', color: 'green', option_ids: ['published'] }],
      }),
    })

    expect(plan.missingOptions).toEqual([])
    expect(plan.unsupportedDrift).toMatchObject([{ kind: 'group_changed' }])
    expect(plan.canApplySafely).toBe(true)
  })

  it('preserves live options and blocks safe apply when missing options mix with unsupported drift', () => {
    const livePublished = option({ id: 'published', name: 'Published', color: 'green' })
    const liveLegacy = option({ id: 'legacy', name: 'Legacy', color: 'yellow' })
    const desiredBlocked = option({ id: 'blocked', name: 'Blocked', color: 'red' })

    const plan = planStatusSchema({
      live: statusProperty({ options: [livePublished, liveLegacy] }),
      desired: statusProperty({ options: [livePublished, desiredBlocked] }),
    })

    expect(plan.missingOptions).toEqual([desiredBlocked])
    expect(plan.unsupportedDrift).toMatchObject([{ kind: 'extra_remote_option' }])
    expect(plan.canApplySafely).toBe(false)
    expect(plan.applyOptions).toEqual([livePublished, liveLegacy, desiredBlocked])
  })
})
