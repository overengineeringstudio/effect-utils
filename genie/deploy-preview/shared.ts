import { workflowReportRecordLineMarker } from '../../packages/@overeng/workflow-report/src/mod.ts'
export {
  workflowReportCommand,
  workflowReportEnv,
  workflowReportNixTokenSetup,
} from '../ci-workflow/shared.ts'

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
