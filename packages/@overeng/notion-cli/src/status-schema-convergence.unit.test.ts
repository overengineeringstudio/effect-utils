import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  NotionSchema,
  notionPropertyMeta,
  type SelectOptionConfig,
  type StatusPropertySchema,
} from '@overeng/notion-effect-schema'

import {
  applyStatusSchemaConvergence,
  getDesiredStatusPropertyFromSchemaModule,
  planStatusSchemaConvergence,
  StatusSchemaApplyVerificationError,
  type StatusSchemaConvergenceGateway,
  type StatusOptionUpdate,
  StatusSchemaUnsupportedDriftError,
} from './status-schema-convergence.ts'

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

const makeGateway = (args: {
  readonly liveResponses: readonly StatusPropertySchema[]
  readonly updates?: Array<{
    readonly dataSourceId: string
    readonly propertyName: string
    readonly options: readonly StatusOptionUpdate[]
  }>
}): StatusSchemaConvergenceGateway => {
  let retrieveIndex = 0

  return {
    retrieveStatusProperty: ({ databaseId: _databaseId, propertyName: _propertyName }) =>
      Effect.sync(() => {
        const live =
          args.liveResponses[Math.min(retrieveIndex, args.liveResponses.length - 1)] ??
          statusProperty({ options: [] })
        retrieveIndex += 1
        return {
          dataSourceId: 'data-source-id',
          live,
        }
      }),
    updateStatusOptions: ({ dataSourceId, propertyName, options }) =>
      Effect.sync(() => {
        args.updates?.push({ dataSourceId, propertyName, options })
      }),
  }
}

describe('status schema convergence', () => {
  it('check mode reports missing options without mutating', async () => {
    const livePublished = option({ id: 'published', name: 'Published', color: 'green' })
    const desiredBlocked = option({ id: 'blocked', name: 'Blocked', color: 'red' })
    const gateway = makeGateway({
      liveResponses: [statusProperty({ options: [livePublished] })],
      updates: [],
    })

    const result = await Effect.runPromise(
      planStatusSchemaConvergence({
        gateway,
        databaseId: 'database-id',
        desired: statusProperty({ options: [livePublished, desiredBlocked] }),
      }),
    )

    expect(result.plan.missingOptions).toEqual([desiredBlocked])
    expect(result.plan.canApplySafely).toBe(true)
  })

  it('apply preserves live options in the update payload and verifies by reading again', async () => {
    const updates: Array<{
      readonly dataSourceId: string
      readonly propertyName: string
      readonly options: readonly StatusOptionUpdate[]
    }> = []
    const livePublished = option({ id: 'published', name: 'Published', color: 'green' })
    const desiredBlocked = option({ id: 'blocked', name: 'Blocked', color: 'red' })
    const desired = statusProperty({ options: [livePublished, desiredBlocked] })
    const gateway = makeGateway({
      liveResponses: [statusProperty({ options: [livePublished] }), desired],
      updates,
    })

    const result = await Effect.runPromise(
      applyStatusSchemaConvergence({
        gateway,
        databaseId: 'database-id',
        desired,
      }),
    )

    expect(result.updated).toBe(true)
    expect(updates).toEqual([
      {
        dataSourceId: 'data-source-id',
        propertyName: 'Status',
        options: [
          { id: 'published', name: 'Published' },
          { name: 'Blocked', color: 'red' },
        ],
      },
    ])
    expect(result.after.missingOptions).toEqual([])
  })

  it('apply tolerates report-only group drift after Notion assigns new options to a group', async () => {
    const updates: Array<{
      readonly dataSourceId: string
      readonly propertyName: string
      readonly options: readonly StatusOptionUpdate[]
    }> = []
    const livePublished = option({ id: 'published', name: 'Published', color: 'green' })
    const desiredBlocked = option({ id: 'blocked', name: 'Blocked', color: 'red' })
    const desired = statusProperty({
      options: [livePublished, desiredBlocked],
      groups: [
        { id: 'todo', name: 'To-do', color: 'gray', option_ids: [] },
        { id: 'done', name: 'Done', color: 'green', option_ids: ['published', 'blocked'] },
      ],
    })
    const gateway = makeGateway({
      liveResponses: [
        statusProperty({
          options: [livePublished],
          groups: [
            { id: 'todo', name: 'To-do', color: 'gray', option_ids: [] },
            { id: 'done', name: 'Done', color: 'green', option_ids: ['published'] },
          ],
        }),
        statusProperty({
          options: [livePublished, desiredBlocked],
          groups: [
            { id: 'todo', name: 'To-do', color: 'gray', option_ids: ['blocked'] },
            { id: 'done', name: 'Done', color: 'green', option_ids: ['published'] },
          ],
        }),
      ],
      updates,
    })

    const result = await Effect.runPromise(
      applyStatusSchemaConvergence({
        gateway,
        databaseId: 'database-id',
        desired,
      }),
    )

    expect(result.updated).toBe(true)
    expect(result.after.missingOptions).toEqual([])
    expect(result.after.unsupportedDrift).toMatchObject([{ kind: 'group_changed' }])
    expect(result.after.canApplySafely).toBe(true)
    expect(updates).toHaveLength(1)
  })

  it('apply refuses unsupported drift before updating', async () => {
    const updates: Array<{
      readonly dataSourceId: string
      readonly propertyName: string
      readonly options: readonly StatusOptionUpdate[]
    }> = []
    const gateway = makeGateway({
      liveResponses: [
        statusProperty({
          options: [option({ id: 'published', name: 'Published', color: 'green' })],
        }),
      ],
      updates,
    })

    const result = await Effect.runPromise(
      applyStatusSchemaConvergence({
        gateway,
        databaseId: 'database-id',
        desired: statusProperty({
          options: [option({ id: 'published', name: 'Published', color: 'blue' })],
        }),
      }).pipe(Effect.either),
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(StatusSchemaUnsupportedDriftError)
    }
    expect(updates).toEqual([])
  })

  it('apply fails verification when Notion silently no-ops the update', async () => {
    const livePublished = option({ id: 'published', name: 'Published', color: 'green' })
    const desiredBlocked = option({ id: 'blocked', name: 'Blocked', color: 'red' })
    const gateway = makeGateway({
      liveResponses: [
        statusProperty({ options: [livePublished] }),
        statusProperty({ options: [livePublished] }),
      ],
      updates: [],
    })

    const result = await Effect.runPromise(
      applyStatusSchemaConvergence({
        gateway,
        databaseId: 'database-id',
        desired: statusProperty({ options: [livePublished, desiredBlocked] }),
      }).pipe(Effect.either),
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(StatusSchemaApplyVerificationError)
    }
  })

  it('extracts desired status metadata from a generated schema module export', async () => {
    const schema = Schema.Struct({
      Status: NotionSchema.status().annotations({
        [notionPropertyMeta]: statusProperty({
          options: [option({ id: 'published', name: 'Published', color: 'green' })],
        }),
      }),
    })

    const desired = await Effect.runPromise(
      getDesiredStatusPropertyFromSchemaModule({
        module: { DeploymentsPageProperties: schema },
        path: 'deployments.gen.ts',
        exportName: 'DeploymentsPageProperties',
        propertyName: 'Status',
      }),
    )

    expect(desired.status.options.map((statusOption) => statusOption.name)).toEqual(['Published'])
  })
})
