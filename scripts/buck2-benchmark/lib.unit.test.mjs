import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  countNonEmptyLines,
  parseJsonl,
  parseMaterializations,
  percentile,
  summarizeSamples,
} from './lib.mjs'

describe('buck2 benchmark parsers', () => {
  it('uses the nearest-rank percentile definition', () => {
    assert.equal(percentile({ values: [5, 1, 4, 2, 3], fraction: 0.5 }), 3)
    assert.equal(percentile({ values: [1, 2, 3, 4, 5], fraction: 0.95 }), 5)
    assert.equal(percentile({ values: [], fraction: 0.5 }), null)
  })

  it('counts only non-empty action lines', () => {
    assert.equal(countNonEmptyLines('build\taction-1\n\nbuild\taction-2\n'), 2)
  })

  it('accepts current and alternate materialization field spellings', () => {
    assert.deepEqual(
      parseMaterializations(
        [
          JSON.stringify({ total_bytes: 10, file_count: 2 }),
          JSON.stringify({ totalBytes: 7, fileCount: 1 }),
          '{not-json}',
        ].join('\n'),
      ),
      { count: 2, bytes: 17, files: 3, malformed: 1 },
    )
  })

  it('rejects malformed JSONL with its line number', () => {
    assert.throws(() => parseJsonl('{"ok":true}\nnope\n'), /line 2/u)
  })

  it('summarizes successful samples and preserves no-verdict groups', () => {
    const base = {
      schema: 'effect-utils-buck2-benchmark/v0',
      kind: 'sample',
      runId: 'test',
      sha: 'abc',
      engine: 'buck2',
      surface: 'workspace-check',
      phase: 'warm-noop',
      mutation: null,
      warmup: false,
      actionCount: 0,
      materializationCount: 0,
    }
    const [ok] = summarizeSamples([
      { ...base, status: 'ok', durationMs: 10 },
      { ...base, status: 'ok', durationMs: 20 },
      { ...base, status: 'ok', durationMs: 30 },
    ])
    assert.equal(ok.status, 'ok')
    assert.equal(ok.timingsMs.p50, 20)
    assert.equal(ok.timingsMs.p95, 30)
    assert.equal(ok.evidenceVerdicts.actions, 'no-verdict')
    assert.deepEqual(ok.crossEngineComparison, {
      generated: false,
      verdict: 'no-verdict',
      reason: 'equivalence-contract-undeclared',
    })

    const [noVerdict] = summarizeSamples([
      { ...base, status: 'ok', durationMs: 10 },
      { ...base, status: 'skipped', durationMs: null, reason: 'tool-unavailable' },
    ])
    assert.equal(noVerdict.status, 'no-verdict')
    assert.equal(noVerdict.skippedCount, 1)

    const [declared] = summarizeSamples([
      {
        ...base,
        workContract: 'workspace-typecheck/v1',
        equivalenceDeclaration: 'operator-declared-not-independently-verified',
        status: 'ok',
        durationMs: 10,
      },
    ])
    assert.deepEqual(declared.crossEngineComparison, {
      generated: false,
      verdict: 'no-verdict',
      reason: 'per-engine-summary-only',
    })

    const [nonEquivalent] = summarizeSamples([
      {
        ...base,
        workContract: 'input-plan/no-devenv-equivalent/v1',
        equivalenceDeclaration: 'work-contract-declares-no-equivalent-devenv-lane',
        status: 'ok',
        durationMs: 10,
      },
    ])
    assert.equal(nonEquivalent.crossEngineComparison.reason, 'workloads-not-declared-equivalent')
  })
})
