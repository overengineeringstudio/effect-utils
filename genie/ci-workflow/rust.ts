import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import {
  cachixCliBuildStep,
  cachixStep,
  checkoutStep,
  installNixStep,
  namespaceRunner,
} from './setup.ts'
import { bashShellDefaults, RUNNER_PROFILES, shellSingleQuote } from './shared.ts'

type WorkflowJob = GitHubWorkflowArgs['jobs'][string]
type WorkflowStep = WorkflowJob['steps'][number]
type RunStep = WorkflowStep & { run: string }

/** Plain flakes need neither devenv nor the megarepo dependency preparation steps. */
export type PlainFlakeSetupOptions = {
  readonly nix?: Parameters<typeof installNixStep>[0]
  /** Public, read-only Cachix cache; no publishing credentials are accepted. */
  readonly cachix?: string
}

/** Install Determinate Nix, optionally enabling a read-only Cachix cache. */
export const plainFlakeSetupSteps = ({
  nix,
  cachix,
}: PlainFlakeSetupOptions = {}): WorkflowStep[] => [
  installNixStep(nix),
  ...(cachix === undefined ? [] : [cachixCliBuildStep, cachixStep({ name: cachix })]),
]

export type NixDevelopStepOptions = {
  readonly name: string
  /** An argv vector, not a shell fragment. Shell metacharacters remain literal. */
  readonly command: readonly [string, ...string[]]
  /** Optional flake/devShell installable, for example '.#ci'. */
  readonly flake?: string
}

const shellArgument = (value: string): string =>
  /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) === true ? value : shellSingleQuote(value)

/** Run a command supplied by the consumer's devShell without a nested shell. */
export const nixDevelopStep = ({ name, command, flake }: NixDevelopStepOptions): RunStep => ({
  name,
  shell: 'bash',
  run: ['nix', 'develop', ...(flake === undefined ? [] : [flake]), '-c', ...command]
    .map(shellArgument)
    .join(' '),
})

export const cargoFmtStep = (): RunStep =>
  nixDevelopStep({ name: 'Cargo fmt', command: ['cargo', 'fmt', '--all', '--', '--check'] })

export type CargoClippyOptions = {
  /** Cargo or rustc flags, for example ['--', '-D', 'warnings']. */
  readonly extraArgs?: readonly string[]
}

export const cargoClippyStep = ({ extraArgs = [] }: CargoClippyOptions = {}): RunStep =>
  nixDevelopStep({
    name: 'Cargo clippy',
    command: ['cargo', 'clippy', '--workspace', '--all-targets', '--locked', ...extraArgs],
  })

export type CargoNextestOptions = {
  /** Failed-test retries; zero disables retries. */
  readonly retries?: number
  /** Nextest accepts a count, 'num-cpus', or a relative count such as 'num-cpus/2'. */
  readonly testThreads?: number | string
  /** Additional nextest options, for example ['--profile', 'ci']. */
  readonly extraArgs?: readonly string[]
}

export const cargoNextestStep = ({
  retries = 2,
  testThreads,
  extraArgs = [],
}: CargoNextestOptions = {}): RunStep =>
  nixDevelopStep({
    name: 'Cargo nextest',
    command: [
      'cargo',
      'nextest',
      'run',
      '--workspace',
      '--locked',
      '--retries',
      String(retries),
      ...(testThreads === undefined ? [] : ['--test-threads', String(testThreads)]),
      ...extraArgs,
    ],
  })

export type PlainFlakeJobOptions = PlainFlakeSetupOptions &
  Omit<WorkflowJob, 'runs-on' | 'steps'> & {
    readonly runsOn?: WorkflowJob['runs-on']
    /** Run after checkout/Nix setup, before the command. */
    readonly preSteps?: readonly WorkflowStep[]
    readonly postSteps?: readonly WorkflowStep[]
  }

/** Wrap one command; callers retain job gates, matrix, environment and timeout control. */
export const plainFlakeJob = ({
  step,
  runsOn = [...namespaceRunner({ profile: RUNNER_PROFILES[0], runId: '${{ github.run_id }}' })],
  nix,
  cachix,
  preSteps = [],
  postSteps = [],
  permissions = { contents: 'read' },
  defaults = bashShellDefaults,
  ...job
}: PlainFlakeJobOptions & { readonly step: WorkflowStep }): WorkflowJob => ({
  ...job,
  'runs-on': runsOn,
  permissions,
  defaults,
  steps: [
    checkoutStep(),
    ...plainFlakeSetupSteps({ nix, cachix }),
    ...preSteps,
    step,
    ...postSteps,
  ],
})

export const cargoFmtJob = (opts: PlainFlakeJobOptions = {}): WorkflowJob =>
  plainFlakeJob({ ...opts, step: cargoFmtStep() })

export const cargoClippyJob = ({
  extraArgs,
  ...opts
}: PlainFlakeJobOptions & CargoClippyOptions = {}): WorkflowJob =>
  plainFlakeJob({ ...opts, step: cargoClippyStep({ extraArgs }) })

export const cargoNextestJob = ({
  retries,
  testThreads,
  extraArgs,
  ...opts
}: PlainFlakeJobOptions & CargoNextestOptions = {}): WorkflowJob =>
  plainFlakeJob({ ...opts, step: cargoNextestStep({ retries, testThreads, extraArgs }) })

/** The consumer devShell supplies genie and a repos/effect-utils input-store symlink. */
export const plainFlakeGenieCheckJob = (opts: PlainFlakeJobOptions = {}): WorkflowJob =>
  plainFlakeJob({
    ...opts,
    step: nixDevelopStep({ name: 'Check generated files', command: ['genie', '--check'] }),
  })
