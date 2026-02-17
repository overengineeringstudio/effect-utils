import type { GenieOutput, Strict } from '../mod.ts'
import * as yaml from '../utils/yaml.ts'

/**
 * GitHub Actions expression string in `${{ ... }}` format.
 *
 * @see https://docs.github.com/en/actions/learn-github-actions/expressions
 */
type Expression = `\${{ ${string} }}`

type InputValue = string | number | boolean

/**
 * Action input definition in `action.yml`.
 *
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions#inputs
 */
type ActionInput = {
  description?: string
  required?: boolean
  default?: InputValue
  deprecationMessage?: string
}

/**
 * Generic action output definition.
 *
 * For non-composite actions, output mappings are optional in metadata.
 *
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions#outputs-for-docker-container-and-javascript-actions
 */
type ActionOutput = {
  description?: string
  value?: string
}

/**
 * Composite action output definition.
 *
 * GitHub requires `value` mappings for composite outputs.
 *
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions#outputs-for-composite-actions
 */
type CompositeActionOutput = {
  description?: string
  value: string
}

/**
 * Common fields shared by `run` and `uses` steps.
 *
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions#runssteps
 */
type ActionStepBase = {
  id?: string
  name?: string
  if?: string
  env?: Record<string, string>
  'continue-on-error'?: boolean
  'working-directory'?: string
}

/** Composite action `run` step. Mutually exclusive with `uses` step fields. */
type ActionRunStep = ActionStepBase & {
  run: string
  shell: 'bash' | 'pwsh' | 'python' | 'sh' | 'cmd' | 'powershell' | string
  uses?: never
  with?: never
}

/** Composite action `uses` step. Mutually exclusive with `run` step fields. */
type ActionUsesStep = ActionStepBase & {
  uses: string
  with?: Record<string, InputValue | Expression>
  run?: never
  shell?: never
}

/** Composite action step variant. */
type ActionStep = ActionRunStep | ActionUsesStep

/**
 * `runs` block for composite actions.
 *
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action
 */
type CompositeRuns = {
  using: 'composite'
  steps: ActionStep[]
}

/**
 * `runs` block for JavaScript actions.
 *
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-javascript-action
 */
type NodeRuns = {
  using: 'node20' | 'node24' | 'node16'
  main: string
  pre?: string
  post?: string
  'pre-if'?: string
  'post-if'?: string
}

/**
 * `runs` block for Docker container actions.
 *
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-docker-container-action
 */
type DockerRuns = {
  using: 'docker'
  image: string
  entrypoint?: string
  args?: string[]
  env?: Record<string, string>
}

type ActionBrandingColor =
  | 'white'
  | 'yellow'
  | 'blue'
  | 'green'
  | 'orange'
  | 'red'
  | 'purple'
  | 'gray-dark'

type ActionBranding = {
  icon: string
  color: ActionBrandingColor
}

/** Common action metadata fields shared across all `runs` variants. */
type GitHubActionArgsBase = {
  name: string
  description?: string
  author?: string
  inputs?: Record<string, ActionInput>
  branding?: ActionBranding
}

/**
 * Arguments for generating a GitHub Action metadata file.
 *
 * The union is discriminated by `runs.using` to enforce variant-specific rules
 * (for example: composite outputs require `value` mappings).
 *
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions
 */
export type GitHubActionArgs =
  | (GitHubActionArgsBase & {
      outputs?: Record<string, CompositeActionOutput>
      runs: CompositeRuns
    })
  | (GitHubActionArgsBase & {
      outputs?: Record<string, ActionOutput>
      runs: NodeRuns | DockerRuns
    })

/**
 * Creates a GitHub Action metadata file (`action.yml`).
 *
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions
 *
 * @example
 * ```ts
 * export default githubAction({
 *   name: 'CI bootstrap',
 *   description: 'Setup shared CI prerequisites',
 *   inputs: {
 *     'cache-name': {
 *       description: 'Cachix cache name',
 *       required: true,
 *     },
 *   },
 *   runs: {
 *     using: 'composite',
 *     steps: [
 *       {
 *         name: 'Checkout',
 *         uses: 'actions/checkout@v4',
 *       },
 *     ],
 *   },
 * })
 * ```
 */
export const githubAction = <const T extends GitHubActionArgs>(
  args: Strict<T, GitHubActionArgs>,
): GenieOutput<T> => ({
  data: args,
  stringify: () => yaml.stringify(args),
})
