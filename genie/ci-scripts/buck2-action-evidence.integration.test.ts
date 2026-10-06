import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { decodeActionArtifact } from './buck2-action-evidence-codec.ts'
import { actionsArtifactName } from './buck2-action-evidence.ts'
import type { CacheEvidence } from './buck2-cache-evidence.ts'

const collector = new URL('./buck2-cache-evidence.ts', import.meta.url).pathname
const event = (
  buildId: string,
  phase: 'SpanStart' | 'SpanEnd',
  spanId: number,
  seconds: number,
  data: unknown,
) => ({
  Event: {
    trace_id: buildId,
    span_id: spanId,
    timestamp: [seconds, 123456789],
    data: { [phase]: { data } },
  },
})
const nativeLog = (buildId: string, offset = 0): string => {
  const records: unknown[] = [event(buildId, 'SpanStart', 1, 1700000000 + offset, { Command: {} })]
  for (let index = 0; index < 100; index++) {
    const action = {
      key: {
        owner: {
          TargetLabel: {
            label: { package: 'effect_utils//pkg', name: 'check' },
            configuration: { full_name: 'linux_x86_64#a312ca1b' },
          },
        },
      },
      kind: 'Run',
      name: { category: 'typescript_check' },
    }
    records.push(
      event(buildId, 'SpanStart', index + 2, 1700000001 + offset, { ActionExecution: action }),
    )
    const end = event(buildId, 'SpanEnd', index + 2, 1700000002 + offset, {
      ActionExecution: {
        ...action,
        execution_kind: 1,
        cache_upload_result: 1,
        commands: [
          {
            details: {
              command_kind: {
                command: {
                  LocalCommand: {
                    action_digest: `${index.toString(16).padStart(64, '0')}:123`,
                    argv: ['/private/root/SECRET_ARG'],
                    env: [{ key: 'TOKEN', value: 'SECRET_VALUE' }],
                  },
                },
              },
            },
          },
        ],
      },
    })
    records.push(end, end)
  }
  records.push(event(buildId, 'SpanEnd', 1, 1700000003 + offset, { Command: {} }))
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}
const fixtureEnv = {
  ...process.env,
  GITHUB_TOKEN: undefined,
  GITHUB_REPOSITORY: 'overengineeringstudio/effect-utils',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  CI_BUCK2_CACHE_EVIDENCE_JOB: 'quality',
  CI_BUCK2_CACHE_EVIDENCE_HEAD_SHA: 'a'.repeat(40),
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main',
  BUCK2_PUBLIC_CACHE_READ_ONLY: '0',
  BUCK2_NO_REMOTE_CACHE: '0',
  CI_BUCK2_CACHE_EVIDENCE_STARTED_AT: '1700000000000',
  CI_BUCK2_CACHE_EVIDENCE_FINISHED_AT: '1700000010000',
}

