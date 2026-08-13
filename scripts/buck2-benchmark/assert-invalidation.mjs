#!/usr/bin/env node
/* oxlint-disable overeng/named-args, overeng/explicit-boolean-compare -- This internal CLI validates parsed JSON and boolean evidence predicates directly. */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const optionValue = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const contractJson = optionValue('--contract-json')
const outputPath = optionValue('--output')
const rawPath = argv.find(
  (arg, index) =>
    !arg.startsWith('--') &&
    argv[index - 1] !== '--contract-json' &&
    argv[index - 1] !== '--output',
)
if (rawPath === undefined) {
  console.error(
    'usage: assert-invalidation.mjs [--contract-json JSON --output FILE] RAW_BENCHMARK_JSONL',
  )
  process.exit(2)
}

if (!existsSync(rawPath)) {
  if (contractJson === undefined || outputPath === undefined)
    throw new Error(`benchmark evidence not found: ${rawPath}`)
  const contract = JSON.parse(contractJson)
  const fingerprint = createHash('sha256').update(JSON.stringify(contract)).digest('hex')
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        producer: {
          name: 'effect-utils-ci-measurement',
          version: 1,
          measurementProtocol: 'buck2-invalidation-v1',
        },
        target: { kind: 'buck2', id: contract.id, label: contract.label },
        contract: { fingerprint, snapshot: contract },
        completeness: { status: 'partial', missing: [{ reason: 'raw-benchmark-missing' }] },
        observations: [],
      },
      null,
      2,
    )}\n`,
  )
  process.exit(1)
}

const records = readFileSync(rawPath, 'utf8')
  .split(/\r?\n/u)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
const samples = records.filter(
  (record) => record.kind === 'sample' && record.engine === 'buck2' && record.warmup === false,
)

const expectationMatches = (expectation, value) => {
  if (expectation._tag === 'exact') return value === expectation.value
  if (expectation._tag === 'at-least') return value >= expectation.value
  if (expectation._tag === 'at-most') return value <= expectation.value
  if (expectation._tag === 'range') return value >= expectation.min && value <= expectation.max
  return false
}

const validExpectation = (expectation) => {
  if (expectation === null || typeof expectation !== 'object') return false
  if (expectation._tag === 'range')
    return (
      Number.isSafeInteger(expectation.min) &&
      expectation.min >= 0 &&
      Number.isSafeInteger(expectation.max) &&
      expectation.max >= expectation.min
    )
  return (
    ['exact', 'at-least', 'at-most'].includes(expectation._tag) &&
    Number.isSafeInteger(expectation.value) &&
    expectation.value >= 0
  )
}

const median = (values) => {
  const sorted = values.toSorted((left, right) => left - right)
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const emitCiMeasurementArtifact = (contract) => {
  if (!Number.isSafeInteger(contract.runs) || contract.runs < 1)
    throw new Error('contract runs must be a positive integer')
  if (!Array.isArray(contract.assertions) || contract.assertions.length === 0)
    throw new Error('contract must contain assertions')
  if (
    new Set(contract.assertions.map((assertion) => assertion.id)).size !==
    contract.assertions.length
  )
    throw new Error('contract assertion IDs must be unique')
  for (const assertion of contract.assertions) {
    if (!['actionCount', 'materializationCount'].includes(assertion.metric))
      throw new Error(`${assertion.id}: unknown metric`)
    if (!validExpectation(assertion.expectation))
      throw new Error(`${assertion.id}: invalid expectation`)
  }

  const metadata = records.filter((record) => record.kind === 'metadata')
  const soleMetadata = metadata.length === 1 ? metadata[0] : null
  const rawSha256 = createHash('sha256').update(readFileSync(rawPath)).digest('hex')
  const contractFingerprint = createHash('sha256').update(JSON.stringify(contract)).digest('hex')
  const missing = []
  const observations = []
  const assertedKeys = new Set(
    contract.assertions.map((assertion) => `${assertion.phase}:${assertion.metric}`),
  )
  const matchingSamples = samples.filter((sample) => sample.workContract === contract.workContract)

  for (const assertion of contract.assertions) {
    const phaseSamples = matchingSamples.filter((sample) => sample.phase === assertion.phase)
    const indexes = phaseSamples.map((sample) => sample.sampleIndex)
    const values = phaseSamples.map((sample) => sample[assertion.metric])
    const complete =
      soleMetadata !== null &&
      soleMetadata.schema === contract.benchmarkSchema &&
      soleMetadata.target === contract.buckTarget &&
      soleMetadata.workContract === contract.workContract &&
      soleMetadata.samplePolicy?.runs === contract.runs &&
      phaseSamples.length === contract.runs &&
      new Set(indexes).size === contract.runs &&
      indexes.every(
        (index) => Number.isSafeInteger(index) && index >= 0 && index < contract.runs,
      ) &&
      phaseSamples.every(
        (sample) =>
          sample.schema === contract.benchmarkSchema &&
          sample.runId === soleMetadata?.runId &&
          sample.sha === soleMetadata?.sha &&
          sample.workContract === soleMetadata?.workContract &&
          sample.status === 'ok' &&
          sample.buckLogStatus === 'ok',
      ) &&
      values.every((value) => Number.isSafeInteger(value) && value >= 0)
    const passing =
      complete && values.every((value) => expectationMatches(assertion.expectation, value))
    if (!complete)
      missing.push({ observationId: assertion.id, reason: 'incomplete-sample-evidence' })
    observations.push({
      id: assertion.id,
      label: assertion.label,
      group: 'buck2 / invalidation',
      name: `buck2.${assertion.metric === 'actionCount' ? 'action_count' : 'materialization_count'}`,
      unit: 'count',
      value: complete ? median(values) : 0,
      measurementKind: 'deterministic',
      dimensions: { phase: assertion.phase, measurementProtocol: 'buck2-invalidation-v1' },
      policy: {
        enabled: true,
        comparisonMode: 'assertion',
        expectation: assertion.expectation,
        onNoVerdict: 'fail',
      },
      statistics: {
        sampleCount: phaseSamples.length,
        measuredSampleCount: phaseSamples.length,
        samples: values,
      },
      assertion: { status: complete ? (passing ? 'pass' : 'fail') : 'no-verdict' },
      evidence: { status: complete ? 'complete' : 'partial', sampleIndexes: indexes, rawSha256 },
    })
  }

  const phases = [...new Set(matchingSamples.map((sample) => sample.phase))].toSorted()
  for (const phase of phases) {
    const phaseSamples = matchingSamples.filter(
      (sample) => sample.phase === phase && sample.status === 'ok',
    )
    for (const [metric, name, unit] of [
      ['durationMs', 'buck2.duration', 'milliseconds'],
      ['actionCount', 'buck2.action_count', 'count'],
      ['materializationCount', 'buck2.materialization_count', 'count'],
      ['materializationBytes', 'buck2.materialization_bytes', 'bytes'],
    ]) {
      if (assertedKeys.has(`${phase}:${metric}`)) continue
      const values = phaseSamples
        .map((sample) => sample[metric])
        .filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      if (values.length === 0) continue
      observations.push({
        id: `${phase}-${name.slice('buck2.'.length).replaceAll('_', '-')}`,
        label: `${phase} ${name.slice('buck2.'.length).replaceAll('_', ' ')}`,
        group: 'buck2 / profile',
        name,
        unit,
        value: median(values),
        measurementKind: 'diagnostic',
        dimensions: { phase, measurementProtocol: 'buck2-invalidation-v1' },
        policy: { enabled: false, comparisonMode: 'historical' },
        statistics: {
          sampleCount: values.length,
          measuredSampleCount: values.length,
          samples: values,
        },
        evidence: {
          status: 'complete',
          sampleIndexes: phaseSamples.map((sample) => sample.sampleIndex),
          rawSha256,
        },
      })
    }
  }

  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    producer: {
      name: 'effect-utils-ci-measurement',
      version: 1,
      measurementProtocol: 'buck2-invalidation-v1',
    },
    subject: { sha: metadata[0]?.sha ?? null },
    target: { kind: 'buck2', id: contract.id, label: contract.label },
    contract: { fingerprint: contractFingerprint, snapshot: contract },
    completeness: { status: missing.length === 0 ? 'complete' : 'partial', missing },
    observations,
    attachments: [
      { name: 'raw-benchmark-jsonl', path: 'raw.jsonl', contentType: 'application/x-ndjson' },
    ],
  }
  mkdirSync(dirname(outputPath), { recursive: true })
  copyFileSync(rawPath, join(dirname(outputPath), 'raw.jsonl'))
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`)
  if (
    missing.length > 0 ||
    observations.some((observation) => observation.assertion?.status === 'fail')
  )
    process.exitCode = 1
}

