import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { decodeActionArtifact } from './buck2-action-evidence-codec.ts'
import { actionsArtifactName, localMaterializationCategories } from './buck2-action-evidence.ts'
import type { CacheEvidence } from './buck2-cache-evidence.ts'
import { decodeEvidence } from './buck2-cache-warm99.ts'

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
const nativeLog = (
  buildId: string,
  offset = 0,
  localCache = false,
  category = 'typescript_check',
  executionKind = 1,
): string => {
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
      name: { category },
    }
    records.push(
      event(buildId, 'SpanStart', index + 2, 1700000001 + offset, { ActionExecution: action }),
    )
    const end = event(buildId, 'SpanEnd', index + 2, 1700000002 + offset, {
      ActionExecution: {
        ...action,
        execution_kind: localCache === true ? 10 : executionKind,
        cache_upload_result: localCache === true ? 3 : executionKind === 3 ? 0 : 1,
        commands:
          localCache === true
            ? []
            : [
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
  it('preserves exclusions across bounded append, compressed full rows and evaluator decoding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-actions-policy-'))
    try {
      const events = join(directory, 'native.jsonl')
      const output = join(directory, 'buck2-cache-evidence.json')
      const actions = join(directory, actionsArtifactName)
      for (const [index, category] of [...localMaterializationCategories, 'tsgo_emit'].entries()) {
        await Bun.write(events, nativeLog(`policy-${index}`, 0, false, category, 3))
        const child = Bun.spawn(
          [
            process.execPath,
            collector,
            '--events',
            events,
            '--output',
            output,
            '--context',
            'populate',
            '--fresh-root',
          ],
          { env: fixtureEnv, stdout: 'ignore', stderr: 'pipe' },
        )
        expect(await new Response(child.stderr).text()).toBe('')
        expect(await child.exited).toBe(0)
      }
      const finalize = Bun.spawn([process.execPath, collector, '--output', output, '--finalize'], {
        env: fixtureEnv,
        stdout: 'ignore',
        stderr: 'pipe',
      })
      expect(await new Response(finalize.stderr).text()).toBe('')
      expect(await finalize.exited).toBe(0)
      const summary: CacheEvidence = await Bun.file(output).json()
      const bytes = new Uint8Array(await Bun.file(actions).arrayBuffer())
      const full = decodeEvidence({ compressed: bytes, summary, expectedLane: 'main-writer' })
      expect(summary.actionCount).toBe(100 * (localMaterializationCategories.length + 1))
      expect(summary.actions).toHaveLength(localMaterializationCategories.length + 1)
      expect(summary.counts['remote-hit']).toBe(100 * (localMaterializationCategories.length + 1))
      expect(summary.excludedByDesign).toEqual({
        'local-materialization-policy': 100 * localMaterializationCategories.length,
        'darwin-unsandboxed': 0,
      })
      expect(full.header.excludedByDesign).toEqual(summary.excludedByDesign)
      expect(full.header.invocations.map((invocation) => invocation.excludedByDesign)).toEqual([
        ...localMaterializationCategories.map(() => ({
          'local-materialization-policy': 100,
          'darwin-unsandboxed': 0,
        })),
        { 'local-materialization-policy': 0, 'darwin-unsandboxed': 0 },
      ])
      expect(
        full.actions.filter((action) => action.exclusionReason === 'local-materialization-policy'),
      ).toHaveLength(100 * localMaterializationCategories.length)
      expect(
        full.actions
          .filter((action) => action.category === 'tsgo_emit')
          .every((action) => action.exclusionReason === null),
      ).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

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
      expect(await child.exited).toBe(2)
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
      const gap = Bun.spawn(
        [
          process.execPath,
          collector,
          '--output',
          output,
          '--evidence-gap',
          'evidence-finalization-failed',
        ],
        { env: fixtureEnv, stdout: 'ignore', stderr: 'ignore' },
      )
      expect(await gap.exited).toBe(0)
      const updated = decodeActionArtifact(
        gunzipSync(await Bun.file(join(directory, actionsArtifactName)).arrayBuffer()).toString(
          'utf8',
        ),
      )
      expect(updated.header.metadata.finishedAt).toBe(1700000010000)
      expect(updated.header.complete).toBe(false)
      expect(updated.header.evidenceGaps).toContain('evidence-finalization-failed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('binds native invocations to the job window and retains out-of-window rows only as incomplete evidence', async () => {
    for (const bounds of [
      { start: 1700000005000, end: 1700000020000, valid: false },
      { start: 1700000000000, end: 1700000002000, valid: false },
      { start: 1700000000123, end: 1700000003123, valid: true },
    ]) {
      const directory = await mkdtemp(join(tmpdir(), 'buck-actions-window-'))
      try {
        const events = join(directory, 'native.jsonl')
        const output = join(directory, 'buck2-cache-evidence.json')
        await Bun.write(events, nativeLog('fixture-build'))
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
            '--finalize',
          ],
          {
            env: {
              ...fixtureEnv,
              CI_BUCK2_CACHE_EVIDENCE_STARTED_AT: String(bounds.start),
              CI_BUCK2_CACHE_EVIDENCE_FINISHED_AT: String(bounds.end),
            },
            stdout: 'ignore',
            stderr: 'ignore',
          },
        )
        expect(await child.exited).toBe(bounds.valid === true ? 0 : 2)
        const full = decodeActionArtifact(
          gunzipSync(await Bun.file(join(directory, actionsArtifactName)).arrayBuffer()).toString(
            'utf8',
          ),
        )
        expect(full.actions).toHaveLength(100)
        expect(full.header.complete).toBe(bounds.valid)
        expect(full.header.invocations[0]?.freshRoot).toBe(bounds.valid)
        expect(full.header.evidenceGaps).toEqual(
          bounds.valid === true ? [] : ['native-invocation-outside-job-window'],
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  })

  it('ignores zero-action audits and retains nondigest local reuse only on later invocations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-actions-fresh-'))
    try {
      const output = join(directory, 'buck2-cache-evidence.json')
      for (const [buildId, offset] of [
        ['later', 5],
        ['earlier', 1],
        ['audit', 0],
      ] as const) {
        const events = join(directory, `${buildId}.jsonl`)
        const log =
          buildId === 'audit'
            ? `${JSON.stringify(event(buildId, 'SpanStart', 1, 1700000000, { Command: {} }))}\n${JSON.stringify(event(buildId, 'SpanEnd', 1, 1700000000, { Command: {} }))}\n`
            : nativeLog(buildId, offset, buildId === 'later')
        await Bun.write(events, log)
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
      expect(full.header.invocations.find((item) => item.buildId === 'audit')!.freshRoot).toBe(
        false,
      )
      expect(full.header.complete).toBe(true)
      const localReuse = full.actions.filter((action) => action.buildId === 'later')
      expect(localReuse).toHaveLength(100)
      expect(
        localReuse.every((action) => action.digest === null && action.executionKind === 10),
      ).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('requires actual in-window native build IDs before declaring rotated logs', async () => {
    for (const confirmation of [
      'confirmed',
      'missing',
      'stale',
      'future',
      'mismatched',
      'invalid',
      'legacy',
      'audit',
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), 'buck-actions-rotation-'))
      try {
        const output = join(directory, 'buck2-cache-evidence.json')
        const events = join(directory, 'native.jsonl')
        const earliest = '2fc13b48-c94a-4a9c-936f-bc24615bc360'
        const survivor = '51bd392e-1f24-4221-80d3-e76ad36f0b9c'
        const nativeId = join(directory, 'earliest.buck-trace-id')
        // The earliest invocation is absent, while the only surviving log has
        // kind-10 local-cache rows with no digest.
        await Bun.write(events, nativeLog(survivor, 5, true))
        if (confirmation !== 'legacy') {
          const row = JSON.stringify({ buildId: earliest, path: nativeId })
          await Bun.write(`${output}.native-build-id-paths.jsonl`, `${row}\n${row}\n`)
        }
        if (confirmation !== 'missing' && confirmation !== 'legacy') {
          await Bun.write(
            nativeId,
            confirmation === 'mismatched'
              ? survivor
              : confirmation === 'invalid'
                ? 'not-an-id'
                : `${earliest}\n`,
          )
          const mtime =
            confirmation === 'stale'
              ? 1699999999
              : confirmation === 'future'
                ? 1700000011
                : 1700000001
          await utimes(nativeId, mtime, mtime)
        }
        // Denied admissions are never evidence that Buck actually started.
        await Bun.write(
          `${output}.admission.jsonl`,
          `${JSON.stringify({
            invocationId: earliest,
            admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
            admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
          })}\n`,
        )
        if (confirmation === 'audit') {
          const audit = join(directory, 'audit.jsonl')
          await Bun.write(
            audit,
            [
              event(earliest, 'SpanStart', 1, 1700000000, { Command: {} }),
              event(earliest, 'SpanEnd', 1, 1700000000, { Command: {} }),
            ]
              .map((record) => JSON.stringify(record))
              .join('\n'),
          )
          const decodedAudit = Bun.spawn(
            [
              process.execPath,
              collector,
              '--events',
              audit,
              '--output',
              output,
              '--context',
              'native-log',
              '--fresh-root',
            ],
            { env: fixtureEnv, stdout: 'ignore', stderr: 'ignore' },
          )
          expect(await decodedAudit.exited).toBe(0)
        }
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
            '--finalize',
          ],
          { env: fixtureEnv, stdout: 'ignore', stderr: 'ignore' },
        )
        expect(await child.exited).toBe(2)
        const summary: CacheEvidence = await Bun.file(output).json()
        const full = decodeActionArtifact(
          gunzipSync(await Bun.file(join(directory, actionsArtifactName)).arrayBuffer()).toString(
            'utf8',
          ),
        )
        expect(full.header.complete).toBe(false)
        expect(summary.actionsArtifact?.complete).toBe(false)
        expect(full.header.evidenceGaps).toEqual(
          confirmation === 'confirmed'
            ? ['native-log-rotated']
            : ['fresh-local-cache-action-missing-digest'],
        )
        expect(full.header.invocations.find((item) => item.buildId === survivor)?.freshRoot).toBe(
          confirmation !== 'confirmed',
        )
        expect(
          full.actions.every((action) => action.executionKind === 10 && action.digest === null),
        ).toBe(true)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  })

  it('keeps a written rotated artifact invalid without adding a finalization-failed gap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-actions-collector-rotation-'))
    try {
      const output = join(directory, 'buck2-cache-evidence.json')
      const actions = join(directory, actionsArtifactName)
      const events = join(directory, 'native.jsonl')
      const marker = join(directory, 'start')
      const earliest = '2fc13b48-c94a-4a9c-936f-bc24615bc360'
      const survivor = '51bd392e-1f24-4221-80d3-e76ad36f0b9c'
      const nativeId = join(directory, 'earliest.buck-trace-id')
      await Bun.write(nativeId, `${earliest}\n`)
      await utimes(nativeId, 1700000001, 1700000001)
      await Bun.write(
        `${output}.native-build-id-paths.jsonl`,
        `${JSON.stringify({ buildId: earliest, path: nativeId })}\n`,
      )
      await Bun.write(events, nativeLog(survivor, 5, true))
      const seed = Bun.spawn(
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
        { env: fixtureEnv, stdout: 'ignore', stderr: 'ignore' },
      )
      expect(await seed.exited).toBe(0)
      await mkdir(join(directory, 'genie'))
      await symlink(dirname(collector), join(directory, 'genie', 'ci-scripts'), 'dir')
      await Bun.write(marker, `1700000000000\n${directory}\n1\n`)
      const child = Bun.spawn(
        ['bash', new URL('./collect-buck2-cache-evidence.sh', import.meta.url).pathname],
        {
          cwd: directory,
          env: {
            ...fixtureEnv,
            PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
            CI_BUCK2_CACHE_EVIDENCE_PATH: output,
            CI_BUCK2_CACHE_ACTIONS_PATH: actions,
            CI_BUCK2_CACHE_EVIDENCE_START: marker,
            CI_BUCK2_CACHE_EVIDENCE_DISABLED: '0',
          },
          stdout: 'ignore',
          stderr: 'ignore',
        },
      )
      expect(await child.exited).toBe(1)
      const summary: CacheEvidence = await Bun.file(output).json()
      const full = decodeActionArtifact(
        gunzipSync(await Bun.file(actions).arrayBuffer()).toString('utf8'),
      )
      expect(summary.actionsArtifact?.complete).toBe(false)
      expect(full.header.complete).toBe(false)
      expect(full.header.evidenceGaps).toEqual(['native-log-rotated'])
      expect(full.header.invocations[0]?.freshRoot).toBe(false)
      expect(
        full.actions.every((action) => action.executionKind === 10 && action.digest === null),
      ).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects absent local-action-cache digests in a fresh cache-bearing invocation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-actions-local-fresh-'))
    try {
      const events = join(directory, 'native.jsonl')
      const output = join(directory, 'buck2-cache-evidence.json')
      await Bun.write(events, nativeLog('fresh-local-cache', 0, true))
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
          '--finalize',
        ],
        { env: fixtureEnv, stdout: 'ignore', stderr: 'ignore' },
      )
      expect(await child.exited).toBe(2)
      const full = decodeActionArtifact(
        gunzipSync(await Bun.file(join(directory, actionsArtifactName)).arrayBuffer()).toString(
          'utf8',
        ),
      )
      expect(full.actions).toHaveLength(100)
      expect(full.header.complete).toBe(false)
      expect(full.header.evidenceGaps).toEqual(['fresh-local-cache-action-missing-digest'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
