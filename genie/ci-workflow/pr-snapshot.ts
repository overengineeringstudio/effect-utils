/**
 * Label-gated PR snapshot publishing.
 *
 * Publishes an immutable npm snapshot of a pull request's package cohort without granting the PR's
 * author any credential. The shape is a privilege split, and the job boundaries below are the split:
 *
 * - `prSnapshotPackJob` runs in the PR's own (possibly forked) context with no secrets and a read-only
 *   token. It builds and packs the cohort and uploads it as an artifact. Everything it produces is
 *   untrusted data.
 * - `prSnapshotReleaseJobs` run on the default branch. They re-resolve the PR by exact repository,
 *   branch and head SHA, validate every tarball without executing it, attest the validated digests,
 *   check authorization, and only then publish through npm trusted publishing.
 *
 * Authorization differs by provenance: a repository-owned PR needs a review of the current head, while
 * a fork PR is trusted through a maintainer-applied label. The label is a revocable grant over the PR
 * head repository and branch rather than a one-shot approval of a single SHA, so removing it stops any
 * publication that has not started — but cannot retract a version already on the registry.
 *
 * The literals threaded through here are load-bearing in ways that are easy to miss:
 * `packJobId` is both a job key in the CI workflow and a `jq` name match inside the release jobs, and
 * the version/tag scheme is duplicated between these workflows and the validator script. A mismatch in
 * either does not fail loudly; it silently finds nothing.
 */

import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/github-workflow/mod.ts'
import { bashShellDefaults, runDevenvTasksBefore } from './shared.ts'
import { emittedPrSnapshotValidatorPath, emittedPrSnapshotValidatorTestPath } from './support-files.ts'

/**
 * Job id of the pack job, and the label granting a fork pull request publishing trust.
 *
 * Constants rather than options. Each is duplicated in places a caller cannot reach: `packJobId` is a
 * job key in one workflow and a `jq` name match in another, and the trust label is also hardcoded
 * inside the validator's authorization predicate. Making either configurable would let the copies
 * disagree — and neither disagreement fails loudly; the dispatcher would simply match nothing.
 */
export const prSnapshotPackJobId = 'pack-pr-snapshot'
export const prSnapshotTrustLabel = 'ci:publish-snapshot'

/**
 * Guard for jobs that existed in a consumer's release workflow before these were added.
 *
 * `scheduleTrigger` and `workflowRunTrigger` widen when the workflow runs — on a cron and on every
 * producer CI completion. Any pre-existing job without a guard then runs on those events too, which
 * for a build-heavy job means a full toolchain build every few minutes. Apply this to them.
 */
export const prSnapshotForeignEventGuard =
  "github.event_name != 'schedule' && github.event_name != 'workflow_run'" 

type WorkflowJob = GitHubWorkflowArgs['jobs'][string]
type WorkflowStep = WorkflowJob['steps'][number]

/** Values that must agree between the pack job and the release jobs. */
export type PrSnapshotSharedOptions = {
  /** Repo-relative path to the trusted release topology JSON. */
  readonly topologyPath: string
  /** Repo-relative path to the emitted `pr-snapshot-artifact.mjs`. Defaults to the shared location. */
  readonly validatorScriptPath?: string
}

export type PrSnapshotPackJobOptions = PrSnapshotSharedOptions & {
  /** Setup steps run after the pinned-SHA checkout. */
  readonly setupStepsAfterCheckout: readonly WorkflowStep[]
  /** Devenv task packing tarballs into `$SNAPSHOT_OUT_DIR`. */
  readonly packTask: string
  /** Repo-relative path to the emitted boundary suite. Defaults to the shared location. */
  readonly validatorTestPath?: string
  /** Runner for the untrusted pack job. */
  readonly runsOn?: WorkflowJob['runs-on']
}

export type PrSnapshotReleaseJobsOptions = PrSnapshotSharedOptions & {
  /** in-toto predicate type URI for the candidate attestation. */
  readonly attestationPredicateType: string
  /** Runner for the trusted jobs. These do no repo build, so the default suits every consumer. */
  readonly runsOn?: WorkflowJob['runs-on']
}

/**
 * The untrusted producer. Runs fork-authored code, so it must hold no secrets and no write token; the
 * release jobs treat everything it uploads as untrusted input.
 */
