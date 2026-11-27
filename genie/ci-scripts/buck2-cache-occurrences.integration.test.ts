import { expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { createTestTempDirectoryFactory } from '../../scripts/test-tmp.ts'
import type { OccurrenceEvidence } from './buck2-occurrence-records.ts'

const temporary = createTestTempDirectoryFactory()
const cli = new URL('./buck2-cache-join-cli.ts', import.meta.url).pathname
const nativeFixture = new URL(
  '../../rust/buck2-tools/events/fixtures/local-build.pb.zst',
  import.meta.url,
).pathname
const run = async (command: string[]) => {
  const child = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GITHUB_TOKEN: '' },
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exit, stderr: exit === 0 ? '' : stderr }).toEqual({ exit: 0, stderr: '' })
  return stdout
}

it('queries real native retained records by time, host and full key without claiming coverage', async () => {
  const native = process.env.BUCK2_EVENTS_BIN
  if (native === undefined) throw new Error('Run the declared genie:ci-workflow:test task')
  const directory = temporary('occurrence-reader-')
  const records = join(directory, 'records')
  // Public byte-scrubbed real build be6971d4: the native golden asserts two actions.
  // Retained JSONL is produced by the real current writer, never a synthetic TS builder.
  await run([
    native,
    'ingest',
    nativeFixture,
    '--records-dir',
    records,
    '--spool-dir',
    join(directory, 'spool'),
  ])
  const completions: number[] = []
  for await (const name of new Bun.Glob('*.jsonl').scan(records)) {
    const lines = (await Bun.file(join(records, name)).text()).trim().split('\n')
    for (const line of lines) {
      const row = JSON.parse(line)
      if (row.type === 'occurrence') completions.push(Number(BigInt(row.end_ns) / 1000000n))
    }
  }
  expect(completions).toHaveLength(2)
  const since = new Date(Math.min(...completions) - 1000).toISOString()
  const until = new Date(Math.max(...completions) + 1000).toISOString()
  const query = async (...filters: string[]): Promise<OccurrenceEvidence> =>
    JSON.parse(
      await run([
        process.execPath,
        cli,
        'occurrences',
        '--records-dir',
        records,
        '--since',
        since,
        '--until',
        until,
        ...filters,
      ]),
    )
  const all = await query()
  expect(all.records).toHaveLength(2)
  expect(all.records.every((row) => row.buildId === '4b68ac2f-58e1-4846-afb2-eff9358143b6')).toBe(
    true,
  )
  expect(all.evidenceGaps.length).toBeGreaterThan(0)
  const keyed = all.records.find((row) => row.digest !== null)
  if (keyed === undefined) throw new Error('Real golden must expose a full native action digest')
  const selected = await query('--host', keyed.host, '--key', keyed.digest!)
  expect(selected.records).toEqual(
    all.records.filter((row) => row.host === keyed.host && row.digest === keyed.digest),
  )
  expect(selected.evidenceGaps).toEqual(all.evidenceGaps)
  expect((await query('--host', 'not-enrolled')).records).toEqual([])
  expect((await query('--key', `${keyed.digest}-not-a-full-key`)).records).toEqual([])
  expect(
    (await query('--since', new Date(Math.max(...completions) + 1).toISOString())).records,
  ).toEqual([])
  expect((await query('--expected-host', 'not-enrolled')).evidenceGaps).not.toEqual(
    all.evidenceGaps,
  )
  const values: string[][] = []
  for await (const name of new Bun.Glob('*.jsonl').scan(records)) {
    const body = await Bun.file(join(records, name)).text()
    const lines = body.trimEnd().split('\n')
    const snapshotSha256 = createHash('sha256').update(body).digest('hex')
    for (const [ordinal, line] of lines.entries())
      values.push([
        '123456789',
        JSON.stringify({
          type: 'buck2.occurrence.ledger',
          version: 1,
          snapshotSha256,
          ordinal,
          recordCount: lines.length,
          line,
        }),
      ])
  }
  const response = join(directory, 'loki.json')
  await Bun.write(
    response,
    JSON.stringify({
      status: 'success',
      data: { resultType: 'streams', result: [{ values }] },
    }),
  )
  expect(
    JSON.parse(
      await run([
        process.execPath,
        cli,
        'occurrences',
        '--loki-response',
        response,
        '--since',
        since,
        '--until',
        until,
      ]),
    ),
  ).toEqual(all)
  const requests: URL[] = []
  const loggedAt = (BigInt(Date.parse(since)) * 1000000n + 500000000n).toString()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      requests.push(new URL(request.url))
      expect(request.headers.has('authorization')).toBe(false)
      return Response.json({
        status: 'success',
        data: {
          resultType: 'streams',
          result: [{ values: values.map(([, line]) => [loggedAt, line]) }],
        },
      })
    },
  })
  try {
    expect(
      JSON.parse(
        await run([
          process.execPath,
          cli,
          'occurrences',
          '--loki-url',
          new URL('/buck2-occurrences/v1/query_range', server.url).href,
          '--query-host',
          keyed.host,
          '--since',
          since,
          '--until',
          until,
        ]),
      ),
    ).toEqual(all)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.searchParams.get('host')).toBe(keyed.host)
    expect(requests[0]!.searchParams.get('start')).toBe(
      (BigInt(Date.parse(since)) * 1000000n).toString(),
    )
    expect(requests[0]!.searchParams.get('end')).toBe(
      (BigInt(Date.parse(until)) * 1000000n - 1n).toString(),
    )
  } finally {
    await server.stop(true)
  }
}, 30000)

it('rejects mixed live/offline inputs, misplaced query hosts and oversized live windows', async () => {
  const endpoint = 'http://127.0.0.1:1/buck2-occurrences/v1/query_range'
  const cases = [
    {
      args: ['--loki-url', endpoint, '--records-dir', '/not-read'],
      message: '--loki-url cannot be combined with offline retained inputs',
    },
    {
      args: ['--records-dir', '/not-read', '--query-host', 'test-host'],
      message: '--query-host requires --loki-url',
    },
    {
      args: ['--loki-url', endpoint],
      message: 'Live occurrence queries must cover at most 24 hours',
    },
  ]
  for (const entry of cases) {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        'occurrences',
        '--since',
        '2020-01-01T00:00:00Z',
        '--until',
        '2020-01-03T00:00:00Z',
        ...entry.args,
      ],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GITHUB_TOKEN: '' } },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit).not.toBe(0)
    expect(`${stdout}${stderr}`).toContain(entry.message)
  }
})
