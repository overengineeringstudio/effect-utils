/**
 * Effectful execution of native Notion `status` convergence (issue #803).
 *
 * Wraps the pure planner (`status-converge.ts`) with live I/O: observe the
 * freshly-introspected data source, plan, fail closed on blocked plans, issue
 * the one safe additive write, then read-after-write verify (the API returns 200
 * for writes it silently ignores, so the 200 is never trusted).
 */

import { Effect, Schema } from 'effect'

import { NotionDatabases, NotionDataSources, SchemaHelpers } from '@overeng/notion-effect-client'
import type { SelectOptionConfig } from '@overeng/notion-effect-schema'

import {
  buildAddOptionsPayload,
  type DesiredStatusProperty,
  planStatusConvergence,
  type StatusConvergePlan,
} from './status-converge.ts'

/** Failure modes of a status convergence apply. */
export class StatusConvergeError extends Schema.TaggedError<StatusConvergeError>()(
  'StatusConvergeError',
  {
    reason: Schema.Literal(
      'data-source-missing',
      'property-not-found',
      'not-a-status-property',
      'blocked',
      'verification-failed',
    ),
    property: Schema.String,
    message: Schema.String,
  },
) {}

/** Outcome of an apply (or dry-run). */
export interface StatusConvergeResult {
  readonly dataSourceId: string
  readonly plan: StatusConvergePlan
  /** Option names actually created (empty on dry-run or when nothing was missing). */
  readonly created: readonly string[]
  /** Whether a write was issued. */
  readonly applied: boolean
}

/** Read the live options of a named status property on a data source. */
const readLiveStatusOptions = Effect.fnUntraced(function* (dataSourceId: string, property: string) {
  const dataSource = yield* NotionDataSources.retrieve({ dataSourceId })
  const props = SchemaHelpers.getProperties({ schema: dataSource })
  const prop = props.find((p) => p.name === property)
  if (prop === undefined) {
    return yield* new StatusConvergeError({
      reason: 'property-not-found',
      property,
      message: `Property "${property}" not found on data source ${dataSourceId}`,
    })
  }
  if (prop._tag !== 'status') {
    return yield* new StatusConvergeError({
      reason: 'not-a-status-property',
      property,
      message: `Property "${property}" is of type "${prop._tag}", expected "status"`,
    })
  }
  return prop.status.options as readonly SelectOptionConfig[]
})

/**
 * Apply additive status convergence: create desired options missing from live,
 * fail closed otherwise, and verify the write actually took effect.
 */
export const applyStatusConvergence = Effect.fnUntraced(function* (input: {
  readonly databaseId: string
  readonly property: string
  readonly desired: DesiredStatusProperty
  readonly dryRun?: boolean
}) {
  const db = yield* NotionDatabases.retrieve({ databaseId: input.databaseId })
  const dataSourceId = db.data_sources?.[0]?.id
  if (dataSourceId === undefined) {
    return yield* new StatusConvergeError({
      reason: 'data-source-missing',
      property: input.property,
      message: `Database ${input.databaseId} has no data source`,
    })
  }

  const liveOptions = yield* readLiveStatusOptions(dataSourceId, input.property)
  const plan = planStatusConvergence({
    property: input.property,
    liveOptions,
    desired: input.desired,
  })

  if (plan.blocked === true) {
    const extras = plan.decisions
      .flatMap((d) => (d._tag === 'extra-remote' && d.policy === 'fail' ? [d.name] : []))
      .join(', ')
    return yield* new StatusConvergeError({
      reason: 'blocked',
      property: input.property,
      message: `Plan is blocked: live option(s) absent from desired under fail policy: ${extras}. Add them to the config or set policy.extras to 'ignore'.`,
    })
  }

  if (input.dryRun === true || plan.creates.length === 0) {
    return { dataSourceId, plan, created: [], applied: false }
  }

  const payload = buildAddOptionsPayload({ liveOptions, creates: plan.creates })
  yield* NotionDataSources.update({
    dataSourceId,
    properties: { [input.property]: { status: payload } },
  })

  // Read-after-write: writes the API ignores still return 200, so verify.
  const after = yield* readLiveStatusOptions(dataSourceId, input.property)
  const afterNames = new Set(after.map((o) => o.name))
  const missing = plan.creates.filter((c) => afterNames.has(c.name) === false)
  if (missing.length > 0) {
    return yield* new StatusConvergeError({
      reason: 'verification-failed',
      property: input.property,
      message: `Options not present after write (the API may have ignored them): ${missing.map((m) => m.name).join(', ')}`,
    })
  }

  return { dataSourceId, plan, created: plan.creates.map((c) => c.name), applied: true }
})
