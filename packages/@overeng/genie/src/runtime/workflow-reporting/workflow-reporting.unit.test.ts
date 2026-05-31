import { describe, expect, it } from 'vitest'

import {
  createWorkflowReportBundle,
  decodeWorkflowReportBundleJson,
  decodeWorkflowReportRecord,
  deriveWorkflowReportManagedState,
  encodeWorkflowReportBundleJson,
  encodeWorkflowReportRecordLine,
  extractWorkflowReportManagedState,
  findWorkflowReportManagedCommentId,
  parseMarkedWorkflowReportJsonl,
  renderWorkflowReportCommentBody,
  renderWorkflowReportManagedState,
  workflowReportBundleJsonSchema,
  workflowReportManagedMarker,
  workflowReportRecordLineMarker,
  type WorkflowReportRecord,
} from './mod.ts'

const sampleRecord = decodeWorkflowReportRecord({
  _tag: 'WorkflowReportRecord',
  schemaVersion: 1,
  id: 'deploy-web',
  kind: 'deploy-preview',
  subject: { id: 'web', label: 'Website' },
  status: 'success',
  title: 'Website preview deployed',
  summary: 'Preview is ready',
  createdAtUtc: '2026-05-31T15:00:00Z',
  links: [{ label: 'Preview', url: 'https://example.vercel.app', primary: true }],
  data: { provider: 'vercel' },
})

describe('workflow reporting schemas', () => {
  it('strictly decodes versioned report records', () => {
    expect(sampleRecord.schemaVersion).toBe(1)
    expect(sampleRecord.subject.id).toBe('web')

    expect(() =>
      decodeWorkflowReportRecord({
        ...sampleRecord,
        unexpected: true,
      }),
    ).toThrow()
  })

  it('exports JSON schemas as the wire contract', () => {
    expect(workflowReportBundleJsonSchema).toMatchObject({
      $schema: 'http://json-schema.org/draft-07/schema#',
      $ref: '#/$defs/WorkflowReporting.Bundle',
    })
    expect(workflowReportBundleJsonSchema.$defs?.['WorkflowReporting.Bundle']).toMatchObject({
      type: 'object',
      required: ['_tag', 'schemaVersion', 'bundleId', 'generatedAtUtc', 'records'],
      additionalProperties: false,
    })
  })

  it('round-trips bundles through schema-backed JSON encoding', () => {
    const bundle = createWorkflowReportBundle({
      bundleId: 'deploy-preview',
      generatedAtUtc: '2026-05-31T15:01:00Z',
      records: [sampleRecord],
    })

    expect(decodeWorkflowReportBundleJson(encodeWorkflowReportBundleJson(bundle))).toEqual(bundle)
  })
})

describe('marked workflow report JSONL parsing', () => {
  it('ignores unmarked output and decodes only marked JSON records', () => {
    const source = [
      'regular deploy output',
      encodeWorkflowReportRecordLine(sampleRecord),
      'Vercel deploy URL: https://unstructured.example',
    ].join('\n')

    expect(parseMarkedWorkflowReportJsonl(source)).toEqual({
      records: [sampleRecord],
      markedLineCount: 1,
      ignoredLineCount: 2,
    })
  })

  it('fails when a marked control-plane record does not match the schema', () => {
    const invalidRecord = `${workflowReportRecordLineMarker}${JSON.stringify({
      ...sampleRecord,
      schemaVersion: 2,
    })}`

    expect(() => parseMarkedWorkflowReportJsonl(invalidRecord)).toThrow()
  })
})

describe('managed workflow report comments', () => {
  it('derives, renders, and extracts managed state from hidden structured JSON', () => {
    const state = deriveWorkflowReportManagedState({
      stateId: 'deploy-preview',
      entryId: 'commit-a',
      entryLabel: 'Commit abc1234',
      createdAtUtc: '2026-05-31T15:02:00Z',
      records: [sampleRecord],
    })

    const hiddenState = renderWorkflowReportManagedState(state)

    expect(hiddenState).toContain(workflowReportManagedMarker)
    expect(extractWorkflowReportManagedState(hiddenState, { stateId: 'deploy-preview' })).toEqual(
      state,
    )
  })

  it('renders Markdown as a projection without making extraction depend on visible text', () => {
    const state = deriveWorkflowReportManagedState({
      stateId: 'deploy-preview',
      entryId: 'commit-a',
      entryLabel: 'Commit abc1234',
      createdAtUtc: '2026-05-31T15:02:00Z',
      records: [sampleRecord],
    })
    const body = renderWorkflowReportCommentBody({
      title: 'Deploy Previews',
      noRecordsMessage: 'No previews were deployed.',
      state,
    })
    const mutatedProjection = body.replace('Website preview deployed', 'rendered markdown changed')

    expect(mutatedProjection).toContain('rendered markdown changed')
    expect(extractWorkflowReportManagedState(mutatedProjection)).toEqual(state)
  })

  it('matches existing managed comments by hidden state ID', () => {
    const deployState = deriveWorkflowReportManagedState({
      stateId: 'deploy-preview',
      entryId: 'commit-a',
      entryLabel: 'Commit abc1234',
      createdAtUtc: '2026-05-31T15:02:00Z',
      records: [sampleRecord],
    })
    const measurementsState = deriveWorkflowReportManagedState({
      stateId: 'ci-measurements',
      entryId: 'commit-a',
      entryLabel: 'Commit abc1234',
      createdAtUtc: '2026-05-31T15:02:00Z',
      records: [sampleRecord],
    })

    expect(
      findWorkflowReportManagedCommentId(
        [
          { id: 10, body: renderWorkflowReportManagedState(deployState) },
          { id: 11, body: renderWorkflowReportManagedState(measurementsState) },
          { id: 12, body: renderWorkflowReportManagedState(deployState) },
        ],
        { stateId: 'deploy-preview' },
      ),
    ).toBe('12')
  })

  it('keeps current records first while preserving prior record order', () => {
    const priorRecord: WorkflowReportRecord = {
      ...sampleRecord,
      id: 'deploy-app',
      subject: { id: 'app', label: 'App' },
      title: 'App preview deployed',
    }
    const priorState = deriveWorkflowReportManagedState({
      stateId: 'deploy-preview',
      entryId: 'commit-a',
      entryLabel: 'Commit abc1234',
      createdAtUtc: '2026-05-31T15:02:00Z',
      records: [priorRecord],
    })

    const nextState = deriveWorkflowReportManagedState({
      stateId: 'deploy-preview',
      priorState,
      entryId: 'commit-b',
      entryLabel: 'Commit def5678',
      createdAtUtc: '2026-05-31T15:03:00Z',
      records: [sampleRecord],
    })

    expect(nextState.recordOrder).toEqual(['web', 'app'])
    expect(nextState.entries.map((entry) => entry.entryId)).toEqual(['commit-b', 'commit-a'])
  })
})
