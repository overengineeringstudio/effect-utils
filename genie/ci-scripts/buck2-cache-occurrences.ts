import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

import { Effect, FileSystem, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'

import { makeDownloadBudget, readBoundedBytes } from './buck2-cache-join-download.ts'
import { makeOccurrenceLedger } from './buck2-occurrence-ledger.ts'
import { consumeOccurrenceLokiPages } from './buck2-occurrence-loki-query.ts'
import { decodeOccurrenceLoki } from './buck2-occurrence-loki.ts'
import type { RetainedOccurrenceFile } from './buck2-occurrence-record-codec.ts'
import { reconcileOccurrenceRecords } from './buck2-occurrence-records.ts'

export class OccurrenceQueryError extends Schema.TaggedError<OccurrenceQueryError>()(
  'OccurrenceQueryError',
  { message: Schema.String },
) {}
const failure = (message: string) => new OccurrenceQueryError({ message })
const help = `buck2-cache-join occurrences (--records-dir DIR | --loki-response FILE | --loki-url URL --output FILE) --since ISO-8601 [--until ISO-8601]
  [--query-host HOST] [--host HOST] [--key FULL_ACTION_DIGEST] [--expected-host HOST]

Read native retained JSONL snapshots, returning JSON records and evidenceGaps.
Repeat --records-dir, --host or --expected-host for multiple values. Host/key filters
select rows, never certify fleet coverage. --key exactly matches the native digest.
The window is [since,until), at most 31 days offline or 24 hours for --loki-url;
until defaults to now. Live reads exhaust hourly cursor pages into a scoped disk
ledger, write the full report to --output FILE and return a small JSON summary.
--query-host narrows only the server-side selector. No GitHub token or remote
writes are required. Live limits: 64 MiB/page or snapshot, 10 minutes total wall
time, no cumulative byte cap or whole-day RAM. Offline limits: 100000 retained
files, 64 MiB/file or raw response, 512 MiB total. Unproven exhaustion fails loudly.
`

export const queryOccurrences = (
  args: readonly string[],
): Effect.Effect<string, OccurrenceQueryError, FileSystem.FileSystem | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const options = yield* Effect.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: {
            'records-dir': { type: 'string', multiple: true },
            'loki-response': { type: 'string' },
            'loki-url': { type: 'string' },
            'query-host': { type: 'string' },
            output: { type: 'string' },
            since: { type: 'string' },
            until: { type: 'string' },
            host: { type: 'string', multiple: true },
            key: { type: 'string' },
            'expected-host': { type: 'string', multiple: true },
            help: { type: 'boolean', short: 'h' },
          },
        }).values,
      catch: () => failure('Invalid occurrences arguments; use occurrences --help'),
    })
    if (options.help === true) return help
    const directories = options['records-dir'] ?? []
    if (
      directories.some((value) => value.length === 0) ||
      (directories.length === 0 &&
        options['loki-response'] === undefined &&
        options['loki-url'] === undefined)
    )
      return yield* failure('--records-dir, --loki-response or --loki-url is required')
    if (
      options['loki-url'] !== undefined &&
      (directories.length !== 0 || options['loki-response'] !== undefined)
    )
      return yield* failure('--loki-url cannot be combined with offline retained inputs')
    if (options['query-host'] !== undefined && options['loki-url'] === undefined)
      return yield* failure('--query-host requires --loki-url')
    if (options.output !== undefined && options['loki-url'] === undefined)
      return yield* failure('--output requires --loki-url')
    if (
      options['loki-url'] !== undefined &&
      (options.output === undefined || options.output === '')
    )
      return yield* failure('--loki-url requires --output FILE')
    const now = Date.now()
    const timestamp = (value: string) =>
      /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN
    const since = timestamp(options.since ?? '')
    const until = options.until === undefined ? now : timestamp(options.until)
    if (
      !Number.isSafeInteger(since) ||
      !Number.isSafeInteger(until) ||
      since >= until ||
      until > now ||
      until - since > 31 * 86400000
    )
      return yield* failure('Specify a past, increasing ISO-8601 window of at most 31 days')
    if (options.key === '' || options.host?.some((value) => value === '') === true)
      return yield* failure('--host and --key must not be empty')
    if (options['loki-url'] !== undefined && until - since > 86400000)
      return yield* failure('Live occurrence queries must cover at most 24 hours')
    const fs = yield* FileSystem.FileSystem
    const files: RetainedOccurrenceFile[] = []
    let entries = 0
    const budget = makeDownloadBudget(512 * 1024 * 1024)
    if (options['loki-url'] !== undefined && options.output !== undefined) {
      const url = options['loki-url']
      const output = options.output
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* makeOccurrenceLedger({
            directory: dirname(output),
            expectedHosts: options['expected-host'] ?? [],
            windowStartMs: since,
            windowEndMs: until,
          })
          const pages = yield* consumeOccurrenceLokiPages(
            {
              url,
              windowStartMs: since,
              windowEndMs: until,
              ...(options['query-host'] === undefined ? {} : { host: options['query-host'] }),
            },
            (page) => ledger.addPage(page.lines),
          )
          const summary = yield* ledger.writeReport({
            path: output,
            hosts: options.host ?? [],
            ...(options.key === undefined ? {} : { key: options.key }),
          })
          return `${JSON.stringify({
            ...summary,
            ...pages,
            coverage: 'UNKNOWN',
            window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
          })}\n`
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: '10 minutes',
          orElse: () =>
            Effect.fail(
              failure('Occurrence reader exceeded 10 minute wall-time budget; coverage UNKNOWN'),
            ),
        }),
        Effect.mapError((cause) => failure(cause.message)),
      )
    }
    if (options['loki-response'] !== undefined) {
      const content = yield* readBoundedBytes(
        fs.stream(options['loki-response']),
        64 * 1024 * 1024,
        budget,
      )
      files.push(
        ...(yield* Effect.try({
          try: () =>
            decodeOccurrenceLoki(new TextDecoder('utf-8', { fatal: true }).decode(content)),
          catch: () => failure('Invalid or incomplete Loki occurrence response; coverage UNKNOWN'),
        })),
      )
    }
    for (const directory of directories) {
      const names = yield* fs.readDirectory(directory)
      entries += names.length
      if (entries > 100000) return yield* failure('Retained entry limit exceeded; coverage UNKNOWN')
      for (const name of names.toSorted()) {
        if (!name.endsWith('.jsonl')) continue
        const path = join(directory, name)
        if ((yield* fs.stat(path)).type !== 'File')
          return yield* failure(`Retained input is not a regular file: ${path}`)
        const content = yield* readBoundedBytes(fs.stream(path), 64 * 1024 * 1024, budget)
        const body = yield* Effect.try({
          try: () => new TextDecoder('utf-8', { fatal: true }).decode(content),
          catch: () => failure(`Invalid retained UTF-8: ${path}`),
        })
        files.push({ name: path, body })
      }
    }
    const report = yield* Effect.try({
      try: () =>
        reconcileOccurrenceRecords({
          files,
          expectedHosts: options['expected-host'] ?? [],
          windowStartMs: since,
          windowEndMs: until,
        }),
      catch: () => failure('Invalid retained occurrence evidence'),
    })
    const hosts = new Set(options.host)
    return `${JSON.stringify({
      ...report,
      records: report.records.filter(
        (record) =>
          (hosts.size === 0 || hosts.has(record.host)) &&
          (options.key === undefined || record.digest === options.key),
      ),
    })}\n`
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof OccurrenceQueryError
        ? cause
        : failure(`Cannot read retained evidence: ${String(cause)}`),
    ),
  )
