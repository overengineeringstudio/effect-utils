import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, FileSystem } from 'effect'

import { makeOccurrenceLedger, OccurrenceLedgerError } from './buck2-occurrence-ledger.ts'
import { reconstructOccurrenceLokiSnapshots } from './buck2-occurrence-loki.ts'
import { reconcileOccurrenceRecords, type OccurrenceEvidence } from './buck2-occurrence-records.ts'

const options = { expectedHosts: ['host'], windowStartMs: 0, windowEndMs: 1000 }
const snapshot = (values: readonly unknown[]) => {
  const lines = values.map((value) => JSON.stringify(value))
  const body = lines.join('\n') + '\n'
  const hash = createHash('sha256').update(body).digest('hex')
  return lines.map((line, ordinal) =>
    JSON.stringify({
      type: 'buck2.occurrence.ledger',
      version: 1,
      snapshotSha256: hash,
      ordinal,
      recordCount: lines.length,
      line,
    }),
  )
}
const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } })
const manifest = (host = 'host', retention = 2592000) =>
  snapshot([
    {
      type: 'manifest',
      host,
      enrolled_at_ns: '0',
      retention_seconds: retention,
      scope: 'supported-entrypoints',
      coverage: 'unknown-until-reconciled',
    },
  ])
const census = (
  phase: 'open' | 'terminal',
  id = 'invocation',
  build: string | null = 'build',
  host = 'host',
  run = 'run',
) =>
  snapshot([
    {
      type: 'invocation',
      phase,
      invocation_id: id,
      host,
      timestamp_ns: phase === 'open' ? '1' : '100',
      build_id: build,
      exit_code: phase === 'open' ? null : 0,
      capture_error: false,
      lane: 'supported-entrypoint/local',
      run_id: run,
    },
  ])
const occurrence = (
  span: string,
  id = `occurrence-${span}`,
  build = 'build',
  digest = 'digest',
) => ({
  type: 'occurrence',
  build_id: build,
  span_id: span,
  start_ns: '10',
  end_ns: '20',
  ended: true,
  attributes: [
    attribute('buck2.occurrence_id', id),
    attribute('buck2.action_digest', digest),
    attribute('buck2.execution_outcome', 'local-exec'),
    { key: 'buck2.total_bytes', value: { intValue: '42' } },
  ],
})
const capture = (
  rows: readonly unknown[],
  { build = 'build', root = 'root', incomplete = false, host = 'host', run = 'run' } = {},
) =>
  snapshot([
    {
      type: 'conversion',
      build_id: build,
      root_id: root,
      resource_attributes: [
        attribute('host.name', host),
        attribute('buck2.root_id', root),
        attribute('cicd.pipeline.run.id', run),
      ],
      truncated: incomplete,
      stop_reason: null,
      unknown_fields: 0,
      action_count: rows.length,
    },
    ...rows,
  ])
const baseline = () => [...manifest(), ...census('open'), ...census('terminal')]