export const prSnapshotPackJob = (opts: PrSnapshotPackJobOptions) => {
  const {
    topologyPath,
    validatorScriptPath = emittedPrSnapshotValidatorPath,
    validatorTestPath = emittedPrSnapshotValidatorTestPath,
    setupStepsAfterCheckout,
    packTask,
    runsOn = 'ubuntu-24.04',
  } = opts
  return {
    [prSnapshotPackJobId]: {
      // Fork candidates are untrusted data: this job has no secrets or write
      // token, and the main-branch release workflow validates every tarball.
      if: "github.event_name == 'pull_request'",
      'runs-on': runsOn,
      permissions: { contents: 'read' },
      env: {
        CACHIX_AUTH_TOKEN: '',
        SNAPSHOT_OUT_DIR: '${{ github.workspace }}/tmp/pr-snapshot-artifact',
      },
      defaults: bashShellDefaults,
      steps: [
        {
          name: 'Checkout exact PR head',
          uses: 'actions/checkout@v4',
          with: {
            ref: '${{ github.event.pull_request.head.sha }}',
            'persist-credentials': false,
          },
        },
        ...setupStepsAfterCheckout,
        {
          name: 'Test snapshot artifact boundary',
          run: `node --test ${validatorTestPath}`,
        },
        {
          name: 'Pack exact-SHA snapshot',
          run: runDevenvTasksBefore(packTask),
          env: {
            GIT_SHA: '${{ github.event.pull_request.head.sha }}',
            PR_NUMBER: '${{ github.event.pull_request.number }}',
          },
        },
        {
          name: 'Create snapshot manifest',
          run: `node ${validatorScriptPath} create \\
  --artifact-dir="$SNAPSHOT_OUT_DIR" \\
  --topology=${topologyPath} \\
  --repository="$GITHUB_REPOSITORY" \\
  --pr-number="\${{ github.event.pull_request.number }}" \\
  --head-sha="\${{ github.event.pull_request.head.sha }}" \\
  --run-id="$GITHUB_RUN_ID" \\
  --run-attempt="$GITHUB_RUN_ATTEMPT"`,
        },
        {
          name: 'Upload immutable PR snapshot candidate',
          uses: 'actions/upload-artifact@v4',
          with: {
            name: 'pr-snapshot-${{ github.event.pull_request.head.sha }}-${{ github.run_attempt }}',
            path: '${{ github.workspace }}/tmp/pr-snapshot-artifact/',
            'if-no-files-found': 'error',
            'retention-days': 7,
          },
        },
      ],
    },
  }
}

