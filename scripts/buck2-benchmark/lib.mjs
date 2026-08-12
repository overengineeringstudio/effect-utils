const finiteNumbers = (values) => values.filter((value) => Number.isFinite(value))

/** Calculate a nearest-rank percentile over finite numeric values. */
export const percentile = ({ values, fraction }) => {
  const sorted = finiteNumbers(values).toSorted((left, right) => left - right)
  if (sorted.length === 0) return null
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  return sorted[index]
}

/** Count non-empty records in Buck's line-oriented action output. */
export const countNonEmptyLines = (text) =>
  text.split(/\r?\n/u).filter((line) => line.trim().length > 0).length

/** Parse Buck materialization JSONL while retaining malformed-record evidence. */
export const parseMaterializations = (text) => {
  let count = 0
  let bytes = 0
  let files = 0
  let malformed = 0

  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    try {
      const value = JSON.parse(line)
      if (typeof value !== 'object' || value === null || Array.isArray(value) === true) {
        malformed += 1
        continue
      }
      const byteCandidate =
        value.total_bytes ?? value.totalBytes ?? value.bytes ?? value.decompressed_size
      const fileCandidate = value.file_count ?? value.fileCount ?? value.files
      if (Number.isFinite(byteCandidate) === false || Number.isFinite(fileCandidate) === false) {
        malformed += 1
        continue
      }
      count += 1
      bytes += byteCandidate
      files += fileCandidate
    } catch {
      malformed += 1
    }
  }

  return { count, bytes, files, malformed }
}

const groupKey = (record) =>
  JSON.stringify([record.engine, record.surface, record.phase, record.mutation ?? null])

/** Aggregate measured samples without converting failures or skips into verdicts. */
export const summarizeSamples = (records) => {
  const groups = new Map()
  for (const record of records) {
    if (record.kind !== 'sample' || record.warmup === true) continue
    const key = groupKey(record)
    const existing = groups.get(key) ?? []
    existing.push(record)
    groups.set(key, existing)
  }

  return [...groups.values()].map((samples) => {
    const first = samples[0]
    const ok = samples.filter((sample) => sample.status === 'ok')
    const durations = ok.map((sample) => sample.durationMs)
    const actionCounts = ok.map((sample) => sample.actionCount)
    const materializationCounts = ok.map((sample) => sample.materializationCount)
    const complete = ok.length === samples.length && ok.length > 0

    return {
      schema: first.schema,
      kind: 'summary',
      runId: first.runId,
      sha: first.sha,
      engine: first.engine,
      surface: first.surface,
      phase: first.phase,
      mutation: first.mutation ?? null,
      workContract: first.workContract ?? null,
      status: complete === true ? 'ok' : 'no-verdict',
      verdict: complete === true ? 'measured' : 'no-verdict',
      sampleCount: samples.length,
      okCount: ok.length,
      failedCount: samples.filter((sample) => sample.status === 'failed').length,
      skippedCount: samples.filter((sample) => sample.status === 'skipped').length,
      timingsMs: {
        min: durations.length === 0 ? null : Math.min(...durations),
        p50: percentile({ values: durations, fraction: 0.5 }),
        p95: percentile({ values: durations, fraction: 0.95 }),
        max: durations.length === 0 ? null : Math.max(...durations),
      },
      actionCounts: {
        p50: percentile({ values: actionCounts, fraction: 0.5 }),
        p95: percentile({ values: actionCounts, fraction: 0.95 }),
      },
      materializationCounts: {
        p50: percentile({ values: materializationCounts, fraction: 0.5 }),
        p95: percentile({ values: materializationCounts, fraction: 0.95 }),
      },
      evidenceVerdicts: {
        timing: complete === true ? 'measured' : 'no-verdict',
        actions:
          first.engine !== 'buck2'
            ? 'not-applicable'
            : ok.length > 0 && ok.every((sample) => sample.buckLogStatus === 'ok') === true
              ? 'measured'
              : 'no-verdict',
        materializations:
          first.engine !== 'buck2'
            ? 'not-applicable'
            : ok.length > 0 && ok.every((sample) => sample.buckLogStatus === 'ok') === true
              ? 'measured'
              : 'no-verdict',
      },
      crossEngineComparison: {
        generated: false,
        verdict: 'no-verdict',
        reason:
          first.workContract === null || first.workContract === undefined
            ? 'equivalence-contract-undeclared'
            : first.equivalenceDeclaration === 'operator-declared-not-independently-verified'
              ? 'per-engine-summary-only'
              : 'workloads-not-declared-equivalent',
      },
    }
  })
}

/** Parse JSONL and report the exact malformed input line. */
export const parseJsonl = (text) => {
  const records = []
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`, { cause: error })
    }
  }
  return records
}
