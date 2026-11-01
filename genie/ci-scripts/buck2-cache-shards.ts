import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { decodeActionArtifact } from './buck2-action-evidence-codec.ts'
import type { ActionRecord, CacheReadPolicy } from './buck2-action-evidence.ts'
import {
  actionExclusionReasons,
  countActionExclusions,
  maxActionArtifactBytes,
} from './buck2-action-evidence.ts'
import {
  cacheEvidenceOutcomes,
  createCacheEvidenceProjector,
  decodeCacheEvidence,
  emptyActionArtifact,
  emptyCacheEvidence,
  mergeCacheEvidence,
} from './buck2-cache-evidence.ts'

// Pinned 2026-09-01: CommonEventLogOptions.event_log is an extra, nonrotating
// writer (buck2_event_log/src/write.rs). utils.rs selects JSON with .json-lines.
// The launcher supplies a private FIFO: raw argv/env/path events never reach disk.
export const maxShardBytes = 32 * 1024 * 1024
export const maxNativeEventBytes = 4 * 1024 * 1024
export const maxNativeStreamBytes = 512 * 1024 * 1024
export const maxNativeInvocations = 4096
export const maxJobShardBytes = 64 * 1024 * 1024
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const shardBudgetUnit = 64 * 1024
const atomic = async ({ path, bytes }: { path: string; bytes: string }): Promise<void> => {
  const temporary = `${path}.${process.pid}.pending`
  await Bun.write(temporary, bytes, { mode: 0o600 })
  await rename(temporary, path)
}