/** The trusted consumer half, plus the workflow-level trigger fragments these jobs require. */
export const prSnapshotReleaseJobs = (opts: PrSnapshotReleaseJobsOptions) => {
  const {
    topologyPath,
    validatorScriptPath = emittedPrSnapshotValidatorPath,
    attestationPredicateType,
    runsOn = 'ubuntu-24.04',
  } = opts
  return {
    jobs: {
      'dispatch-authorized-pr-snapshots': {
        if: "github.event_name == 'schedule'",
        'runs-on': runsOn,
        permissions: {
          actions: 'write',
          contents: 'read',
          'pull-requests': 'read',
        },
        env: { GH_TOKEN: '${{ github.token }}' },
        defaults: bashShellDefaults,
        steps: [
          {
            name: 'Checkout trusted package topology',
            uses: 'actions/checkout@v4',
            with: {
              ref: '${{ github.workflow_sha }}',
              'persist-credentials': false,
              'sparse-checkout': `${validatorScriptPath}
${topologyPath}`,
            },
          },
          {
            name: 'Dispatch incomplete authorized cohorts to trusted main workflow',
            run: `set -euo pipefail
test "$GITHUB_WORKFLOW_REF" = "$GITHUB_REPOSITORY/.github/workflows/release.yml@refs/heads/main"
prs_json=$(gh api --paginate "/repos/$GITHUB_REPOSITORY/pulls?state=open&base=main&per_page=100" --slurp)
release_workflow_id=$(gh api "/repos/$GITHUB_REPOSITORY/actions/workflows/release.yml" --jq .id)
[[ "$release_workflow_id" =~ ^[1-9][0-9]*$ ]]
scan_failed=false
while IFS=$'\t' read -r pr_number head_sha head_repository head_ref fork_label_present; do
  cohort_failed=false
  verified_receipt=false
  registry_state_file="$RUNNER_TEMP/registry-state-$pr_number.json"
  printf '[]\n' > "$registry_state_file"

  [[ "$pr_number" =~ ^[1-9][0-9]*$ ]]
  [[ "$head_sha" =~ ^[0-9a-f]{40}$ ]]
  test -n "$head_repository"
  test -n "$head_ref"
  if [ "$head_repository" = "$GITHUB_REPOSITORY" ]; then
    review_json=$(gh api graphql \
      -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision}}}' \
      -f owner="\${GITHUB_REPOSITORY%%/*}" \
      -f name="\${GITHUB_REPOSITORY#*/}" \
      -F number="$pr_number")
    if [ "$(jq -r '.data.repository.pullRequest.reviewDecision // ""' <<<"$review_json")" != APPROVED ]; then
      continue
    fi
  elif [ "$fork_label_present" != true ]; then
    continue
  fi

  version="0.0.0-snapshot-pr.$pr_number.$head_sha"
  snapshot_tag="pr-$pr_number-$head_sha"

  selected_run_id=''
  selected_pack_attempt=''
  runs_json=$(gh api --paginate --method GET "/repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs" \
    -f event=pull_request \
    -f status=success \
    -f branch="$head_ref" \
    -F per_page=100 \
    --slurp)
  while IFS= read -r candidate_run_id; do
    [[ "$candidate_run_id" =~ ^[1-9][0-9]*$ ]]
    jobs_json=$(gh api --paginate "/repos/$GITHUB_REPOSITORY/actions/runs/$candidate_run_id/jobs?filter=all&per_page=100" --slurp)
    pack_job=$(jq -c '[.[] | .jobs[] | select(.name == "${prSnapshotPackJobId}" and .conclusion == "success")] | sort_by(.run_attempt) | last' <<<"$jobs_json")
    if [ "$pack_job" = null ]; then
      continue
    fi
    pack_attempt=$(jq -r '.run_attempt' <<<"$pack_job")
    [[ "$pack_attempt" =~ ^[1-9][0-9]*$ ]]
    artifact_name="pr-snapshot-$head_sha-$pack_attempt"
    artifacts_json=$(gh api --paginate "/repos/$GITHUB_REPOSITORY/actions/runs/$candidate_run_id/artifacts?per_page=100" --slurp)
    if ! jq -e --arg name "$artifact_name" 'any(.[] | .artifacts[]; .name == $name and .expired == false)' <<<"$artifacts_json" >/dev/null; then
      continue
    fi
    selected_run_id="$candidate_run_id"
    selected_pack_attempt="$pack_attempt"
    break
  done < <(jq -r --arg sha "$head_sha" --arg head_repository "$head_repository" --arg head_ref "$head_ref" \
    '[.[] | .workflow_runs[] | select(.event == "pull_request" and .conclusion == "success" and .head_repository.full_name == $head_repository and .head_branch == $head_ref and .head_sha == $sha)] | sort_by(.created_at) | reverse | .[].id' \
    <<<"$runs_json")
  if [ -z "$selected_run_id" ]; then
    echo "PR #$pr_number has no exact successful pack artifact yet; skipping"
    continue
  fi

  receipt_name="verified-pr-snapshot-$head_sha-$selected_run_id-$selected_pack_attempt"
  receipts_json=$(gh api --paginate --method GET "/repos/$GITHUB_REPOSITORY/actions/artifacts" \
    -f name="$receipt_name" \
    -F per_page=100 \
    --slurp)
  while IFS= read -r receipt_run_id; do
    [[ "$receipt_run_id" =~ ^[1-9][0-9]*$ ]]
    receipt_run=$(gh api "/repos/$GITHUB_REPOSITORY/actions/runs/$receipt_run_id")
    if [ "$(jq -r .workflow_id <<<"$receipt_run")" = "$release_workflow_id" ] && \
       [ "$(jq -r .event <<<"$receipt_run")" = workflow_dispatch ] && \
       [ "$(jq -r .head_branch <<<"$receipt_run")" = main ] && \
       [ "$(jq -r .conclusion <<<"$receipt_run")" = success ]; then
      verified_receipt=true
      break
    fi
  done < <(jq -r --arg name "$receipt_name" '.[] | .artifacts[]? | select(.name == $name and .expired == false) | .workflow_run.id' <<<"$receipts_json")

  while IFS= read -r package_name; do
    remote_version=$(npm view "$package_name@$version" version --json --registry=https://registry.npmjs.org 2>/dev/null | jq -r . || true)
    remote_tag=$(npm view "$package_name" dist-tags --json --registry=https://registry.npmjs.org 2>/dev/null | jq -r --arg tag "$snapshot_tag" '.[$tag] // empty' || true)
    jq --arg name "$package_name" --arg version "$remote_version" --arg tag "$remote_tag" \
      '. + [{name: $name, version: $version, tag: $tag}]' "$registry_state_file" > "$registry_state_file.next"
    mv "$registry_state_file.next" "$registry_state_file"
  done < <(jq -r '.publishablePackageNames[]' ${topologyPath})

  assessment=$(node ${validatorScriptPath} assess-registry \
    --state-file="$registry_state_file" \
    --version="$version" \
    --verified-receipt="$verified_receipt")
  action=$(jq -r .action <<<"$assessment")
  if [ "$action" = conflict ]; then
    package_name=$(jq -r .packageName <<<"$assessment")
    conflicting_version=$(jq -r .conflictingVersion <<<"$assessment")
    echo "::error::PR #$pr_number package $package_name tag $snapshot_tag points to unexpected version $conflicting_version"
    cohort_failed=true
  elif [ "$action" = complete ]; then
    echo "PR #$pr_number snapshot cohort has a trusted verification receipt"
    continue
  elif [ "$action" != dispatch ]; then
    echo "Unknown registry assessment action: $action" >&2
    cohort_failed=true
  fi

  if [ "$cohort_failed" = true ]; then
    scan_failed=true
    continue
  fi

  gh workflow run release.yml --repo "$GITHUB_REPOSITORY" --ref main \
    -f mode=promote-pr-snapshot \
    -f npm_tag=latest \
    -f pr_number="$pr_number" \
    -f head_sha="$head_sha" \
    -f ci_run_id="$selected_run_id"
done < <(jq -r \
  '.[][] | select(.draft == false and .base.ref == "main") | [.number, .head.sha, .head.repo.full_name, .head.ref, (any(.labels[]?; .name == "${prSnapshotTrustLabel}") | tostring)] | @tsv' \
  <<<"$prs_json")
if [ "$scan_failed" = true ]; then
  exit 1
fi`,
          },
        ],
      },
      'validate-pr-snapshot': {
        if: "(github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'pull_request') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.mode == 'promote-pr-snapshot')",
        'runs-on': runsOn,
        permissions: {
          actions: 'read',
          contents: 'read',
          'pull-requests': 'read',
        },
        outputs: {
          'head-sha': '${{ steps.identity.outputs.head-sha }}',
          'manifest-digest': '${{ steps.validate.outputs.manifest-digest }}',
          'npm-tag': '${{ steps.validate.outputs.npm-tag }}',
          'package-count': '${{ steps.validate.outputs.package-count }}',
          'pr-number': '${{ steps.identity.outputs.pr-number }}',
          'release-run-attempt': '${{ steps.validate.outputs.release-run-attempt }}',
          'run-attempt': '${{ steps.identity.outputs.run-attempt }}',
          'run-id': '${{ steps.identity.outputs.run-id }}',
          'source-run-url': '${{ steps.identity.outputs.source-run-url }}',
          'topology-digest': '${{ steps.validate.outputs.topology-digest }}',
          version: '${{ steps.validate.outputs.version }}',
        },
        env: {
          ARTIFACT_DIR: '${{ github.workspace }}/tmp/pr-snapshot-artifact',
          CACHIX_AUTH_TOKEN: '',
          GH_TOKEN: '${{ github.token }}',
          PUBLISH_LIST: '${{ github.workspace }}/tmp/pr-snapshot-publish-list.tsv',
        },
        defaults: bashShellDefaults,
        steps: [
          {
            id: 'identity',
            name: 'Resolve exact successful CI run and current PR head',
            run: `set -euo pipefail
test "$GITHUB_WORKFLOW_REF" = "$GITHUB_REPOSITORY/.github/workflows/release.yml@refs/heads/main"
[[ "$GITHUB_WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]
if [ "$GITHUB_EVENT_NAME" = workflow_run ]; then
  run_id='\${{ github.event.workflow_run.id }}'
else
  test "$GITHUB_EVENT_NAME" = workflow_dispatch
  pr_number='\${{ inputs.pr_number }}'
  head_sha='\${{ inputs.head_sha }}'
  run_id='\${{ inputs.ci_run_id }}'
fi

[[ "$run_id" =~ ^[1-9][0-9]*$ ]]
run_json=$(gh api "/repos/$GITHUB_REPOSITORY/actions/runs/$run_id")
test "$(jq -r '.event' <<<"$run_json")" = pull_request
test "$(jq -r '.status' <<<"$run_json")" = completed
test "$(jq -r '.conclusion' <<<"$run_json")" = success
test "$(jq -r '.path' <<<"$run_json")" = .github/workflows/ci.yml
run_head_repository=$(jq -r '.head_repository.full_name' <<<"$run_json")
run_head_branch=$(jq -r '.head_branch' <<<"$run_json")
run_head_sha=$(jq -r '.head_sha' <<<"$run_json")
test -n "$run_head_repository"
test -n "$run_head_branch"
[[ "$run_head_sha" =~ ^[0-9a-f]{40}$ ]]
if [ "$GITHUB_EVENT_NAME" = workflow_run ]; then
  prs_json=$(gh api --paginate "/repos/$GITHUB_REPOSITORY/pulls?state=open&base=main&per_page=100" --slurp)
  matching_prs=$(jq --arg head_repository "$run_head_repository" --arg head_branch "$run_head_branch" --arg head_sha "$run_head_sha" \
    '[.[][] | select(.draft == false and .base.ref == "main" and .head.repo.full_name == $head_repository and .head.ref == $head_branch and .head.sha == $head_sha)]' \
    <<<"$prs_json")
  test "$(jq 'length' <<<"$matching_prs")" = 1
  pr_number=$(jq -r '.[0].number' <<<"$matching_prs")
  head_sha="$run_head_sha"
else
  test "$run_head_sha" = "$head_sha"
fi
[[ "$pr_number" =~ ^[1-9][0-9]*$ ]]
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]]
source_run_url=$(jq -r '.html_url' <<<"$run_json")
jobs_json=$(gh api --paginate "/repos/$GITHUB_REPOSITORY/actions/runs/$run_id/jobs?filter=all&per_page=100" --slurp)
pack_job=$(jq -c '[.[] | .jobs[] | select(.name == "${prSnapshotPackJobId}" and .conclusion == "success")] | sort_by(.run_attempt) | last' <<<"$jobs_json")
test "$pack_job" != null
run_attempt=$(jq -r '.run_attempt' <<<"$pack_job")
[[ "$run_attempt" =~ ^[1-9][0-9]*$ ]]
pr_json=$(gh api "/repos/$GITHUB_REPOSITORY/pulls/$pr_number")

test "$(jq -r '.state' <<<"$pr_json")" = open
test "$(jq -r '.base.ref' <<<"$pr_json")" = main
test "$(jq -r '.head.sha' <<<"$pr_json")" = "$head_sha"
test "$(jq -r '.head.repo.full_name' <<<"$pr_json")" = "$run_head_repository"
test "$(jq -r '.head.ref' <<<"$pr_json")" = "$run_head_branch"

echo "head-sha=$head_sha" >> "$GITHUB_OUTPUT"
echo "pr-number=$pr_number" >> "$GITHUB_OUTPUT"
echo "run-id=$run_id" >> "$GITHUB_OUTPUT"
echo "run-attempt=$run_attempt" >> "$GITHUB_OUTPUT"
echo "source-run-url=$source_run_url" >> "$GITHUB_OUTPUT"`,
          },
          {
            name: 'Checkout trusted validator only',
            uses: 'actions/checkout@v4',
            with: {
              ref: '${{ github.workflow_sha }}',
              'persist-credentials': false,
              'sparse-checkout': `${validatorScriptPath}
${topologyPath}`,
            },
          },
          {
            name: 'Use pinned Node validator runtime',
            uses: 'actions/setup-node@v4',
            with: {
              'node-version': '24.15.0',
            },
          },
          {
            name: 'Download exact-run snapshot candidate',
            uses: 'actions/download-artifact@v4',
            with: {
              name: 'pr-snapshot-${{ steps.identity.outputs.head-sha }}-${{ steps.identity.outputs.run-attempt }}',
              path: '${{ github.workspace }}/tmp/pr-snapshot-artifact',
              'github-token': '${{ github.token }}',
              'run-id': '${{ steps.identity.outputs.run-id }}',
            },
          },
          {
            id: 'validate',
            name: 'Validate immutable snapshot candidate',
            env: {
              EXPECTED_HEAD_SHA: '${{ steps.identity.outputs.head-sha }}',
              EXPECTED_PR_NUMBER: '${{ steps.identity.outputs.pr-number }}',
              EXPECTED_RUN_ID: '${{ steps.identity.outputs.run-id }}',
              EXPECTED_RUN_ATTEMPT: '${{ steps.identity.outputs.run-attempt }}',
            },
            run: `set -euo pipefail
result=$(node ${validatorScriptPath} validate \\
  --artifact-dir="$ARTIFACT_DIR" \\
  --topology=${topologyPath} \\
  --repository="$GITHUB_REPOSITORY" \\
  --pr-number="$EXPECTED_PR_NUMBER" \\
  --head-sha="$EXPECTED_HEAD_SHA" \\
  --run-id="$EXPECTED_RUN_ID" \\
  --run-attempt="$EXPECTED_RUN_ATTEMPT" \\
  --publish-list="$PUBLISH_LIST")
echo "version=$(jq -r '.version' <<<"$result")" >> "$GITHUB_OUTPUT"
echo "manifest-digest=$(jq -r '.manifestDigest' <<<"$result")" >> "$GITHUB_OUTPUT"
echo "topology-digest=$(jq -r '.topologyDigest' <<<"$result")" >> "$GITHUB_OUTPUT"
echo "npm-tag=$(jq -r '.npmTag' <<<"$result")" >> "$GITHUB_OUTPUT"
echo "package-count=$(jq -r '.packageCount' <<<"$result")" >> "$GITHUB_OUTPUT"
echo "release-run-attempt=$GITHUB_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"
cp "$PUBLISH_LIST" "$ARTIFACT_DIR/trusted-publish-list.tsv"`,
          },
          {
            name: 'Upload validated snapshot candidate',
            uses: 'actions/upload-artifact@v4',
            with: {
              name: 'validated-pr-snapshot-${{ steps.identity.outputs.head-sha }}-${{ steps.identity.outputs.run-id }}-${{ steps.validate.outputs.release-run-attempt }}',
              path: '${{ github.workspace }}/tmp/pr-snapshot-artifact/',
              'if-no-files-found': 'error',
              'retention-days': 1,
            },
          },
        ],
      },
      'attest-pr-snapshot': {
        needs: ['validate-pr-snapshot'],
        'runs-on': runsOn,
        permissions: {
          actions: 'read',
          attestations: 'write',
          'artifact-metadata': 'write',
          contents: 'read',
          'id-token': 'write',
        },
        env: {
          ARTIFACT_DIR: '${{ github.workspace }}/tmp/validated-pr-snapshot',
          CACHIX_AUTH_TOKEN: '',
        },
        defaults: bashShellDefaults,
        outputs: { 'promotion-attempt': '${{ steps.handoff.outputs.promotion-attempt }}' },
        steps: [
          {
            name: 'Download validated snapshot candidate',
            uses: 'actions/download-artifact@v4',
            with: {
              name: 'validated-pr-snapshot-${{ needs.validate-pr-snapshot.outputs.head-sha }}-${{ needs.validate-pr-snapshot.outputs.run-id }}-${{ needs.validate-pr-snapshot.outputs.release-run-attempt }}',
              path: '${{ github.workspace }}/tmp/validated-pr-snapshot',
            },
          },
          {
            id: 'handoff',
            name: 'Verify validated artifact identity and write predicate',
            env: {
              HEAD_SHA: '${{ needs.validate-pr-snapshot.outputs.head-sha }}',
              MANIFEST_DIGEST: '${{ needs.validate-pr-snapshot.outputs.manifest-digest }}',
              PR_NUMBER: '${{ needs.validate-pr-snapshot.outputs.pr-number }}',
              SOURCE_RUN_ATTEMPT: '${{ needs.validate-pr-snapshot.outputs.run-attempt }}',
              SOURCE_RUN_ID: '${{ needs.validate-pr-snapshot.outputs.run-id }}',
              TOPOLOGY_DIGEST: '${{ needs.validate-pr-snapshot.outputs.topology-digest }}',
            },
            run: `set -euo pipefail
test "$(sha256sum "$ARTIFACT_DIR/manifest.json" | cut -d' ' -f1)" = "$MANIFEST_DIGEST"
echo "promotion-attempt=$GITHUB_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"
jq -n \
  --arg repository "$GITHUB_REPOSITORY" \
  --argjson prNumber "$PR_NUMBER" \
  --arg headSha "$HEAD_SHA" \
  --argjson sourceRunId "$SOURCE_RUN_ID" \
  --argjson sourceRunAttempt "$SOURCE_RUN_ATTEMPT" \
  --arg manifestSha256 "$MANIFEST_DIGEST" \
  --arg topologySha256 "$TOPOLOGY_DIGEST" \
  '{repository, prNumber, headSha, sourceRunId, sourceRunAttempt, manifestSha256, topologySha256}' \
  > "$RUNNER_TEMP/pr-snapshot-attestation.json"`,
          },
          {
            name: 'Attest validated snapshot candidate',
            uses: 'actions/attest@v4',
            with: {
              'subject-path': [
                '${{ env.ARTIFACT_DIR }}/*.tgz',
                '${{ env.ARTIFACT_DIR }}/manifest.json',
              ].join('\n'),
              'predicate-type': attestationPredicateType,
              'predicate-path': '${{ runner.temp }}/pr-snapshot-attestation.json',
            },
          },
          {
            name: 'Upload attested promotion artifact',
            uses: 'actions/upload-artifact@v4',
            with: {
              name: 'promotion-pr-snapshot-${{ needs.validate-pr-snapshot.outputs.head-sha }}-${{ needs.validate-pr-snapshot.outputs.run-id }}-${{ steps.handoff.outputs.promotion-attempt }}',
              path: '${{ github.workspace }}/tmp/validated-pr-snapshot/',
              'if-no-files-found': 'error',
              'retention-days': 1,
            },
          },
        ],
      },
      'authorize-pr-snapshot': {
        needs: ['validate-pr-snapshot'],
        'runs-on': runsOn,
        permissions: { contents: 'read', 'pull-requests': 'read' },
        outputs: { authorized: '${{ steps.approval.outputs.authorized }}' },
        defaults: bashShellDefaults,
        steps: [
          {
            id: 'approval',
            name: 'Require current-head review or fork trust label',
            env: {
              EXPECTED_HEAD_SHA: '${{ needs.validate-pr-snapshot.outputs.head-sha }}',
              GH_TOKEN: '${{ github.token }}',
              PR_NUMBER: '${{ needs.validate-pr-snapshot.outputs.pr-number }}',
            },
            run: `set -euo pipefail
pr_json=$(gh api "/repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER")
authorized=false
authorized_by='none'
if [ "$(jq -r '.state' <<<"$pr_json")" = open ] && \
   [ "$(jq -r '.draft' <<<"$pr_json")" = false ] && \
   [ "$(jq -r '.base.ref' <<<"$pr_json")" = main ] && \
   [ "$(jq -r '.head.sha' <<<"$pr_json")" = "$EXPECTED_HEAD_SHA" ]; then
  head_repository=$(jq -r '.head.repo.full_name' <<<"$pr_json")
  if [ "$head_repository" = "$GITHUB_REPOSITORY" ]; then
    reviews_json=$(gh api --paginate "/repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/reviews?per_page=100" --slurp | jq -s 'flatten')
    owner="\${GITHUB_REPOSITORY%%/*}"
    name="\${GITHUB_REPOSITORY#*/}"
    review_decision=$(gh api graphql \
      -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision}}}' \
      -f owner="$owner" -f name="$name" -F number="$PR_NUMBER" \
      --jq '.data.repository.pullRequest.reviewDecision')
    if [ "$review_decision" = APPROVED ] && \
       jq -e --arg sha "$EXPECTED_HEAD_SHA" 'any(.[]; .state == "APPROVED" and .commit_id == $sha)' <<<"$reviews_json" >/dev/null; then
      authorized=true
      authorized_by='current-head review'
    fi
  elif jq -e 'any(.labels[]?; .name == "${prSnapshotTrustLabel}")' <<<"$pr_json" >/dev/null; then
    authorized=true
    authorized_by='${prSnapshotTrustLabel} fork trust label'
  fi
fi
echo "authorized=$authorized" >> "$GITHUB_OUTPUT"
echo "Snapshot promotion authorized: $authorized ($authorized_by)" >> "$GITHUB_STEP_SUMMARY"`,
          },
        ],
      },
      'publish-pr-snapshot': {
        if: "needs.authorize-pr-snapshot.outputs.authorized == 'true'",
        needs: ['validate-pr-snapshot', 'attest-pr-snapshot', 'authorize-pr-snapshot'],
        'runs-on': runsOn,
        concurrency: {
          group: 'pr-snapshot-${{ needs.validate-pr-snapshot.outputs.head-sha }}',
          'cancel-in-progress': false,
        },
        permissions: {
          actions: 'read',
          contents: 'read',
          'id-token': 'write',
          'pull-requests': 'read',
        },
        env: {
          ARTIFACT_DIR: '${{ github.workspace }}/tmp/validated-pr-snapshot',
          CACHIX_AUTH_TOKEN: '',
          GH_TOKEN: '${{ github.token }}',
          PUBLISH_LIST:
            '${{ github.workspace }}/tmp/validated-pr-snapshot/trusted-publish-list.tsv',
        },
        defaults: bashShellDefaults,
        steps: [
          {
            name: 'Use pinned npm trusted-publishing client',
            uses: 'actions/setup-node@v4',
            with: {
              'node-version': '24.15.0',
            },
          },
          {
            name: 'Download validated promotion artifact',
            uses: 'actions/download-artifact@v4',
            with: {
              name: 'promotion-pr-snapshot-${{ needs.validate-pr-snapshot.outputs.head-sha }}-${{ needs.validate-pr-snapshot.outputs.run-id }}-${{ needs.attest-pr-snapshot.outputs.promotion-attempt }}',
              path: '${{ github.workspace }}/tmp/validated-pr-snapshot',
            },
          },
          {
            name: 'Recheck current-head authorization before OIDC publication',
            env: {
              EXPECTED_HEAD_SHA: '${{ needs.validate-pr-snapshot.outputs.head-sha }}',
              PR_NUMBER: '${{ needs.validate-pr-snapshot.outputs.pr-number }}',
            },
            run: `set -euo pipefail
pr_json=$(gh api "/repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER")
test "$(jq -r '.state' <<<"$pr_json")" = open
test "$(jq -r '.draft' <<<"$pr_json")" = false
test "$(jq -r '.base.ref' <<<"$pr_json")" = main
test "$(jq -r '.head.sha' <<<"$pr_json")" = "$EXPECTED_HEAD_SHA"
head_repository=$(jq -r '.head.repo.full_name' <<<"$pr_json")
if [ "$head_repository" = "$GITHUB_REPOSITORY" ]; then
  reviews_json=$(gh api --paginate "/repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/reviews?per_page=100" --slurp | jq -s 'flatten')
  owner="\${GITHUB_REPOSITORY%%/*}"
  name="\${GITHUB_REPOSITORY#*/}"
  review_decision=$(gh api graphql \
    -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision}}}' \
    -f owner="$owner" -f name="$name" -F number="$PR_NUMBER" \
    --jq '.data.repository.pullRequest.reviewDecision')
  test "$review_decision" = APPROVED
  jq -e --arg sha "$EXPECTED_HEAD_SHA" 'any(.[]; .state == "APPROVED" and .commit_id == $sha)' <<<"$reviews_json" >/dev/null
else
  jq -e 'any(.labels[]?; .name == "${prSnapshotTrustLabel}")' <<<"$pr_json" >/dev/null
fi`,
          },
          {
            name: 'Verify promotion handoff',
            env: {
              EXPECTED_MANIFEST_DIGEST: '${{ needs.validate-pr-snapshot.outputs.manifest-digest }}',
            },
            run: `set -euo pipefail
test -f "$ARTIFACT_DIR/manifest.json"
test -f "$PUBLISH_LIST"
actual_manifest_digest=$(sha256sum "$ARTIFACT_DIR/manifest.json" | cut -d' ' -f1)
test "$actual_manifest_digest" = "$EXPECTED_MANIFEST_DIGEST"
jq -r '.packages[] | [.name, .file] | @tsv' "$ARTIFACT_DIR/manifest.json" > "$RUNNER_TEMP/expected-publish-list.tsv"
cmp "$RUNNER_TEMP/expected-publish-list.tsv" "$PUBLISH_LIST"
jq -r '.packages[] | [.file, .sha256] | @tsv' "$ARTIFACT_DIR/manifest.json" |
  while IFS=$'\t' read -r file expected_sha256; do
    [[ "$file" =~ ^[a-zA-Z0-9._-]+[.]tgz$ ]]
    actual_sha256=$(sha256sum "$ARTIFACT_DIR/$file" | cut -d' ' -f1)
    test "$actual_sha256" = "$expected_sha256"
  done
if [ -n "\${NODE_AUTH_TOKEN:-}" ] || [ -n "\${NPM_TOKEN:-}" ]; then
  echo "PR snapshot publishing must use npm trusted publishing; token auth is not allowed." >&2
  exit 1
fi`,
          },
          {
            name: 'Publish exact-SHA package cohort',
            env: {
              SNAPSHOT_TAG: '${{ needs.validate-pr-snapshot.outputs.npm-tag }}',
              SNAPSHOT_VERSION: '${{ needs.validate-pr-snapshot.outputs.version }}',
            },
            run: `set -euo pipefail
while IFS=$'\t' read -r package_name file; do
  test -n "$package_name"
  test -n "$file"
  tarball="$ARTIFACT_DIR/$file"
  local_sha1=$(sha1sum "$tarball" | cut -d' ' -f1)
  if remote_sha1=$(npm view "$package_name@$SNAPSHOT_VERSION" dist.shasum --json --registry=https://registry.npmjs.org 2>/dev/null); then
    remote_sha1=$(jq -r . <<<"$remote_sha1")
    if [ "$remote_sha1" != "$local_sha1" ]; then
      echo "$package_name@$SNAPSHOT_VERSION already exists with a different tarball digest" >&2
      exit 1
    fi
    remote_tag=$(npm view "$package_name" dist-tags --json --registry=https://registry.npmjs.org 2>/dev/null | jq -r --arg tag "$SNAPSHOT_TAG" '.[$tag] // empty' || true)
    if [ -n "$remote_tag" ] && [ "$remote_tag" != "$SNAPSHOT_VERSION" ]; then
      echo "$package_name tag $SNAPSHOT_TAG points to unexpected version $remote_tag" >&2
      exit 1
    fi
    if [ -z "$remote_tag" ]; then
      echo "::warning::$package_name@$SNAPSHOT_VERSION matches the candidate but mutable tag $SNAPSHOT_TAG is absent; OIDC publishing cannot repair dist-tags"
    fi
    echo "$package_name@$SNAPSHOT_VERSION already matches candidate; skipping"
    continue
  fi
  npm publish "$tarball" --registry=https://registry.npmjs.org --tag="$SNAPSHOT_TAG" --access=public --ignore-scripts --provenance
done < "$PUBLISH_LIST"`,
          },
          {
            name: 'Verify complete immutable registry cohort',
            env: {
              SNAPSHOT_TAG: '${{ needs.validate-pr-snapshot.outputs.npm-tag }}',
              SNAPSHOT_VERSION: '${{ needs.validate-pr-snapshot.outputs.version }}',
            },
            run: `set -euo pipefail
verified=0
while IFS=$'\t' read -r package_name file; do
  tarball="$ARTIFACT_DIR/$file"
  local_integrity="sha512-$(openssl dgst -sha512 -binary "$tarball" | base64 -w0)"
  matched=false
  for attempt in $(seq 1 12); do
    remote_version=$(npm view "$package_name@$SNAPSHOT_VERSION" version --json --registry=https://registry.npmjs.org 2>/dev/null | jq -r . || true)
    remote_integrity=$(npm view "$package_name@$SNAPSHOT_VERSION" dist.integrity --json --registry=https://registry.npmjs.org 2>/dev/null | jq -r . || true)
    remote_tag=$(npm view "$package_name" dist-tags --json --registry=https://registry.npmjs.org 2>/dev/null | jq -r --arg tag "$SNAPSHOT_TAG" '.[$tag] // empty' || true)
    if [ -n "$remote_tag" ] && [ "$remote_tag" != "$SNAPSHOT_VERSION" ]; then
      echo "$package_name tag $SNAPSHOT_TAG points to unexpected version $remote_tag" >&2
      exit 1
    fi
    if [ "$remote_version" = "$SNAPSHOT_VERSION" ] && \
       [ "$remote_integrity" = "$local_integrity" ]; then
      matched=true
      break
    fi
    sleep 5
  done
  if [ "$matched" != true ]; then
    echo "Registry verification failed for $package_name@$SNAPSHOT_VERSION" >&2
    exit 1
  fi
  verified=$((verified + 1))
done < "$PUBLISH_LIST"
test "$verified" = '\${{ needs.validate-pr-snapshot.outputs.package-count }}'
echo "Verified $verified immutable package versions and SHA-512 integrities; tag bindings are present or absent, never conflicting." >> "$GITHUB_STEP_SUMMARY"`,
          },
          {
            name: 'Write trusted verification receipt',
            env: {
              HEAD_SHA: '${{ needs.validate-pr-snapshot.outputs.head-sha }}',
              MANIFEST_DIGEST: '${{ needs.validate-pr-snapshot.outputs.manifest-digest }}',
              PR_NUMBER: '${{ needs.validate-pr-snapshot.outputs.pr-number }}',
              SNAPSHOT_VERSION: '${{ needs.validate-pr-snapshot.outputs.version }}',
              SOURCE_RUN_ATTEMPT: '${{ needs.validate-pr-snapshot.outputs.run-attempt }}',
              SOURCE_RUN_ID: '${{ needs.validate-pr-snapshot.outputs.run-id }}',
            },
            run: `jq -n \
  --arg repository "$GITHUB_REPOSITORY" \
  --argjson prNumber "$PR_NUMBER" \
  --arg headSha "$HEAD_SHA" \
  --argjson sourceRunId "$SOURCE_RUN_ID" \
  --argjson sourceRunAttempt "$SOURCE_RUN_ATTEMPT" \
  --arg version "$SNAPSHOT_VERSION" \
  --arg manifestSha256 "$MANIFEST_DIGEST" \
  '{repository, prNumber, headSha, sourceRunId, sourceRunAttempt, version, manifestSha256}' \
  > "$RUNNER_TEMP/verified-pr-snapshot.json"`,
          },
          {
            name: 'Upload trusted verification receipt',
            uses: 'actions/upload-artifact@v4',
            with: {
              name: 'verified-pr-snapshot-${{ needs.validate-pr-snapshot.outputs.head-sha }}-${{ needs.validate-pr-snapshot.outputs.run-id }}-${{ needs.validate-pr-snapshot.outputs.run-attempt }}',
              path: '${{ runner.temp }}/verified-pr-snapshot.json',
              'if-no-files-found': 'error',
              overwrite: true,
              'retention-days': 30,
            },
          },
          {
            name: 'Record snapshot provenance',
            env: {
              SNAPSHOT_VERSION: '${{ needs.validate-pr-snapshot.outputs.version }}',
              MANIFEST_DIGEST: '${{ needs.validate-pr-snapshot.outputs.manifest-digest }}',
              PACKAGE_COUNT: '${{ needs.validate-pr-snapshot.outputs.package-count }}',
              PR_NUMBER: '${{ needs.validate-pr-snapshot.outputs.pr-number }}',
              SNAPSHOT_TAG: '${{ needs.validate-pr-snapshot.outputs.npm-tag }}',
              SOURCE_RUN_URL: '${{ needs.validate-pr-snapshot.outputs.source-run-url }}',
            },
            run: `cat >> "$GITHUB_STEP_SUMMARY" <<EOF
## PR snapshot

- PR: #$PR_NUMBER
- Head: \`\${{ needs.validate-pr-snapshot.outputs.head-sha }}\`
- Version: \`$SNAPSHOT_VERSION\`
- Publish-time npm tag (best-effort mutable metadata): \`$SNAPSHOT_TAG\`
- Packages: $PACKAGE_COUNT
- Manifest SHA-256: \`$MANIFEST_DIGEST\`
- Source CI run: $SOURCE_RUN_URL
- Candidate attestation: binds the validated package and manifest digests to the exact PR head and source CI run.
- npm provenance: identifies this trusted default-branch promotion workflow; it does not claim that the PR CI job held npm publishing authority.
EOF`,
          },
        ],
      },
    },
    /** Spread into `on.workflow_dispatch.inputs`. */
    dispatchInputs: {
      pr_number: {
        description: 'PR number selector for trusted snapshot promotion',
        required: false,
        default: '0',
        type: 'string',
      },
      head_sha: {
        description: 'Expected PR head selector for trusted snapshot promotion',
        required: false,
        default: '',
        type: 'string',
      },
      ci_run_id: {
        description: 'Exact successful PR CI run selector for trusted snapshot promotion',
        required: false,
        default: '0',
        type: 'string',
      },
    },
    /** Append to `on.workflow_dispatch.inputs.mode.options`. */
    dispatchModeOption: 'promote-pr-snapshot',
    /**
     * Spread into `on`. The dispatcher polls rather than reacting to the label event: a label applied
     * after CI already finished produces no workflow_run, so without this the common maintainer
     * gesture — review, then label — would never publish anything.
     */
    scheduleTrigger: [{ cron: '*/5 * * * *' }],
    /** Spread into `on`. Fires when the producer workflow completes. */
    workflowRunTrigger: { workflows: ['ci'], types: ['completed'] },
  }
}
