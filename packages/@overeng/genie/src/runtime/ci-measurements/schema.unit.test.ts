import { runInNewContext } from 'node:vm'

import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import {
  CiMeasurementArtifact,
  CiMeasurementCommentState,
  CiMeasurementComparison,
  ciMeasurementAuthority,
  renderCiMeasurementValidators,
} from './schema.ts'

const generatedIs = (name: string, input: unknown): boolean =>
  Schema.decodeUnknownSync(Schema.Boolean)(runInNewContext(
    renderCiMeasurementValidators() + '\n' + name + '(input)',
    { input },
  ))

const artifact = {
  schemaVersion: 1,
  generatedAt: '2026-10-12T00:00:00Z',
  producer: { name: 'test', version: 1 },
  target: { kind: 'source-shape', id: 'source' },
  observations: [{ name: 'source.lines', unit: 'lines', value: 5 }],
  artifacts: [{ name: 'details', path: 'details.json', contentType: 'application/json' }],
} satisfies typeof CiMeasurementArtifact.Type

const state = {
  _tag: 'ci-measurement-comment-state',
  schemaVersion: 1,
  title: 'CI Measurements',
  runs: [{
    commitSha: 'abc', shortSha: 'abc', generatedAt: '2026-10-12T00:00:00Z',
    status: 'pass', mode: 'warn', runAttempt: '1', workflow: 'CI', job: 'measurements',
    visibleRows: [{ status: 'pass', target: 'source', observation: 'lines', meaning: 'unchanged',
      dimensions: '', baseline: '5', current: '5', delta: '0', ratio: '1x', impact: '0x' }],
  }],
} satisfies typeof CiMeasurementCommentState.Type

const comparison = {
  schemaVersion: 1, status: 'skipped', mode: 'off', comparisons: {},
} satisfies typeof CiMeasurementComparison.Type

describe('CI measurement record authorities', () => {
  it('publishes three independently released record fragments', () => {
    expect(ciMeasurementAuthority.fragments.map(({ id }) => id)).toEqual([
      'ci-measurement-artifact/v1', 'ci-measurement-comparison/v1', 'ci-measurement-comment-state/v1',
    ])
  })

  it('generates dependency-free artifact validation from the typed producer contract', () => {
    expect(generatedIs('isCiMeasurementArtifact', artifact)).toBe(true)
    expect(Schema.decodeUnknownSync(CiMeasurementArtifact, { onExcessProperty: 'error' })(artifact)).toEqual(artifact)
    for (const malformed of [
      { ...artifact, schemaVersion: '1' },
      { ...artifact, schemaVersion: 2 },
      { ...artifact, observations: [{ name: 'source.lines', unit: 'lines', value: '5' }] },
      { ...artifact, observations: [{ name: 'source.lines', unit: 'lines', value: Infinity }] },
      { ...artifact, target: { kind: 'source-shape' } },
      { ...artifact, unknown: true },
    ]) expect(generatedIs('isCiMeasurementArtifact', malformed)).toBe(false)
  })

  it('rejects malformed and version-mismatched comparison records', () => {
    expect(generatedIs('isCiMeasurementComparison', comparison)).toBe(true)
    for (const malformed of [
      { ...comparison, schemaVersion: '1' }, { ...comparison, schemaVersion: 2 },
      { ...comparison, comparisons: [] }, { ...comparison, comparisons: { broken: {} } },
      { ...comparison, readiness: { enforceable: 'yes' } },
    ]) expect(generatedIs('isCiMeasurementComparison', malformed)).toBe(false)
  })

  it('validates every cached history run and visible row rather than only the tag', () => {
    expect(generatedIs('isCiMeasurementCommentState', state)).toBe(true)
    for (const malformed of [
      { ...state, schemaVersion: '1' }, { ...state, schemaVersion: 2 },
      { ...state, runs: [{}] }, { ...state, runs: [{ ...state.runs[0], visibleRows: [{}] }] },
      { ...state, runs: [{ ...state.runs[0], commitSha: 1 }] },
      { ...state, unknown: true },
    ]) expect(generatedIs('isCiMeasurementCommentState', malformed)).toBe(false)
  })
})
