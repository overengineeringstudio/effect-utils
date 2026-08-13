#!/usr/bin/env node

import { readFileSync } from 'node:fs'

const [rawPath] = process.argv.slice(2)
if (rawPath === undefined) {
  console.error('usage: assert-invalidation.mjs RAW_BENCHMARK_JSONL')
  process.exit(2)
}

const records = readFileSync(rawPath, 'utf8')
  .split(/\r?\n/u)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
const samples = records.filter(
  (record) => record.kind === 'sample' && record.engine === 'buck2' && record.warmup === false,
)

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
