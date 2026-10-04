import { defaultActionlintConfig } from '../../genie/ci-workflow.ts'
import {
  githubWorkflow,
  type GitHubWorkflowArgs,
} from '../../packages/@overeng/genie/src/runtime/mod.ts'
import normalCI from './ci.yml.genie.ts'

// Job definitions and this benchmark subject must come from the same source revision.
const benchmarkCommit = 'edba8e895e87f5ec0a96cb8ed09cd9cfc35188cb'
const baselineProfile = 'namespace-profile-effect-utils-benchmark-linux-baseline'
const candidateProfile = 'namespace-profile-effect-utils-benchmark-linux-candidate'
const lanes = [
  'typecheck',
  'lint',
  'native-dependency-policy',
  'default-ref-policy',
  'source-shape',
  'nix-closure-sizes',
] as const
type Job = GitHubWorkflowArgs['jobs'][string]

// Clone existing jobs, substituting subject metadata and disabling optional backfill/debug inputs.
// No task command, setup action, coverage selection, timeout or permission is removed.
const pinExpressions = (job: Job): Job =>
  JSON.parse(
    JSON.stringify(job, (_key, value: unknown) =>
      typeof value === 'string'
        ? value
            .replaceAll('github.sha', 'inputs.benchmark_commit')
            .replaceAll('inputs.measurement_baseline_ref', "''")
            .replaceAll('inputs.measurement_baseline_label', "''")
            .replaceAll('inputs.debug_force_nix_diagnostics_failure', 'false')
            // Empty Nix cache settings retain their value without inherited trailing spaces.
            .replaceAll(/^(extra-(?:substituters|trusted-public-keys) =) +$/gm, '$1')
        : value,
    ),
  )

const selectedJob = (lane: (typeof lanes)[number]): Job => {
  const original: Job = normalCI.data.jobs[lane]
  const pinned = pinExpressions(original)
  return {
    ...pinned,
    if: `\${{ inputs.lane == '${lane}' }}`,
    'runs-on': [
      `\${{ inputs.profile == 'candidate' && '${candidateProfile}' || '${baselineProfile}' }}`,
      'namespace-features:github.run-id=${{ github.run_id }}',
    ],
    concurrency: {
      group: 'namespace-sizing-${{ github.run_id }}-${{ github.run_attempt }}',
      'cancel-in-progress': false,
    },
    env: {
      ...pinned.env,
      CI_MEASUREMENT_SUBJECT_REF: '${{ inputs.benchmark_commit }}',
      CI_MEASUREMENT_SUBJECT_SHA: '${{ inputs.benchmark_commit }}',
      CI_MEASUREMENT_SUBJECT_LABEL: '${{ inputs.pair_id }}',
    },
    steps: [
      {
        name: 'Validate pinned benchmark subject',
        shell: 'bash',
        env: {
          BENCHMARK_COMMIT: '${{ inputs.benchmark_commit }}',
          PAIR_ID: '${{ inputs.pair_id }}',
          CACHE_STATE: '${{ inputs.cache_state }}',
          PROFILE_KIND: '${{ inputs.profile }}',
          PROFILE_LABEL: `\${{ inputs.profile == 'candidate' && '${candidateProfile}' || '${baselineProfile}' }}`,
          BENCHMARK_LANE: lane,
        },
        run:
          `set -euo pipefail\n[[ "$BENCHMARK_COMMIT" == '${benchmarkCommit}' ]] || { echo 'Unsupported subject: regenerate this workflow from the intended pinned source revision'; exit 1; }\n[[ "$PAIR_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$ ]] || { echo 'Pair ID must be 1-80 ASCII letters, digits, dots, underscores or hyphens and start with a letter or digit'; exit 1; }\n[[ "$CACHE_STATE" == warm || "$CACHE_STATE" == cold ]]\n[[ "$PROFILE_KIND" == baseline || "$PROFILE_KIND" == candidate ]]\n` +
          String.raw`python3 - <<'PY'
import json, os
record = {
    'repository': os.environ['GITHUB_REPOSITORY'],
    'lane': os.environ['BENCHMARK_LANE'],
    'commit': os.environ['BENCHMARK_COMMIT'],
    'pair_id': os.environ['PAIR_ID'],
    'profile': os.environ['PROFILE_LABEL'],
    'profile_kind': os.environ['PROFILE_KIND'],
    'cache_state_declared': os.environ['CACHE_STATE'],
    'cache_state_verified': False,
    'github_run_id': os.environ['GITHUB_RUN_ID'],
    'github_run_attempt': os.environ['GITHUB_RUN_ATTEMPT'],
}
with open(os.path.join(os.environ['RUNNER_TEMP'], 'namespace-sizing-run-manifest.json'), 'w') as handle:
    json.dump(record, handle, indent=2)
PY`,
      },
      ...pinned.steps.flatMap((step) => {
        if ('uses' in step === false || step.uses?.startsWith('actions/checkout@') !== true)
          return [step]
        return [
          { ...step, with: { ...step.with, ref: '${{ inputs.benchmark_commit }}' } },
          {
            name: 'Verify checked-out benchmark subject',
            if: step.if,
            shell: 'bash',
            env: { BENCHMARK_COMMIT: '${{ inputs.benchmark_commit }}' },
            run: 'set -euo pipefail\n[[ "$(git rev-parse HEAD)" == "$BENCHMARK_COMMIT" ]]',
          },
        ]
      }),
      {
        name: 'Retain Namespace benchmark run manifest',
        if: '${{ always() }}',
        uses: 'actions/upload-artifact@v4',
        with: {
          name: 'namespace-sizing-run-manifest-${{ github.run_id }}-${{ github.run_attempt }}',
          path: '${{ runner.temp }}/namespace-sizing-run-manifest.json',
          'if-no-files-found': 'error',
        },
      },
    ],
  }
}

export default githubWorkflow({
  name: 'Namespace sizing benchmark',
  'run-name':
    'Namespace sizing: ${{ inputs.lane }} / ${{ inputs.profile }} / ${{ inputs.pair_id }}',
  on: {
    workflow_dispatch: {
      inputs: {
        benchmark_commit: {
          description: 'Exact supported benchmark subject SHA',
          type: 'string',
          required: true,
          default: benchmarkCommit,
        },
        lane: {
          description:
            'Run exactly one existing Linux CI lane; weaver requires a pinned comparison base',
          type: 'choice',
          required: true,
          options: [...lanes],
          default: 'source-shape',
        },
        profile: {
          description: 'Namespace baseline or dedicated candidate profile',
          type: 'choice',
          required: true,
          options: ['baseline', 'candidate'],
          default: 'baseline',
        },
        pair_id: {
          description: 'Matched baseline/candidate pair identifier',
          type: 'string',
          required: true,
        },
        cache_state: {
          description: 'Operator-recorded condition; this input does not warm or clear caches',
          type: 'choice',
          required: true,
          options: ['warm', 'cold'],
        },
      },
    },
  },
  permissions: normalCI.data.permissions,
  actionlint: {
    ...defaultActionlintConfig,
    selfHostedRunnerLabels: [
      ...(defaultActionlintConfig.selfHostedRunnerLabels ?? []),
      baselineProfile,
      candidateProfile,
    ],
  },
  jobs: Object.fromEntries(lanes.map((lane) => [lane, selectedJob(lane)])),
})