export const registerNativeShard = async ({
  output,
  buildId,
}: {
  output: string
  buildId: string
}): Promise<string> => {
  if (idPattern.test(buildId) === false) throw new Error('Invalid native build ID')
  const directory = `${output}.native-build-ids`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${buildId}.buck-trace-id`)
  let priorMtimeMs: number | null = null
  try {
    priorMtimeMs = (await stat(path)).mtimeMs
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  await appendFile(
    `${output}.native-build-id-paths.jsonl`,
    `${JSON.stringify({ buildId, path, startedAt: Date.now(), priorMtimeMs })}\n`,
    { mode: 0o600 },
  )
  return path
}

export const writeNativeShard = async ({
  output,
  events,
  buildId,
  freshRoot = false,
  rootId,
  context = 'native-log',
  cacheReadPolicy = 'unknown',
  exitCode,
  onReady,
}: {
  output: string
  events: string
  buildId: string
  freshRoot?: boolean
  rootId?: string
  context?: string
  cacheReadPolicy?: CacheReadPolicy
  exitCode?: number
  onReady?: () => void
}): Promise<void> => {
  if (idPattern.test(buildId) === false) throw new Error('Invalid shard build ID')
  if (rootId !== undefined && /^[a-f0-9]{64}$/.test(rootId) === false)
    throw new Error('Invalid root scope')
  if (/^[a-zA-Z0-9_.:-]{1,96}$/.test(context) === false) throw new Error('Invalid shard context')
  const directory = `${output}.shards`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (exitCode !== undefined) {
    if (Number.isSafeInteger(exitCode) === false || exitCode < 0)
      throw new Error('Invalid native exit code')
    await atomic({
      path: `${output}.native-build-ids/${buildId}.exit.json`,
      bytes: `${JSON.stringify({ buildId, exitCode, finishedAt: Date.now() })}\n`,
    })
  }
  const artifact = emptyActionArtifact('collected')
  let bytes = 0
  let streamBytes = 0
  let overflow = false
  let invalid = false
  const projector = createCacheEvidenceProjector({
    context,
    freshRoot,
    rootId,
    cacheReadPolicy,
    onAction: (row: ActionRecord) => {
      const size = Buffer.byteLength(JSON.stringify(row)) + 1
      if (bytes + size > maxShardBytes / 2) overflow = true
      else {
        bytes += size
        artifact.actions.push(row)
      }
    },
    onInvocation: (invocation) => artifact.header.invocations.push(invocation),
  })
  // Bound the unfinished line too; readline would allocate an arbitrarily long event.
  let pending = ''
  const stream = createReadStream(events, { encoding: 'utf8', highWaterMark: 64 * 1024 })
  await once(stream, 'open')
  onReady?.()
  for await (const chunk of stream) {
    streamBytes += Buffer.byteLength(chunk)
    if (streamBytes > maxNativeStreamBytes) {
      overflow = true
      continue
    }
    if (invalid === true || overflow === true) continue
    pending += chunk
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (Buffer.byteLength(line) > maxNativeEventBytes) {
        overflow = true
        break
      }
      if (line.trim() === '') continue
      try {
        projector.add(JSON.parse(line))
      } catch {
        invalid = true
        break
      }
    }
    if (Buffer.byteLength(pending) > maxNativeEventBytes) {
      overflow = true
      pending = ''
    }
  }
  if (pending.length !== 0) invalid = true // Truncated final JSON is never accepted.
  const summary = projector.finish()
  const invocation = artifact.header.invocations[0]
  if (summary.invocations[0]?.buildId !== buildId) throw new Error('Unexpected native build ID')
  const gaps: string[] = []
  if (invalid === true) gaps.push('invalid-native-json')
  if (overflow === true) gaps.push('native-shard-size-limit')
  if (invocation?.buildId !== buildId) gaps.push('native-shard-build-id-mismatch')
  if (invocation?.complete !== true) gaps.push('incomplete-native-invocation')
  artifact.header.actionCount = summary.actionCount
  artifact.header.rows = artifact.actions.length
  artifact.header.excludedByDesign = countActionExclusions(artifact.actions)
  artifact.header.droppedActionCount = summary.actionCount - artifact.actions.length
  artifact.header.missingDigestCount = artifact.actions.filter((row) => row.digest === null).length
  artifact.header.missingIdentityCount = artifact.actions.filter(
    (row) =>
      row.category === null ||
      row.target === null ||
      row.configuration === null ||
      row.buildId === null,
  ).length
  artifact.header.missingTimestampCount = artifact.actions.filter(
    (row) =>
      row.startedAt === null ||
      row.completedAt === null ||
      (row.cacheUploadResult === 1 && row.uploadCompletedAt === null),
  ).length
  artifact.header.evidenceGaps = gaps
  const raw = `${JSON.stringify(artifact.header)}\n${artifact.actions.map((row) => JSON.stringify(row)).join('\n')}${artifact.actions.length > 0 ? '\n' : ''}`
  const body =
    JSON.stringify({
      schemaVersion: 1,
      buildId,
      complete: gaps.length === 0,
      summary,
      artifact: raw,
    }) + '\n'
  if (Buffer.byteLength(body) > maxShardBytes) throw new Error('Shard size limit')
  // Atomic mkdir reservations serialize only byte ownership, never commands.
  // Crashed reservations stay spent: failure must not overcommit the job budget.
  const budget = `${output}.shard-budget`
  await mkdir(budget, { recursive: true, mode: 0o700 })
  let reserved = 0
  const required = Math.ceil(Buffer.byteLength(body) / shardBudgetUnit)
  for (let slot = 0; slot < maxJobShardBytes / shardBudgetUnit && reserved < required; slot++) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Serial atomic reservations stop at the exact byte budget.
      await mkdir(join(budget, String(slot)))
      reserved++
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    }
  }
  if (reserved !== required) {
    await Bun.write(`${output}.shard-budget-exhausted`, '1\n', { mode: 0o600 })
    throw new Error('Job shard budget exhausted')
  }
  await atomic({ path: join(directory, `${buildId}.json`), bytes: body })
}

export const reconcileNativeShards = async ({ output }: { output: string }) => {
  let summary = emptyCacheEvidence()
  const artifact = emptyActionArtifact('collected')
  const evidenceGaps: string[] = []
  if ((await Bun.file(`${output}.shard-budget-exhausted`).exists()) === true)
    evidenceGaps.push('native-shard-job-size-limit')
  const expected = new Set<string>()
  const observed = new Set<string>()
  const commands: {
    buildId: string
    startedAt: number
    finishedAt: number | null
    exitCode: number | null
  }[] = []
  let totalShardBytes = 0
  let actionBytes = 0
  const shards: {
    buildId: string
    name: string
    sha256: string
    bytes: number
    rows: number
    complete: boolean
  }[] = []
  try {
    const registry = Bun.file(`${output}.native-build-id-paths.jsonl`)
    if (registry.size > maxNativeInvocations * 8192) throw new Error('Registry overflow')
    for (const line of (await registry.text()).split('\n')) {
      if (line === '') continue
      const row = JSON.parse(line)
      if (
        typeof row.buildId !== 'string' ||
        idPattern.test(row.buildId) === false ||
        typeof row.path !== 'string' ||
        expected.has(row.buildId) === true
      )
        throw new Error('Invalid registry')
      if (expected.size >= maxNativeInvocations) {
        evidenceGaps.push('native-invocation-count-limit')
        throw new Error('Registry overflow')
      }
      expected.add(row.buildId)
      if (Number.isSafeInteger(row.startedAt) === false || row.startedAt < 0)
        throw new Error('Invalid launch time')
      const command: {
        buildId: string
        startedAt: number
        finishedAt: number | null
        exitCode: number | null
      } = { buildId: row.buildId, startedAt: row.startedAt, finishedAt: null, exitCode: null }
      try {
        const endFile = Bun.file(`${output}.native-build-ids/${row.buildId}.exit.json`)
        if (endFile.size > 1024) throw new Error('Command completion overflow')
        // eslint-disable-next-line no-await-in-loop -- Bound registry reconciliation to one open file at a time.
        const end = await endFile.json()
        if (
          end.buildId !== row.buildId ||
          Number.isSafeInteger(end.exitCode) === false ||
          end.exitCode < 0 ||
          Number.isSafeInteger(end.finishedAt) === false ||
          end.finishedAt < row.startedAt
        )
          throw new Error('Invalid command completion')
        if (end.sourceComplete === false) evidenceGaps.push('native-event-source-incomplete')
        command.finishedAt = end.finishedAt
        command.exitCode = end.exitCode
      } catch {
        evidenceGaps.push('native-command-completion-missing')
      }
      commands.push(command)
      try {
        // eslint-disable-next-line no-await-in-loop -- Validate before opening the bounded native ID file.
        const info = await stat(row.path)
        // New producer-owned UUID paths were absent before launch. Filesystem
        // mtimes may use a coarser clock than Date.now(), so do not compare their
        // sub-command clocks. Reused caller paths must demonstrably change.
        const changedSinceLaunch =
          row.priorMtimeMs === null ||
          (typeof row.priorMtimeMs === 'number' &&
            Number.isFinite(row.priorMtimeMs) === true &&
            info.mtimeMs > row.priorMtimeMs) ||
          (row.priorMtimeMs === undefined && Math.floor(info.mtimeMs) >= row.startedAt)
        if (
          info.isFile() === true &&
          info.size <= 128 &&
          changedSinceLaunch === true &&
          Math.floor(info.mtimeMs) <= (command.finishedAt ?? Date.now()) &&
          // eslint-disable-next-line no-await-in-loop -- Read only after the file-size guard.
          (await Bun.file(row.path).text()).trim() === row.buildId
        )
          observed.add(row.buildId)
      } catch {
        /* Missing native output remains a gap. */
      }
    }
  } catch {
    evidenceGaps.push('native-invocation-registry-incomplete')
  }
  try {
    const nativeFiles = await readdir(`${output}.native-build-ids`)
    if (nativeFiles.length > maxNativeInvocations * 2)
      evidenceGaps.push('native-build-id-count-limit')
    for (const name of nativeFiles) {
      if (name.endsWith('.buck-trace-id') === true && expected.has(name.slice(0, -14)) === false)
        evidenceGaps.push('unregistered-native-build-id')
    }
  } catch {
    evidenceGaps.push('native-build-id-directory-missing')
  }
  let names: string[] = []
  try {
    names = await readdir(`${output}.shards`)
  } catch {
    evidenceGaps.push('native-shards-missing')
  }
  if (names.length > maxNativeInvocations) {
    evidenceGaps.push('native-shard-count-limit')
    names = []
  }
  for (const name of names.toSorted()) {
    const buildId = name.slice(0, -5)
    if (name.endsWith('.json') === false || idPattern.test(buildId) === false) {
      evidenceGaps.push('native-shard-unfinalized')
      continue
    }
    try {
      const path = join(`${output}.shards`, name)
      // eslint-disable-next-line no-await-in-loop -- Check the job byte budget before loading each shard.
      const size = (await stat(path)).size
      totalShardBytes += size
      if (size > maxShardBytes || totalShardBytes > maxJobShardBytes)
        throw new Error('Shard overflow')
      // eslint-disable-next-line no-await-in-loop -- Serial decoding bounds peak memory to one shard.
      const body = await Bun.file(path).text()
      const value = JSON.parse(body)
      if (value.schemaVersion === 1 && value.buildId === buildId && value.complete === false) {
        const partial = decodeActionArtifact(value.artifact)
        for (const gap of [
          'native-shard-size-limit',
          'invalid-native-json',
          'incomplete-native-invocation',
          'native-shard-build-id-mismatch',
        ])
          if (partial.header.evidenceGaps.includes(gap) === true) evidenceGaps.push(gap)
      }
      if (
        value.schemaVersion !== 1 ||
        value.buildId !== buildId ||
        value.complete !== true ||
        expected.has(buildId) === false ||
        observed.has(buildId) === false
      )
        throw new Error('Unconfirmed shard')
      const decoded = decodeActionArtifact(value.artifact)
      const next = decodeCacheEvidence(value.summary)
      if (
        decoded.header.invocations.length !== 1 ||
        decoded.header.invocations[0]?.buildId !== buildId ||
        decoded.header.invocations[0]?.complete !== true ||
        next.invocations.length !== 1 ||
        next.invocations[0]?.buildId !== buildId ||
        next.actionCount !== decoded.actions.length ||
        decoded.header.evidenceGaps.length > 0
      )
        throw new Error('Invalid shard')
      const invocation = decoded.header.invocations[0]
      const compactInvocation = next.invocations[0]
      const exclusions = countActionExclusions(decoded.actions)
      if (
        invocation === undefined ||
        compactInvocation === undefined ||
        invocation.actionCount !== decoded.actions.length ||
        compactInvocation.actionCount !== decoded.actions.length ||
        decoded.header.rows !== decoded.actions.length ||
        decoded.header.actionCount !== decoded.actions.length ||
        decoded.header.droppedActionCount !== 0 ||
        decoded.actions.some((row) => row.buildId !== buildId) === true ||
        actionExclusionReasons.some(
          (reason) =>
            invocation.excludedByDesign?.[reason] !== exclusions[reason] ||
            compactInvocation.excludedByDesign?.[reason] !== exclusions[reason] ||
            decoded.header.excludedByDesign[reason] !== exclusions[reason],
        ) === true ||
        cacheEvidenceOutcomes.some((outcome) => {
          const count = decoded.actions.filter((row) => row.cacheOutcome === outcome).length
          return next.counts[outcome] !== count || compactInvocation.counts[outcome] !== count
        }) === true
      )
        throw new Error('Shard counters mismatch')
      const nextBytes = decoded.actions.reduce(
        (bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)) + 1,
        0,
      )
      if (actionBytes + nextBytes > maxActionArtifactBytes)
        throw new Error('Full action artifact overflow')
      actionBytes += nextBytes
      summary = mergeCacheEvidence({ previous: summary, next })
      artifact.actions.push(...decoded.actions)
      artifact.header.invocations.push(...decoded.header.invocations)
      shards.push({
        buildId,
        name,
        sha256: createHash('sha256').update(body).digest('hex'),
        bytes: Buffer.byteLength(body),
        rows: decoded.actions.length,
        complete: true,
      })
    } catch {
      evidenceGaps.push('native-shard-incomplete')
    }
  }
  for (const buildId of expected) {
    if (observed.has(buildId) === false) evidenceGaps.push('native-build-id-missing')
    if (shards.some((shard) => shard.buildId === buildId) === false)
      evidenceGaps.push('native-shard-missing')
  }
  if (expected.size === 0) evidenceGaps.push('native-invocations-missing')
  const index = {
    schemaVersion: 1,
    complete: evidenceGaps.length === 0,
    evidenceGaps: [...new Set(evidenceGaps)].toSorted(),
    expectedBuildIds: [...expected].toSorted(),
    observedBuildIds: [...observed].toSorted(),
    commands: commands.toSorted((a, b) => a.buildId.localeCompare(b.buildId)),
    shards,
  }
  await atomic({ path: `${output}.shard-index.json`, bytes: `${JSON.stringify(index)}\n` })
  return { summary, artifact, index }
}
