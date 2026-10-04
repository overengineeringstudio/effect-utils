import { mkdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fail = (message: string): never => {
  throw new Error(`test verdict: ${message}`)
}
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail('expected an object')
  return value
}
const text = (value: unknown): string =>
  typeof value === 'string' ? value : fail('expected a string')
const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : fail('expected an array')

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
  const report = record(raw)
  if (typeof report['success'] !== 'boolean') fail('missing report success')
  const suites = list(report['testResults'])
    .map((value) => {
      const suite = record(value)
      const file = relative(packageTree, text(suite['name']))
      if (file === '' || file.startsWith('../')) fail('suite file escapes package tree')
      const tests = list(suite['assertionResults'])
        .map((assertion) => {
          const test = record(assertion)
          const testStatus = text(test['status'])
          if (!['passed', 'failed', 'pending', 'skipped', 'todo'].includes(testStatus))
            fail(`unknown test status: ${testStatus}`)
          return {
            name: text(test['fullName']),
            status: testStatus,
            failures: list(test['failureMessages']).map((message) =>
              text(message).replaceAll(packageTree, '<package>'),
            ),
          }
        })
        .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      return { file, tests }
    })
    .toSorted((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
  if (suites.length === 0) fail('report contains no suites')
  const failed = suites.some((suite) => suite.tests.some((test) => test.status === 'failed'))
  const verdict = failed ? 'fail' : 'pass'
  if (report['success'] !== !failed || (status === 0) !== !failed || (failed && status !== 1))
    fail('runner exit status and assertion verdict disagree (crash or collection failure)')
  return { verdict, suites }
}

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
export const readTestVerdict = async (output: string, operation: string): Promise<number> => {
  const result = record(await Bun.file(join(output, 'result.json')).json())
  if (result['schemaVersion'] !== 1 || !['pass', 'fail'].includes(text(result['verdict'])))
    fail('unsupported result schema or verdict')
  if (result['operation'] !== operation || result['report'] !== 'report.json')
    fail('operation identity or report path mismatch')
  const report = record(await Bun.file(join(output, 'report.json')).json())
  if (report['verdict'] !== result['verdict']) fail('result and report verdict disagree')
  list(report['suites'])
  console.log(`${operation}: ${result['verdict']} (cached verdict artifact)`)
  if (result['verdict'] === 'fail') console.error(JSON.stringify(report, undefined, 2))
  return result['verdict'] === 'pass' ? 0 : 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(
      await readTestVerdict(
        process.argv[2] ?? fail('missing artifact'),
        process.argv[3] ?? fail('missing operation'),
      ),
    )
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}
