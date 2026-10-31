import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readdir, rm, truncate, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { decodeActionArtifact } from './buck2-action-evidence-codec.ts'
import {
  maxJobShardBytes,
  maxNativeEventBytes,
  maxShardBytes,
  reconcileNativeShards,
  registerNativeShard,
  writeNativeShard,
} from './buck2-cache-shards.ts'

const rootId = 'a'.repeat(64)
const canary = 'CANARY_SECRET_HOST_CREDENTIAL'
const buildIdFor = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const nativeEvents = ({
  buildId,
  actions = true,
  complete = true,
  identifier = 'check',
  executionKind = 3,
  digest = true,
}: {
  buildId: string
  actions?: boolean
  complete?: boolean
  identifier?: string
  executionKind?: number
  digest?: boolean
}) => {
  const identity = {
    kind: 'Run',
    name: { category: 'typescript_check', identifier },
    key: {
      owner: {
        TargetLabel: {
          label: { package: 'effect_utils//pkg', name: 'check' },
          configuration: { full_name: 'linux#abcd' },
        },
      },
    },
  }
  const event = (span: number, time: number, phase: string, data: unknown) => ({
    Event: {
      trace_id: buildId,
      span_id: span,
      timestamp: [time, 0],
      data: { [phase]: { data } },
      hostname: canary,
      environment: { SECRET: canary },
    },
  })
  return (
    [
      { trace_id: buildId, working_dir: `/private/${canary}`, command_line_args: [canary] },
      event(1, 1, 'SpanStart', { Command: {} }),
      ...(actions === true
        ? [
            event(2, 2, 'SpanStart', { ActionExecution: identity }),
            event(2, 3, 'SpanEnd', {
              ActionExecution: {
                ...identity,
                execution_kind: executionKind,
                cache_upload_result: 8,
                commands:
                  digest === true
                    ? [
                        {
                          details: {
                            cmd_stderr: canary,
                            command_kind: {
                              command: {
                                RemoteCommand: {
                                  action_digest: `${'b'.repeat(64)}:10`,
                                  environment: canary,
                                  argv: [canary],
                                },
                              },
                            },
                          },
                        },
                      ]
                    : [],
              },
            }),
          ]
        : []),
      ...(complete === true ? [event(1, 4, 'SpanEnd', { Command: {} })] : []),
    ]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n'
  )
}
const prepare = async ({
  output,
  buildId,
  raw,
  events,
}: {
  output: string
  buildId: string
  raw?: string
  events: string
}) => {
  const nativeId = await registerNativeShard({ output, buildId })
  await Bun.write(nativeId, `${buildId}\n`)
  await Bun.write(events, raw ?? nativeEvents({ buildId }))
  await writeNativeShard({ output, buildId, events, rootId, freshRoot: true, exitCode: 0 })
}

