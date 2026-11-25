import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { Effect, FileSystem, Schema } from 'effect'

import { makeDownloadBudget, readBoundedBytes } from './buck2-cache-join-download.ts'
import { decodeOccurrenceLoki } from './buck2-occurrence-loki.ts'
import type { RetainedOccurrenceFile } from './buck2-occurrence-record-codec.ts'
import { reconcileOccurrenceRecords } from './buck2-occurrence-records.ts'

export class OccurrenceQueryError extends Schema.TaggedError<OccurrenceQueryError>()(
  'OccurrenceQueryError',
  { message: Schema.String },
) {}
const failure = (message: string) => new OccurrenceQueryError({ message })
const help = `buck2-cache-join occurrences (--records-dir DIR | --loki-response FILE) --since ISO-8601 [--until ISO-8601]
  [--host HOST] [--key FULL_ACTION_DIGEST] [--expected-host HOST]

Read native retained JSONL snapshots, returning JSON records and evidenceGaps.
Repeat --records-dir, --host or --expected-host for multiple values. Host/key filters
select rows, never certify fleet coverage. --key exactly matches the native digest.
The window is [since,until), at most 31 days; until defaults to now. No GitHub token,
backend access or writes are required. Limits: 100000 entries, 64 MiB/file, 512 MiB total.
`

export const queryOccurrences = (
  args: readonly string[],
): Effect.Effect<string, OccurrenceQueryError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const options = yield* Effect.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: {
            'records-dir': { type: 'string', multiple: true },
            'loki-response': { type: 'string' },
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
    if (directories.some((value) => value.length === 0) ||
      (directories.length === 0 && options['loki-response'] === undefined))
      return yield* failure('--records-dir or --loki-response is required')
    const now = Date.now()
    const timestamp = (value: string) =>
      /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN
    const since = timestamp(options.since ?? '')
    const until = options.until === undefined ? now : timestamp(options.until)
    if (
      !Number.isSafeInteger(since) || !Number.isSafeInteger(until) ||
      since >= until || until > now || until - since > 31 * 86400000
    )
      return yield* failure('Specify a past, increasing ISO-8601 window of at most 31 days')
    if (options.key === '' || options.host?.some((value) => value === '') === true)
      return yield* failure('--host and --key must not be empty')
    const fs = yield* FileSystem.FileSystem
    const files: RetainedOccurrenceFile[] = []
    let entries = 0
    const budget = makeDownloadBudget(512 * 1024 * 1024)
    if (options['loki-response'] !== undefined) {
      const content = yield* readBoundedBytes(fs.stream(options['loki-response']), 64 * 1024 * 1024, budget)
      files.push(...(yield* Effect.try({
        try: () => decodeOccurrenceLoki(new TextDecoder('utf-8', { fatal: true }).decode(content)),
        catch: () => failure('Invalid or incomplete Loki occurrence response; coverage UNKNOWN'),
      })))
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
      try: () => reconcileOccurrenceRecords({
        files, expectedHosts: options['expected-host'] ?? [],
        windowStartMs: since, windowEndMs: until,
      }),
      catch: () => failure('Invalid retained occurrence evidence'),
    })
    const hosts = new Set(options.host)
    return `${JSON.stringify({
      ...report,
      records: report.records.filter((record) =>
        (hosts.size === 0 || hosts.has(record.host)) &&
        (options.key === undefined || record.digest === options.key)),
    })}\n`
  }).pipe(Effect.mapError((cause) =>
    cause instanceof OccurrenceQueryError ? cause : failure(`Cannot read retained evidence: ${String(cause)}`)))
