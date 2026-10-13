import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { configuredTimeoutFactor, sampleHostLoad, type HostLoad } from './bun-test-timeout.ts'

const decodeXml = (value: string): string =>
  value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/giu,
    (entity: string, decimal: string | undefined, hex: string | undefined) =>
      decimal !== undefined
        ? String.fromCodePoint(Number(decimal))
        : hex !== undefined
          ? String.fromCodePoint(Number.parseInt(hex, 16))
          : ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity] ??
            entity),
  )
const attributes = (xml: string): Record<string, string> =>
  Object.fromEntries(
    [...xml.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)].map((match) => [
      match[1]!,
      decodeXml((match[2] ?? match[3])!),
    ]),
  )
/** Registration metadata paired with Bun's typed JUnit failure records. */
export type TestDeadline = {
  readonly file: string
  readonly name: string
  readonly classname: string
  readonly namePattern?: string | undefined
  readonly classnamePattern?: string | undefined
  readonly base: number
  readonly effective: number
}

/** Parses Bun's JUnit records, never the human-readable console stream. */
export const classifyBunReport = ({
  xml,
  deadlines,
  base,
  factor,
  host,
}: {
  readonly xml: string
  readonly deadlines: readonly TestDeadline[]
  readonly base: number
  readonly factor: number
  readonly host: HostLoad
}): readonly string[] => {
  let timeouts = 0
  let assertions = 0
  let other = 0
  const lines: string[] = []
  const remaining = [...deadlines]
  const patterns = new Map<string, RegExp>()
  const matchesTitle = ({
    actual,
    expected,
    pattern,
  }: {
    readonly actual: string | undefined
    readonly expected: string
    readonly pattern: string | undefined
  }): boolean => {
    if (actual === expected) return true
    if (actual === undefined || pattern === undefined) return false
    let compiled = patterns.get(pattern)
    if (compiled === undefined) {
      compiled = new RegExp(pattern, 'u')
      patterns.set(pattern, compiled)
    }
    return compiled.test(actual)
  }
  for (const test of xml.matchAll(
    /<testcase\b((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(?:\/>|>([\s\S]*?)<\/testcase\s*>)/gu,
  )) {
    const record = attributes(test[1]!)
    let deadlineIndex = remaining.findIndex(
      (entry) =>
        entry.file === record['file'] &&
        matchesTitle({
          actual: record['name'],
          expected: entry.name,
          pattern: entry.namePattern,
        }) &&
        matchesTitle({
          actual: record['classname'],
          expected: entry.classname,
          pattern: entry.classnamePattern,
        }),
    )
    // Imported registration helpers have their own source file, while JUnit reports
    // the active test file. Bun registers files sequentially; consume matching names in order.
    if (deadlineIndex < 0)
      deadlineIndex = remaining.findIndex(
        (entry) =>
          matchesTitle({
            actual: record['name'],
            expected: entry.name,
            pattern: entry.namePattern,
          }) &&
          matchesTitle({
            actual: record['classname'],
            expected: entry.classname,
            pattern: entry.classnamePattern,
          }),
      )
    const deadline = deadlineIndex < 0 ? undefined : remaining.splice(deadlineIndex, 1)[0]
    const failure = /<failure\b((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/u.exec(
      test[2] ?? '',
    )
    if (failure === null) continue
    const type = attributes(failure[1]!)['type']
    if (type === 'TimeoutError') {
      timeouts += 1
      const testBase = deadline?.base ?? base
      const effective = deadline?.effective ?? Math.ceil(base * factor)
      lines.push(
        `test-timeout-under-load file=${JSON.stringify(record['file'])} test=${JSON.stringify([record['classname']?.split(' > ').toReversed().join(' > '), record['name']].filter(Boolean).join(' > '))} base=${testBase} factor=${factor} effective=${effective} deadlineMs=${effective} elapsedMs=${Number(record['time']) * 1000} load1=${host.load1} cpus=${host.cpus} memPsiFullAvg10=${host.memPsiFullAvg10 ?? 'unavailable'}`,
      )
    } else if (type === 'AssertionError') assertions += 1
    else other += 1
  }
  lines.push(
    `test-failure-summary timeoutFailures=${timeouts} assertionFailures=${assertions} otherFailures=${other}`,
  )
  return lines
}

/** Shared launch path for devenv and Buck; the child status is returned unchanged. */
export const runBunTests = async ({
  command,
  cwd,
  env,
  results,
}: {
  readonly command: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly results: string
}): Promise<number> => {
  const host = await sampleHostLoad()
  const factor = configuredTimeoutFactor({ host, env })
  const args = [...command]
  const testIndex = args.indexOf('test')
  if (testIndex < 1) throw new Error('Bun test runner requires a bun test command')
  const timeoutIndex = args.indexOf('--timeout', testIndex)
  const inlineIndex = args.findIndex(
    (arg, index) => index > testIndex && arg.startsWith('--timeout='),
  )
  const base = Number(
    timeoutIndex >= 0
      ? args[timeoutIndex + 1]
      : inlineIndex >= 0
        ? args[inlineIndex]!.slice('--timeout='.length)
        : 5000,
  )
  const effective = Math.ceil(base * factor)
  if (timeoutIndex >= 0) args.splice(timeoutIndex, 2)
  else if (inlineIndex >= 0) args.splice(inlineIndex, 1)
  const report = join(results, 'bun-junit.xml')
  const metadata = join(results, 'bun-deadlines.jsonl')
  await Promise.all([rm(report, { force: true }), rm(metadata, { force: true })])
  const preload = fileURLToPath(new URL('./bun-test-preload.ts', import.meta.url))
  args.splice(
    testIndex + 1,
    0,
    '--timeout',
    String(effective),
    '--preload',
    preload,
    '--reporter=junit',
    `--reporter-outfile=${report}`,
  )
  const child = Bun.spawn(args, {
    cwd,
    env: {
      ...env,
      BUN_TEST_TIMEOUT_BASE: String(base),
      BUN_TEST_TIMEOUT_FACTOR: String(factor),
      BUN_TEST_TIMEOUT_METADATA: metadata,
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const status = await child.exited
  const endHost = await sampleHostLoad()
  try {
    const xml = await readFile(report, 'utf8')
    let deadlines: TestDeadline[] = []
    try {
      deadlines = (await readFile(metadata, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TestDeadline)
    } catch {
      // Collection failures can finish before any test is registered.
    }
    for (const line of classifyBunReport({ xml, deadlines, base, factor, host: endHost }))
      console.error(line)
  } catch (error) {
    console.error(`test-classification-unavailable reason=${JSON.stringify(String(error))}`)
  }
  return status
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await mkdtemp(join(tmpdir(), 'bun-test-classify-'))
  try {
    process.exitCode = await runBunTests({
      command: [process.execPath, ...process.argv.slice(2)],
      cwd: process.cwd(),
      env: process.env,
      results,
    })
  } finally {
    await rm(results, { recursive: true, force: true })
  }
}
