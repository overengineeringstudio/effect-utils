import { githubAccessTokenEnv, githubAppInstallationTokenStep } from './setup.ts'

/** Eligibility comes only from this run's successful status write for its exact SHA. */
export const publishedRefIf =
  "github.repository == 'overengineeringstudio/effect-utils' && github.event_name == 'push' && github.ref == 'refs/heads/main' && (steps.publication-scope.outputs.current-sha == github.sha || steps.product-publication.outputs.current-sha == github.sha)"

const publishedRefTokenStep = githubAppInstallationTokenStep({
  id: 'published-ref-token',
  name: 'Mint publisher GitHub App token for published ref',
  appId: '${{ vars.NIX_PUBLISHER_GITHUB_APP_ID }}',
  privateKey: '${{ secrets.NIX_PUBLISHER_GITHUB_APP_PRIVATE_KEY }}',
  owner: 'overengineeringstudio',
  repositories: ['effect-utils'],
})

export const publishedRefSteps = [
  {
    ...publishedRefTokenStep,
    with: { ...publishedRefTokenStep.with, 'permission-contents': 'write' },
    if: publishedRefIf,
  },
  {
    id: 'advance-published-ref',
    name: 'Advance published ref',
    if: publishedRefIf,
    env: githubAccessTokenEnv('${{ steps.published-ref-token.outputs.token }}'),
    run: [
      'set -euo pipefail',
      'source genie/ci-workflow/published-ref-decide.sh',
      'gh auth setup-git',
      // Checkout credentials must not override the publisher App credential helper.
      'git config --local --unset-all http.https://github.com/.extraheader || test "$?" = 5',
      'if [ "$(git rev-parse --is-shallow-repository)" = true ]; then',
      '  git fetch --no-tags --unshallow origin main',
      'fi',
      'fetch_published() {',
      '  local result',
      '  if git ls-remote --exit-code origin refs/heads/published > /dev/null; then',
      '    git fetch --no-tags origin +refs/heads/published:refs/remotes/origin/published',
      '    git rev-parse refs/remotes/origin/published',
      '  else',
      '    result=$?',
      '    if [ "$result" -ne 2 ]; then return "$result"; fi',
      '  fi',
      '}',
      'for attempt in 1 2 3; do',
      '  tip="$(fetch_published)"',
      '  case "$(decide "$tip" "$GITHUB_SHA")" in',
      '    noop)',
      '      echo "published $tip -> $tip (already at or ahead of $GITHUB_SHA)" >> "$GITHUB_STEP_SUMMARY"',
      '      exit 0',
      '      ;;',
      '    create|push)',
      '      if git push origin "$GITHUB_SHA:refs/heads/published"; then',
      '        echo "published ${tip:-<absent>} -> $GITHUB_SHA" >> "$GITHUB_STEP_SUMMARY"',
      '        exit 0',
      '      fi',
      '      echo "::notice::published push attempt $attempt rejected; refetching before retry"',
      '      ;;',
      '    diverged)',
      '      echo "::error::published $tip is not an ancestor of $GITHUB_SHA; refusing non-fast-forward update"',
      '      exit 1',
      '      ;;',
      '    *)',
      '      echo "::error::Unable to classify published ancestry"',
      '      exit 1',
      '      ;;',
      '  esac',
      'done',
      // The last rejected push may also have lost to a newer eligible run.
      'tip="$(fetch_published)"',
      'if [ "$(decide "$tip" "$GITHUB_SHA")" = noop ]; then',
      '  echo "published $tip -> $tip (concurrent run already advanced past $GITHUB_SHA)" >> "$GITHUB_STEP_SUMMARY"',
      '  exit 0',
      'fi',
      'echo "::error::Failed to advance published to $GITHUB_SHA after 3 push attempts"',
      'exit 1',
    ].join('\n'),
  },
]