// Uses the suite's Bun runner and real platform filesystem/SQLite, with one scoped harness.
const compare = (
  pages: readonly (readonly string[])[],
  filters: { hosts: readonly string[]; key?: string } = { hosts: [] },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const ledger = yield* makeOccurrenceLedger({ ...options, directory })
      for (const page of pages) yield* ledger.addPage(page)
      const path = `${directory}/report.json`
      const counts = yield* ledger.writeReport({ path, ...filters })
      const body = yield* fs.readFileString(path)
      const actual: OccurrenceEvidence = JSON.parse(body)
      const oracle = reconcileOccurrenceRecords({
        ...options,
        files: reconstructOccurrenceLokiSnapshots(pages.flat()),
      })
      oracle.records = oracle.records.filter(
        (record) =>
          (filters.hosts.length === 0 || filters.hosts.includes(record.host)) &&
          (filters.key === undefined || filters.key === record.digest),
      )
      expect(actual).toEqual(oracle)
      expect(counts).toEqual({
        recordCount: actual.records.length,
        evidenceGapCount: actual.evidenceGaps.length,
      })
      // A report record/gap is one physical line, never a whole-day JSON serialization.
      for (const line of body.split('\n')) expect(line.length).toBeLessThan(10000)
      return actual
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

test('SQLite report matches multi-file oracle with interleaved ordinals and exact repeats', async () => {
  const rows = capture([occurrence('2'), occurrence('1')])
  const evidence = await compare([
    [...baseline(), rows[2]!],
    [rows[1]!, rows[0]!],
    rows,
    manifest(),
  ])
  expect(evidence.records.map((row) => row.id)).toEqual(['occurrence-2', 'occurrence-1'])
})
test('snapshot first-seen order, not completion order, determines census latest values', async () => {
  const first = capture([occurrence('1')])
  await compare([
    [first[1]!],
    [...census('terminal', 'second'), ...census('terminal'), ...baseline()],
    [first[0]!],
  ])
})
test('complete supersets cover incomplete versions; incomparable and mismatched versions remain gaps', async () => {
  const a = occurrence('1')
  const b = occurrence('2')
  const c = occurrence('3')
  const covered = await compare([
    [...baseline(), ...capture([a], { incomplete: true })],
    capture([a, b]),
  ])
  expect(covered.evidenceGaps).not.toContain('build:incomplete-conversion')
  const incomparable = await compare([
    [...baseline(), ...capture([a, b])],
    capture([a, c]),
    capture([a], { root: 'other', incomplete: true }),
  ])
  expect(incomparable.evidenceGaps).toContain('build:incomparable-captures')
  expect(incomparable.evidenceGaps).toContain('build:capture-identity-mismatch')
  expect(incomparable.evidenceGaps).toContain('build:incomplete-conversion')
})
test('canonical duplicate spans deduplicate, differing spans and cross-build occurrence IDs suppress', async () => {
  const evidence = await compare([
    [...baseline(), ...capture([occurrence('1'), occurrence('1'), occurrence('2', 'shared')])],
    capture([occurrence('1', 'changed'), occurrence('2', 'shared')]),
    census('open', 'other', 'other'),
    census('terminal', 'other', 'other'),
    capture([occurrence('3', 'shared', 'other')], { build: 'other' }),
  ])
  expect(evidence.records).toEqual([])
  expect(evidence.evidenceGaps).toContain('shared:conflicting-identity')
})
test('native per-capture conflicts suppress even when a later complete version repairs that span', async () => {
  const evidence = await compare([
    [...baseline(), ...capture([occurrence('1'), occurrence('1', 'different')])],
    capture([occurrence('1')]),
  ])
  expect(evidence.records).toEqual([])
})
test('census latest value retains first-key order across collision and multiple invocation builds', async () => {
  await compare([
    [...baseline(), ...capture([occurrence('1')])],
    census('terminal', 'another'),
    census('open', 'another'),
    census('terminal', 'invocation', 'build', 'unexpected', 'other-run'),
    manifest('host', 1),
  ])
})
test('missing census pair/conversion/manifests and malformed native evidence preserve oracle gaps', async () => {
  const malformed = snapshot([{ type: 'conversion', build_id: 'bad' }, { type: 'occurrence' }])
  await compare([
    census('terminal', 'missing', null),
    census('terminal', 'no-conversion', 'absent'),
    capture([occurrence('1')]),
    malformed,
  ])
})
test('filters select records only, retaining all global and unselected-host gaps', async () => {
  const pages = [
    [
      ...baseline(),
      ...capture([occurrence('1')]),
      ...capture([occurrence('2', 'second', 'second')], { build: 'second', host: 'unexpected' }),
    ],
  ]
  const hidden = await compare(pages, { hosts: ['not-present'], key: 'digest' })
  expect(hidden.records).toEqual([])
  expect(hidden.evidenceGaps).toContain('unexpected:unexpected-host')
  await compare(pages, { hosts: ['host'], key: 'digest' })
  await compare(pages, { hosts: [], key: 'absent' })
})

const expectFailure = (pages: readonly (readonly string[])[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const result = yield* Effect.gen(function* () {
        const ledger = yield* makeOccurrenceLedger({ ...options, directory })
        for (const page of pages) yield* ledger.addPage(page)
        return yield* ledger.writeReport({ path: `${directory}/report.json`, hosts: [] })
      }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure).toBeInstanceOf(OccurrenceLedgerError)
        expect(result.failure.message).toContain('coverage UNKNOWN')
      }
      expect(yield* fs.exists(`${directory}/report.json`)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

test('partial snapshots cannot certify exhaustion', async () => {
  const rows = capture([occurrence('1')])
  await expectFailure([[rows[1]!]])
})
test('tampered hash, count, ordinal and conflicting repeated envelope fail explicitly', async () => {
  const rows = capture([occurrence('1')])
  const original = JSON.parse(rows[0]!)
  await expectFailure([[JSON.stringify({ ...original, line: original.line + ' ' }), rows[1]!]])
  await expectFailure([[rows[0]!], [JSON.stringify({ ...original, recordCount: 3 })]])
  await expectFailure([[JSON.stringify({ ...original, ordinal: 5000 })]])
  await expectFailure([[rows[0]!], [JSON.stringify({ ...original, line: 'different' })]])
  await expectFailure([[JSON.stringify({ ...original, recordCount: 5001 })]])
  await expectFailure([[JSON.stringify({ ...original, line: 'embedded\nnewline' })]])
  await expectFailure([rows, [JSON.stringify({ ...original, line: 'different-after-completion' })]])
  await expectFailure([[JSON.stringify({ ...original, version: 2 })]])
})
test('scoped SQLite directory is removed on success and native proof failure', async () => {
  // Inspect actual invocation-owned directories, not a mocked database/resource layer.
  const fsProgram = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tempRoot = yield* fs.makeTempDirectoryScoped()
    // The report remains outside the ledger's private scope, while its DB is released.
    const path = `${tempRoot}/report.json`
    const before = new Set(yield* fs.readDirectory(tempRoot))
    let ledgerDirectory = ''
    yield* Effect.gen(function* () {
      const ledger = yield* makeOccurrenceLedger({ ...options, directory: tempRoot })
      const created = (yield* fs.readDirectory(tempRoot)).find(
        (entry) => entry.startsWith('buck2-occurrence-ledger-') && !before.has(entry),
      )
      expect(created).toBeDefined()
      ledgerDirectory = `${tempRoot}/${created}`
      expect(yield* fs.exists(`${ledgerDirectory}/ledger.sqlite`)).toBe(true)
      yield* ledger.addPage([...baseline(), ...capture([occurrence('1')])])
      yield* ledger.writeReport({ path, hosts: [] })
    }).pipe(Effect.scoped)
    expect(JSON.parse(yield* fs.readFileString(path)).records).toHaveLength(1)
    expect(yield* fs.exists(ledgerDirectory)).toBe(false)
    expect(
      (yield* fs.readDirectory(tempRoot)).filter((entry) =>
        entry.startsWith('.buck2-occurrence-report-'),
      ),
    ).toEqual([])
    const prior = yield* fs.readFileString(path)
    const failure = yield* Effect.gen(function* () {
      const ledger = yield* makeOccurrenceLedger({ ...options, directory: tempRoot })
      const created = (yield* fs.readDirectory(tempRoot)).find(
        (entry) => entry.startsWith('buck2-occurrence-ledger-') && !before.has(entry),
      )
      expect(created).toBeDefined()
      ledgerDirectory = `${tempRoot}/${created}`
      yield* ledger.addPage([capture([occurrence('1')])[1]!])
      return yield* ledger.writeReport({ path, hosts: [] })
    }).pipe(Effect.scoped, Effect.result)
    expect(failure._tag).toBe('Failure')
    expect(yield* fs.exists(ledgerDirectory)).toBe(false)
    expect(yield* fs.readFileString(path)).toBe(prior)
    const blockedPath = `${tempRoot}/directory`
    yield* fs.makeDirectory(blockedPath)
    const renameFailure = yield* Effect.gen(function* () {
      const ledger = yield* makeOccurrenceLedger({ ...options, directory: tempRoot })
      yield* ledger.addPage(manifest())
      return yield* ledger.writeReport({ path: blockedPath, hosts: [] })
    }).pipe(Effect.scoped, Effect.result)
    expect(renameFailure._tag).toBe('Failure')
    expect(
      (yield* fs.readDirectory(tempRoot)).filter((entry) =>
        entry.startsWith('.buck2-occurrence-report-'),
      ),
    ).toEqual([])
    // A closed ledger cannot mutate its released SQLite resource.
    const closed = yield* Effect.gen(function* () {
      return yield* makeOccurrenceLedger({ ...options, directory: tempRoot })
    }).pipe(Effect.scoped)
    const rejected = yield* closed.addPage(manifest()).pipe(Effect.result)
    expect(rejected._tag).toBe('Failure')
  })
  await Effect.runPromise(fsProgram.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
