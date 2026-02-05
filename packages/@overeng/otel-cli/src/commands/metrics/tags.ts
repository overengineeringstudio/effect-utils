/**
 * otel metrics tags [name] [--filter]
 *
 * List span attribute tags or values for a specific tag.
 */

import * as Cli from '@effect/cli'
import { Effect, Option } from 'effect'
import React from 'react'

import { outputModeLayer, outputOption } from '@overeng/tui-react'

import { LsApp, LsView, type MetricSummary } from '../../renderers/MetricsLsOutput/mod.ts'
import { getTags, getTagValues } from '../../services/MetricsClient.ts'

/** List tags or tag values. */
export const tagsCommand = Cli.Command.make(
  'tags',
  {
    output: outputOption,
    tagName: Cli.Args.optional(Cli.Args.text({ name: 'tag-name' })).pipe(
      Cli.Args.withDescription('Tag name to get values for (omit to list all tags)'),
    ),
    filter: Cli.Options.optional(Cli.Options.text('filter')).pipe(
      Cli.Options.withDescription('Filter by pattern'),
    ),
  },
  ({ output, tagName: tagNameOption, filter: filterOption }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* LsApp.run(React.createElement(LsView, { stateAtom: LsApp.stateAtom }))
        const filterValue = Option.getOrUndefined(filterOption)
        const tagName = Option.getOrUndefined(tagNameOption)

        if (tagName !== undefined) {
          // Get values for specific tag
          const values = yield* Effect.catchAll(getTagValues(tagName), (error) =>
            Effect.gen(function* () {
              tui.dispatch({
                _tag: 'SetError',
                error: error.reason,
                message: error.message,
              })
              return yield* error
            }),
          )

          // Filter values
          let filteredValues = [...values]
          if (filterValue) {
            const pattern = filterValue.toLowerCase()
            filteredValues = filteredValues.filter((v) => v.toLowerCase().includes(pattern))
          }

          // Convert to metrics format
          const metrics: MetricSummary[] = filteredValues.map((value) => ({
            name: value,
            type: 'value',
            value: 1,
            labels: { tag: tagName },
          }))

          tui.dispatch({
            _tag: 'SetMetrics',
            metrics,
            metricNames: filteredValues,
            filter: filterValue,
            source: 'tempo',
          })
        } else {
          // List all tags
          const tags = yield* Effect.catchAll(getTags(), (error) =>
            Effect.gen(function* () {
              tui.dispatch({
                _tag: 'SetError',
                error: error.reason,
                message: error.message,
              })
              return yield* error
            }),
          )

          // Filter tags
          let filteredTags = [...tags]
          if (filterValue) {
            const pattern = filterValue.toLowerCase()
            filteredTags = filteredTags.filter((t) => t.toLowerCase().includes(pattern))
          }

          // Convert to metrics format (without fetching value counts for speed)
          const metrics: MetricSummary[] = filteredTags.map((tag) => ({
            name: tag,
            type: 'tag',
            value: 0,
            labels: {},
          }))

          tui.dispatch({
            _tag: 'SetMetrics',
            metrics,
            metricNames: filteredTags,
            filter: filterValue,
            source: 'tempo',
          })
        }
      }),
    ).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('List span attribute tags or tag values'))
