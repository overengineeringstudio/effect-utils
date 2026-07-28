#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

type BaselineFile = {
  readonly file: string
  readonly packageName: string
}

type FileResult =
  | {
      readonly collectedTests: number
      readonly file: string
      readonly report: string
    }
  | {
      readonly collectedTests?: number
      readonly error: string
      readonly file: string
    }

type VitestFileResult = {
  readonly assertionResults?: unknown
  readonly name?: unknown
}

const argumentValue = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const root = resolve(argumentValue('--root') ?? process.cwd())
const reportDirectory = resolve(root, argumentValue('--report-dir') ?? 'tmp/otel-scrape/summaries')

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

const testFileSources = await Promise.all(
  testFiles.map(async (file) => [file, await Bun.file(resolve(root, file)).text()] as const),
)

const baselineFiles = testFileSources
  .filter(([, source]) =>
    Array.from(source.matchAll(baselineDescribePattern)).some((match) =>
      /(?:baseline|cross-major)/i.test(match[2] ?? ''),
    ),
  )
  .map(([file]): BaselineFile | undefined => {
    const packageName = packageNameFrom(file)
    return packageName === undefined ? undefined : { file, packageName }
  })
  .filter((file): file is BaselineFile => file !== undefined)
  .toSorted((left, right) => left.file.localeCompare(right.file))

const baselineFilesByPackage = Map.groupBy(baselineFiles, (file) => file.packageName)

const missingReportError = (packageName: string) =>
  `missing managed Vitest JSON report for test:${packageName} in ${reportDirectory}; was the test task run in an installed worktree?`

const newestReportFor = async (packageName: string) => {
  const reports =
    existsSync(reportDirectory) === false
      ? []
      : await Array.fromAsync(
          new Bun.Glob(`test-${packageName}*.vitest.json`).scan({
            absolute: true,
            cwd: reportDirectory,
          }),
        )

  const reportsByNewest = await Promise.all(
    reports.map(async (report) => ({
      modifiedAt: (await Bun.file(report).stat()).mtimeMs,
      report,
    })),
  )
  reportsByNewest.sort(
    (left, right) => right.modifiedAt - left.modifiedAt || right.report.localeCompare(left.report),
  )
  return reportsByNewest[0]?.report
}

const repoPathFromReportName = ({
  name,
  packageName,
}: {
  readonly name: string
  readonly packageName: string
}) => {
  const normalizedName = name.replaceAll('\\', '/')
  const absolute =
    isAbsolute(name) === true
      ? name
      : normalizedName.startsWith('packages/') === true
        ? resolve(root, normalizedName)
        : resolve(root, 'packages', '@overeng', packageName, normalizedName)
  const repoPath = relative(root, absolute).split(sep).join('/')
  return repoPath.startsWith('../') === true ? undefined : repoPath
}

const failFiles = ({
  files,
  error,
}: {
  readonly error: string
  readonly files: readonly BaselineFile[]
}): readonly FileResult[] => files.map(({ file }) => ({ error, file }))

const readPackageResults = async ({
  packageName,
  files,
}: {
  readonly files: readonly BaselineFile[]
  readonly packageName: string
}): Promise<readonly FileResult[]> => {
  const report = await newestReportFor(packageName)
  if (report === undefined) {
    return failFiles({ files, error: missingReportError(packageName) })
  }

  let decoded: unknown
  try {
    decoded = await Bun.file(report).json()
  } catch (cause) {
    return failFiles({
      files,
      error: `${basename(report)} is not valid JSON: ${String(cause)}`,
    })
  }

  const testResults =
    typeof decoded === 'object' &&
    decoded !== null &&
    'testResults' in decoded &&
    Array.isArray(decoded.testResults) === true
      ? (decoded.testResults as readonly VitestFileResult[])
      : undefined
  if (testResults === undefined) {
    return failFiles({
      files,
      error: `${basename(report)} has no testResults array`,
    })
  }

  const collectedByFile = new Map<string, number>()
  for (const testResult of testResults) {
    if (
      typeof testResult.name !== 'string' ||
      Array.isArray(testResult.assertionResults) === false
    ) {
      continue
    }
    const file = repoPathFromReportName({ name: testResult.name, packageName })
    if (file === undefined) continue
    collectedByFile.set(file, (collectedByFile.get(file) ?? 0) + testResult.assertionResults.length)
  }
  const reportTests = [...collectedByFile.values()].reduce((sum, count) => sum + count, 0)

  return files.map(({ file }): FileResult => {
    const collectedTests = collectedByFile.get(file)
    if (collectedTests === undefined) {
      return {
        error: `${basename(report)} does not contain this baseline file (${reportTests} tests collected from other files)`,
        file,
      }
    }
    if (collectedTests === 0) {
      return {
        collectedTests,
        error: `${basename(report)} reports zero collected tests for this baseline file (${reportTests} tests collected across the package)`,
        file,
      }
    }
    return {
      collectedTests,
      file,
      report: basename(report),
    }
  })
}

const results = (
  await Promise.all(
    [...baselineFilesByPackage.entries()].map(([packageName, files]) =>
      readPackageResults({ packageName, files }),
    ),
  )
)
  .flat()
  .toSorted((left, right) => left.file.localeCompare(right.file))
const failed = results.filter((result) => 'error' in result)

for (const result of results) {
  if ('error' in result) {
    console.error(`FAIL ${result.file}: ${result.error}`)
  } else {
    console.log(`PASS ${result.file}: collectedTests=${result.collectedTests} (${result.report})`)
  }
}

const markdownCell = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ')

const appendGitHubStepSummary = async () => {
  const stepSummary = process.env.GITHUB_STEP_SUMMARY
  if (stepSummary === undefined || stepSummary.length === 0) return

  const rows = results.map((result) => {
    const collectedTests =
      typeof result.collectedTests === 'number' ? String(result.collectedTests) : '-'
    const evidence = 'error' in result ? `FAIL: ${result.error}` : `PASS: ${result.report}`
    return `| ${markdownCell(result.file)} | ${collectedTests} | ${markdownCell(evidence)} |`
  })
  const table = [
    '## Effect 4 baseline test collection',
    '',
    '| Baseline file | Collected tests | Evidence |',
    '| --- | ---: | --- |',
    ...rows,
    '',
  ].join('\n')

  try {
    await appendFile(stepSummary, table)
  } catch (cause) {
    console.warn(
      `WARN: could not append Effect 4 baseline file counts to GITHUB_STEP_SUMMARY; gate enforcement is unchanged: ${String(cause)}`,
    )
  }
}

await appendGitHubStepSummary()

if (failed.length === 0) {
  console.log(
    `PASS: ${baselineFiles.length} baseline files each contributed at least one collected test.`,
  )
} else {
  console.error(
    `FAIL: ${failed.length}/${baselineFiles.length} baseline files lack proof of collected tests.`,
  )
  process.exitCode = 1
}