describe('rotation-independent native evidence shards', () => {
  it('keeps identical complete results after 131 overlapping commands rotate beyond 120 logs and all logs are removed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-shard-rotations-'))
    try {
      const output = join(directory, 'evidence.json')
      const logs = join(directory, 'buck-out/v2/log')
      const sinks = join(directory, 'private-sinks')
      await mkdir(logs, { recursive: true })
      await mkdir(sinks)
      for (let offset = 0; offset < 131; offset += 8) {
        await Promise.all(
          Array.from({ length: Math.min(8, 131 - offset) }, async (_, slot) => {
            const index = offset + slot
            const buildId = buildIdFor(index)
            const raw = nativeEvents({ buildId, actions: index % 11 !== 0 })
            await Bun.write(join(logs, `${index}.pb.zst`), raw)
            if (index >= 120) await rm(join(logs, `${index - 120}.pb.zst`), { force: true })
            await prepare({ output, buildId, events: join(sinks, `${buildId}.json-lines`), raw })
          }),
        )
      }
      const before = await reconcileNativeShards({ output })
      expect(before.index.evidenceGaps).toEqual([])
      expect(before.index.complete).toBe(true)
      expect(before.index.shards).toHaveLength(131)
      expect(
        before.artifact.header.invocations.filter((row) => row.actionCount === 0),
      ).toHaveLength(12)
      expect(await readdir(logs)).toHaveLength(120)
      const finalize = async () => {
        const child = Bun.spawn(
          [
            process.execPath,
            new URL('./buck2-cache-evidence.ts', import.meta.url).pathname,
            '--output',
            output,
            '--finalize',
          ],
          {
            stdout: 'ignore',
            stderr: 'pipe',
            env: {
              ...process.env,
              GITHUB_REPOSITORY: 'overengineeringstudio/effect-utils',
              GITHUB_RUN_ID: '123',
              GITHUB_RUN_ATTEMPT: '1',
              CI_BUCK2_CACHE_EVIDENCE_JOB: 'quality',
              CI_BUCK2_CACHE_EVIDENCE_JOB_NAME: 'quality (namespace-profile-linux-x86-64)',
              CI_BUCK2_CACHE_EVIDENCE_HEAD_SHA: 'a'.repeat(40),
              GITHUB_EVENT_NAME: 'push',
              GITHUB_REF: 'refs/heads/main',
              BUCK2_PUBLIC_CACHE_READ_ONLY: '1',
              BUCK2_NO_REMOTE_CACHE: '0',
              CI_BUCK2_CACHE_EVIDENCE_STARTED_AT: '0',
              CI_BUCK2_CACHE_EVIDENCE_FINISHED_AT: '5000',
              CI_BUCK2_CACHE_WARM99_MANIFEST: undefined,
              GITHUB_STEP_SUMMARY: undefined,
            },
          },
        )
        const [stderr, status] = await Promise.all([
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(stderr).toBe('')
        expect(status).toBe(0)
        return await Promise.all(
          [
            'evidence.json',
            'buck2-cache-actions.jsonl.gz',
            'buck2-cache-warm99.json',
            'buck2-cache-proof-manifest.json',
          ].map(
            async (name) => new Uint8Array(await Bun.file(join(directory, name)).arrayBuffer()),
          ),
        )
      }
      const finalizedBefore = await finalize()
      const actionHeader = JSON.parse(
        gunzipSync(finalizedBefore[1]!).toString('utf8').split('\n')[0]!,
      )
      expect(actionHeader.metadata.cell).toBe(
        `job-cell-sha256-v1:${createHash('sha256')
          .update('effect-utils/buck2-proof-job-cell/v1\0')
          .update('quality (namespace-profile-linux-x86-64)')
          .digest('hex')}`,
      )
      await rm(join(directory, 'buck-out'), { recursive: true, force: true })
      await rm(sinks, { recursive: true, force: true })
      const after = await reconcileNativeShards({ output })
      expect(after).toEqual(before)
      expect(await finalize()).toEqual(finalizedBefore)
      const bytes = after.index.shards.reduce((size, shard) => size + shard.bytes, 0)
      expect(bytes).toBeLessThan(maxJobShardBytes)
      const indexBytes = Bun.file(`${output}.shard-index.json`).size
      const finalizedBytes = finalizedBefore.reduce(
        (size, artifact) => size + artifact.byteLength,
        0,
      )
      console.log(
        `Synthetic 131-command proof bundle bytes: ${bytes + indexBytes + finalizedBytes}; shards: ${bytes}; index: ${indexBytes}; summary/actions/reports: ${finalizedBytes}`,
      )
      for (const shard of after.index.shards) {
        const body = await Bun.file(join(`${output}.shards`, shard.name)).text()
        expect(body).not.toContain(canary)
        expect(body).not.toContain('/private/')
        expect(body.length).toBeLessThan(maxShardBytes)
        expect(createHash('sha256').update(body).digest('hex')).toBe(shard.sha256)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
  it('records a real killed streaming collector as a gap without a finalized shard', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-shard-crash-'))
    let keeper: number | undefined
    let reapCollector: (() => Promise<void>) | undefined
    try {
      const output = join(directory, 'evidence.json')
      const buildId = buildIdFor(1)
      const nativeId = await registerNativeShard({ output, buildId })
      await Bun.write(nativeId, buildId)
      const sink = join(directory, 'native.json-lines')
      expect(await Bun.spawn(['mkfifo', '-m', '600', sink]).exited).toBe(0)
      keeper = openSync(sink, 'r+')
      const collector = Bun.spawn(
        [
          process.execPath,
          new URL('./buck2-cache-evidence.ts', import.meta.url).pathname,
          '--output',
          output,
          '--write-shard',
          sink,
          '--shard-build-id',
          buildId,
        ],
        { stdout: 'pipe', stderr: 'ignore' },
      )
      reapCollector = async () => {
        if (collector.exitCode === null) collector.kill('SIGKILL')
        await collector.exited
      }
      expect(
        new TextDecoder().decode((await collector.stdout.getReader().read()).value).trim(),
      ).toBe('ready')
      collector.kill('SIGKILL')
      await collector.exited
      closeSync(keeper)
      keeper = undefined
      const result = await reconcileNativeShards({ output })
      expect(result.index.complete).toBe(false)
      expect(result.index.evidenceGaps).toContain('native-shard-missing')
    } finally {
      if (keeper !== undefined) closeSync(keeper)
      await reapCollector?.()
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

  it('fails closed on collector crash, truncated registry/shard, missing native output, and an unregistered native invocation', async () => {
    for (const failure of [
      'crash',
      'registry',
      'shard',
      'native-id',
      'decoder',
      'unregistered',
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), 'buck-shard-gap-'))
      try {
        const output = join(directory, 'evidence.json')
        const buildId = buildIdFor(1)
        await prepare({ output, buildId, events: join(directory, 'events.json-lines') })
        if (failure === 'crash') {
          const crashed = buildIdFor(2)
          const nativeId = await registerNativeShard({ output, buildId: crashed })
          await Bun.write(nativeId, crashed)
          await Bun.write(join(`${output}.shards`, `${crashed}.json.123.pending`), '{')
        } else if (failure === 'registry')
          await appendFile(`${output}.native-build-id-paths.jsonl`, '{')
        else if (failure === 'shard')
          await truncate(join(`${output}.shards`, `${buildId}.json`), 100)
        else if (failure === 'native-id')
          await rm(join(`${output}.native-build-ids`, `${buildId}.buck-trace-id`))
        else if (failure === 'decoder') {
          const completion = join(`${output}.native-build-ids`, `${buildId}.exit.json`)
          await Bun.write(
            completion,
            JSON.stringify({
              ...(await Bun.file(completion).json()),
              sourceComplete: false,
            }),
          )
        } else
          await Bun.write(
            join(`${output}.native-build-ids`, `${buildIdFor(99)}.buck-trace-id`),
            buildIdFor(99),
          )
        const result = await reconcileNativeShards({ output })
        expect(result.index.complete).toBe(false)
        expect(result.index.evidenceGaps.length).toBeGreaterThan(0)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  })

  it('requires CommandEnd even for zero-action commands and rejects truncated final JSON', async () => {
    for (const rawFor of [
      (buildId: string) => nativeEvents({ buildId, actions: false, complete: false }),
      (buildId: string) => nativeEvents({ buildId }) + '{"Event":',
    ]) {
      const directory = await mkdtemp(join(tmpdir(), 'buck-shard-eof-'))
      try {
        const output = join(directory, 'evidence.json')
        const buildId = buildIdFor(1)
        await prepare({
          output,
          buildId,
          raw: rawFor(buildId),
          events: join(directory, 'events.json-lines'),
        })
        expect((await reconcileNativeShards({ output })).index.complete).toBe(false)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  })

  it('drains oversize events into an explicit incomplete shard without publishing raw payloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-shard-bound-'))
    try {
      const output = join(directory, 'evidence.json')
      const buildId = buildIdFor(1)
      await prepare({
        output,
        buildId,
        raw:
          nativeEvents({ buildId }) +
          JSON.stringify({ secret: canary, payload: 'x'.repeat(maxNativeEventBytes) }) +
          '\n',
        events: join(directory, 'events.json-lines'),
      })
      const body = await Bun.file(join(`${output}.shards`, `${buildId}.json`)).text()
      expect(body).not.toContain(canary)
      expect(Buffer.byteLength(body)).toBeLessThan(maxShardBytes)
      expect((await reconcileNativeShards({ output })).index.complete).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps null-digest kind10 configured identity without synthesizing a digest; historical identifiers remain unknown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-shard-identity-'))
    try {
      const output = join(directory, 'evidence.json')
      const buildId = buildIdFor(1)
      await prepare({
        output,
        buildId,
        raw: nativeEvents({ buildId, identifier: '', executionKind: 10, digest: false }),
        events: join(directory, 'events.json-lines'),
      })
      const body = await Bun.file(join(`${output}.shards`, `${buildId}.json`)).json()
      const decoded = decodeActionArtifact(body.artifact)
      expect(decoded.actions[0]?.digest).toBe(null)
      expect(decoded.actions[0]?.identifier).toBe('')
      expect(decoded.header.invocations[0]?.rootId).toBe(rootId)
      const lines = body.artifact
        .trim()
        .split('\n')
        .map((line: string) => JSON.parse(line))
      delete lines[1].identifier
      const historical = decodeActionArtifact(
        lines.map((row: unknown) => JSON.stringify(row)).join('\n') + '\n',
      )
      expect(historical.actions[0]?.identifier ?? null).toBe(null)
      expect(await readdir(`${output}.shards`)).toEqual([`${buildId}.json`])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when the atomic aggregate shard byte budget is exhausted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-shard-budget-'))
    try {
      const output = join(directory, 'evidence.json')
      const budget = `${output}.shard-budget`
      await mkdir(budget)
      for (let offset = 0; offset < 1024; offset += 8)
        await Promise.all(
          Array.from({ length: 8 }, (_, slot) => mkdir(join(budget, String(offset + slot)))),
        )
      const buildId = buildIdFor(1)
      await expect(
        prepare({ output, buildId, events: join(directory, 'events.json-lines') }),
      ).rejects.toThrow('Job shard budget exhausted')
      expect(await readdir(`${output}.shards`)).toEqual([])
      const result = await reconcileNativeShards({ output })
      expect(result.index.complete).toBe(false)
      expect(result.index.evidenceGaps).toContain('native-shard-missing')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

  it.each([
    '..',
    `/private/${canary}`,
    `../../private/${canary}`,
    `C:/Users/alice/${canary}`,
    `${canary}.internal.example`,
    `TOKEN_${canary}`,
  ])('publishes only an opaque configured-identifier hash for %s', async (identifier) => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-shard-canary-'))
    try {
      const output = join(directory, 'evidence.json')
      const buildId = buildIdFor(1)
      await prepare({
        output,
        buildId,
        raw: nativeEvents({ buildId, identifier }),
        events: join(directory, 'events.json-lines'),
      })
      const body = await Bun.file(join(`${output}.shards`, `${buildId}.json`)).text()
      expect(body).not.toContain(canary)
      const decoded = decodeActionArtifact(JSON.parse(body).artifact)
      expect(decoded.actions[0]?.identifier).toBe(
        `identifier-sha256-v1:${createHash('sha256')
          .update('effect-utils/buck2-action-identifier/v1\0')
          .update(identifier)
          .digest('hex')}`,
      )
      const lines = JSON.parse(body)
        .artifact.trim()
        .split('\n')
        .map((line: string) => JSON.parse(line))
      lines[1].identifier = identifier
      expect(() =>
        decodeActionArtifact(lines.map((line: unknown) => JSON.stringify(line)).join('\n') + '\n'),
      ).toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses prelaunch absence rather than a finer wall clock, and rejects unchanged reused native ID outputs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-shard-native-id-clock-'))
    try {
      const output = join(directory, 'evidence.json')
      const buildId = buildIdFor(1)
      const events = join(directory, 'events.json-lines')
      await prepare({ output, buildId, events })
      const nativeId = join(`${output}.native-build-ids`, `${buildId}.buck-trace-id`)
      // A newly created file can have an earlier filesystem-clock tick.
      await utimes(nativeId, 1000, 1000)
      expect((await reconcileNativeShards({ output })).index.complete).toBe(true)

      const reusedOutput = join(directory, 'reused.json')
      const reusedId = join(`${reusedOutput}.native-build-ids`, `${buildId}.buck-trace-id`)
      await mkdir(`${reusedOutput}.native-build-ids`)
      await Bun.write(reusedId, buildId)
      await utimes(reusedId, 1000, 1000)
      await registerNativeShard({ output: reusedOutput, buildId })
      await writeNativeShard({ output: reusedOutput, buildId, events, rootId, exitCode: 0 })
      expect((await reconcileNativeShards({ output: reusedOutput })).index.evidenceGaps).toContain(
        'native-build-id-missing',
      )
      await Bun.write(reusedId, buildId)
      await writeNativeShard({ output: reusedOutput, buildId, events, rootId, exitCode: 0 })
      expect((await reconcileNativeShards({ output: reusedOutput })).index.complete).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
