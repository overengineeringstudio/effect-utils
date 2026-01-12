import type { GenieOutput } from '../mod.ts'
import * as yaml from '../utils/yaml.ts'

/**
 * Type-safe GitHub Actions workflow generator
 * Reference: https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions
 */

type Expression = `\${{ ${string} }}`

type EventTrigger =
  | 'branch_protection_rule'
  | 'check_run'
  | 'check_suite'
  | 'create'
  | 'delete'
  | 'deployment'
  | 'deployment_status'
  | 'discussion'
  | 'discussion_comment'
  | 'fork'
  | 'gollum'
  | 'issue_comment'
  | 'issues'
  | 'label'
  | 'merge_group'
  | 'milestone'
  | 'page_build'
  | 'project'
  | 'project_card'
  | 'project_column'
  | 'public'
  | 'pull_request'
  | 'pull_request_comment'
  | 'pull_request_review'
  | 'pull_request_review_comment'
  | 'pull_request_target'
  | 'push'
  | 'registry_package'
  | 'release'
  | 'repository_dispatch'
  | 'schedule'
  | 'status'
  | 'watch'
  | 'workflow_call'
  | 'workflow_dispatch'
  | 'workflow_run'

type PushPullRequestTriggerConfig = {
  branches?: string[]
  'branches-ignore'?: string[]
  paths?: string[]
  'paths-ignore'?: string[]
  tags?: string[]
  'tags-ignore'?: string[]
}

type ScheduleTrigger = {
  cron: string
}

type WorkflowDispatchInput = {
  description?: string
  required?: boolean
  default?: string | boolean | number
  type?: 'boolean' | 'choice' | 'environment' | 'string' | 'number'
  options?: string[]
}

type WorkflowDispatchConfig = {
  inputs?: Record<string, WorkflowDispatchInput>
}

type WorkflowCallInput = {
  description?: string
  required?: boolean
  default?: string | boolean | number
  type: 'boolean' | 'number' | 'string'
}

type WorkflowCallSecret = {
  description?: string
  required?: boolean
}

type WorkflowCallOutput = {
  description?: string
  value: string
}

type WorkflowCallConfig = {
  inputs?: Record<string, WorkflowCallInput>
  outputs?: Record<string, WorkflowCallOutput>
  secrets?: Record<string, WorkflowCallSecret>
}

type WorkflowRunConfig = {
  workflows: string[]
  types?: ('completed' | 'requested' | 'in_progress')[]
  branches?: string[]
  'branches-ignore'?: string[]
}

type OnConfig = {
  [K in EventTrigger]?: K extends 'push' | 'pull_request' | 'pull_request_target'
    ? PushPullRequestTriggerConfig | null
    : K extends 'schedule'
      ? ScheduleTrigger[]
      : K extends 'workflow_dispatch'
        ? WorkflowDispatchConfig | null
        : K extends 'workflow_call'
          ? WorkflowCallConfig | null
          : K extends 'workflow_run'
            ? WorkflowRunConfig
            : null
}

type PermissionLevel = 'read' | 'write' | 'none'

type Permissions =
  | 'read-all'
  | 'write-all'
  | {
      actions?: PermissionLevel
      attestations?: PermissionLevel
      checks?: PermissionLevel
      contents?: PermissionLevel
      deployments?: PermissionLevel
      'id-token'?: PermissionLevel
      issues?: PermissionLevel
      discussions?: PermissionLevel
      packages?: PermissionLevel
      pages?: PermissionLevel
      'pull-requests'?: PermissionLevel
      'repository-projects'?: PermissionLevel
      'security-events'?: PermissionLevel
      statuses?: PermissionLevel
    }

type Environment = {
  name: string
  url?: string
}

type Matrix = {
  include?: Array<Record<string, unknown>>
  exclude?: Array<Record<string, unknown>>
} & Record<string, unknown[] | undefined>

type Strategy = {
  matrix?: Matrix | Expression
  'fail-fast'?: boolean
  'max-parallel'?: number
}

type Container = {
  image: string
  credentials?: {
    username: string
    password: string
  }
  env?: Record<string, string>
  ports?: number[]
  volumes?: string[]
  options?: string
}

type Service = {
  image: string
  credentials?: {
    username: string
    password: string
  }
  env?: Record<string, string>
  ports?: (number | string)[]
  volumes?: string[]
  options?: string
}

type StepBase = {
  id?: string
  name?: string
  if?: string
  env?: Record<string, string>
  'continue-on-error'?: boolean
  'timeout-minutes'?: number
  'working-directory'?: string
}

type RunStep = StepBase & {
  run: string
  shell?: 'bash' | 'pwsh' | 'python' | 'sh' | 'cmd' | 'powershell' | string
}

type UsesStep = StepBase & {
  uses: string
  with?: Record<string, string | number | boolean>
}

type Step = RunStep | UsesStep

type Defaults = {
  run?: {
    shell?: string
    'working-directory'?: string
  }
}

type Concurrency = {
  group: string
  'cancel-in-progress'?: boolean
}

type Job = {
  name?: string
  'runs-on': string | string[]
  needs?: string | string[]
  if?: string
  permissions?: Permissions
  environment?: string | Environment
  concurrency?: string | Concurrency
  outputs?: Record<string, string>
  env?: Record<string, string>
  defaults?: Defaults
  steps: Step[]
  'timeout-minutes'?: number
  strategy?: Strategy
  'continue-on-error'?: boolean
  container?: string | Container
  services?: Record<string, Service>
}

/** Arguments for generating a GitHub Actions workflow file */
export type GitHubWorkflowArgs = {
  /** Workflow name displayed in GitHub UI */
  name?: string
  /** Event triggers for the workflow */
  on: OnConfig | EventTrigger | EventTrigger[]
  /** Workflow-level permissions */
  permissions?: Permissions
  /** Environment variables for all jobs */
  env?: Record<string, string>
  /** Default settings for all jobs */
  defaults?: Defaults
  /** Concurrency settings */
  concurrency?: string | Concurrency
  /** Jobs to run */
  jobs: Record<string, Job>
  /** Workflow run name */
  'run-name'?: string
}

/**
 * Creates a GitHub Actions workflow YAML configuration.
 *
 * Returns a `GenieOutput` with the structured data accessible via `.data`
 * for composition with other genie files.
 *
 * @example
 * ```ts
 * export default githubWorkflow({
 *   name: "CI",
 *   on: {
 *     push: { branches: ["main"] },
 *     pull_request: { branches: ["main"] }
 *   },
 *   jobs: {
 *     build: {
 *       "runs-on": "ubuntu-latest",
 *       steps: [
 *         { uses: "actions/checkout@v4" },
 *         { run: "npm test" }
 *       ]
 *     }
 *   }
 * })
 * ```
 */
export const githubWorkflow = <const T extends GitHubWorkflowArgs>(args: T): GenieOutput<T> => ({
  data: args,
  stringify: (_ctx) => yaml.stringify(args),
})
