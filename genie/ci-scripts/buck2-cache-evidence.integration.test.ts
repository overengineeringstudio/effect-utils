import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CacheEvidence } from './buck2-cache-evidence.ts'

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
