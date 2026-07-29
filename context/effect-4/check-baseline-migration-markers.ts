#!/usr/bin/env bun

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
    registerEntry: 'cli-A-nested-terminator-loss',
    regex: /\bargs\s*:\s*\[\s*["']add["']\s*,\s*["']--["']/g,
    why: 'Effect 4 drops operands after -- for the nested megarepo add command.',
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
    registerEntry: 'layer-memoization-freshness-opt-outs',
    regex: /\bLayer\.fresh\b/g,
    why: 'Layer.fresh explicitly opts out of shared layer memoization.',
  },
  {
    registerEntry: 'layer-memoization-freshness-opt-outs',
    regex: /\bEffect\.provide\([\s\S]{0,300}\blocal\s*:\s*true\b/g,
    why: 'A local provide creates an isolated memoization scope.',
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

/**
 * Register entries whose risks have no reliable textual fingerprint in a
 * baseline. Each exception must explain why a signature would be misleading.
 */
const noSignatures = [
  {
    registerEntry: 'cli-B-accepted-grammar-improvements',
    noSignature:
      'Four unrelated grammar forms are accepted; each contract needs its own case-specific signature.',
  },
  {
    registerEntry: 'cli-C-rendering-and-stdout-breakage',
    noSignature:
      'CLI-owned prose and ANSI bytes are intentionally varied and cannot use one safe signature.',
  },
  {
    registerEntry: 'fork-defaults',
    noSignature:
      'The identical default scheduling behavior has no changed baseline text to detect.',
  },
  {
    registerEntry: 'equality-structural-default',
    noSignature:
      'Structural equality depends on runtime value types, and the register audit found no production Effect equality site.',
  },
  {
    registerEntry: 'effect-never-idle-timer',
    noSignature:
      'Process liveness is a runtime side effect; Effect.never is also used as unrelated test-only suspension control, with no production liveness site.',
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

type ContractionMarker = {
  readonly bridgeId: string
  readonly file: string
  readonly kind: 'BRIDGE' | 'END' | 'TARGET' | 'TODO'
  readonly line: number
}

const rootArgumentIndex = process.argv.indexOf('--root')
const root =
  rootArgumentIndex === -1
    ? process.cwd()
    : resolve(process.argv[rootArgumentIndex + 1] ?? process.cwd())

const liveMigrationName = ['LIVE', 'MIGRATION'].join('-')
const todoMigrationName = ['TODO(', 'live-migration:'].join('')
const todoMigrationPattern = ['TODO\\(', 'live-migration:'].join('')
const blockMarkerPattern = new RegExp(
  `${liveMigrationName}\\s+(BRIDGE|TARGET|END)(?:\\s+([a-z0-9][a-z0-9._-]*))?`,
  'gi',
)
const todoMarkerPattern = new RegExp(`${todoMigrationPattern}([a-z0-9][a-z0-9._-]*)?\\)`, 'gi')

/**
 * Ignore only the three permanent grammar-definition sites. File plus line
 * shape keeps the exception narrow: any executable marker elsewhere in either
 * context file is still a contraction survivor.
 */
const isContractionDefinitionSite = ({
  file,
  sourceLine,
}: {
  readonly file: string
  readonly sourceLine: string
}) => {
  if (
    file === 'context/effect-4/check-baseline-migration-markers.ts' &&
    sourceLine.trimStart().startsWith('const marker = ') === true
  ) {
    return true
  }

  if (file !== 'context/effect-4/baseline-operations.md') return false

  return (
    sourceLine.includes(`carry no \`${liveMigrationName} BRIDGE\` block`) ||
    sourceLine.trimStart().startsWith(`\`${todoMigrationName}`)
  )
}

const repositoryFiles = async () => {
  const gitProcess = Bun.spawn(
    ['git', '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )
  const [exitCode, stderr, stdout] = await Promise.all([
    gitProcess.exited,
    new Response(gitProcess.stderr).text(),
    new Response(gitProcess.stdout).text(),
  ])

  if (exitCode !== 0) {
    console.error(`FAIL: cannot enumerate repository files for contraction sweep: ${stderr.trim()}`)
    process.exit(1)
  }

  return [...new Set(stdout.split('\0').filter((file) => file.length > 0))].toSorted(
    (left, right) => left.localeCompare(right),
  )
}

const runProcess = async ({
  command,
  cwd,
}: {
  readonly command: readonly string[]
  readonly cwd: string
}) => {
  const child = Bun.spawn(command, {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])

  return { exitCode, stderr, stdout }
}

const writeContractionFixture = async ({
  fixtureRoot,
  includeSurvivors,
}: {
  readonly fixtureRoot: string
  readonly includeSurvivors: boolean
}) => {
  const contextRoot = resolve(fixtureRoot, 'context/effect-4')
  await mkdir(contextRoot, { recursive: true })
  await Bun.write(
    resolve(contextRoot, 'check-baseline-migration-markers.ts'),
    `const marker = '${todoMigrationName}effect-3-4)'\n`,
  )
  await Bun.write(
    resolve(contextRoot, 'baseline-operations.md'),
    [
      `Baseline files carry no \`${liveMigrationName} BRIDGE\` block after contraction.`,
      `\`${todoMigrationName}<bridge-id>)\` identifies a migration assertion.`,
      '',
    ].join('\n'),
  )

  if (includeSurvivors === true) {
    await mkdir(resolve(fixtureRoot, 'src'), { recursive: true })
    await Bun.write(
      resolve(fixtureRoot, 'src/survivors.ts'),
      [
        `// ${liveMigrationName} BRIDGE fixture-bridge`,
        `// ${todoMigrationName}fixture-todo): resolve the retained assertion`,
        '',
      ].join('\n'),
    )
  }

  const initialized = await runProcess({
    command: ['git', 'init', '--quiet'],
    cwd: fixtureRoot,
  })
  const added = await runProcess({
    command: ['git', 'add', '--all'],
    cwd: fixtureRoot,
  })
  if (initialized.exitCode !== 0 || added.exitCode !== 0) {
    const detail = [initialized.stderr, added.stderr].join('').trim()
    throw new Error(`cannot initialize contraction fixture repository: ${detail}`)
  }
}

const runContractionFixtureCheck = async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'effect4-contraction-fixtures-'))
  const definitionOnlyRoot = resolve(fixtureRoot, 'definition-only')
  const survivorRoot = resolve(fixtureRoot, 'survivors')
  let failure: string | undefined

  try {
    await Promise.all([
      writeContractionFixture({ fixtureRoot: definitionOnlyRoot, includeSurvivors: false }),
      writeContractionFixture({ fixtureRoot: survivorRoot, includeSurvivors: true }),
    ])

    const [definitionOnly, survivors] = await Promise.all([
      runProcess({
        command: [
          process.execPath,
          import.meta.path,
          '--contraction',
          '--root',
          definitionOnlyRoot,
        ],
        cwd: root,
      }),
      runProcess({
        command: [process.execPath, import.meta.path, '--contraction', '--root', survivorRoot],
        cwd: root,
      }),
    ])
    const expectedDefinitionOnly =
      'PASS: contraction sweep found no live migration markers (3 permanent grammar definitions excluded).\n'
    const expectedSurvivors = [
      'src/survivors.ts:1 DELETE BLOCK (BRIDGE) fixture-bridge',
      'src/survivors.ts:2 RESOLVE TODO fixture-todo',
      'FAIL: contraction blocked by 2 markers across 1 files: 1 BRIDGE blocks (1 block marker lines) to delete, 1 TODO markers to resolve; 3 permanent grammar definitions excluded.',
      '',
    ].join('\n')

    if (
      definitionOnly.exitCode !== 0 ||
      definitionOnly.stdout !== expectedDefinitionOnly ||
      definitionOnly.stderr !== ''
    ) {
      failure = [
        'FAIL: contraction definition-only fixture did not pass with the expected report.',
        `exit: ${definitionOnly.exitCode}`,
        `stdout: ${JSON.stringify(definitionOnly.stdout)}`,
        `stderr: ${JSON.stringify(definitionOnly.stderr)}`,
      ].join('\n')
    } else if (
      survivors.exitCode !== 1 ||
      survivors.stdout !== '' ||
      survivors.stderr !== expectedSurvivors
    ) {
      failure = [
        'FAIL: contraction survivor fixture did not fail with the expected report.',
        `exit: ${survivors.exitCode}`,
        `stdout: ${JSON.stringify(survivors.stdout)}`,
        `stderr: ${JSON.stringify(survivors.stderr)}`,
      ].join('\n')
    }
  } catch (error) {
    failure = `FAIL: contraction fixture lane could not run: ${String(error)}`
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true })
  }

  if (failure !== undefined) {
    console.error(failure)
    return false
  }

  console.log(
    'PASS: contraction fixtures cover definition exclusions and actionable survivor reporting.',
  )
  return true
}

const runContractionCheck = async () => {
  const markers: ContractionMarker[] = []
  let definitionMarkers = 0
  const fileEntries = await Promise.all(
    (await repositoryFiles()).map(
      async (file) => [file, await Bun.file(resolve(root, file)).text()] as const,
    ),
  )

  for (const [file, source] of fileEntries) {
    for (const [lineIndex, sourceLine] of source.split('\n').entries()) {
      const blockMatches = [...sourceLine.matchAll(blockMarkerPattern)]
      const todoMatches = [...sourceLine.matchAll(todoMarkerPattern)]

      if (isContractionDefinitionSite({ file, sourceLine }) === true) {
        definitionMarkers++
        continue
      }

      for (const match of blockMatches) {
        markers.push({
          bridgeId: match[2] ?? '<missing-id>',
          file,
          kind: match[1]!.toUpperCase() as 'BRIDGE' | 'END' | 'TARGET',
          line: lineIndex + 1,
        })
      }
      for (const match of todoMatches) {
        markers.push({
          bridgeId: match[1] ?? '<missing-id>',
          file,
          kind: 'TODO',
          line: lineIndex + 1,
        })
      }
    }
  }

  markers.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.kind.localeCompare(right.kind),
  )

  if (markers.length === 0) {
    console.log(
      `PASS: contraction sweep found no live migration markers (${definitionMarkers} permanent grammar definitions excluded).`,
    )
    return
  }

  for (const survivor of markers) {
    const action = survivor.kind === 'TODO' ? 'RESOLVE TODO' : `DELETE BLOCK (${survivor.kind})`
    console.error(`${survivor.file}:${survivor.line} ${action} ${survivor.bridgeId}`)
  }

  const fileCount = new Set(markers.map(({ file }) => file)).size
  const bridgeBlockCount = markers.filter(({ kind }) => kind === 'BRIDGE').length
  const blockMarkerCount = markers.filter(({ kind }) => kind !== 'TODO').length
  const todoCount = markers.length - blockMarkerCount
  console.error(
    `FAIL: contraction blocked by ${markers.length} markers across ${fileCount} files: ${bridgeBlockCount} BRIDGE blocks (${blockMarkerCount} block marker lines) to delete, ${todoCount} TODO markers to resolve; ${definitionMarkers} permanent grammar definitions excluded.`,
  )
  process.exitCode = 1
}

if (process.argv.includes('--contraction') === true) {
  await runContractionCheck()
  process.exit(process.exitCode ?? 0)
}

if ((await runContractionFixtureCheck()) === false) process.exit(1)

const registerFile = 'context/effect-4/alignment-register.md'
let registerSource: string

try {
  registerSource = await Bun.file(resolve(root, registerFile)).text()
} catch (error) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
  console.error(`FAIL: cannot read ${registerFile} (${code}).`)
  process.exit(1)
}

