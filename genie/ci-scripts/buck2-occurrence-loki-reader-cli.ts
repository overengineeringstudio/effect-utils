#!/usr/bin/env bun
import { parseArgs } from 'node:util'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { Effect, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

import { readOccurrenceLoki, readerOtlp } from './buck2-occurrence-loki-reader.ts'

class CliError extends Schema.TaggedError<CliError>()('CliError', { message: Schema.String }) {}
const help = `buck2-occurrence-loki-reader --previous-utc-day --expected-host <host>... [--loki-url http://127.0.0.1:42034] [--mimir-url http://127.0.0.1:42030] [--otlp-endpoint http://127.0.0.1:4318] [--max-runtime 20m] [--query-timeout 60s] [--format json]

Only the previous complete UTC day is scored. Loki reads never reach further than 48h back.
UNKNOWN is a valid report (exit 0). Invalid arguments or publishing transport failure exit nonzero.
JSON is printed to stdout. Metrics and a JSON proof/reasons log are sent to OTLP HTTP.
Durations require ms, s, m, or h. Hosts are explicit, repeatable inputs; no inferred fleet.
`
const duration = (value: string) => {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value)
  if (match === null) throw new CliError({ message: 'Invalid duration (use ms, s, m, h)' })
  const amount =
    Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] as 'ms' | 's' | 'm' | 'h']
  if (Number.isSafeInteger(amount) === false || amount <= 0)
    throw new CliError({ message: 'Duration must be a positive safe integer' })
  return amount
}
const program = Effect.gen(function* () {
  const options = yield* Effect.try({
    try: () =>
      parseArgs({
        options: {
          'previous-utc-day': { type: 'boolean' },
          'expected-host': { type: 'string', multiple: true },
          'loki-url': { type: 'string', default: 'http://127.0.0.1:42034' },
          'mimir-url': { type: 'string', default: 'http://127.0.0.1:42030' },
          'otlp-endpoint': { type: 'string', default: 'http://127.0.0.1:4318' },
          'max-runtime': { type: 'string', default: '20m' },
          'query-timeout': { type: 'string', default: '60s' },
          format: { type: 'string', default: 'json' },
          help: { type: 'boolean' },
        },
      }).values,
    catch: () => new CliError({ message: 'Invalid arguments; use --help' }),
  })
  if (options.help === true) {
    process.stdout.write(help)
    return
  }
  const expectedHosts = options['expected-host'] ?? []
  if (
    options['previous-utc-day'] !== true ||
    expectedHosts.length === 0 ||
    expectedHosts.some((host) => host.trim().length === 0) === true ||
    options.format !== 'json'
  )
    return yield* Effect.fail(
      new CliError({
        message: 'Require --previous-utc-day, at least one --expected-host, and --format json',
      }),
    )
  const limits = yield* Effect.try({
    try: () => ({
      maxRuntimeMs: duration(options['max-runtime']),
      queryTimeoutMs: duration(options['query-timeout']),
    }),
    catch: () => new CliError({ message: 'Invalid duration' }),
  })
  if (limits.maxRuntimeMs <= 2 * limits.queryTimeoutMs)
    return yield* Effect.fail(
      new CliError({ message: '--max-runtime must exceed two --query-timeout publication slots' }),
    )
  const report = yield* readOccurrenceLoki({
    lokiUrl: options['loki-url'],
    mimirUrl: options['mimir-url'],
    expectedHosts,
    now: Date.now(),
    queryTimeoutMs: limits.queryTimeoutMs,
    maxRuntimeMs: limits.maxRuntimeMs - 2 * limits.queryTimeoutMs,
  })
  process.stdout.write(`${JSON.stringify(report)}\n`)
  const client = yield* HttpClient.HttpClient
  const publish = ({ path, payload }: { path: string; payload: unknown }) =>
    Effect.gen(function* () {
      const request = yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post(`${options['otlp-endpoint'].replace(/\/$/, '')}/v1/${path}`),
        payload,
      )
      const response = yield* client.execute(request)
      if (response.status < 200 || response.status >= 300)
        return yield* Effect.fail(new CliError({ message: 'OTLP publication rejected' }))
      const text = yield* response.text
      if (text.trim() !== '') {
        const result = yield* Effect.try({
          try: () =>
            JSON.parse(text) as {
              partialSuccess?: {
                rejectedDataPoints?: string | number
                rejectedLogRecords?: string | number
              }
              partial_success?: {
                rejected_data_points?: string | number
                rejected_log_records?: string | number
              }
            },
          catch: () => new CliError({ message: 'Invalid OTLP response' }),
        })
        if (
          Number(
            result.partialSuccess?.rejectedDataPoints ??
              result.partial_success?.rejected_data_points ??
              0,
          ) > 0 ||
          Number(
            result.partialSuccess?.rejectedLogRecords ??
              result.partial_success?.rejected_log_records ??
              0,
          ) > 0
        )
          return yield* Effect.fail(new CliError({ message: 'OTLP partial rejection' }))
      }
    }).pipe(Effect.timeout(`${limits.queryTimeoutMs} millis`))
  yield* publish({ path: 'metrics', payload: readerOtlp(report) })
  yield* publish({
    path: 'logs',
    payload: {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'effect-utils-buck2' } },
              { key: 'service.namespace', value: { stringValue: 'infra' } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: 'buck2-occurrence-loki-reader' },
              logRecords: [
                {
                  timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
                  body: {
                    stringValue: JSON.stringify({
                      type: 'buck2.occurrence.reader.proof',
                      proof: report.proof,
                      reasons: report.reasons,
                      windowStartMs: report.windowStartMs,
                      windowEndMs: report.windowEndMs,
                    }),
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  })
}).pipe(
  Effect.scoped,
  Effect.provide(FetchHttpClient.layer),
  Effect.mapError(
    () =>
      new CliError({
        message:
          'Reader argument, request, or publication failed; JSON report if present remains non-authoritative until delivered',
      }),
  ),
)

program.pipe(NodeRuntime.runMain())
