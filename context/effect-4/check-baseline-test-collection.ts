#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

type BaselineFile = {
  readonly file: string
  readonly registration?: TestTaskRegistration
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

type TestTaskRegistration = {
  readonly packagePath: string
  readonly taskName: string
}

const argumentValue = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const root = resolve(argumentValue('--root') ?? process.cwd())
const reportDirectory = resolve(root, argumentValue('--report-dir') ?? 'tmp/otel-scrape/summaries')
const taskRegistryPath = argumentValue('--task-registry')
if (taskRegistryPath === undefined) {
  throw new Error('--task-registry is required')
}

const decodedTaskRegistry: unknown = await Bun.file(taskRegistryPath).json()
if (
  Array.isArray(decodedTaskRegistry) === false ||
  decodedTaskRegistry.some(
    (registration) =>
      typeof registration !== 'object' ||
      registration === null ||
      !('packagePath' in registration) ||
      typeof registration.packagePath !== 'string' ||
      !('taskName' in registration) ||
      typeof registration.taskName !== 'string',
  ) === true
) {
  throw new Error(`${taskRegistryPath} is not a valid baseline test task registry`)
}
const taskRegistry = decodedTaskRegistry as readonly TestTaskRegistration[]

const testGlobs = [
  'packages/@overeng/**/*.test.ts',
  'packages/@overeng/**/*.test.tsx',
  'packages/@overeng/**/*.spec.ts',
  'packages/@overeng/**/*.spec.tsx',
] as const

const baselineDescribePattern =
  /(?:^|[^\w$])(?:[A-Za-z_$][\w$]*\.)?describe(?:\.\w+)*\s*\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g

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

const registrationFor = (file: string) =>
  taskRegistry
    .filter(({ packagePath }) => file.startsWith(`${packagePath}/`))
    .toSorted((left, right) => right.packagePath.length - left.packagePath.length)[0]

const baselineFiles = testFileSources
  .filter(([, source]) =>
    Array.from(source.matchAll(baselineDescribePattern)).some((match) =>
      /(?:baseline|cross-major)/i.test(match[2] ?? ''),
    ),
  )
  .map(([file]): BaselineFile => ({ file, registration: registrationFor(file) }))
  .toSorted((left, right) => left.file.localeCompare(right.file))

const repoPathFromReportName = (name: string) => {
  const normalizedName = name.replaceAll('\\', '/')
  const absolute =
    isAbsolute(name) === true
      ? name
      : normalizedName.startsWith('packages/') === true
        ? resolve(root, normalizedName)
        : undefined
  if (absolute === undefined) return undefined
  const repoPath = relative(root, absolute).split(sep).join('/')
  return repoPath.startsWith('../') === true ? undefined : repoPath
}

const taskFileStem = (taskName: string) =>
  taskName.replaceAll(':', '-').replaceAll('/', '-').replaceAll(' ', '-').replaceAll('.', '_')

const readTaskResults = async ({
  files,
  registration,
}: {
  readonly files: readonly BaselineFile[]
  readonly registration: TestTaskRegistration
}): Promise<readonly FileResult[]> => {
  const report = resolve(reportDirectory, `${taskFileStem(registration.taskName)}.vitest.json`)
  if (existsSync(report) === false) {
    return files.map(({ file }) => ({
      error: `missing exact report ${basename(report)} for registered task ${registration.taskName}`,
      file,
    }))
  }

  let decoded: unknown
  try {
    decoded = await Bun.file(report).json()
  } catch (cause) {
    return files.map(({ file }) => ({
      error: `${basename(report)} is not valid JSON: ${String(cause)}`,
      file,
    }))
  }

  const testResults =
    typeof decoded === 'object' &&
    decoded !== null &&
    'testResults' in decoded &&
    Array.isArray(decoded.testResults) === true
      ? (decoded.testResults as readonly VitestFileResult[])
      : undefined
  if (testResults === undefined) {
    return files.map(({ file }) => ({
      error: `${basename(report)} has no testResults array`,
      file,
    }))
  }

  const collectedByFile = new Map<string, number>()
  for (const testResult of testResults) {
    if (
      typeof testResult.name !== 'string' ||
      Array.isArray(testResult.assertionResults) === false
    ) {
      continue
    }
    const file = repoPathFromReportName(testResult.name)
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
        error: `${basename(report)} reports zero collected tests for this baseline file (${reportTests} tests collected across the registered task)`,
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

const unregisteredResults: readonly FileResult[] = baselineFiles
  .filter(({ registration }) => registration === undefined)
  .map(({ file }) => ({
    error: 'no registered managed test task owns this baseline file',
    file,
  }))
const filesByTask = Map.groupBy(
  baselineFiles.filter(
    (file): file is BaselineFile & { readonly registration: TestTaskRegistration } =>
      file.registration !== undefined,
  ),
  ({ registration }) => registration.taskName,
)
const registeredResults = (
  await Promise.all(
    [...filesByTask.values()].map((files) =>
      readTaskResults({ files, registration: files[0]!.registration }),
    ),
  )
).flat()
const results = [...unregisteredResults, ...registeredResults].toSorted((left, right) =>
  left.file.localeCompare(right.file),
)
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
