import { workflowReportRecordLineMarker } from '../../packages/@overeng/genie/src/runtime/mod.ts'

export const deployTargetEnvSuffix = (name: string) =>
  name
    .toUpperCase()
    .replaceAll('-', '_')
    .replaceAll(/[^A-Z0-9_]/g, '')

export const deployPreviewManagedMarker = '<!-- deploy-preview-comment:managed -->'
export const deployPreviewStatePrefix = '<!-- deploy-preview-comment:state\n'
export const deployPreviewStateSuffix = '\n-->'

export const workflowReportMarker = workflowReportRecordLineMarker
export const workflowReportSchemaVersion = 1
export const workflowReportKind = 'deploy-preview'
export const workflowReportOutputName = 'workflow_report'
export const workflowReportPathOutputName = 'workflow_report_path'

export const workflowReportEnvKey = (name: string) =>
  `WORKFLOW_REPORT_${deployTargetEnvSuffix(name)}`

export const workflowReportPathEnvKey = (name: string) =>
  `WORKFLOW_REPORT_PATH_${deployTargetEnvSuffix(name)}`
