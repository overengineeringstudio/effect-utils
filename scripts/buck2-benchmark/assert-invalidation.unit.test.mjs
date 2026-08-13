import assert from 'node:assert/strict'
/* oxlint-disable overeng/named-args, overeng/explicit-boolean-compare -- Test fixtures mirror the internal CLI's compact JSON inputs. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const measurementContract = {
  id: 'fixture-product',
  label: 'Fixture product',
  workContract: 'fixture/product-v1',
  benchmarkSchema: 'effect-utils-buck2-benchmark/v0',
  buckTarget: '//fixture:product',
  runs: 2,
  assertions: [
    {
      id: 'warm-actions',
      label: 'Warm actions',
      phase: 'warm-noop',
      metric: 'actionCount',
      expectation: { _tag: 'exact', value: 0 },
    },
    {
      id: 'relevant-actions',
      label: 'Relevant actions',
      phase: 'relevant-edit',
      metric: 'actionCount',
      expectation: { _tag: 'at-least', value: 1 },
    },
  ],
}

const measurementRecords = ({ relevant = [1, 1], omitWarm = false } = {}) => [
  {
    kind: 'metadata',
    schema: measurementContract.benchmarkSchema,
    target: measurementContract.buckTarget,
    runId: 'run-1',
    sha: 'abc123',
    workContract: measurementContract.workContract,
    samplePolicy: { runs: 2, warmups: 0 },
  },
  ...(!omitWarm
    ? [0, 0].map((actionCount, sampleIndex) =>
        Object.assign(sample({ phase: 'warm-noop', actionCount }), {
          schema: measurementContract.benchmarkSchema,
          sampleIndex,
          runId: 'run-1',
          sha: 'abc123',
          workContract: measurementContract.workContract,
          materializationCount: 0,
          durationMs: 1,
        }),
      )
    : []),
  ...relevant.map((actionCount, sampleIndex) => ({
    ...sample({ phase: 'relevant-edit', actionCount }),
    schema: measurementContract.benchmarkSchema,
    sampleIndex,
    runId: 'run-1',
    sha: 'abc123',
    workContract: measurementContract.workContract,
    materializationCount: 1,
    durationMs: 2,
  })),
]

const runMeasurementAdmission = (records, contract = measurementContract) => {
  const directory = mkdtempSync(join(tmpdir(), 'buck2-measurement-admission-test-'))
  const input = join(directory, 'raw.jsonl')
  const output = join(directory, 'measurements.json')
  writeFileSync(input, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  const result = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, 'assert-invalidation.mjs'),
      '--contract-json',
      JSON.stringify(contract),
      '--output',
      output,
      input,
    ],
    { encoding: 'utf8' },
  )
  const artifact = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null
  rmSync(directory, { recursive: true, force: true })
  return { result, artifact }
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

describe('Buck CI measurement admission', () => {
  it('emits additive schema-v1 assertion and advisory sample evidence', () => {
    const { result, artifact } = runMeasurementAdmission(measurementRecords())
    assert.equal(result.status, 0, result.stderr)
    assert.equal(artifact.schemaVersion, 1)
    assert.equal(artifact.completeness.status, 'complete')
    assert.deepEqual(
      artifact.observations.find((row) => row.id === 'warm-actions').statistics.samples,
      [0, 0],
    )
    assert.equal(
      artifact.observations.find((row) => row.id === 'relevant-actions').policy.comparisonMode,
      'assertion',
    )
    assert.ok(artifact.observations.some((row) => row.id === 'warm-noop-duration'))
  })

  it('rejects one bad sample hidden by a healthy median', () => {
    const { result, artifact } = runMeasurementAdmission(measurementRecords({ relevant: [0, 2] }))
    assert.notEqual(result.status, 0)
    assert.equal(artifact.completeness.status, 'complete')
    assert.equal(
      artifact.observations.find((row) => row.id === 'relevant-actions').assertion.status,
      'fail',
    )
  })

  it('emits no-verdict evidence and fails when configured samples are missing', () => {
    const { result, artifact } = runMeasurementAdmission(measurementRecords({ omitWarm: true }))
    assert.notEqual(result.status, 0)
    assert.equal(artifact.completeness.status, 'partial')
    assert.ok(artifact.completeness.missing.some((row) => row.observationId === 'warm-actions'))
  })

  it('rejects malformed contracts', () => {
    const malformed = structuredClone(measurementContract)
    malformed.assertions[0].expectation = { _tag: 'exact', value: -1 }
    const { result } = runMeasurementAdmission(measurementRecords(), malformed)
    assert.notEqual(result.status, 0)
  })
})
