import { createGenieOutput } from '../core.ts'
import type { GenieOutput, Strict } from '../mod.ts'
import * as yaml from '../utils/yaml.ts'
import type { GenieValidationIssue } from '../validation/mod.ts'

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

type RepositoryDispatchConfig = {
  types?: string[]
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
            : K extends 'repository_dispatch'
              ? RepositoryDispatchConfig | null
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

const invalidRunnerLabelPattern = /(^|[=:])(undefined|null)$/
const githubExpressionStart = '${{'
const githubExpressionEnd = '}}'

const validateRunsOn = ({
  jobName,
  runsOn,
  location,
}: {
  jobName: string
  runsOn: unknown
  location: string
}): GenieValidationIssue[] => {
  const labels = Array.isArray(runsOn) === true ? runsOn : [runsOn]
  const issues: GenieValidationIssue[] = []

  if (labels.length === 0) {
    issues.push({
      severity: 'error',
      packageName: location,
      dependency: `jobs.${jobName}.runs-on`,
      message: `jobs.${jobName}.runs-on must include at least one runner label.`,
      rule: 'github-workflow-runs-on-empty',
    })
    return issues
  }

  for (const [index, label] of labels.entries()) {
    const dependency = `jobs.${jobName}.runs-on[${index}]`
    if (typeof label !== 'string') {
      issues.push({
        severity: 'error',
        packageName: location,
        dependency,
        message: `jobs.${jobName}.runs-on must serialize to string labels, got ${String(label)}.`,
        rule: 'github-workflow-runs-on-non-string',
      })
      continue
    }

    if (label.trim() === '') {
      issues.push({
        severity: 'error',
        packageName: location,
        dependency,
        message: `jobs.${jobName}.runs-on labels must not be empty.`,
        rule: 'github-workflow-runs-on-empty-label',
      })
      continue
    }

    if (invalidRunnerLabelPattern.test(label) === true) {
      issues.push({
        severity: 'error',
        packageName: location,
        dependency,
        message: `jobs.${jobName}.runs-on contains a stale placeholder label (${label}). This usually means a CI helper API drifted and serialized undefined/null into the workflow.`,
        rule: 'github-workflow-runs-on-placeholder',
      })
    }
  }

  return issues
}

/**
 * TODO: Remove this validator once upstream ca-derivations issues are resolved
 * (NixOS/nix#12361, cachix/devenv#2364)
 */
const validateDeterminateNixExtraConf = ({
  args,
  location,
}: {
  args: GitHubWorkflowArgs
  location: string
}): GenieValidationIssue[] => {
  const issues: GenieValidationIssue[] = []

  for (const [jobName, job] of Object.entries(args.jobs)) {
    for (const [stepIndex, step] of job.steps.entries()) {
      if ('uses' in step === false) continue
      if (step.uses.startsWith('DeterminateSystems/determinate-nix-action') === false) continue

      const extraConf = step.with?.['extra-conf']
      if (typeof extraConf === 'string' && extraConf.includes('experimental-features') === true)
        continue

      issues.push({
        severity: 'warning',
        packageName: location,
        dependency: `jobs.${jobName}.steps[${stepIndex}]`,
        message: `jobs.${jobName}.steps[${stepIndex}] uses DeterminateSystems/determinate-nix-action without "experimental-features" in extra-conf. Determinate Nix enables ca-derivations by default which causes store path validity failures with devenv. Add "experimental-features = nix-command flakes" to extra-conf.`,
        rule: 'github-workflow-determinate-nix-extra-conf',
      })
    }
  }

  return issues
}

const containsNestedGitHubExpression = (value: string) => {
  const trimmed = value.trim()
  if (trimmed.startsWith(githubExpressionStart) === false) return false

  const firstExpressionClose = trimmed.indexOf(githubExpressionEnd, githubExpressionStart.length)
  if (firstExpressionClose === -1) return false

  const nestedExpressionStart = trimmed.indexOf(githubExpressionStart, githubExpressionStart.length)
  if (nestedExpressionStart === -1) return false

  return nestedExpressionStart < firstExpressionClose
}

const validateGitHubExpressionStrings = ({
  value,
  dependency,
  location,
}: {
  value: unknown
  dependency: string
  location: string
}): GenieValidationIssue[] => {
  if (typeof value === 'string') {
    if (containsNestedGitHubExpression(value) === false) return []

    return [
      {
        severity: 'error',
        packageName: location,
        dependency,
        message: `${dependency} contains a nested GitHub Actions expression. GitHub does not allow \`${githubExpressionStart} ... ${githubExpressionEnd}\` inside another expression. Precompute the fallback string in TypeScript instead of nesting expressions in YAML.`,
        rule: 'github-workflow-expression-nesting',
      },
    ]
  }

  if (Array.isArray(value) === true) {
    return value.flatMap((item, index) =>
      validateGitHubExpressionStrings({
        value: item,
        dependency: `${dependency}[${index}]`,
        location,
      }),
    )
  }

  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entryValue]) =>
      validateGitHubExpressionStrings({
        value: entryValue,
        dependency: dependency === '' ? key : `${dependency}.${key}`,
        location,
      }),
    )
  }

  return []
}

const validateWorkflow = ({
  args,
  location,
}: {
  args: GitHubWorkflowArgs
  location: string
}): GenieValidationIssue[] => {
  const issues: GenieValidationIssue[] = []

  for (const [jobName, job] of Object.entries(args.jobs)) {
    issues.push(...validateRunsOn({ jobName, runsOn: job['runs-on'], location }))
  }

  issues.push(...validateDeterminateNixExtraConf({ args, location }))
  issues.push(
    ...validateGitHubExpressionStrings({
      value: args,
      dependency: '',
      location,
    }),
  )

  return issues
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
export const githubWorkflow = <const T extends GitHubWorkflowArgs>(
  args: Strict<T, GitHubWorkflowArgs>,
): GenieOutput<T> =>
  createGenieOutput({
    data: args,
    stringify: (_ctx) => yaml.stringify(args),
    validate: (ctx) => validateWorkflow({ args, location: ctx.location }),
  })
