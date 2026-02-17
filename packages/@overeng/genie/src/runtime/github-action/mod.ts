import type { GenieOutput, Strict } from '../mod.ts'
import * as yaml from '../utils/yaml.ts'

type Expression = `\${{ ${string} }}`

type InputValue = string | number | boolean

type ActionInput = {
  description?: string
  required?: boolean
  default?: InputValue
  deprecationMessage?: string
}

type ActionOutput = {
  description?: string
  value?: string
}

type ActionStepBase = {
  id?: string
  name?: string
  if?: string
  env?: Record<string, string>
  'continue-on-error'?: boolean
  'working-directory'?: string
}

type ActionRunStep = ActionStepBase & {
  run: string
  shell: 'bash' | 'pwsh' | 'python' | 'sh' | 'cmd' | 'powershell' | string
}

type ActionUsesStep = ActionStepBase & {
  uses: string
  with?: Record<string, InputValue | Expression>
}

type ActionStep = ActionRunStep | ActionUsesStep

type CompositeRuns = {
  using: 'composite'
  steps: ActionStep[]
}

type NodeRuns = {
  using: 'node20' | 'node24' | 'node16'
  main: string
  pre?: string
  post?: string
  'pre-if'?: string
  'post-if'?: string
}

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

/** Arguments for generating a GitHub Action metadata file. */
export type GitHubActionArgs = {
  name: string
  description?: string
  author?: string
  inputs?: Record<string, ActionInput>
  outputs?: Record<string, ActionOutput>
  runs: CompositeRuns | NodeRuns | DockerRuns
  branding?: ActionBranding
}

/**
 * Creates a GitHub Action metadata file (`action.yml`).
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