const registerEntries = new Set(
  [...registerSource.matchAll(/^## ([a-z0-9][a-zA-Z0-9-]*)\s*$/gm)].map((match) => match[1]!),
)
const signatureEntries = new Set(riskSignatures.map(({ registerEntry }) => registerEntry))
const noSignatureEntries = new Set(noSignatures.map(({ registerEntry }) => registerEntry))
const declaredEntries = new Set([...signatureEntries, ...noSignatureEntries])

const unmappedEntries = [...registerEntries]
  .filter((entry) => declaredEntries.has(entry) === false)
  .toSorted()
const missingRegisterEntries = [...declaredEntries]
  .filter((entry) => registerEntries.has(entry) === false)
  .toSorted()
const conflictingEntries = [...signatureEntries]
  .filter((entry) => noSignatureEntries.has(entry))
  .toSorted()

if (
  unmappedEntries.length > 0 ||
  missingRegisterEntries.length > 0 ||
  conflictingEntries.length > 0
) {
  for (const entry of unmappedEntries) {
    console.error(
      `UNMAPPED: register entry "${entry}" needs a risk signature or justified noSignature declaration.`,
    )
  }
  for (const entry of missingRegisterEntries) {
    console.error(`STALE: checker declaration references missing register entry "${entry}".`)
  }
  for (const entry of conflictingEntries) {
    console.error(`CONFLICT: register entry "${entry}" has both a signature and noSignature.`)
  }
  console.error('FAIL: alignment register and marker checker declarations are inconsistent.')
  process.exit(1)
}

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
    let openingOffset = source.indexOf('(', match.index)
    let end = findMatchingDelimiter({ source, openingOffset, opening: '(', closing: ')' })
    if (end === undefined) continue

    let titleOffset = openingOffset + 1
    while (/\s/.test(source[titleOffset] ?? '') === true) titleOffset++
    let title = readStaticString({ source, offset: titleOffset })

    if (title === undefined && callName === 'test' && match[0].includes('.each') === true) {
      openingOffset = end
      while (/\s/.test(source[openingOffset] ?? '') === true) openingOffset++
      if (source[openingOffset] !== '(') continue

      end = findMatchingDelimiter({ source, openingOffset, opening: '(', closing: ')' })
      if (end === undefined) continue

      titleOffset = openingOffset + 1
      while (/\s/.test(source[titleOffset] ?? '') === true) titleOffset++
      title = readStaticString({ source, offset: titleOffset })
    }

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
