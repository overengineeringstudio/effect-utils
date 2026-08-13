import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const sample = ({ phase, actionCount }) => ({
  kind: 'sample',
  engine: 'buck2',
  warmup: false,
  phase,
  status: 'ok',
  buckLogStatus: 'ok',
  actionCount,
})

const validRecords = [
  sample({ phase: 'warm-noop', actionCount: 0 }),
  sample({ phase: 'mtime-only', actionCount: 0 }),
  sample({ phase: 'irrelevant-edit', actionCount: 0 }),
  sample({ phase: 'relevant-edit', actionCount: 1 }),
  sample({ phase: 'declared-unreachable-edit', actionCount: 1 }),
]

const runAssertion = (records) => {
  const directory = mkdtempSync(join(tmpdir(), 'buck2-invalidation-assertion-test-'))
  try {
    const input = join(directory, 'raw.jsonl')
    writeFileSync(input, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    return spawnSync(
      process.execPath,
      [join(import.meta.dirname, 'assert-invalidation.mjs'), input],
      { encoding: 'utf8' },
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('Buck invalidation assertions', () => {
  it('accepts role exclusion while explicitly recording the coarse declared-input boundary', () => {
    const result = runAssertion(validRecords)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /declared-unreachable production boundary remains coarse/u)
  })

  it('rejects a false claim that a declared-unreachable production input is fine-grained', () => {
    const records = structuredClone(validRecords)
    const declaredUnreachable = records.find(
      (record) => record.phase === 'declared-unreachable-edit',
    )
    assert.ok(declaredUnreachable)
    declaredUnreachable.actionCount = 0
    const result = runAssertion(records)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /declared-unreachable-edit: expected at least one action/u)
  })

  it('rejects invalidation from a role-excluded test input', () => {
    const records = structuredClone(validRecords)
    const roleExcluded = records.find((record) => record.phase === 'irrelevant-edit')
    assert.ok(roleExcluded)
    roleExcluded.actionCount = 1
    const result = runAssertion(records)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /irrelevant-edit: expected zero actions/u)
  })
})
