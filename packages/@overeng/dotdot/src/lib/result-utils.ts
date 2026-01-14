/**
 * Common result utilities for command operations
 *
 * Provides generic result types and summary building for repo operations.
 */

import { Effect } from 'effect'

/** Base result shape for repo operations */
export type BaseResult<TStatus extends string> = {
  name: string
  status: TStatus
  message?: string
}

/** Count results by status */
export const countByStatus = <TStatus extends string>({
  results,
  statuses,
}: {
  results: BaseResult<TStatus>[]
  statuses: readonly TStatus[]
}): Record<TStatus, number> => {
  const counts = {} as Record<TStatus, number>
  for (const status of statuses) {
    counts[status] = results.filter((r) => r.status === status).length
  }
  return counts
}

/** Build a summary string from results */
export const buildSummary = <TStatus extends string>({
  results,
  statusLabels,
}: {
  results: BaseResult<TStatus>[]
  statusLabels: Record<TStatus, string>
}): string => {
  const statuses = Object.keys(statusLabels) as TStatus[]
  const counts = countByStatus({ results, statuses })

  const parts: string[] = []
  for (const status of statuses) {
    const count = counts[status]
    if (count > 0) {
      parts.push(`${count} ${statusLabels[status]}`)
    }
  }

  return parts.join(', ')
}

/** Log results summary with Effect.log */
export const logSummary = <TStatus extends string>({
  results,
  statusLabels,
  prefix = 'Done:',
}: {
  results: BaseResult<TStatus>[]
  statusLabels: Record<TStatus, string>
  prefix?: string
}) =>
  Effect.gen(function* () {
    const summary = buildSummary({ results, statusLabels })
    yield* Effect.log(`${prefix} ${summary}`)
  })
