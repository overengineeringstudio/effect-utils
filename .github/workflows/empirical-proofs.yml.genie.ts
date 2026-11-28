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
import { pinnedAction } from '../../packages/@overeng/genie/src/runtime/github-workflow/action-pins.ts'
import { empiricalProofJobs } from './ci.yml.genie.ts'

const occurrenceReaderTrusted =
  "github.repository == 'overengineeringstudio/effect-utils' && github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')"
const occurrenceReaderConfigured =
  "vars.TS_OCCURRENCE_READ_CLIENT_ID != '' && vars.TS_OCCURRENCE_READ_AUDIENCE != ''"

/** Keep export failures visible on the nonblocking daily job, without changing other jobs. */
const withCacheJoinExportCheck = (jobs: CiWorkflowArgs['jobs']): CiWorkflowArgs['jobs'] => {
  const daily = jobs['buck2-cache-join']!
  return {
    ...jobs,
    'buck2-cache-join': {
      ...daily,
      steps: [
        ...daily.steps.map((step) =>
          step.uses?.startsWith('tailscale/github-action@') === true &&
          step.id !== 'occurrence-reader'
            ? {
                ...step,
                if: step.if?.replace(
                  'always()',
                  "always() && steps.occurrence-disconnect.outcome != 'failure'",
                ),
              }
            : step,
        ),
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
        occurrence_since: {
          description: 'Optional exact UTC occurrence window start (requires occurrence_until)',
          required: false,
          type: 'string',
        },
        occurrence_until: {
          description: 'Optional exact UTC occurrence window end (at most 24h after start)',
          required: false,
          type: 'string',
        },
        occurrence_host: {
          description: 'Optional occurrence host from the configured expected-host inventory',
          required: false,
          type: 'string',
        },
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
              name: 'Notice unconfigured occurrence reader',
              if: `\${{ (${occurrenceReaderTrusted}) && !(${occurrenceReaderConfigured}) }}`,
              run: 'echo "::notice::Daily occurrence reader skipped: configure TS_OCCURRENCE_READ_CLIENT_ID and TS_OCCURRENCE_READ_AUDIENCE repository variables."',
            },
            {
              name: 'Connect dedicated occurrence reader',
              id: 'occurrence-reader',
              if: `\${{ (${occurrenceReaderTrusted}) && (${occurrenceReaderConfigured}) }}`,
              ...pinnedAction({ name: 'tailscale' }),
              with: {
                'oauth-client-id': '${{ vars.TS_OCCURRENCE_READ_CLIENT_ID }}',
                audience: '${{ vars.TS_OCCURRENCE_READ_AUDIENCE }}',
                tags: 'tag:ci-buck2-occurrence-read',
                args: '--accept-dns=true',
              },
            },
            {
              name: 'Read bounded occurrences',
              id: 'occurrence-query',
              if: "${{ steps.occurrence-reader.outcome == 'success' }}",
              shell: 'bash',
              env: {
                BUCK2_OCCURRENCE_READ_URL: '${{ vars.BUCK2_OCCURRENCE_READ_URL }}',
                BUCK2_OCCURRENCE_EXPECTED_HOSTS: '${{ vars.BUCK2_OCCURRENCE_EXPECTED_HOSTS }}',
                OCCURRENCE_QUERY_EVENT: '${{ github.event_name }}',
                OCCURRENCE_QUERY_SINCE: '${{ inputs.occurrence_since }}',
                OCCURRENCE_QUERY_UNTIL: '${{ inputs.occurrence_until }}',
                OCCURRENCE_QUERY_HOST: '${{ inputs.occurrence_host }}',
              },
              run: withCiSourceRoot(
                [
                  'set -euo pipefail',
                  ': "${BUCK2_OCCURRENCE_READ_URL:?configure occurrence reader URL}"',
                  ': "${BUCK2_OCCURRENCE_EXPECTED_HOSTS:?configure space-separated expected hosts}"',
                  'if [ "$OCCURRENCE_QUERY_EVENT" = workflow_dispatch ]; then',
                  '  until=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
                  'else',
                  '  until=$(date -u +%Y-%m-%dT00:00:00Z)',
                  'fi',
                  'end=$(date -u -d "$until" +%s)',
                  'start=$((end - 86400))',
                  'since=$(date -u -d "@$start" +%Y-%m-%dT%H:%M:%SZ)',
                  'if [[ -n "$OCCURRENCE_QUERY_SINCE" || -n "$OCCURRENCE_QUERY_UNTIL" ]]; then',
                  '  [[ "$OCCURRENCE_QUERY_EVENT" = workflow_dispatch ]]',
                  '  for bound in "$OCCURRENCE_QUERY_SINCE" "$OCCURRENCE_QUERY_UNTIL"; do',
                  '    [[ "$bound" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo "Both exact UTC occurrence bounds are required" >&2; exit 1; }',
                  '    [[ "$(date -u -d "$bound" +%Y-%m-%dT%H:%M:%SZ)" = "$bound" ]]',
                  '  done',
                  '  since="$OCCURRENCE_QUERY_SINCE"',
                  '  until="$OCCURRENCE_QUERY_UNTIL"',
                  '  start=$(date -u -d "$since" +%s)',
                  '  end=$(date -u -d "$until" +%s)',
                  '  (( end > start && end - start <= 86400 )) || { echo "Occurrence window must be positive and at most 24h" >&2; exit 1; }',
                  'fi',
                  'if [ -n "$OCCURRENCE_QUERY_HOST" ]; then',
                  '  [[ "$OCCURRENCE_QUERY_EVENT" = workflow_dispatch && "$OCCURRENCE_QUERY_HOST" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]',
                  '  read -r -a configured_hosts <<< "$BUCK2_OCCURRENCE_EXPECTED_HOSTS"',
                  '  found_host=false',
                  '  for host in "${configured_hosts[@]}"; do if [ "$host" = "$OCCURRENCE_QUERY_HOST" ]; then found_host=true; fi; done',
                  '  "$found_host" || { echo "Occurrence host is absent from the configured inventory" >&2; exit 1; }',
                  '  BUCK2_OCCURRENCE_EXPECTED_HOSTS="$OCCURRENCE_QUERY_HOST"',
                  'fi',
                  'proof="$GITHUB_WORKSPACE/tmp/buck2-occurrence-proof"',
                  'mkdir -p "$proof"',
                  'export OCCURRENCE_SINCE="$since" OCCURRENCE_UNTIL="$until" OCCURRENCE_PROOF="$proof"',
                  '"${DEVENV_BIN:?}" shell -- bash -euo pipefail -c \'',
                  '  cd "${GITHUB_WORKSPACE:?}"',
                  '  args=()',
                  '  if [ -n "$OCCURRENCE_QUERY_HOST" ]; then args+=(--query-host "$OCCURRENCE_QUERY_HOST"); fi',
                  '  read -r -a hosts <<< "$BUCK2_OCCURRENCE_EXPECTED_HOSTS"',
                  '  for host in "${hosts[@]}"; do args+=(--expected-host "$host"); done',
                  '  bun genie/ci-scripts/buck2-cache-join-cli.ts occurrences --loki-url "$BUCK2_OCCURRENCE_READ_URL" --output "$OCCURRENCE_PROOF/occurrences.json" --since "$OCCURRENCE_SINCE" --until "$OCCURRENCE_UNTIL" "${args[@]}" > "$OCCURRENCE_PROOF/summary.json"',
                  "'",
                  'jq -r \'"## Daily occurrence evidence\\nRecords: \\(.recordCount)\\nEvidence gaps: \\(.evidenceGapCount)\\nPages: \\(.pages)\\nDownloaded bytes: \\(.downloadedBytes)\\nCoverage: UNKNOWN (bounded retained evidence, not fleet certification)"\' "$proof/summary.json" >> "$GITHUB_STEP_SUMMARY"',
                ].join('\n'),
              ),
            },
            {
              name: 'Disconnect occurrence reader before evidence writer',
              id: 'occurrence-disconnect',
              if: "${{ always() && steps.occurrence-reader.outcome != 'skipped' }}",
              shell: 'bash',
              run: 'sudo tailscale logout',
            },
            {
              name: 'Publish per-occurrence query receipt',
              if: "${{ always() && steps.occurrence-query.outcome == 'success' }}",
              shell: 'bash',
              run: withCiSourceRoot(
                [
                  'set -euo pipefail',
                  'proof="$GITHUB_WORKSPACE/tmp/buck2-occurrence-proof/occurrences.json"',
                  'cat "$proof"',
                  'bytes=$(wc -c < "$proof")',
                  'if (( bytes < 900000 )); then',
                  '  jq -r \'"### Per-occurrence JSON\\n\\n```json\\n" + tojson + "\\n```"\' "$proof" >> "$GITHUB_STEP_SUMMARY"',
                  'else',
                  '  printf "Full per-occurrence JSON is in this step output (%s bytes); it exceeds the bounded job-summary size.\\n" "$bytes" >> "$GITHUB_STEP_SUMMARY"',
                  'fi',
                ].join('\n'),
              ),
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
