import { describe, expect, it } from 'vitest'

import {
  collectWorkflowReportBundle,
  createWorkflowReportBundle,
  decodeWorkflowReportBundleJson,
  decodeWorkflowReportRecord,
  deriveWorkflowReportManagedState,
  encodeWorkflowReportBundleJson,
  encodeWorkflowReportRecordLine,
  extractWorkflowReportManagedState,
  findWorkflowReportManagedComment,
  parseMarkedWorkflowReportJsonl,
  renderWorkflowReportCommentBody,
  renderWorkflowReportManagedState,
  workflowReportBundleJsonSchema,
  workflowReportManagedMarker,
  workflowReportRecordLineMarker,
  type WorkflowReportManagedState,
  type WorkflowReportRecord,
} from './mod.ts'
import type { PipelineReportData, PipelineRow } from './pipeline-report.ts'

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

  it('collects bundles from marked log sources through the shared decoder', () => {
    expect(
      collectWorkflowReportBundle({
        bundleId: 'deploy-preview',
        generatedAtUtc: '2026-05-31T15:01:00Z',
        sources: ['plain output', encodeWorkflowReportRecordLine(sampleRecord)],
      }),
    ).toEqual({
      _tag: 'WorkflowReportBundle',
      schemaVersion: 1,
      bundleId: 'deploy-preview',
      generatedAtUtc: '2026-05-31T15:01:00Z',
      records: [sampleRecord],
    })
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

describe('ci-tools workflow-report wire baselines (cross-major invariant)', () => {
  const wireRecord = decodeWorkflowReportRecord({
    _tag: 'WorkflowReportRecord',
    schemaVersion: 1,
    id: 'deploy-web:世界',
    kind: 'deploy-preview',
    subject: { id: 'web', label: 'Website | Primary' },
    status: 'failure',
    title: 'Preview failed',
    summary: 'Line 1\r\nLine 2 résumé',
    createdAtUtc: '2026-07-28T08:00:00.000Z',
    links: [
      { label: 'Log', url: 'https://example.invalid/log?attempt=1', primary: false },
      { label: 'Preview', url: 'https://preview.example.invalid', primary: true },
    ],
    data: {
      empty: '',
      nullable: null,
      unicode: '東京',
      impossibleDate: '2026-02-31',
      largeInteger: 9007199254740991,
    },
  })

  it('encodes marked report lines as byte-identical JSON', () => {
    expect(encodeWorkflowReportRecordLine(wireRecord)).toMatchInlineSnapshot(
      `"WORKFLOW_REPORT_V1: {"_tag":"WorkflowReportRecord","schemaVersion":1,"id":"deploy-web:世界","kind":"deploy-preview","subject":{"id":"web","label":"Website | Primary"},"status":"failure","title":"Preview failed","summary":"Line 1\\r\\nLine 2 résumé","createdAtUtc":"2026-07-28T08:00:00.000Z","links":[{"label":"Log","url":"https://example.invalid/log?attempt=1","primary":false},{"label":"Preview","url":"https://preview.example.invalid","primary":true}],"data":{"empty":"","nullable":null,"unicode":"東京","impossibleDate":"2026-02-31","largeInteger":9007199254740991}}"`,
    )
  })

  it('encodes report bundles as byte-identical pretty JSON', () => {
    const bundle = createWorkflowReportBundle({
      bundleId: 'deploy-preview',
      generatedAtUtc: '2026-07-28T08:01:00.000Z',
      records: [wireRecord],
    })

    expect(encodeWorkflowReportBundleJson(bundle)).toMatchInlineSnapshot(`
      "{
        "_tag": "WorkflowReportBundle",
        "schemaVersion": 1,
        "bundleId": "deploy-preview",
        "generatedAtUtc": "2026-07-28T08:01:00.000Z",
        "records": [
          {
            "_tag": "WorkflowReportRecord",
            "schemaVersion": 1,
            "id": "deploy-web:世界",
            "kind": "deploy-preview",
            "subject": {
              "id": "web",
              "label": "Website | Primary"
            },
            "status": "failure",
            "title": "Preview failed",
            "summary": "Line 1\\r\\nLine 2 résumé",
            "createdAtUtc": "2026-07-28T08:00:00.000Z",
            "links": [
              {
                "label": "Log",
                "url": "https://example.invalid/log?attempt=1",
                "primary": false
              },
              {
                "label": "Preview",
                "url": "https://preview.example.invalid",
                "primary": true
              }
            ],
            "data": {
              "empty": "",
              "nullable": null,
              "unicode": "東京",
              "impossibleDate": "2026-02-31",
              "largeInteger": 9007199254740991
            }
          }
        ]
      }
      "
    `)
  })

  it('encodes managed comment state as byte-identical Markdown', () => {
    const state = deriveWorkflowReportManagedState({
      stateId: 'deploy-preview',
      entryId: 'commit-a',
      entryLabel: 'Commit abc1234',
      createdAtUtc: '2026-07-28T08:02:00.000Z',
      records: [wireRecord],
    })

    expect(
      renderWorkflowReportCommentBody({
        title: 'Deploy Previews',
        noRecordsMessage: 'No previews were deployed.',
        state,
      }),
    ).toMatchInlineSnapshot(`
      "## Deploy Previews

      | Subject | Status | Report | Details | Updated |
      | --- | --- | --- | --- | --- |
      | Website \\| Primary | failure | [Preview failed](https://preview.example.invalid) | Line 1
      <br>Line 2 résumé | 2026-07-28 10:00 CEST |

      <details>
      <summary>Report history</summary>

      ### Commit abc1234 · 2026-07-28 10:02 CEST

      | Subject | Status | Report | Details | Updated |
      | --- | --- | --- | --- | --- |
      | Website \\| Primary | failure | [Preview failed](https://preview.example.invalid) | Line 1
      <br>Line 2 résumé | 2026-07-28 10:00 CEST |

      </details>

      <!-- workflow-report:managed -->
      <!-- workflow-report:state
      {
        "_tag": "WorkflowReportManagedState",
        "schemaVersion": 1,
        "stateId": "deploy-preview",
        "timeZone": "Europe/Berlin",
        "recordOrder": [
          "web"
        ],
        "entries": [
          {
            "_tag": "WorkflowReportManagedEntry",
            "entryId": "commit-a",
            "label": "Commit abc1234",
            "createdAtUtc": "2026-07-28T08:02:00.000Z",
            "records": [
              {
                "_tag": "WorkflowReportRecord",
                "schemaVersion": 1,
                "id": "deploy-web:世界",
                "kind": "deploy-preview",
                "subject": {
                  "id": "web",
                  "label": "Website | Primary"
                },
                "status": "failure",
                "title": "Preview failed",
                "summary": "Line 1\\r\\nLine 2 résumé",
                "createdAtUtc": "2026-07-28T08:00:00.000Z",
                "links": [
                  {
                    "label": "Log",
                    "url": "https://example.invalid/log?attempt=1",
                    "primary": false
                  },
                  {
                    "label": "Preview",
                    "url": "https://preview.example.invalid",
                    "primary": true
                  }
                ],
                "data": {
                  "empty": "",
                  "nullable": null,
                  "unicode": "東京",
                  "impossibleDate": "2026-02-31",
                  "largeInteger": 9007199254740991
                }
              }
            ]
          }
        ]
      }

      -->
      "
    `)
  })

  it('captures workflow-report decode failures as stable JSON', () => {
    let failureJson = '{"_tag":"UnexpectedSuccess"}'
    try {
      decodeWorkflowReportBundleJson(
        '{"_tag":"WorkflowReportBundle","schemaVersion":2,"bundleId":"deploy-preview","generatedAtUtc":"2026-07-28T08:01:00Z","records":[]}',
      )
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      failureJson = JSON.stringify({ _tag: 'DecodeFailure', message })
    }

    expect(failureJson).toMatchInlineSnapshot(
      `"{"_tag":"DecodeFailure","message":"WorkflowReportBundle.schemaVersion must be 1"}"`,
    )
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
      findWorkflowReportManagedComment(
        [
          { id: 10, body: renderWorkflowReportManagedState(deployState) },
          { id: 11, body: renderWorkflowReportManagedState(measurementsState) },
          { id: 12, body: renderWorkflowReportManagedState(deployState) },
        ],
        { stateId: 'deploy-preview' },
      )?.id,
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

  it('evicts oldest history to keep the managed comment below the GitHub limit', () => {
    const records = Array.from({ length: 5 }, (_, index) => ({
      ...sampleRecord,
      id: `deploy-${index}`,
      subject: { id: `subject-${index}` },
      summary: 'x'.repeat(500),
    }))
    const priorState = Array.from({ length: 20 }).reduce<WorkflowReportManagedState>(
      (state, _, index) =>
        deriveWorkflowReportManagedState({
          stateId: 'deploy-preview',
          priorState: state,
          entryId: `commit-${index}`,
          entryLabel: `Commit ${index}`,
          createdAtUtc: `2026-05-31T15:${String(index).padStart(2, '0')}:00Z`,
          records,
        }),
      deriveWorkflowReportManagedState({
        stateId: 'deploy-preview',
        entryId: 'initial',
        entryLabel: 'Initial',
        createdAtUtc: '2026-05-31T15:00:00Z',
        records,
      }),
    )

    const body = renderWorkflowReportCommentBody({
      title: 'Deploy Previews',
      noRecordsMessage: 'No previews were deployed.',
      state: priorState,
    })
    const retainedState = extractWorkflowReportManagedState(body, { stateId: 'deploy-preview' })

    expect(body.length).toBeLessThanOrEqual(60_000)
    expect(retainedState?.entries[0]?.entryId).toBe('commit-19')
    expect(retainedState?.entries.length).toBeLessThan(priorState.entries.length)
  })
})

describe('pipeline waterfall comment consumers', () => {
  const row = (job: string, wallTimeMs: number): PipelineRow => ({
    job,
    status: 'success',
    wallTime: `${wallTimeMs / 1000}s`,
    wallTimeMs,
    delta: 'no main baseline',
    instrumented: false,
  })
  const rows = [
    ...Array.from({ length: 5 }, (_, index) => row(`slow-${index}`, 900_000 - index * 60_000)),
    { ...row('failed-fast', 1000), status: 'failure' },
    {
      ...row('regressed', 150_000),
      baselineMs: 120_000,
      deltaMs: 30_000,
      delta: '+30.0s (25.0%; n=7)',
    },
    row('ordinary | <job>', 20_000),
    {
      job: 'skipped',
      status: 'skipped',
      wallTime: 'unavailable',
      delta: 'duration unavailable',
      instrumented: false,
    },
  ]
  const data: PipelineReportData = {
    rows,
    gantt: 'gantt\n    section Jobs\n    slow-0 (success) :job0, 2026-10-01 00:00:00+0000, 900s',
    omittedBars: 1,
    baselineRunIds: [101],
    skippedBaselineRunIds: [102],
    baselineCounts: { regressed: 7 },
    counts: { success: 7, failure: 1, skipped: 1 },
    timeline: {
      attempt: 2,
      jobs: [
        {
          name: 'slow-0',
          status: 'success',
          attempt: 1,
          start: 0,
          end: 900_000,
          steps: [{ name: 'Build', status: 'success', start: 1000, end: 899_000 }],
        },
      ],
    },
    waterfall: {
      lightUrl: `https://gitbucket.schickling.dev/api/get/${'a'.repeat(64)}`,
      darkUrl: `https://gitbucket.schickling.dev/api/get/${'b'.repeat(64)}`,
    },
  }
  const recordFor = (reportData: PipelineReportData): WorkflowReportRecord =>
    decodeWorkflowReportRecord({
      ...sampleRecord,
      id: 'pipeline-traces:123:2',
      kind: 'pipeline-traces',
      subject: { id: 'pipeline-traces', label: 'Run 123 · attempt 2' },
      title: 'Pipeline traces',
      summary: '9 jobs; 7 successful, 1 failed, 1 skipped',
      data: reportData,
    })
  const render = (reportData: PipelineReportData) =>
    renderWorkflowReportCommentBody({
      title: 'Pipeline traces',
      noRecordsMessage: 'Jobs API report unavailable.',
      state: deriveWorkflowReportManagedState({
        stateId: 'pipeline-traces',
        entryId: '123/2',
        entryLabel: 'Run 123',
        createdAtUtc: sampleRecord.createdAtUtc,
        records: [recordFor(reportData)],
      }),
    })

  it('preserves timings and both image URLs through marked record transport', () => {
    const record = recordFor(data)
    const transported = parseMarkedWorkflowReportJsonl(encodeWorkflowReportRecordLine(record))
    expect(transported.records[0]?.data).toEqual(data)
  })

  it('shows failures, slow jobs and regressions inline while retaining every other row collapsed', () => {
    const body = render(data)
    const inline = body.slice(0, body.indexOf('<details>'))
    const collapsed = body.slice(body.indexOf('<details>'), body.indexOf('</details>'))
    for (const name of [
      'failed-fast',
      'regressed',
      'slow-0',
      'slow-1',
      'slow-2',
      'slow-3',
      'slow-4',
    ]) {
      expect(inline).toContain(`| ${name} |`)
      expect(collapsed).not.toContain(`| ${name} |`)
    }
    expect(inline).not.toContain('| ordinary')
    expect(collapsed).toContain('| ordinary \\| &lt;job&gt; |')
    expect(collapsed).toContain('| skipped |')
    expect(body).toContain('n=7')
    expect(body).toContain('Selected main run IDs: 101.')
    expect(body).toContain('Skipped main run IDs (Jobs API unavailable): 102.')
  })

  it('publishes a theme-aware image before the table without duplicating its Mermaid fallback', () => {
    const body = render(data)
    expect(body).toContain('<picture>')
    expect(body).toContain('prefers-color-scheme: dark')
    expect(body).toContain(data.waterfall!.lightUrl)
    expect(body).toContain(data.waterfall!.darkUrl)
    expect(body.indexOf('<picture>')).toBeLessThan(body.indexOf('| Job |'))
    expect(body).not.toContain('```mermaid')
    expect(extractWorkflowReportManagedState(body)?.entries[0]?.records[0]?.data).toBeUndefined()
  })

  it('falls back to jobs-only Mermaid when images are absent or either URL is unsafe', () => {
    const { waterfall: _waterfall, ...withoutImages } = data
    for (const reportData of [
      withoutImages,
      { ...data, waterfall: { ...data.waterfall!, lightUrl: 'javascript:alert(1)' } },
      {
        ...data,
        waterfall: {
          ...data.waterfall!,
          darkUrl: 'https://gitbucket.schickling.dev/" onerror="x.png',
        },
      },
    ]) {
      const body = render(reportData)
      expect(body).toContain('```mermaid\ngantt')
      expect(body).toContain('slow-0 (success) :job0')
      expect(body).not.toContain('<picture>')
      expect(body).not.toContain('onerror=')
      expect(body).not.toContain('javascript:')
      expect(body).not.toContain('    Build :')
    }
  })

  it('fits oversized image-backed reports and retains decodable identity metadata', () => {
    const body = render({
      ...data,
      rows: Array.from({ length: 80 }, (_, index) => ({
        ...row(`job-${index}`, 100_000 - index),
        instrumented: true,
        traceUrl: `https://grafana.example.test/explore?${'q'.repeat(2000)}`,
      })),
    })
    expect(body.length).toBeLessThanOrEqual(60_000)
    expect(body).toMatch(/\d+ additional job row\(s\) omitted to fit the GitHub comment limit\./u)
    const retained = extractWorkflowReportManagedState(body, { stateId: 'pipeline-traces' })
    expect(retained?.entries.map((entry) => entry.entryId)).toEqual(['123/2'])
    expect(retained?.entries[0]?.records[0]?.id).toBe('pipeline-traces:123:2')
    expect(retained?.entries[0]?.records[0]?.data).toBeUndefined()
  })
})
