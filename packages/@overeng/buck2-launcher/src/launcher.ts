/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args, overeng/explicit-boolean-compare -- Public launcher data is documented as a wire contract; positional helpers preserve process and parser interfaces. */
/* oxlint-disable unicorn/no-array-sort -- The launcher deliberately targets ES2022; Array.prototype.toSorted requires ES2023. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { constants as osConstants, homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import {
  actionsSemanticallyComplete,
  countOutcomes,
  decodeReceipt,
  descriptorForClosureManifest,
  descriptorForFile,
  explainClosures,
  isSafePathComponent,
  materializationsSemanticallyComplete,
  normalizeActions,
  normalizeMaterialization,
  parseJsonLinesComplete,
  sanitizeEvidenceText,
  type BuckRunReceipt,
  type ClosureDigest,
} from './receipt.ts'

export interface ClosureManifestInput {
  readonly label: string
  readonly path: string
}

export interface LaunchOptions {
  readonly buckBinary: string
  readonly buckArgs: ReadonlyArray<string>
  readonly cwd: string
  readonly evidenceRoot?: string
  readonly closureManifests?: ReadonlyArray<ClosureManifestInput>
  readonly compareReceipt?: string
  readonly buckMachineVersion?: string
  readonly launcherRunId?: string
  readonly now?: () => Date
  readonly stderr?: NodeJS.WritableStream
}

export interface LaunchResult {
  readonly exitCode: number
  readonly receipt?: BuckRunReceipt
  readonly receiptPath?: string
  readonly receiptError?: string
}

const reservedEvidenceFlags = new Set([
  '--event-log',
  '--build-report',
  '--build-report-options',
  '--write-build-id',
])

export const assertNoReservedEvidenceFlags = (args: ReadonlyArray<string>): void => {
  const passthrough = args.indexOf('--')
  const buckOwnedArgs = passthrough === -1 ? args : args.slice(0, passthrough)
  const collision = buckOwnedArgs.find((arg) => reservedEvidenceFlags.has(arg.split('=')[0]!))
  if (collision !== undefined) {
    throw new Error(
      `${collision} is owned by buck2-launcher; use --evidence-dir or bypass the launcher and invoke Buck directly`,
    )
  }
}

const supportedCommands = new Set(['build', 'test', 'run', 'install'])
const globalOptionsWithValues = new Set([
  '--isolation-dir',
  '--verbose',
  '-v',
  '--oncall',
  '--client-metadata',
])

const buckCommand = (args: ReadonlyArray<string>): string | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--') return undefined
    const equals = arg.indexOf('=')
    const option = equals === -1 ? arg : arg.slice(0, equals)
    if (globalOptionsWithValues.has(option)) {
      if (equals === -1) index += 1
      continue
    }
    return arg
  }
  return undefined
}

export const assertSupportedCommand = (args: ReadonlyArray<string>): void => {
  const command = buckCommand(args)
  if (command === undefined || !supportedCommands.has(command)) {
    throw new Error(
      `Buck command ${command ?? '<missing>'} does not support build reports; bypass the launcher for non-build commands`,
    )
  }
}

const defaultEvidenceRoot = (): string =>
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'overeng',
    'buck2-launcher',
  )

const runChild = async ({
  binary,
  args,
  cwd,
  stdio,
}: {
  binary: string
  args: ReadonlyArray<string>
  cwd: string
  stdio: 'inherit' | 'capture'
}): Promise<{ exitCode: number; stdout: string }> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [...args], {
      cwd,
      env: process.env,
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    if (stdio === 'capture') {
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      // Buck prints a non-semantic "Showing ..." line here. Drain it but never put it in receipts.
      child.stderr?.resume()
    }
    child.once('error', reject)
    child.once('close', (code, signal) => {
      const signalNumber = signal === null ? undefined : osConstants.signals[signal]
      resolvePromise({
        exitCode: code ?? (signalNumber === undefined ? 1 : 128 + signalNumber),
        stdout,
      })
    })
  })

const readBuildReport = async (path: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const report = value as Record<string, unknown>
    if (
      typeof report.trace_id !== 'string' ||
      report.trace_id.length === 0 ||
      typeof report.success !== 'boolean' ||
      typeof report.results !== 'object' ||
      report.results === null ||
      Array.isArray(report.results)
    )
      return undefined
    return report
  } catch {
    return undefined
  }
}

const requestedTargetsFromReport = (report: Record<string, unknown> | undefined): Array<string> => {
  const results = report?.results
  if (typeof results !== 'object' || results === null) return []
  return Object.keys(results).map(sanitizeEvidenceText).sort()
}

const loadPreviousReceipt = async (
  path: string | undefined,
): Promise<BuckRunReceipt | undefined> => {
  if (path === undefined) return undefined
  try {
    return decodeReceipt(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return undefined
  }
}

const outputsFromReport = (
  report: Record<string, unknown> | undefined,
): Array<{ target: string; buckDigest: string }> => {
  const results = report?.results
  if (typeof results !== 'object' || results === null) return []
  const outputs: Array<{ target: string; buckDigest: string }> = []
  for (const [target, rawResult] of Object.entries(results)) {
    if (typeof rawResult !== 'object' || rawResult === null) continue
    const configured = (rawResult as Record<string, unknown>).configured
    if (typeof configured !== 'object' || configured === null) continue
    for (const rawConfigured of Object.values(configured)) {
      if (typeof rawConfigured !== 'object' || rawConfigured === null) continue
      const artifactInfo = (rawConfigured as Record<string, unknown>).artifact_info
      if (typeof artifactInfo !== 'object' || artifactInfo === null) continue
      for (const rawArtifact of Object.values(artifactInfo)) {
        if (typeof rawArtifact !== 'object' || rawArtifact === null) continue
        const digest = (rawArtifact as Record<string, unknown>).digest
        if (typeof digest === 'string' && digest.length > 0) {
          outputs.push({
            target: sanitizeEvidenceText(target),
            buckDigest: sanitizeEvidenceText(digest),
          })
        }
      }
    }
  }
  return outputs.sort((left, right) =>
    `${left.target}:${left.buckDigest}`.localeCompare(`${right.target}:${right.buckDigest}`),
  )
}

const sameOutputs = (
  current: ReadonlyArray<{ readonly target: string; readonly buckDigest: string }>,
  previous: ReadonlyArray<{ readonly target: string; readonly buckDigest: string }> | undefined,
): boolean =>
  current.length > 0 &&
  previous !== undefined &&
  current.length === previous.length &&
  current.every(
    (value, index) =>
      value.target === previous[index]?.target && value.buckDigest === previous[index]?.buckDigest,
  )

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

const withEvidenceFlags = (
  buckArgs: ReadonlyArray<string>,
  evidenceFlags: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const passthrough = buckArgs.indexOf('--')
  if (passthrough === -1) return [...buckArgs, ...evidenceFlags]
  return [...buckArgs.slice(0, passthrough), ...evidenceFlags, ...buckArgs.slice(passthrough)]
}

const prepareClosures = async (
  manifests: ReadonlyArray<ClosureManifestInput>,
): Promise<Array<ClosureDigest>> => {
  const seen = new Set<string>()
  for (const manifest of manifests) {
    if (seen.has(manifest.label))
      throw new Error(`duplicate closure manifest label: ${manifest.label}`)
    seen.add(manifest.label)
  }
  const closures = await Promise.all(
    manifests.map(async (manifest) => ({
      label: sanitizeEvidenceText(manifest.label),
      descriptor: await descriptorForClosureManifest(manifest.path, manifest.label),
    })),
  )
  return closures.sort((left, right) => left.label.localeCompare(right.label))
}

export const launchBuck = async (options: LaunchOptions): Promise<LaunchResult> => {
  assertNoReservedEvidenceFlags(options.buckArgs)
  assertSupportedCommand(options.buckArgs)
  const closures = await prepareClosures(options.closureManifests ?? [])
  const now = options.now ?? (() => new Date())
  const launcherRunId = options.launcherRunId ?? randomUUID()
  if (isSafePathComponent(launcherRunId) === false) {
    throw new Error('launcher run ID must be a safe path component')
  }
  const evidenceRoot = resolve(options.evidenceRoot ?? defaultEvidenceRoot())
  const runDir = resolve(evidenceRoot, launcherRunId)
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
  try {
    await mkdir(runDir, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`launcher run ID already exists: ${launcherRunId}`, { cause: error })
    }
    throw error
  }
  const eventLogPath = join(runDir, 'buck.eventlog.json-lines')
  const buildReportPath = join(runDir, 'buck.build-report.json')
  const buildIdPath = join(runDir, 'buck.build-id')
  const receiptPath = join(runDir, 'receipt.json')
  const instrumentedArgs = withEvidenceFlags(options.buckArgs, [
    '--event-log',
    eventLogPath,
    '--build-report',
    buildReportPath,
    '--build-report-options',
    'package-project-relative-paths,include-artifact-hash-information,truncate-error-content',
    '--write-build-id',
    buildIdPath,
  ])
  const started = now()
  const commandResult = await runChild({
    binary: options.buckBinary,
    args: instrumentedArgs,
    cwd: options.cwd,
    stdio: 'inherit',
  })
  const ended = now()

  try {
    const [
      whatRanQuery,
      materializedQuery,
      report,
      eventLogDescriptor,
      buildReportDescriptor,
      previous,
    ] = await Promise.all([
      runChild({
        binary: options.buckBinary,
        args: ['log', 'what-ran', '--format', 'json', '--emit-cache-queries', eventLogPath],
        cwd: options.cwd,
        stdio: 'capture',
      }),
      runChild({
        binary: options.buckBinary,
        args: ['log', 'what-materialized', '--format', 'json', eventLogPath],
        cwd: options.cwd,
        stdio: 'capture',
      }),
      readBuildReport(buildReportPath),
      descriptorForFile(eventLogPath, 'application/x-ndjson'),
      descriptorForFile(buildReportPath, 'application/json'),
      loadPreviousReceipt(options.compareReceipt),
    ])
    const whatRanParse = parseJsonLinesComplete(whatRanQuery.stdout)
    const materializedParse = parseJsonLinesComplete(materializedQuery.stdout)
    const actions = normalizeActions(whatRanParse.rows)
    const materialization = normalizeMaterialization(materializedParse.rows)
    const whatRanSemanticComplete = actionsSemanticallyComplete(whatRanParse.rows, actions)
    const materializedSemanticComplete = materializationsSemanticallyComplete(
      materializedParse.rows,
    )
    const whatRanObservation = {
      exitCode: whatRanQuery.exitCode,
      parseComplete: whatRanParse.complete,
      semanticComplete: whatRanSemanticComplete,
      records: whatRanParse.rows.length,
    }
    const materializedObservation = {
      exitCode: materializedQuery.exitCode,
      parseComplete: materializedParse.complete,
      semanticComplete: materializedSemanticComplete,
      records: materializedParse.rows.length,
    }
    const incompleteReasons = [
      ...(whatRanQuery.exitCode === 0 ? [] : ['what-ran-exit']),
      ...(whatRanParse.complete ? [] : ['what-ran-parse']),
      ...(whatRanSemanticComplete ? [] : ['what-ran-schema']),
      ...(materializedQuery.exitCode === 0 ? [] : ['materialized-exit']),
      ...(materializedParse.complete ? [] : ['materialized-parse']),
      ...(materializedSemanticComplete ? [] : ['materialized-schema']),
      ...(report === undefined ? ['build-report'] : []),
      ...(eventLogDescriptor === undefined ? ['event-log'] : []),
      ...(buildReportDescriptor === undefined ? ['build-report-file'] : []),
    ]
    const observationComplete = incompleteReasons.length === 0
    const previousTrusted = previous?.observation.complete === true ? previous : undefined
    const outputs = outputsFromReport(report)
    const success = commandResult.exitCode === 0
    const fallback = !observationComplete
      ? ('unknown' as const)
      : !success
        ? ('failed' as const)
        : actions.length === 0 &&
            materialization.records === 0 &&
            sameOutputs(outputs, previousTrusted?.outputs)
          ? ('dice_reuse' as const)
          : actions.length === 0 && materialization.records > 0
            ? ('materialized_only' as const)
            : actions.length === 0
              ? ('unknown' as const)
              : undefined
    let buckInvocationId: string | undefined
    try {
      buckInvocationId = (await readFile(buildIdPath, 'utf8')).trim() || undefined
    } catch {
      buckInvocationId = typeof report?.trace_id === 'string' ? report.trace_id : undefined
    }
    const outcomes = observationComplete ? countOutcomes(actions, fallback) : { unknown: 1 }
    if (!success) outcomes.failed = Math.max(outcomes.failed ?? 0, 1)
    const receipt = decodeReceipt({
      schema: 'buck-run-receipt/v1',
      launcherRunId,
      ...(buckInvocationId === undefined ? {} : { buckInvocationId }),
      command: {
        kind: sanitizeEvidenceText(buckCommand(options.buckArgs) ?? 'unknown'),
        requestedTargets: requestedTargetsFromReport(report),
      },
      status: {
        exitCode: commandResult.exitCode,
        success,
        ...(typeof report?.error_category === 'string'
          ? { errorCategory: sanitizeEvidenceText(report.error_category) }
          : {}),
      },
      timing: {
        startedAt: started.toISOString(),
        endedAt: ended.toISOString(),
        durationMs: Math.max(0, ended.getTime() - started.getTime()),
      },
      buck:
        options.buckMachineVersion === undefined
          ? {}
          : { machineVersion: sanitizeEvidenceText(options.buckMachineVersion) },
      evidence: {
        ...(eventLogDescriptor === undefined ? {} : { eventLog: eventLogDescriptor }),
        ...(buildReportDescriptor === undefined ? {} : { buildReport: buildReportDescriptor }),
      },
      observation: {
        complete: observationComplete,
        verdict: observationComplete ? 'complete' : 'incomplete',
        reasons: incompleteReasons,
        whatRan: whatRanObservation,
        materialized: materializedObservation,
      },
      outputs,
      closures,
      actions,
      outcomes,
      materialization,
      explanation: explainClosures(
        closures,
        previousTrusted?.closures,
        actions.length,
        observationComplete,
      ),
    })
    await writeJsonAtomic(receiptPath, receipt)
    return { exitCode: commandResult.exitCode, receipt, receiptPath }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.stderr?.write(`buck2-launcher: WARNING receipt generation failed: ${message}\n`)
    return { exitCode: commandResult.exitCode, receiptError: message }
  }
}

export const quoteCommand = (binary: string, args: ReadonlyArray<string>): string =>
  [binary, ...args]
    .map((part) =>
      /^[A-Za-z0-9_./:@%+=,-]+$/u.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`,
    )
    .join(' ')

export const evidenceRunLabel = (receiptPath: string): string =>
  basename(resolve(receiptPath, '..'))
