#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

type SummaryRecord = {
  readonly name?: unknown
  readonly value?: unknown
}

type PackageResult =
  | {
      readonly failures: number
      readonly packageName: string
      readonly summary: string
      readonly tests: number
    }
  | {
      readonly error: string
      readonly packageName: string
    }

const argumentValue = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const root = resolve(argumentValue('--root') ?? process.cwd())
const summaryDirectory = resolve(
  root,
  argumentValue('--summary-dir') ?? 'tmp/otel-scrape/summaries',
)

const testGlobs = [
  'packages/@overeng/**/*.test.ts',
  'packages/@overeng/**/*.test.tsx',
  'packages/@overeng/**/*.spec.ts',
  'packages/@overeng/**/*.spec.tsx',
] as const

const baselineDescribePattern =
  /(?:^|[^\w$])(?:[A-Za-z_$][\w$]*\.)?describe(?:\.\w+)*\s*\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g

const packageNameFrom = (file: string) => file.split('/')[2]

const testFiles = (
  await Promise.all(
    testGlobs.map(async (pattern) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root }))),
  )
)
  .flat()
  .toSorted()

const baselinePackages = new Set<string>()

const testFileSources = await Promise.all(
  testFiles.map(async (file) => [file, await Bun.file(resolve(root, file)).text()] as const),
)

for (const [file, source] of testFileSources) {
  const hasBaselineDescribe = Array.from(source.matchAll(baselineDescribePattern)).some((match) =>
    /(?:baseline|cross-major)/i.test(match[2] ?? ''),
  )
  const packageName = packageNameFrom(file)
  if (hasBaselineDescribe === true && packageName !== undefined) {
    baselinePackages.add(packageName)
  }
}

const metricValue = ({
  records,
  metric,
}: {
  readonly metric: string
  readonly records: readonly SummaryRecord[]
}) => records.find((record) => record.name === metric)?.value

const missingSummaryError = () =>
  `missing managed-task summary in ${summaryDirectory}; was the test task run in an installed worktree?`

const readPackageResult = async (packageName: string): Promise<PackageResult> => {
  const summaries =
    existsSync(summaryDirectory) === false
      ? []
      : await Array.fromAsync(
          new Bun.Glob(`test-${packageName}*.summary.json`).scan({
            absolute: true,
            cwd: summaryDirectory,
          }),
        )

  if (summaries.length === 0) {
    return {
      error: missingSummaryError(),
      packageName,
    }
  }

  const summariesByNewest = await Promise.all(
    summaries.map(async (summary) => ({
      modifiedAt: (await Bun.file(summary).stat()).mtimeMs,
      summary,
    })),
  )
  summariesByNewest.sort(
    (left, right) =>
      right.modifiedAt - left.modifiedAt || right.summary.localeCompare(left.summary),
  )
  const summary = summariesByNewest[0]?.summary
  if (summary === undefined) {
    return {
      error: missingSummaryError(),
      packageName,
    }
  }

  let decoded: unknown
  try {
    decoded = await Bun.file(summary).json()
  } catch (cause) {
    return {
      error: `${basename(summary)} is not valid JSON: ${String(cause)}`,
      packageName,
    }
  }

  const records =
    typeof decoded === 'object' &&
    decoded !== null &&
    'adapter' in decoded &&
    typeof decoded.adapter === 'object' &&
    decoded.adapter !== null &&
    'records' in decoded.adapter &&
    Array.isArray(decoded.adapter.records) === true
      ? (decoded.adapter.records as readonly SummaryRecord[])
      : []
  const tests = metricValue({ records, metric: 'vitest.tests' })
  const failures = metricValue({ records, metric: 'vitest.failures' })

  if (
    typeof tests !== 'number' ||
    Number.isFinite(tests) === false ||
    Number.isInteger(tests) === false ||
    tests < 0
  ) {
    return {
      error: `${basename(summary)} has no non-negative integer vitest.tests metric`,
      packageName,
    }
  }
  if (
    typeof failures !== 'number' ||
    Number.isFinite(failures) === false ||
    Number.isInteger(failures) === false ||
    failures < 0
  ) {
    return {
      error: `${basename(summary)} has no non-negative integer vitest.failures metric`,
      packageName,
    }
  }
  if (tests === 0) {
    return {
      error: `${basename(summary)} reports vitest.tests=0 (vitest.failures=${failures})`,
      packageName,
    }
  }

  return {
    failures,
    packageName,
    summary: basename(summary),
    tests,
  }
}

const results = await Promise.all(
  baselinePackages.values().toArray().toSorted().map(readPackageResult),
)
const failed = results.filter((result) => 'error' in result)

for (const result of results) {
  if ('error' in result) {
    console.error(`FAIL ${result.packageName}: ${result.error}`)
  } else {
    console.log(
      `PASS ${result.packageName}: vitest.tests=${result.tests} vitest.failures=${result.failures} (${result.summary})`,
    )
  }
}

if (failed.length === 0) {
  console.log(
    `PASS: ${baselinePackages.size} baseline packages have managed-task summaries with collected tests.`,
  )
} else {
  console.error(
    `FAIL: ${failed.length}/${baselinePackages.size} baseline packages lack proof of collected tests.`,
  )
  process.exitCode = 1
}
