/**
 * otel debug test
 *
 * End-to-end smoke test: send a span and verify it round-trips
 * through Collector -> Tempo -> Grafana via both HTTP and spool file paths.
 */

import * as Cli from '@effect/cli'
import { Effect, Schedule } from 'effect'
import React from 'react'

import { outputModeLayer, outputOption } from '@overeng/tui-react/node'

import { DebugTestApp, DebugTestView, type TestStep } from '../../renderers/DebugTestOutput/mod.ts'
import { sendTestSpan, sendTestSpanViaSpool } from '../../services/CollectorClient.ts'
import { searchTraces } from '../../services/GrafanaClient.ts'
import { getTrace } from '../../services/TempoClient.ts'

/** End-to-end smoke test: send a span and verify round-trip through the OTEL stack. */
export const testCommand = Cli.Command.make(
  'test',
  {
    output: outputOption,
  },
  ({ output }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* DebugTestApp.run(
          React.createElement(DebugTestView, { stateAtom: DebugTestApp.stateAtom }),
        )

        // Generate unique IDs so each test run produces a distinct trace
        // that won't collide with previous runs in Tempo's search index.
        const testTraceId = randomHex(32)
        const testSpanId = randomHex(16)
        const spoolTraceId = randomHex(32)
        const spoolSpanId = randomHex(16)
        const testSuffix = randomHex(8)
        const serviceName = `otel-cli-test-${testSuffix}`
        const spanName = `smoke-test-${Date.now()}`
        const spoolSpanName = `smoke-test-spool-${Date.now()}`

        const steps: Array<TestStep> = [
          { name: 'Send test span via HTTP', status: 'pending' },
          { name: 'Send test span via spool file', status: 'pending' },
          { name: 'Wait for ingestion', status: 'pending' },
          { name: 'Verify HTTP span in Tempo', status: 'pending' },
          { name: 'Verify spool span in Tempo', status: 'pending' },
          { name: 'Verify via Grafana TraceQL', status: 'pending' },
        ]

        const updateStep = (args: {
          index: number
          status: TestStep['status']
          message?: string
        }) => {
          const step = steps[args.index]
          if (step !== undefined) {
            steps[args.index] = {
              name: step.name,
              status: args.status,
              message: args.message,
            }
          }
          tui.dispatch({ _tag: 'UpdateSteps', steps: [...steps] })
        }

        // Step 1: Send test span via HTTP
        updateStep({ index: 0, status: 'running' })
        const sendResult = yield* Effect.either(
          sendTestSpan({
            serviceName,
            spanName,
            traceId: testTraceId,
            spanId: testSpanId,
          }),
        )

        if (sendResult._tag === 'Left') {
          updateStep({ index: 0, status: 'failed', message: sendResult.left.message })
          tui.dispatch({ _tag: 'Complete', steps: [...steps], allPassed: false })
          return
        }
        updateStep({ index: 0, status: 'passed', message: 'span sent' })

        // Step 2: Send test span via spool file
        updateStep({ index: 1, status: 'running' })
        const spoolResult = yield* Effect.either(
          sendTestSpanViaSpool({
            serviceName,
            spanName: spoolSpanName,
            traceId: spoolTraceId,
            spanId: spoolSpanId,
          }),
        )

        let spoolEnabled = true
        if (spoolResult._tag === 'Left') {
          // Spool not available — skip gracefully (OTEL_SPAN_SPOOL_DIR not set)
          spoolEnabled = false
          updateStep({ index: 1, status: 'skipped', message: 'OTEL_SPAN_SPOOL_DIR not set' })
        } else {
          updateStep({ index: 1, status: 'passed', message: 'span written to spool file' })
        }

        // Step 3: Wait for ingestion
        updateStep({ index: 2, status: 'running' })
        yield* Effect.sleep('2 seconds')
        updateStep({ index: 2, status: 'passed', message: '2s delay' })

        // Step 4: Verify HTTP span in Tempo
        updateStep({ index: 3, status: 'running' })
        const traceResult = yield* Effect.either(getTrace(testTraceId))

        if (traceResult._tag === 'Left') {
          updateStep({ index: 3, status: 'failed', message: traceResult.left.message })
          tui.dispatch({ _tag: 'Complete', steps: [...steps], allPassed: false })
          return
        }
        updateStep({
          index: 3,
          status: 'passed',
          message: `trace ${testTraceId.slice(0, 8)}... found`,
        })

        // Step 5: Verify spool span in Tempo
        if (spoolEnabled) {
          updateStep({ index: 4, status: 'running' })
          const spoolTraceResult = yield* Effect.either(getTrace(spoolTraceId))

          if (spoolTraceResult._tag === 'Left') {
            updateStep({ index: 4, status: 'failed', message: spoolTraceResult.left.message })
          } else {
            updateStep({
              index: 4,
              status: 'passed',
              message: `trace ${spoolTraceId.slice(0, 8)}... found`,
            })
          }
        } else {
          updateStep({ index: 4, status: 'skipped', message: 'spool not available' })
        }

        // Step 6: Verify via Grafana TraceQL (retry — search index may lag behind ingest)
        // Tempo's search index needs ~9s after ingestion to become searchable.
        // Direct trace lookup (steps 4-5) works immediately via the WAL, but search
        // requires the ingester to flush blocks.
        updateStep({ index: 5, status: 'running' })

        const found = yield* searchTraces({
          query: `{resource.service.name="${serviceName}"}`,
          limit: 1,
          includeInternal: true,
        }).pipe(
          Effect.flatMap((results) =>
            results.some((t) => t.traceId === testTraceId)
              ? Effect.succeed(true)
              : Effect.fail('not-found' as const),
          ),
          Effect.retry(Schedule.spaced('3 seconds').pipe(Schedule.intersect(Schedule.recurs(4)))),
          Effect.orElseSucceed(() => false),
        )
        if (found) {
          updateStep({ index: 5, status: 'passed', message: 'trace found via TraceQL' })
        } else {
          updateStep({
            index: 5,
            status: 'failed',
            message: 'trace not found via TraceQL (may need more time)',
          })
        }

        const allPassed = steps.every((s) => s.status === 'passed' || s.status === 'skipped')
        tui.dispatch({ _tag: 'Complete', steps: [...steps], allPassed })
      }),
    ).pipe(Effect.provide(outputModeLayer(output))),
).pipe(Cli.Command.withDescription('End-to-end smoke test: send span and verify in Tempo'))

// =============================================================================
// Helpers
// =============================================================================

/** Generate a random hex string of the given length. */
const randomHex = (length: number): string => {
  const chars = '0123456789abcdef'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * 16)]
  }
  return result
}
