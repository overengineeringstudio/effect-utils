import { isCacheLane, type CacheLane } from './buck2-action-evidence.ts'

export type EvidencePosture = 'read-only' | 'writer' | 'disabled-by-design'

/** Existing q33 Actions wire identity: its serialized property set is unchanged. */
export type GitHubActionsEvidenceProducerWire = {
  repo: string | null
  runId: string | null
  runAttempt: string | null
  job: string | null
  lane: CacheLane | null
  headSha: string | null
  posture: EvidencePosture
  startedAt: number | null
  finishedAt: number | null
}
export type GitHubActionsEvidenceProducer = GitHubActionsEvidenceProducerWire & {
  _tag: 'github-actions'
}

/** Real host observation identity, never a synthesized GitHub run or lane. */
export type HostServiceEvidenceProducer = {
  _tag: 'host-service'
  host: string | null
  unit: string | null
  invocationId: string | null
  fetchedCommit: string | null
  posture: EvidencePosture | null
  startedAt: number | null
  finishedAt: number | null
}
export type CacheEvidenceProducer = GitHubActionsEvidenceProducer | HostServiceEvidenceProducer
export type EvidenceProducerWire = GitHubActionsEvidenceProducerWire | HostServiceEvidenceProducer

/** Preserve the untagged Actions wire contract; the canonical domain is always tagged. */
export const encodeEvidenceProducer = (producer: CacheEvidenceProducer): EvidenceProducerWire => {
  if (producer._tag === 'host-service') {
    return {
      _tag: 'host-service',
      host: producer.host,
      unit: producer.unit,
      invocationId: producer.invocationId,
      fetchedCommit: producer.fetchedCommit,
      posture: producer.posture,
      startedAt: producer.startedAt,
      finishedAt: producer.finishedAt,
    }
  }
  return {
    repo: producer.repo,
    runId: producer.runId,
    runAttempt: producer.runAttempt,
    job: producer.job,
    lane: producer.lane,
    headSha: producer.headSha,
    posture: producer.posture,
    startedAt: producer.startedAt,
    finishedAt: producer.finishedAt,
  }
}

export const evidenceProducerComplete = (producer: CacheEvidenceProducer): boolean =>
  Object.values(producer).every((value) => value !== null)

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false
    ? Reflect.get(value, key)
    : undefined
const invalid = (): never => {
  throw new Error('Invalid cache evidence producer')
}
const identity = (value: unknown, grammar: RegExp, limit = 4096): string | null => {
  if (value === null) return null
  return typeof value === 'string' && value.length <= limit && grammar.test(value)
    ? value
    : invalid()
}
const timestamp = (value: unknown): number | null => {
  if (value === null) return null
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid()
}
const posture = (value: unknown): EvidencePosture => {
  if (value === 'read-only' || value === 'writer' || value === 'disabled-by-design') return value
  return invalid()
}

export const hostIdentityGrammar = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/
export const serviceUnitGrammar = /^[a-zA-Z0-9_.@-]+\.service$/
export const serviceInvocationGrammar = /^[a-f0-9]{32}$/
export const fetchedCommitGrammar = /^[a-fA-F0-9]{40}$/

/** Reconstruct only the selected producer's own allowlisted fields at the JSON boundary. */
export const decodeEvidenceProducer = (value: unknown): CacheEvidenceProducer => {
  const tag = field(value, '_tag')
  if (tag === 'host-service') {
    const rawPosture = field(value, 'posture')
    return {
      _tag: 'host-service',
      host: identity(field(value, 'host'), hostIdentityGrammar, 253),
      unit: identity(field(value, 'unit'), serviceUnitGrammar, 255),
      invocationId: identity(field(value, 'invocationId'), serviceInvocationGrammar, 32),
      fetchedCommit: identity(field(value, 'fetchedCommit'), fetchedCommitGrammar, 40),
      posture: rawPosture === null ? null : posture(rawPosture),
      startedAt: timestamp(field(value, 'startedAt')),
      finishedAt: timestamp(field(value, 'finishedAt')),
    }
  }
  // Untagged metadata is the current Actions wire shape, not an inferred host identity.
  if (tag !== undefined) return invalid()
  const rawLane = field(value, 'lane')
  return {
    _tag: 'github-actions',
    repo: identity(field(value, 'repo'), /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
    runId: identity(field(value, 'runId'), /^[0-9]+$/),
    runAttempt: identity(field(value, 'runAttempt'), /^[0-9]+$/),
    job: identity(field(value, 'job'), /^[a-zA-Z0-9_.-]+$/),
    lane: rawLane === null ? null : isCacheLane(rawLane) ? rawLane : invalid(),
    headSha: identity(field(value, 'headSha'), fetchedCommitGrammar),
    posture: posture(field(value, 'posture')),
    startedAt: timestamp(field(value, 'startedAt')),
    finishedAt: timestamp(field(value, 'finishedAt')),
  }
}
