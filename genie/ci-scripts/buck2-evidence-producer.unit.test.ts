import { describe, expect, it } from 'bun:test'

import {
  decodeEvidenceProducer,
  encodeEvidenceProducer,
  type GitHubActionsEvidenceProducer,
  type HostServiceEvidenceProducer,
} from './buck2-evidence-producer.ts'

const host: HostServiceEvidenceProducer = {
  _tag: 'host-service',
  host: 'fixture-host',
  unit: 'fixture-seeder.service',
  invocationId: 'b'.repeat(32),
  fetchedCommit: 'a'.repeat(40),
  posture: 'writer',
  startedAt: 1700000000000,
  finishedAt: 1700000010000,
}
const actions: GitHubActionsEvidenceProducer = {
  _tag: 'github-actions',
  repo: 'fixture/public-cache',
  runId: '123',
  runAttempt: '1',
  job: 'quality',
  lane: 'main-writer',
  headSha: 'a'.repeat(40),
  posture: 'writer',
  startedAt: 1700000000000,
  finishedAt: 1700000010000,
}
const legacyActionsWire =
  '{"repo":"fixture/public-cache","runId":"123","runAttempt":"1","job":"quality","lane":"main-writer","headSha":"' +
  'a'.repeat(40) +
  '","posture":"writer","startedAt":1700000000000,"finishedAt":1700000010000}'

describe('cache evidence producer wire codec', () => {
  it('preserves the exact legacy Actions field order and values without serializing the domain tag', () => {
    expect(JSON.stringify(encodeEvidenceProducer(actions))).toBe(legacyActionsWire)
    expect(encodeEvidenceProducer(actions)).not.toHaveProperty('_tag')
    expect(decodeEvidenceProducer(JSON.parse(legacyActionsWire))).toEqual(actions)
  })

  it('round-trips the explicit host identity without introducing an Actions run or lane', () => {
    const encoded = encodeEvidenceProducer(host)
    expect(encoded).toEqual(host)
    expect(decodeEvidenceProducer(JSON.parse(JSON.stringify(encoded)))).toEqual(host)
    for (const field of ['repo', 'runId', 'runAttempt', 'job', 'lane', 'headSha']) {
      expect(encoded).not.toHaveProperty(field)
    }
  })

  it('allowlists host serialization even when structurally assignable input carries unrelated fields', () => {
    const input = {
      ...host,
      repo: 'fixture/public-cache',
      runId: '123',
      runAttempt: '1',
      job: 'quality',
      lane: 'main-writer',
      headSha: 'c'.repeat(40),
      GITHUB_TOKEN: 'FIXTURE_SECRET',
      command: '/fixture/private-command',
    }
    expect(encodeEvidenceProducer(input)).toEqual(host)
    expect(decodeEvidenceProducer(input)).toEqual(host)
    expect(JSON.stringify(encodeEvidenceProducer(input))).not.toContain('FIXTURE_SECRET')
  })

  it('allowlists Actions serialization without changing its historical metadata wire', () => {
    const input = {
      ...actions,
      host: 'fixture-host',
      unit: 'fixture-seeder.service',
      invocationId: 'b'.repeat(32),
      fetchedCommit: 'c'.repeat(40),
      GITHUB_TOKEN: 'FIXTURE_SECRET',
      command: '/fixture/private-command',
    }
    expect(JSON.stringify(encodeEvidenceProducer(input))).toBe(legacyActionsWire)
    expect(JSON.stringify(encodeEvidenceProducer(input))).not.toContain('FIXTURE_SECRET')
    expect(
      decodeEvidenceProducer({ ...JSON.parse(legacyActionsWire), GITHUB_TOKEN: 'FIXTURE_SECRET' }),
    ).toEqual(actions)
  })

  it('preserves explicit nulls for honest incomplete host and legacy Actions metadata', () => {
    const incompleteHost: HostServiceEvidenceProducer = {
      _tag: 'host-service',
      host: null,
      unit: null,
      invocationId: null,
      fetchedCommit: null,
      posture: null,
      startedAt: null,
      finishedAt: null,
    }
    const incompleteActions: GitHubActionsEvidenceProducer = {
      _tag: 'github-actions',
      repo: null,
      runId: null,
      runAttempt: null,
      job: null,
      lane: null,
      headSha: null,
      posture: 'read-only',
      startedAt: null,
      finishedAt: null,
    }
    for (const producer of [incompleteHost, incompleteActions]) {
      expect(decodeEvidenceProducer(encodeEvidenceProducer(producer))).toEqual(producer)
    }
  })

  it('does not guess host identity from an untagged payload or accept unsupported producer variants', () => {
    const untaggedHost = Object.fromEntries(Object.entries(host).filter(([key]) => key !== '_tag'))
    for (const value of [
      untaggedHost,
      { ...host, _tag: 'unknown' },
      { ...host, _tag: 'github-actions' },
      { ...JSON.parse(legacyActionsWire), _tag: 'github-actions' },
      null,
      [],
      'host-service',
    ]) {
      expect(() => decodeEvidenceProducer(value)).toThrow('Invalid cache evidence producer')
    }
  })

  const invalidHostFields: { name: string; fields: Record<string, unknown> }[] = [
    { name: 'absent host', fields: { host: undefined } },
    { name: 'unsafe host', fields: { host: '../unsafe host' } },
    { name: 'absent unit', fields: { unit: undefined } },
    { name: 'unsafe unit', fields: { unit: '../fixture-seeder.service' } },
    { name: 'non-service unit', fields: { unit: 'fixture-seeder.timer' } },
    { name: 'absent invocation', fields: { invocationId: undefined } },
    { name: 'uppercase invocation', fields: { invocationId: 'B'.repeat(32) } },
    { name: 'short invocation', fields: { invocationId: 'b'.repeat(31) } },
    { name: 'UUID invocation', fields: { invocationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } },
    { name: 'absent commit', fields: { fetchedCommit: undefined } },
    { name: 'malformed commit', fields: { fetchedCommit: 'g'.repeat(40) } },
    { name: 'absent posture', fields: { posture: undefined } },
    { name: 'unsupported posture', fields: { posture: 'owner' } },
    { name: 'absent start', fields: { startedAt: undefined } },
    { name: 'absent finish', fields: { finishedAt: undefined } },
    { name: 'fractional start', fields: { startedAt: 1700000000000.5 } },
    { name: 'negative start', fields: { startedAt: -1 } },
    { name: 'string finish', fields: { finishedAt: '1700000010000' } },
    { name: 'unsafe integer finish', fields: { finishedAt: Number.MAX_SAFE_INTEGER + 1 } },
  ]
  for (const invalid of invalidHostFields) {
    it(`rejects ${invalid.name} at the producer wire boundary`, () => {
      expect(() => decodeEvidenceProducer({ ...host, ...invalid.fields })).toThrow(
        'Invalid cache evidence producer',
      )
    })
  }
})
