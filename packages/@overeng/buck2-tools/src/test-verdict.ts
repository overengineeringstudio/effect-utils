import { mkdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fail = (message: string): never => {
  throw new Error(`test verdict: ${message}`)
}
const object = (value: unknown): object => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true)
    return fail('expected an object')
  return value
}
const text = (value: unknown): string =>
  typeof value === 'string' ? value : fail('expected a string')
const list = (value: unknown): unknown[] =>
  Array.isArray(value) === true ? value : fail('expected an array')

/** Strip host paths and timing from Vitest's JSON report before publishing declared outputs. */
export const normalizeTestReport = ({
  raw,
  packageTree,
  status,
}: {
  readonly raw: unknown
  readonly packageTree: string
  readonly status: number
}): { readonly verdict: 'pass' | 'fail'; readonly suites: readonly unknown[] } => {
  const report = object(raw)
  if (!('success' in report) || typeof report.success !== 'boolean')
    return fail('missing report success')
  const suites = list('testResults' in report ? report.testResults : undefined)
    .map((value) => {
      const suite = object(value)
      const file = relative(packageTree, text('name' in suite ? suite.name : undefined))
      if (file === '' || file.startsWith('../') === true) fail('suite file escapes package tree')
      const tests = list('assertionResults' in suite ? suite.assertionResults : undefined)
        .map((assertion) => {
          const test = object(assertion)
          const testStatus = text('status' in test ? test.status : undefined)
          if (['passed', 'failed', 'pending', 'skipped', 'todo'].includes(testStatus) === false)
            fail(`unknown test status: ${testStatus}`)
          return {
            name: text('fullName' in test ? test.fullName : undefined),
            status: testStatus,
            failures: list('failureMessages' in test ? test.failureMessages : undefined).map(
              (message) => text(message).replaceAll(packageTree, '<package>'),
            ),
          }
        })
        .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      return { file, tests }
    })
    .toSorted((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
  if (suites.length === 0) fail('report contains no suites')
  const failed = suites.some((suite) => suite.tests.some((test) => test.status === 'failed'))
  const verdict = failed === true ? 'fail' : 'pass'
  if (report.success !== !failed || (status === 0) !== !failed || (failed === true && status !== 1))
    fail('runner exit status and assertion verdict disagree (crash or collection failure)')
  return { verdict, suites }
}

/** Publish the normalized report and the operation-bound result as declared action outputs. */
export const publishTestVerdict = async ({
  output,
  operation,
  packageTree,
  report,
  status,
}: {
  readonly output: string
  readonly operation: string
  readonly packageTree: string
  readonly report: string
  readonly status: number
}): Promise<void> => {
  const normalized = normalizeTestReport({
    raw: await Bun.file(report).json(),
    packageTree,
    status,
  })
  await mkdir(output, { recursive: true })
  await Bun.write(join(output, 'report.json'), `${JSON.stringify(normalized)}\n`)
  await Bun.write(
    join(output, 'result.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      verdict: normalized.verdict,
      operation,
      report: 'report.json',
    })}\n`,
  )
}

/** Test adapter consumes a successful action artifact; it never executes the suite. */
export const readTestVerdict = async ({
  output,
  operation,
}: {
  readonly output: string
  readonly operation: string
}): Promise<number> => {
  const result = object(await Bun.file(join(output, 'result.json')).json())
  if (
    !('schemaVersion' in result) ||
    result.schemaVersion !== 1 ||
    !('verdict' in result) ||
    ['pass', 'fail'].includes(text(result.verdict)) === false
  )
    return fail('unsupported result schema or verdict')
  if (
    !('operation' in result) ||
    result.operation !== operation ||
    !('report' in result) ||
    result.report !== 'report.json'
  )
    return fail('operation identity or report path mismatch')
  const report = object(await Bun.file(join(output, 'report.json')).json())
  if (!('verdict' in report) || report.verdict !== result.verdict)
    return fail('result and report verdict disagree')
  list('suites' in report ? report.suites : undefined)
  console.log(`${operation}: ${result.verdict} (cached verdict artifact)`)
  if (result.verdict === 'fail') console.error(JSON.stringify(report, undefined, 2))
  return result.verdict === 'pass' ? 0 : 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(
      await readTestVerdict({
        output: process.argv[2] ?? fail('missing artifact'),
        operation: process.argv[3] ?? fail('missing operation'),
      }),
    )
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}
