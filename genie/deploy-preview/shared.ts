import { workflowReportRecordLineMarker } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { workflowReportRuntimeModuleSetup as sharedWorkflowReportRuntimeModuleSetup } from '../ci-workflow/shared.ts'

export const deployTargetEnvSuffix = (name: string) =>
  name
    .toUpperCase()
    .replaceAll('-', '_')
    .replaceAll(/[^A-Z0-9_]/g, '')

export const workflowReportMarker = workflowReportRecordLineMarker
export const workflowReportSchemaVersion = 1
export const workflowReportKind = 'deploy-preview'
export const workflowReportOutputName = 'workflow_report'
export const workflowReportPathOutputName = 'workflow_report_path'

export const workflowReportEnvKey = (name: string) =>
  `WORKFLOW_REPORT_${deployTargetEnvSuffix(name)}`

export const workflowReportPathEnvKey = (name: string) =>
  `WORKFLOW_REPORT_PATH_${deployTargetEnvSuffix(name)}`

export const workflowReportRuntimeModuleSetup = sharedWorkflowReportRuntimeModuleSetup()
