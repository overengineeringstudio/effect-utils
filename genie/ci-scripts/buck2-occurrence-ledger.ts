import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import { Effect, FileSystem, Schema, type Scope } from 'effect'

import { integer, text } from './buck2-action-evidence-codec.ts'
import { decodeOccurrenceLokiEnvelope } from './buck2-occurrence-loki.ts'
import { decodeOccurrenceFiles, fail, type Census } from './buck2-occurrence-record-codec.ts'
import { normalizeOccurrenceRecord } from './buck2-occurrence-records.ts'

export class OccurrenceLedgerError extends Schema.TaggedError<OccurrenceLedgerError>()(
  'OccurrenceLedgerError',
  { message: Schema.String },
) {}
export interface OccurrenceLedger {
  readonly addPage: (lines: readonly string[]) => Effect.Effect<void, OccurrenceLedgerError>
  readonly writeReport: (options: {
    path: string
    hosts: readonly string[]
    key?: string
  }) => Effect.Effect<
    { recordCount: number; evidenceGapCount: number },
    OccurrenceLedgerError,
    FileSystem.FileSystem
  >
}
const error = (cause: unknown) =>
  new OccurrenceLedgerError({
    message: `Occurrence ledger failed; occurrence coverage UNKNOWN: ${String(cause)}`,
  })
const attempt = <T>(run: () => T): Effect.Effect<T, OccurrenceLedgerError> =>
  Effect.try({ try: run, catch: error })
const limit = 64 * 1024 * 1024

