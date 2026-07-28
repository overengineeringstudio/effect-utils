#!/usr/bin/env bun

import { resolve } from 'node:path'

const marker = 'TODO(live-migration:effect-3-4)'

/**
 * Auditable fingerprints of baseline bytes or assertions whose Effect 3 shape
 * is called out by the alignment register. Keep these expressions narrow:
 * this checker points at migration decisions, not every use of the API.
 */
const riskSignatures = [
  {
    registerEntry: 'schema-date',
    regex: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/g,
    why: 'ISO-8601 wire strings can be affected by the Schema.Date reassignment.',
  },
  {
    registerEntry: 'schema-date',
    regex: /\b\d{4}-02-(?:30|31)\b/g,
    why: 'Impossible date strings exercise the tightened date-validation boundary.',
  },
  {
    registerEntry: 'schema-date-invalid-message',
    regex: /Expected [^\r\n]+, actual [^\r\n]+/g,
    why: 'Effect 3 parse-tree text changes to SchemaError(...) rendering in Effect 4.',
  },
  {
    registerEntry: 'platform-error-wrapper',
    regex: /["'](?:_tag["']\s*:\s*["'])?SystemError["']/g,
    why: 'Effect 4 changes the outer platform error tag to PlatformError.',
  },
  {
    registerEntry: 'http-client-status-error-wrapper',
    regex: /["']ResponseError["']|["']StatusCode["']/g,
    why: 'Effect 4 changes the rejected-status wrapper and reason shape.',
  },
  {
    registerEntry: 'fork-copied-options',
    regex: /\b(?:startImmediately|uninterruptible)\b/g,
    why: 'Copied fork options change scheduling and must have a local justification.',
  },
  {
    registerEntry: 'equality-nan',
    regex: /\bEqual\.equals\(\s*NaN\s*,\s*NaN\s*\)/g,
    why: 'Effect 4 changes Effect equality for NaN.',
  },
  {
    registerEntry: 'equality-by-reference-opt-out',
    regex: /\bEqual\.byReference(?:Unsafe)?\b/g,
    why: 'The Effect 4 identity-equality opt-out changes object identity.',
  },
  {
    registerEntry: 'layer-memoization-default',
    regex: /\b(?:build|construction|acquisition)Count\b[^\r\n]*\.(?:toBe|toEqual)\(\s*\d+\s*\)/g,
    why: 'Construction-count assertions can change under Effect 4 layer memoization.',
  },
  {
    registerEntry: 'rpc-failure-cause-wire-shape',
    regex: /(?:\\+)?"cause(?:\\+)?"\s*:\s*(?:\\+)?\{/g,
    why: 'Effect 3 encodes RPC failure cause as an object; Effect 4 uses an array.',
  },
  {
    registerEntry: 'browser-testing-barrel',
    regex: /["']node:assert(?:\/strict)?["']/g,
    why: 'The Effect 4 testing barrel can leak node:assert into browser bundles.',
  },
  {
    registerEntry: 'filesystem-watch-recursive-option-removed',
    regex: /\bwatch\([\s\S]{0,300}\brecursive\s*:\s*(?:false|true)\b/g,
    why: 'Effect 4 removes recursive watch control and widens Node watch scope.',
  },
  {
    registerEntry: 'prompt-pty-ansi-rendering',
    regex: /(?:\\u001b|\\x1b|\\x1B)\[[0-9;?]*[ -/]*[@-~]/g,
    why: 'Effect 4 Prompt changes exact PTY ANSI rendering bytes.',
  },
] as const

type CallBlock = {
  readonly end: number
  readonly leadingStart: number
  readonly start: number
  readonly title: string
}

type Finding = {
  readonly column: number
  readonly file: string
  readonly line: number
  readonly registerEntry: string
  readonly testTitle: string | undefined
  readonly why: string
}

const rootArgumentIndex = process.argv.indexOf('--root')
const root =
  rootArgumentIndex === -1
    ? process.cwd()
    : resolve(process.argv[rootArgumentIndex + 1] ?? process.cwd())

const lineAndColumnAt = ({
  source,
  offset,
}: {
  readonly source: string
  readonly offset: number
}) => {
  const before = source.slice(0, offset)
  const lines = before.split('\n')
  return {
    column: (lines.at(-1)?.length ?? 0) + 1,
    line: lines.length,
  }
}

const findMatchingDelimiter = ({
  source,
  openingOffset,
  opening,
  closing,
}: {
  readonly source: string
  readonly openingOffset: number
  readonly opening: string
  readonly closing: string
}) => {
  let depth = 0
  let quote: '"' | "'" | '`' | undefined
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = openingOffset; index < source.length; index++) {
    const character = source[index]
    const next = source[index + 1]

    if (lineComment === true) {
      if (character === '\n') lineComment = false
      continue
    }
    if (blockComment === true) {
      if (character === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote !== undefined) {
      if (escaped === true) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = undefined
      }
      continue
    }
    if (character === '/' && next === '/') {
      lineComment = true
      index++
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === opening) depth++
    if (character === closing) {
      depth--
      if (depth === 0) return index + 1
    }
  }

  return undefined
}

const readStaticString = ({
  source,
  offset,
}: {
  readonly source: string
  readonly offset: number
}) => {
  const quote = source[offset]
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined

  let escaped = false
  for (let index = offset + 1; index < source.length; index++) {
    const character = source[index]
    if (escaped === true) {
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === quote) {
      return {
        end: index + 1,
        value: source.slice(offset + 1, index),
      }
    }
  }

  return undefined
}

const attachedCommentStart = ({
  source,
  callStart,
}: {
  readonly source: string
  readonly callStart: number
}) => {
  const lineStart = source.lastIndexOf('\n', callStart - 1) + 1
  const previousLineEnd = lineStart - 1
  if (previousLineEnd < 0) return callStart

  const previousLineStart = source.lastIndexOf('\n', previousLineEnd - 1) + 1
  const previousLine = source.slice(previousLineStart, previousLineEnd).trim()
  return previousLine.startsWith('//') === true ? previousLineStart : callStart
}

const findCalls = ({
  source,
  callName,
}: {
  readonly source: string
  readonly callName: 'describe' | 'test'
}) => {
  const namePattern =
    callName === 'describe'
      ? /(?:^|[^\w$])(?:[A-Za-z_$][\w$]*\.)?describe(?:\.\w+)*\s*\(/g
      : /(?:^|[^\w$])(?:(?:[A-Za-z_$][\w$]*\.)?(?:it|test))(?:\.\w+)*\s*\(/g
  const calls: CallBlock[] = []

  for (const match of source.matchAll(namePattern)) {
    const openingOffset = source.indexOf('(', match.index)
    const end = findMatchingDelimiter({ source, openingOffset, opening: '(', closing: ')' })
    if (end === undefined) continue

    let titleOffset = openingOffset + 1
    while (/\s/.test(source[titleOffset] ?? '') === true) titleOffset++
    const title = readStaticString({ source, offset: titleOffset })
    if (title === undefined || title.value.includes('${') === true) continue

    const start = match.index + (match[0].match(/^[^\w$]/)?.[0].length ?? 0)
    calls.push({
      end,
      leadingStart: attachedCommentStart({ source, callStart: start }),
      start,
      title: title.value,
    })
  }

  return calls
}

const hasMarker = ({ source, test }: { readonly source: string; readonly test: CallBlock }) =>
  source.slice(test.leadingStart, test.end).includes(marker)

const baselineTestsIn = (source: string) => {
  const baselineDescribes = findCalls({ source, callName: 'describe' }).filter((block) =>
    /(?:baseline|cross-major)/i.test(block.title),
  )
  const tests = findCalls({ source, callName: 'test' })

  return tests.filter((test) =>
    baselineDescribes.some((describe) => test.start > describe.start && test.end < describe.end),
  )
}

const collectSignatureFindings = ({
  file,
  source,
  test,
}: {
  readonly file: string
  readonly source: string
  readonly test: CallBlock | undefined
}) => {
  if (test !== undefined && hasMarker({ source, test }) === true) return []

  const findings: Finding[] = []
  const searchable = test === undefined ? source : source.slice(test.start, test.end)
  const searchableOffset = test === undefined ? 0 : test.start

  for (const signature of riskSignatures) {
    for (const match of searchable.matchAll(signature.regex)) {
      const offset = searchableOffset + match.index
      const location = lineAndColumnAt({ source, offset })
      findings.push({
        ...location,
        file,
        registerEntry: signature.registerEntry,
        testTitle: test?.title,
        why: signature.why,
      })
    }
  }

  return findings
}

const testGlobs = [
  'packages/@overeng/**/*.test.ts',
  'packages/@overeng/**/*.test.tsx',
  'packages/@overeng/**/*.spec.ts',
  'packages/@overeng/**/*.spec.tsx',
] as const

const testFiles = (
  await Promise.all(
    testGlobs.map(async (pattern) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root }))),
  )
)
  .flat()
  .toSorted()

const baselineFileEntries = await Promise.all(
  testFiles.map(async (file) => {
    const source = await Bun.file(resolve(root, file)).text()
    return [file, { source, tests: baselineTestsIn(source) }] as const
  }),
)

const baselineFiles = new Map<
  string,
  {
    readonly source: string
    readonly tests: readonly CallBlock[]
  }
>(baselineFileEntries.filter(([, baseline]) => baseline.tests.length > 0))

const findings: Finding[] = []

for (const [file, baseline] of baselineFiles) {
  for (const test of baseline.tests) {
    findings.push(
      ...collectSignatureFindings({
        file,
        source: baseline.source,
        test,
      }),
    )
  }
}

const snapshotFiles = await Array.fromAsync(
  new Bun.Glob('packages/@overeng/**/__snapshots__/*.snap').scan({ cwd: root }),
)
const snapshotFileEntries = await Promise.all(
  snapshotFiles.map(async (file) => [file, await Bun.file(resolve(root, file)).text()] as const),
)

for (const [file, source] of snapshotFileEntries) {
  const testFileName = file.replace('/__snapshots__/', '/').replace(/\.snap$/, '')
  const baseline = baselineFiles.get(testFileName)
  if (baseline === undefined) continue

  const entryStarts = [...source.matchAll(/^exports\[`/gm)].map((match) => match.index)
  for (const [entryIndex, entryStart] of entryStarts.entries()) {
    const entryEnd = entryStarts[entryIndex + 1] ?? source.length
    const entry = source.slice(entryStart, entryEnd)
    const key = readStaticString({ source: entry, offset: entry.indexOf('`') })
    if (key === undefined) continue

    const test = baseline.tests.find((candidate) => key.value.includes(` > ${candidate.title} `))
    if (test === undefined) continue
    if (hasMarker({ source: baseline.source, test }) === true) continue

    for (const signature of riskSignatures) {
      for (const match of entry.matchAll(signature.regex)) {
        const offset = entryStart + match.index
        const location = lineAndColumnAt({ source, offset })
        findings.push({
          ...location,
          file,
          registerEntry: signature.registerEntry,
          testTitle: test.title,
          why: signature.why,
        })
      }
    }
  }
}

findings.sort(
  (left, right) =>
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    left.registerEntry.localeCompare(right.registerEntry),
)

if (findings.length === 0) {
  console.log(
    `PASS: ${baselineFiles.size} baseline test files contain no unmarked Effect 3 -> 4 risk signatures.`,
  )
} else {
  for (const finding of findings) {
    const testSuffix = finding.testTitle === undefined ? '' : ` [${finding.testTitle}]`
    console.error(
      `${finding.file}:${finding.line}:${finding.column} ${finding.registerEntry}${testSuffix} - ${finding.why}`,
    )
  }
  console.error(
    `FAIL: ${findings.length} unmarked risk signature matches across ${baselineFiles.size} baseline test files.`,
  )
  process.exitCode = 1
}
