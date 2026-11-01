import {
  cachixCliBuildStep,
  cachixStep,
  ciMeasurementBaselineWorkflowDispatchInputs,
  ciWorkflow,
  checkoutStep,
  installNixStep,
  linuxSandboxPrerequisitesStep,
  namespaceRunner,
  prepareCiScriptsStep,
  preparePinnedDevenvStep,
  runDevenvTasksBefore,
  validateNixStoreStep,
  withCiSourceRoot,
  type CiWorkflowArgs,
} from '../../genie/ci-workflow.ts'
import { withBuck2CacheEvidence } from '../../genie/ci-workflow/buck2-cache-evidence.ts'
import { withBuck2CachePostures } from '../../genie/ci-workflow/buck2-cache-posture.ts'
import { withPipelineTelemetry } from '../../genie/ci-workflow/pipeline-telemetry.ts'
import { effectUtilsWorkflowPolicy } from '../../genie/ci-workflow/policy.ts'
import { empiricalProofJobs } from './ci.yml.genie.ts'

/** Keep export failures visible on the nonblocking daily job, without changing other jobs. */
const withCacheJoinExportCheck = (jobs: CiWorkflowArgs['jobs']): CiWorkflowArgs['jobs'] => {
  const daily = jobs['buck2-cache-join']!
  return {
    ...jobs,
    'buck2-cache-join': {
      ...daily,
      steps: [
        ...daily.steps,
        {
          name: 'Require daily cache metrics export',
          shell: 'bash',
          run: [
            'set -euo pipefail',
            ': "${BUCK2_CACHE_JOIN_PENDING:?join did not declare its metrics spool}"',
            'shopt -s nullglob',
            'chunks=("$BUCK2_CACHE_JOIN_PENDING"/*.metrics.chunk)',
            'if (( ${#chunks[@]} != 0 )); then',
            '  printf "Unexported cache metrics chunk: %s\\n" "${chunks[@]}" >&2',
            '  exit 1',
            'fi',
          ].join('\n'),
        },
      ],
    },
  }
}

export default ciWorkflow({
  policy: effectUtilsWorkflowPolicy('empirical-proofs.yml'),
  trustTier: 'public',
  name: 'Empirical Proofs',
  on: {
    push: { branches: ['main'] },
    pull_request: { types: ['opened', 'reopened', 'synchronize', 'labeled'] },
    schedule: [{ cron: '17 3 * * *' }],
    workflow_dispatch: {
      inputs: {
        ...ciMeasurementBaselineWorkflowDispatchInputs,
        debug_force_nix_diagnostics_failure: {
          description: 'Force post-validation failure to verify proof diagnostics',
          required: false,
          default: false,
          type: 'boolean',
        },
      },
    },
  },
  permissions: { contents: 'read', 'id-token': 'write' },
  jobs: withBuck2CachePostures({
    jobs: withCacheJoinExportCheck(
      withPipelineTelemetry({
        ...withBuck2CacheEvidence(empiricalProofJobs),
        'buck2-cache-join': {
          name: 'ci/buck2-cache-join',
          if: "${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}",
          'runs-on': namespaceRunner({
            profile: 'namespace-profile-linux-x86-64',
            runId: '${{ github.run_id }}',
            privileged: 'always',
            priority: 4,
          }),
          'continue-on-error': true,
          'timeout-minutes': 30,
          permissions: { contents: 'read', actions: 'read', 'id-token': 'write' },
          steps: [
            checkoutStep(),
            installNixStep(),
            linuxSandboxPrerequisitesStep({ privileged: 'always' }),
            cachixCliBuildStep,
            cachixStep({ name: 'overeng-effect-utils' }),
            prepareCiScriptsStep,
            preparePinnedDevenvStep,
            validateNixStoreStep,
            {
              name: 'Prepare source script dependencies',
              env: { GITHUB_TOKEN: '${{ github.token }}' },
              run: runDevenvTasksBefore('buck2:editor:bootstrap'),
            },
            {
              name: 'Join previous UTC day cache evidence',
              shell: 'bash',
              env: { GITHUB_TOKEN: '${{ github.token }}' },
              run: withCiSourceRoot(
                [
                  'set -euo pipefail',
                  '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bash -euo pipefail -c \'',
                  '  cd "${GITHUB_WORKSPACE:?}"',
                  '  args=()',
                  '  if [ -n "${PIPELINE_MATRIX_RUNNER:-}" ]; then args+=("runner=$PIPELINE_MATRIX_RUNNER"); fi',
                  '  read -r trace_assignment root_assignment <<< "$(otel-span pipeline-derive "$PIPELINE_RUN_ID" "$PIPELINE_JOB_KEY" "${args[@]}")"',
                  '  spool="$PWD/.devenv/otel/run-records/${trace_assignment#trace=}-${root_assignment#root=}"',
                  '  mkdir -p "$spool/spans" "$spool/buck2" "$spool/pending"',
                  '  printf "BUCK2_CACHE_JOIN_PENDING=%s\\n" "$spool/pending" >> "$GITHUB_ENV"',
                  '  bun genie/ci-scripts/buck2-cache-join-cli.ts --repo "$GITHUB_REPOSITORY" --previous-utc-day --otlp-spool "$spool/pending" --proof-directory "$GITHUB_WORKSPACE/tmp/buck2-cache-history-proof"',
                  "'",
                ].join('\n'),
              ),
              // Retained locally: tmp/buck2-cache-history-proof/buck2-cache-warm99.json
              // and buck2-cache-proof-manifest.json. Do not add actions/upload-artifact:
              // fleet policy bans new uses, and ci-storage (#2157) supplies only the
              // library/action, not the broker/presigner required for workflow uploads.
            },
          ],
        },
      }),
    ),
    postures: {
      'bootstrap-cold-proof': 'reader',
      'test-megarepo-cold-gc': 'reader',
      'nix-closure-sizes': 'reader',
      'main-source-shape': 'none',
      'ci-measurements-report': 'none',
      'buck2-cache-join': 'reader',
      'devenv-perf': {
        posture: 'reader',
        disabledWhen:
          "github.event_name == 'workflow_dispatch' && inputs.measurement_baseline_ref != ''",
      },
    },
  }),
} satisfies CiWorkflowArgs)