/** Invocation-owned rebuildable state. SQLite, including temporary joins/sorts, stays on disk. */
export const makeOccurrenceLedger = (options: {
  directory: string
  expectedHosts: readonly string[]
  windowStartMs: number
  windowEndMs: number
}): Effect.Effect<OccurrenceLedger, OccurrenceLedgerError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs
      .makeTempDirectoryScoped({ directory: options.directory, prefix: 'buck2-occurrence-ledger-' })
      .pipe(Effect.mapError(error))
    const db = yield* Effect.acquireRelease(
      attempt(() => new Database(join(directory, 'ledger.sqlite'), { strict: true })),
      (database) => Effect.sync(() => database.close()),
    )
    const { hosts, start, end } = yield* attempt(() => {
      const hosts = new Set(options.expectedHosts.map(text))
      const start = BigInt(integer(options.windowStartMs)) * 1_000_000n
      const end = BigInt(integer(options.windowEndMs)) * 1_000_000n
      if (end <= start) fail()
      db.exec(`
        PRAGMA cache_size = -4096;
        PRAGMA temp_store = FILE;
        PRAGMA journal_mode = DELETE;
        CREATE TABLE snapshots (seq INTEGER PRIMARY KEY, hash TEXT UNIQUE, count INTEGER, bytes INTEGER DEFAULT 0, complete INTEGER DEFAULT 0);
        CREATE TABLE envelopes (hash TEXT, ordinal INTEGER, line TEXT, PRIMARY KEY(hash, ordinal));
        CREATE TABLE gaps (gap TEXT PRIMARY KEY, sortkey TEXT);
        CREATE INDEX gaps_order ON gaps(sortkey);
        CREATE TABLE manifests (host TEXT PRIMARY KEY, canonical TEXT);
        CREATE TABLE census (seq INTEGER PRIMARY KEY, key TEXT UNIQUE, id TEXT, phase TEXT, build TEXT, canonical TEXT);
        CREATE INDEX census_build ON census(build, phase, seq);
        CREATE TABLE captures (seq INTEGER PRIMARY KEY, build TEXT, root TEXT, attrs TEXT, identity TEXT, incomplete INTEGER);
        CREATE INDEX captures_build ON captures(build, seq);
        CREATE TABLE rows (seq INTEGER PRIMARY KEY, capture INTEGER, build TEXT, span TEXT, canonical TEXT, value TEXT, conflict INTEGER, UNIQUE(capture, span));
        CREATE INDEX rows_build_span ON rows(build, span, capture);
        CREATE TABLE conflicts (key TEXT PRIMARY KEY);
        CREATE TABLE records (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, canonical TEXT, host TEXT, digest TEXT);
      `)
      return { hosts, start, end }
    })
    const gap = (value: string) => {
      // Hex UTF-16BE preserves the oracle's JS string ordering in SQLite BINARY.
      const bytes = Buffer.from(value, 'utf16le')
      bytes.swap16()
      db.query('INSERT OR IGNORE INTO gaps VALUES (?,?)').run(value, bytes.toString('hex'))
    }
    const conflict = (value: string) => {
      db.query('INSERT OR IGNORE INTO conflicts VALUES (?)').run(value)
    }
    for (const value of [
      'unsupported-entrypoints:unknown',
      'fleet-registry:unknown',
      'continuous-census:unknown',
      'remote-worker-linkage:unknown',
    ])
      gap(value)
    if (hosts.size === 0) gap('expected-hosts:missing')
    let finalized = false
    let poisoned = false
    const addPage: OccurrenceLedger['addPage'] = (lines) =>
      attempt(() => {
        if (finalized || poisoned) fail()
        try {
          db.transaction(() => {
            for (const line of lines) {
              const row = decodeOccurrenceLokiEnvelope(line)
              db.query('INSERT OR IGNORE INTO snapshots(hash,count) VALUES (?,?)').run(
                row.snapshotSha256,
                row.recordCount,
              )
              const snapshot = db
                .query<{ count: number; bytes: number; complete: number }, [string]>(
                  'SELECT count,bytes,complete FROM snapshots WHERE hash=?',
                )
                .get(row.snapshotSha256)!
              if (snapshot.count !== row.recordCount) fail()
              const previous = db
                .query<{ line: string }, [string, number]>(
                  'SELECT line FROM envelopes WHERE hash=? AND ordinal=?',
                )
                .get(row.snapshotSha256, row.ordinal)
              if (previous !== null) {
                if (previous.line !== row.line) fail()
                continue
              }
              const bytes = Buffer.byteLength(row.line) + 1
              if (snapshot.bytes + bytes > limit) fail()
              db.query('INSERT INTO envelopes VALUES (?,?,?)').run(
                row.snapshotSha256,
                row.ordinal,
                row.line,
              )
              db.query('UPDATE snapshots SET bytes=bytes+? WHERE hash=?').run(
                bytes,
                row.snapshotSha256,
              )
              const total = db
                .query<{ n: number }, [string]>('SELECT count(*) AS n FROM envelopes WHERE hash=?')
                .get(row.snapshotSha256)!.n
              if (total === row.recordCount) {
                const hash = createHash('sha256')
                for (const entry of db
                  .query<{ line: string }, [string]>(
                    'SELECT line FROM envelopes WHERE hash=? ORDER BY ordinal',
                  )
                  .iterate(row.snapshotSha256))
                  hash.update(entry.line).update('\n')
                if (hash.digest('hex') !== row.snapshotSha256) fail()
                db.query('UPDATE snapshots SET complete=1 WHERE hash=?').run(row.snapshotSha256)
              }
            }
          })()
        } catch (cause) {
          poisoned = true
          throw cause
        }
      })
    const decodeCensus = (canonical: string): Census => {
      const value: Omit<Census, 'at'> & { at: string } = JSON.parse(canonical)
      return { ...value, at: BigInt(value.at) }
    }
    const stage = function* () {
      for (const snapshot of db
        .query<{ hash: string }, []>('SELECT hash FROM snapshots ORDER BY seq')
        .iterate()) {
        // At most one producer snapshot (5000 rows / 64 MiB) is materialized.
        const lines = db
          .query<{ line: string }, [string]>(
            'SELECT line FROM envelopes WHERE hash=? ORDER BY ordinal',
          )
          .all(snapshot.hash)
        const gaps = new Set<string>()
        const decoded = decodeOccurrenceFiles({
          files: [
            {
              name: `loki-${snapshot.hash}.jsonl`,
              body: lines.map((row) => row.line).join('\n') + '\n',
            },
          ],
          hosts,
          start,
          gaps,
        })
        db.transaction(() => {
          for (const value of gaps) gap(value)
          for (const [host, canonical] of decoded.manifests) {
            const prior = db
              .query<{ canonical: string }, [string]>(
                'SELECT canonical FROM manifests WHERE host=?',
              )
              .get(host)
            if (prior !== null && prior.canonical !== canonical) gap(`${host}:conflicting-manifest`)
            db.query(
              'INSERT INTO manifests VALUES (?,?) ON CONFLICT(host) DO UPDATE SET canonical=excluded.canonical',
            ).run(host, canonical)
          }
          for (const [key, entry] of decoded.census) {
            const canonical = JSON.stringify({ ...entry, at: entry.at.toString() })
            const prior = db
              .query<{ canonical: string }, [string]>('SELECT canonical FROM census WHERE key=?')
              .get(key)
            if (prior !== null && prior.canonical !== canonical)
              gap(`${entry.id}:conflicting-census`)
            db.query(
              'INSERT INTO census(key,id,phase,build,canonical) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET id=excluded.id,phase=excluded.phase,build=excluded.build,canonical=excluded.canonical',
            ).run(key, entry.id, entry.phase, entry.build, canonical)
          }
          for (const [build, versions] of decoded.captures)
            for (const capture of versions) {
              const attrs = JSON.stringify(Array.from(capture.attrs))
              const identity = JSON.stringify([capture.root, Array.from(capture.attrs).toSorted()])
              const inserted = db
                .query(
                  'INSERT INTO captures(build,root,attrs,identity,incomplete) VALUES (?,?,?,?,?)',
                )
                .run(build, capture.root, attrs, identity, Number(capture.incomplete))
              for (const [span, canonical] of capture.rows)
                db.query(
                  'INSERT INTO rows(capture,build,span,canonical,value,conflict) VALUES (?,?,?,?,?,?)',
                ).run(
                  inserted.lastInsertRowid,
                  build,
                  span,
                  canonical,
                  JSON.stringify(capture.values.get(span)),
                  Number(capture.conflicts.has(span)),
                )
            }
        })()
        yield
      }
    }
    const reconcile = function* () {
      for (const host of hosts)
        if (db.query('SELECT 1 FROM manifests WHERE host=?').get(host) === null)
          gap(`${host}:missing-manifest`)
      for (const row of db
        .query<{ canonical: string }, []>('SELECT canonical FROM census ORDER BY seq')
        .iterate()) {
        yield
        const entry = decodeCensus(row.canonical)
        if (!hosts.has(entry.host)) gap(`${entry.host}:unexpected-host`)
        if (entry.error) gap(`${entry.id}:capture-error`)
        const paired = db
          .query<{ canonical: string }, [string]>('SELECT canonical FROM census WHERE key=?')
          .get(JSON.stringify([entry.id, entry.phase === 'open' ? 'terminal' : 'open']))
        if (paired === null)
          gap(`${entry.id}:missing-${entry.phase === 'open' ? 'terminal' : 'open'}`)
        else {
          const other = decodeCensus(paired.canonical)
          if (
            other.host !== entry.host ||
            other.run !== entry.run ||
            other.lane !== entry.lane ||
            (entry.phase === 'terminal' &&
              (entry.at < other.at || (other.build !== null && other.build !== entry.build)))
          )
            gap(`${entry.id}:census-identity-mismatch`)
        }
        if (entry.phase === 'terminal') {
          if (entry.build === null) gap(`${entry.id}:missing-build`)
          else {
            if (
              db
                .query("SELECT 1 FROM census WHERE phase='terminal' AND build=? AND id<>? LIMIT 1")
                .get(entry.build, entry.id) !== null
            )
              gap(`${entry.build}:multiple-invocations`)
            if (db.query('SELECT 1 FROM captures WHERE build=? LIMIT 1').get(entry.build) === null)
              gap(`${entry.id}:missing-conversion`)
          }
        }
      }
      // Subset comparisons operate on indexed canonical rows, never materialized builds.
      const subset = `NOT EXISTS (SELECT 1 FROM rows a WHERE a.capture=c.seq AND NOT EXISTS (SELECT 1 FROM rows b WHERE b.capture=o.seq AND b.span=a.span AND b.canonical=a.canonical))`
      for (const capture of db
        .query<{ seq: number; build: string; incomplete: number }, []>(
          'SELECT seq,build,incomplete FROM captures ORDER BY seq',
        )
        .iterate()) {
        yield
        const build = capture.build
        if (
          db.query("SELECT 1 FROM census WHERE build=? AND phase='terminal' LIMIT 1").get(build) ===
          null
        )
          gap(`${build}:missing-census`)
        if (
          db
            .query(
              'SELECT 1 FROM captures c JOIN captures o ON o.build=c.build WHERE c.seq=? AND o.identity<>c.identity LIMIT 1',
            )
            .get(capture.seq) !== null
        )
          gap(`${build}:capture-identity-mismatch`)
        if (
          capture.incomplete &&
          db
            .query(
              `SELECT 1 FROM captures c JOIN captures o ON o.build=c.build WHERE c.seq=? AND o.incomplete=0 AND o.identity=c.identity AND ${subset} LIMIT 1`,
            )
            .get(capture.seq) === null
        )
          gap(`${build}:incomplete-conversion`)
        const reverseSubset = `NOT EXISTS (SELECT 1 FROM rows a WHERE a.capture=o.seq AND NOT EXISTS (SELECT 1 FROM rows b WHERE b.capture=c.seq AND b.span=a.span AND b.canonical=a.canonical))`
        if (
          db
            .query(
              `SELECT 1 FROM captures c JOIN captures o ON o.build=c.build WHERE c.seq=? AND NOT (${subset}) AND NOT (${reverseSubset}) LIMIT 1`,
            )
            .get(capture.seq) !== null
        )
          gap(`${build}:incomparable-captures`)
      }
      for (const row of db
        .query<{ build: string; span: string; native: number; differing: number }, []>(`
        SELECT r.build,r.span,max(r.conflict) AS native,
          (count(DISTINCT r.canonical)>1 OR count(DISTINCT c.identity)>1) AS differing
        FROM rows r JOIN captures c ON c.seq=r.capture GROUP BY r.build,r.span
      `)
        .iterate()) {
        yield
        if (row.native || row.differing) conflict(JSON.stringify([row.build, row.span]))
        if (row.differing) gap(`${row.build}:${row.span}:conflicting-capture`)
      }
      for (const row of db
        .query<
          { build: string; span: string; value: string; root: string | null; attrs: string },
          []
        >(`
        SELECT r.build,r.span,r.value,c.root,c.attrs FROM rows r JOIN captures c ON c.seq=r.capture
        WHERE r.capture=(SELECT max(x.capture) FROM rows x WHERE x.build=r.build AND x.span=r.span)
        ORDER BY (SELECT min(v.seq) FROM captures v WHERE v.build=r.build),
          (SELECT min(x.seq) FROM rows x WHERE x.build=r.build AND x.span=r.span)
      `)
        .iterate()) {
        yield
        if (
          db
            .query('SELECT 1 FROM conflicts WHERE key=?')
            .get(JSON.stringify([row.build, row.span])) !== null
        )
          continue
        const terminal = db
          .query<{ canonical: string }, [string]>(
            "SELECT canonical FROM census WHERE build=? AND phase='terminal' ORDER BY seq DESC LIMIT 1",
          )
          .get(row.build)
        const attrs: Array<[string, string | boolean]> = JSON.parse(row.attrs)
        const record = normalizeOccurrenceRecord({
          build: row.build,
          span: row.span,
          value: JSON.parse(row.value),
          capture: { root: row.root, attrs: new Map(attrs) },
          terminal: terminal === null ? undefined : decodeCensus(terminal.canonical),
          hosts,
          start,
          end,
          addGap: gap,
        })
        if (record === undefined) continue
        const canonical = JSON.stringify(record)
        const prior = db
          .query<{ canonical: string }, [string]>('SELECT canonical FROM records WHERE id=?')
          .get(record.id)
        if (prior !== null && prior.canonical !== canonical) {
          gap(`${record.id}:conflicting-identity`)
          conflict(record.id)
        }
        db.query('INSERT OR IGNORE INTO records(id,canonical,host,digest) VALUES (?,?,?,?)').run(
          record.id,
          canonical,
          record.host,
          record.digest,
        )
      }
    }
    const writeReport: OccurrenceLedger['writeReport'] = ({ path, hosts: selectedHosts, key }) =>
      Effect.gen(function* () {
        yield* attempt(() => {
          if (finalized || poisoned) fail()
          finalized = true
          if (db.query('SELECT 1 FROM snapshots WHERE complete=0 LIMIT 1').get() !== null) fail()
        })
        const staging = stage()
        while ((yield* attempt(() => staging.next())).done !== true) yield* Effect.yieldNow
        const reconciliation = reconcile()
        let complete = false
        while (complete === false) {
          complete = yield* attempt(() =>
            db.transaction(() => {
              for (let index = 0; index < 256; index++) {
                if (reconciliation.next().done === true) return true
              }
              return false
            })(),
          )
          yield* Effect.yieldNow
        }
        const fs = yield* FileSystem.FileSystem
        const outputDirectory = yield* fs
          .makeTempDirectoryScoped({
            directory: dirname(path),
            prefix: '.buck2-occurrence-report-',
          })
          .pipe(Effect.mapError(error))
        const temporaryPath = join(outputDirectory, 'report.json')
        const file = yield* fs.open(temporaryPath, { flag: 'w' }).pipe(Effect.mapError(error))
        const encoder = new TextEncoder()
        let recordCount = 0
        let evidenceGapCount = 0
        yield* file.writeAll(encoder.encode('{"records":[\n')).pipe(Effect.mapError(error))
        // Keyset iteration avoids retaining report rows and permits cooperative interruption.
        let seq = 0
        while (true) {
          const row = yield* attempt(() =>
            db
              .query<
                { seq: number; canonical: string; host: string; digest: string | null },
                [number]
              >(
                'SELECT seq,canonical,host,digest FROM records WHERE seq>? AND NOT EXISTS (SELECT 1 FROM conflicts WHERE key=records.id) ORDER BY seq LIMIT 1',
              )
              .get(seq),
          )
          if (row === null) break
          seq = row.seq
          if (seq % 256 === 0) yield* Effect.yieldNow
          if (
            (selectedHosts.length > 0 && !selectedHosts.includes(row.host)) ||
            (key !== undefined && row.digest !== key)
          )
            continue
          yield* file
            .writeAll(encoder.encode(`${recordCount === 0 ? '' : ',\n'}${row.canonical}`))
            .pipe(Effect.mapError(error))
          recordCount++
        }
        yield* file.writeAll(encoder.encode('\n],"evidenceGaps":[\n')).pipe(Effect.mapError(error))
        yield* Effect.yieldNow
        let previous = ''
        while (true) {
          const row = yield* attempt(() =>
            db
              .query<{ gap: string; sortkey: string }, [string]>(
                'SELECT gap,sortkey FROM gaps WHERE sortkey>? ORDER BY sortkey LIMIT 1',
              )
              .get(previous),
          )
          if (row === null) break
          previous = row.sortkey
          yield* file
            .writeAll(
              encoder.encode(`${evidenceGapCount === 0 ? '' : ',\n'}${JSON.stringify(row.gap)}`),
            )
            .pipe(Effect.mapError(error))
          evidenceGapCount++
        }
        yield* file.writeAll(encoder.encode('\n]}\n')).pipe(Effect.mapError(error))
        yield* file.sync.pipe(Effect.mapError(error))
        yield* fs.rename(temporaryPath, path).pipe(Effect.mapError(error))
        return { recordCount, evidenceGapCount }
      }).pipe(Effect.scoped)
    return { addPage, writeReport }
  })