describe('complete normalized action artifact CLI', () => {
  it('keeps all first ends, checksum, raw enums, timestamp bounds and append dedup without altering compact counts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-actions-'))
    try {
      const events = join(directory, 'native.jsonl')
      const output = join(directory, 'buck2-cache-evidence.json')
      const actions = join(directory, actionsArtifactName)
      await Bun.write(events, nativeLog('fixture-build'))
      for (const context of ['populate', 'native-log']) {
        const child = Bun.spawn(
          [
            process.execPath,
            collector,
            '--events',
            events,
            '--output',
            output,
            '--context',
            context,
            '--fresh-root',
          ],
          { env: fixtureEnv, stdout: 'ignore', stderr: 'pipe' },
        )
        expect(await child.exited).toBe(0)
      }
      const finalize = Bun.spawn([process.execPath, collector, '--output', output, '--finalize'], {
        env: fixtureEnv,
        stdout: 'ignore',
        stderr: 'pipe',
      })
      const error = await new Response(finalize.stderr).text()
      expect(error).toBe('')
      expect(await finalize.exited).toBe(0)
      const summary: CacheEvidence = await Bun.file(output).json()
      const bytes = new Uint8Array(await Bun.file(actions).arrayBuffer())
      const raw = gunzipSync(bytes).toString('utf8')
      const full = decodeActionArtifact(raw)
      expect(summary.actionCount).toBe(100)
      expect(summary.actions).toHaveLength(1)
      expect(summary.counts.uploaded).toBe(100)
      expect(summary.droppedActionCount).toBe(99)
      expect(summary.actionsArtifact).toMatchObject({
        name: actionsArtifactName,
        rows: 100,
        complete: true,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        uncompressedBytes: Buffer.byteLength(raw),
        droppedActionCount: 0,
      })
      expect(full.actions).toHaveLength(100)
      expect(full.header).toMatchObject({
        complete: true,
        rows: 100,
        actionCount: 100,
        droppedActionCount: 0,
        evidenceGaps: [],
      })
      expect(full.header.invocations[0]).toMatchObject({
        context: 'populate',
        freshRoot: true,
        complete: true,
      })
      expect(full.actions[0]).toMatchObject({
        context: 'populate',
        executionKind: 1,
        cacheUploadResult: 1,
        startedAt: 1700000001123,
        completedAt: 1700000002123,
        uploadCompletedAt: 1700000002123,
      })
      expect(raw).not.toContain('SECRET')
      expect(raw).not.toContain('/private/')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('records invalid/truncated inputs and explicit gaps while retaining available normalized rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-actions-gap-'))
    try {
      const events = join(directory, 'native.jsonl')
      const output = join(directory, 'buck2-cache-evidence.json')
      await Bun.write(events, `${nativeLog('fixture-build')}INVALID_NATIVE_SECRET\n`)
      const child = Bun.spawn(
        [
          process.execPath,
          collector,
          '--events',
          events,
          '--output',
          output,
          '--finalize',
          '--evidence-gap',
          'native-log-decode-failed',
        ],
        { env: fixtureEnv, stdout: 'ignore', stderr: 'pipe' },
      )
      const error = await new Response(child.stderr).text()
      expect(await child.exited).toBe(1)
      expect(error).not.toContain('SECRET')
      const raw = gunzipSync(
        new Uint8Array(await Bun.file(join(directory, actionsArtifactName)).arrayBuffer()),
      ).toString('utf8')
      const full = decodeActionArtifact(raw)
      expect(full.actions).toHaveLength(100)
      expect(full.header.complete).toBe(false)
      expect(full.header.evidenceGaps).toContain('invalid-native-json')
      expect(full.header.evidenceGaps).toContain('native-log-decode-failed')
      expect(raw).not.toContain('SECRET')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resolves unsorted native invocations by native start time, never granting freshness to later roots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-actions-fresh-'))
    try {
      const output = join(directory, 'buck2-cache-evidence.json')
      for (const [buildId, offset] of [
        ['later', 5],
        ['earlier', 0],
      ] as const) {
        const events = join(directory, `${buildId}.jsonl`)
        await Bun.write(events, nativeLog(buildId, offset))
        const child = Bun.spawn(
          [
            process.execPath,
            collector,
            '--events',
            events,
            '--output',
            output,
            '--context',
            'native-log',
            '--fresh-root',
          ],
          { env: fixtureEnv, stdout: 'ignore', stderr: 'pipe' },
        )
        expect(await child.exited).toBe(0)
      }
      const child = Bun.spawn([process.execPath, collector, '--output', output, '--finalize'], {
        env: fixtureEnv,
        stdout: 'ignore',
        stderr: 'pipe',
      })
      expect(await child.exited).toBe(0)
      const full = decodeActionArtifact(
        gunzipSync(
          new Uint8Array(await Bun.file(join(directory, actionsArtifactName)).arrayBuffer()),
        ).toString('utf8'),
      )
      expect(full.header.invocations.find((item) => item.buildId === 'earlier')!.freshRoot).toBe(
        true,
      )
      expect(full.header.invocations.find((item) => item.buildId === 'later')!.freshRoot).toBe(
        false,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