if (contractJson !== undefined || outputPath !== undefined) {
  if (contractJson === undefined || outputPath === undefined)
    throw new Error('--contract-json and --output must be provided together')
  emitCiMeasurementArtifact(JSON.parse(contractJson))
} else {
  const assertPhase = ({ phase, expected }) => {
    const phaseSamples = samples.filter((sample) => sample.phase === phase)
    if (phaseSamples.length === 0) throw new Error(`${phase}: no measured samples`)
    for (const sample of phaseSamples) {
      if (sample.status !== 'ok' || sample.buckLogStatus !== 'ok')
        throw new Error(`${phase}: incomplete action evidence`)
      if (expected === 'zero' && sample.actionCount !== 0)
        throw new Error(`${phase}: expected zero actions, observed ${sample.actionCount}`)
      if (expected === 'positive' && !(sample.actionCount > 0))
        throw new Error(`${phase}: expected at least one action, observed ${sample.actionCount}`)
    }
  }

  assertPhase({ phase: 'warm-noop', expected: 'zero' })
  assertPhase({ phase: 'mtime-only', expected: 'zero' })
  assertPhase({ phase: 'irrelevant-edit', expected: 'zero' })
  assertPhase({ phase: 'relevant-edit', expected: 'positive' })
  assertPhase({ phase: 'declared-unreachable-edit', expected: 'positive' })
  console.log(
    'buck2 benchmark invalidation assertions: PASS (declared-unreachable production boundary remains coarse)',
  )
}
