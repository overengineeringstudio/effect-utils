import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CacheAdmissionInvocation, CacheEvidence } from './buck2-cache-evidence.ts'

const collector = new URL('./buck2-cache-evidence.ts', import.meta.url).pathname

describe('native cache evidence CLI exit policy', () => {
  it('accepts nondigest local-cache/native actions but rejects missing remote cache keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-cache-evidence-'))
    try {
      const cases = [
        { kind: 'Run', executionKind: 10, uploadResult: 3, outcome: 'local-cache', exit: 0 },
        { kind: 'Run', executionKind: 7, uploadResult: 3, outcome: 'local-cache', exit: 0 },
        { kind: 'Run', executionKind: 1, uploadResult: 2, outcome: 'local', exit: 0 },
        { kind: 'Write', executionKind: 6, uploadResult: 2, outcome: 'other', exit: 0 },
        { kind: 'Run', executionKind: 3, uploadResult: 8, outcome: 'remote-hit', exit: 1 },
        { kind: 'Run', executionKind: 1, uploadResult: 1, outcome: 'uploaded', exit: 1 },
      ] as const
      for (const [index, entry] of cases.entries()) {
        const events = join(directory, `${index}.jsonl`)
        const output = join(directory, `${index}.json`)
        await Bun.write(
          events,
          `${JSON.stringify({
            Event: {
              trace_id: `build-${index}`,
              span_id: 1,
              data: {
                SpanEnd: {
                  data: {
                    ActionExecution: {
                      kind: entry.kind,
                      name: { category: 'typescript_check' },
                      key: {
                        owner: {
                          TargetLabel: { label: { package: 'effect_utils//pkg', name: 'check' } },
                        },
                      },
                      execution_kind: entry.executionKind,
                      cache_upload_result: entry.uploadResult,
                      commands: [],
                    },
                  },
                },
              },
            },
          })}\n`,
        )
        const child = Bun.spawn(
          [process.execPath, collector, '--events', events, '--output', output],
          {
            env: { ...process.env, GITHUB_TOKEN: undefined },
            stdout: 'ignore',
            stderr: 'pipe',
          },
        )
        const error = await new Response(child.stderr).text()
        expect(await child.exited).toBe(entry.exit)
        const evidence: CacheEvidence = await Bun.file(output).json()
        expect(evidence.invocations[0]!.noDigestReasons?.[entry.outcome]).toBe(1)
        expect(evidence.counts[entry.outcome]).toBe(1)
        expect(evidence.actions).toEqual([])
        if (entry.exit === 0) expect(error).toBe('')
        else expect(error).toContain('remote-hit/uploaded action(s) have no native action digest')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('entrypoint admission sidecar collection', () => {
  it('emits zeros without a sidecar and deduplicates real rows across repeated collection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-cache-admission-'))
    try {
      const output = join(directory, 'evidence.json')
      const collect = async () => {
        const child = Bun.spawn([process.execPath, collector, '--output', output], {
          stdout: 'ignore',
          stderr: 'pipe',
        })
        const error = await new Response(child.stderr).text()
        expect(await child.exited).toBe(0)
        expect(error).toBe('')
        return (await Bun.file(output).json()) as CacheEvidence
      }
      const initial = await collect()
      expect(initial.admissionFallbacks).toEqual({ reapi: 0, archiveOrigin: 0 })
      expect(initial.admissionRetrySuccesses).toEqual({ reapi: 0, archiveOrigin: 0 })
      expect(initial.admissionInvocations).toEqual([])
      const rows: CacheAdmissionInvocation[] = [
        {
          invocationId: '2fc13b48-c94a-4a9c-936f-bc24615bc360',
          admissionFallbacks: { reapi: 1, archiveOrigin: 0 },
          admissionRetrySuccesses: { reapi: 0, archiveOrigin: 1 },
        },
        {
          invocationId: 'c568610f-0ddf-40c5-99df-d178142b9dad',
          admissionFallbacks: { reapi: 1, archiveOrigin: 1 },
          admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
        },
        {
          invocationId: 'bd999eb2-5b8b-4828-a19a-95bddfb2b27e',
          admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
          admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
        },
      ]
      await Bun.write(
        `${output}.admission.jsonl`,
        `${[...rows, rows[0]].map((row) => JSON.stringify(row)).join('\n')}\n`,
      )
      for (let attempt = 0; attempt < 2; attempt++) {
        const evidence = await collect()
        expect(evidence.status).toBe('no-native-logs')
        expect(evidence.invocations).toEqual([])
        expect(evidence.admissionInvocations).toEqual(rows)
        expect(evidence.admissionFallbacks).toEqual({ reapi: 2, archiveOrigin: 1 })
        expect(evidence.admissionRetrySuccesses).toEqual({ reapi: 0, archiveOrigin: 1 })
      }
      await rm(`${output}.admission.jsonl`)
      expect((await collect()).admissionInvocations).toEqual(rows)
      const additional: CacheAdmissionInvocation = {
        invocationId: '51bd392e-1f24-4221-80d3-e76ad36f0b9c',
        admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
        admissionRetrySuccesses: { reapi: 1, archiveOrigin: 0 },
      }
      await Bun.write(`${output}.admission.jsonl`, `${JSON.stringify(additional)}\n`)
      const appended = await collect()
      expect(appended.admissionInvocations).toEqual([...rows, additional])
      expect(appended.admissionFallbacks).toEqual({ reapi: 2, archiveOrigin: 1 })
      expect(appended.admissionRetrySuccesses).toEqual({ reapi: 1, archiveOrigin: 1 })
      const summaryPath = join(directory, 'step-summary')
      await Bun.write(summaryPath, 'Existing job summary\n')
      const finalized = Bun.spawn([process.execPath, collector, '--output', output, '--finalize'], {
        env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
        stdout: 'ignore',
        stderr: 'pipe',
      })
      await new Response(finalized.stderr).text()
      expect(await finalized.exited).toBe(1)
      const summaryText = await Bun.file(summaryPath).text()
      expect(summaryText).toStartWith('Existing job summary\n')
      expect(summaryText).toContain('| Total | 2 | 1 | 1 | 1 |')
      for (const invocation of [...rows, additional])
        expect(summaryText).toContain(invocation.invocationId)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('rejects malformed or conflicting sidecar rows rather than reporting healthy admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buck-cache-admission-invalid-'))
    try {
      const row: CacheAdmissionInvocation = {
        invocationId: '2fc13b48-c94a-4a9c-936f-bc24615bc360',
        admissionFallbacks: { reapi: 1, archiveOrigin: 0 },
        admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
      }
      const invalidRows = [
        '{',
        JSON.stringify({ ...row, invocationId: 'not-an-id' }),
        JSON.stringify({ ...row, admissionFallbacks: { reapi: '1', archiveOrigin: 0 } }),
        JSON.stringify({ ...row, admissionFallbacks: { reapi: 2, archiveOrigin: 0 } }),
        JSON.stringify({ ...row, admissionRetrySuccesses: { reapi: 1, archiveOrigin: 0 } }),
        `${JSON.stringify(row)}\n${JSON.stringify({
          ...row,
          admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
        })}`,
      ]
      for (const [index, raw] of invalidRows.entries()) {
        const output = join(directory, `${index}.json`)
        await Bun.write(`${output}.admission.jsonl`, `${raw}\n`)
        const child = Bun.spawn([process.execPath, collector, '--output', output], {
          stdout: 'ignore',
          stderr: 'pipe',
        })
        await new Response(child.stderr).text()
        expect(await child.exited).toBe(1)
        expect(await Bun.file(output).exists()).toBe(false)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
