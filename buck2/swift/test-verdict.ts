/**
 * Run one linked XCTest suite and publish its verdict as declared outputs.
 *
 * The result follows the repository's unit-test verdict contract
 * (`result.json`: schemaVersion 1, `pass`/`fail`, operation, report path).
 * A failing suite writes a `fail` verdict and exits nonzero, so Buck never
 * uploads it; a crash or an exit status that disagrees with the reported test
 * cases fails without a verdict.
 */
import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

type TestStatus = 'passed' | 'failed' | 'skipped'
type SuiteReport = {
  readonly suite: string
  readonly tests: readonly { readonly name: string; readonly status: TestStatus; readonly failures: readonly string[] }[]
}

const CASE_RESULT = /^Test Case '([^.']+)\.([^']+)' (passed|failed|skipped) \(/
const CASE_FAILURE = /^(.*):(\d+): error: ([^.\s]+)\.(\S+) : (.*)$/

const byCodeUnits = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

/** corelibs-XCTest console output → per-class test results; timings are dropped. */
export const parseXCTestOutput = (output: string): readonly SuiteReport[] => {
  const failures = new Map<string, string[]>()
  const results = new Map<string, Map<string, TestStatus>>()
  for (const line of output.split('\n')) {
    const failure = CASE_FAILURE.exec(line)
    if (failure !== null) {
      const key = `${failure[3]}.${failure[4]}`
      failures.set(key, [...(failures.get(key) ?? []), `${failure[1]}:${failure[2]}: ${failure[5]}`])
      continue
    }
    const result = CASE_RESULT.exec(line)
    if (result === null) continue
    const suite = results.get(result[1]!) ?? new Map<string, TestStatus>()
    if (suite.has(result[2]!)) throw new Error(`swift test verdict: ${result[1]}.${result[2]} reported twice`)
    suite.set(result[2]!, result[3] as TestStatus)
    results.set(result[1]!, suite)
  }
  return [...results.entries()]
    .map(([suite, tests]) => ({
      suite,
      tests: [...tests.entries()]
        .map(([name, status]) => ({ name, status, failures: failures.get(`${suite}.${name}`) ?? [] }))
        .sort((left, right) => byCodeUnits(left.name, right.name)),
    }))
    .sort((left, right) => byCodeUnits(left.suite, right.suite))
}

/** The verdict, cross-checked against the runner's exit status. */
export const testVerdict = ({ suites, status }: { readonly suites: readonly SuiteReport[]; readonly status: number }) => {
  if (suites.length === 0) throw new Error('swift test verdict: the suite reported no test cases')
  const failed = suites.some((suite) => suite.tests.some((test) => test.status === 'failed'))
  if ((status === 0) === failed) {
    throw new Error(`swift test verdict: exit status ${status} disagrees with the reported test cases (crash?)`)
  }
  return failed ? 'fail' : 'pass'
}

if (import.meta.main) {
  const [executable, resultPath, reportPath, operation] = process.argv.slice(2)
  if (executable === undefined || resultPath === undefined || reportPath === undefined || operation === undefined) {
    throw new Error('usage: test-verdict.ts <test-executable> <result.json> <report.json> <operation>')
  }
  const scratch = process.env.BUCK_SCRATCH_PATH
  if (scratch === undefined || scratch === '') throw new Error('swift test verdict: BUCK_SCRATCH_PATH is required')
  const home = join(scratch, 'home')
  const temporary = join(scratch, 'tmp')
  await mkdir(home, { recursive: true })
  await mkdir(temporary, { recursive: true })
  // A scrubbed environment: the suite sees no host stamp, locale or tool path.
  const run = Bun.spawnSync([executable], {
    env: { HOME: home, TMPDIR: `${temporary}/` },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const console_ = `${run.stdout.toString()}${run.stderr.toString()}`
  process.stdout.write(console_)
  const suites = parseXCTestOutput(console_)
  const verdict = testVerdict({ suites, status: run.exitCode ?? -1 })
  await Bun.write(reportPath, `${JSON.stringify({ verdict, suites })}\n`)
  await Bun.write(
    resultPath,
    `${JSON.stringify({ schemaVersion: 1, verdict, operation, report: basename(reportPath) })}\n`,
  )
  process.exit(verdict === 'pass' ? 0 : 1)
}
