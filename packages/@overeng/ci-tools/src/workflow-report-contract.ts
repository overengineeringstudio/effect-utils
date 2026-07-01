/* oxlint-disable overeng/jsdoc-require-exports -- Dependency-free wire contract used by generated workflow code. */

export const workflowReportRecordLineMarker = 'WORKFLOW_REPORT_V1: ' as const
export const workflowReportManagedMarker = '<!-- workflow-report:managed -->' as const

export type WorkflowReportStatus = 'success' | 'failure' | 'skipped' | 'neutral'

export type WorkflowReportSubject = {
  readonly id: string
  readonly label?: string
}

export type WorkflowReportLink = {
  readonly label: string
  readonly url: string
  readonly primary?: boolean
}

export type WorkflowReportRecord = {
  readonly _tag: 'WorkflowReportRecord'
  readonly schemaVersion: 1
  readonly id: string
  readonly kind: string
  readonly subject: WorkflowReportSubject
  readonly status: WorkflowReportStatus
  readonly title: string
  readonly summary?: string
  readonly createdAtUtc: string
  readonly links?: readonly WorkflowReportLink[]
  readonly data?: Readonly<Record<string, unknown>>
}

export const encodeWorkflowReportRecordLine = ({
  record,
  marker = workflowReportRecordLineMarker,
}: {
  readonly record: WorkflowReportRecord
  readonly marker?: string
}) => `${marker}${JSON.stringify(record)}`
