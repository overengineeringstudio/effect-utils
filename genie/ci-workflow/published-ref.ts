import { githubAccessTokenEnv, githubAppInstallationTokenStep } from './setup.ts'

/** Eligibility comes only from this run's successful status write for its exact SHA. */
export const publishedRefIf =
  "github.event_name == 'push' && github.ref == 'refs/heads/main' && (steps.publication-scope.outputs.current-sha == github.sha || steps.product-publication.outputs.current-sha == github.sha)"

export const publishedRefSteps = [
  {
    ...githubAppInstallationTokenStep({
      id: 'published-ref-token',
      name: 'Mint publisher GitHub App token for published ref',
      appId: '${{ vars.NIX_PUBLISHER_GITHUB_APP_ID }}',
      privateKey: '${{ secrets.NIX_PUBLISHER_GITHUB_APP_PRIVATE_KEY }}',
      owner: 'overengineeringstudio',
      repositories: ['effect-utils'],
    }),
    if: publishedRefIf,
  },
  {
    id: 'advance-published-ref',
    name: 'Advance published ref',
    if: publishedRefIf,
    env: githubAccessTokenEnv('${{ steps.published-ref-token.outputs.token }}'),
    run: [
      'set -euo pipefail',
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
      'old="$(fetch_published)"',
      'if [ -n "$old" ]; then',
      '  if git merge-base --is-ancestor "$GITHUB_SHA" "$old"; then',
      '    echo "published $old -> $old (already at or ahead of $GITHUB_SHA)" >> "$GITHUB_STEP_SUMMARY"',
      '    exit 0',
      '  fi',
      '  if ! git merge-base --is-ancestor "$old" "$GITHUB_SHA"; then',
      '    echo "::error::published $old is not an ancestor of $GITHUB_SHA; refusing non-fast-forward update"',
      '    exit 1',
      '  fi',
      'fi',
      'if git push origin "$GITHUB_SHA:refs/heads/published"; then',
      '  echo "published ${old:-<absent>} -> $GITHUB_SHA" >> "$GITHUB_STEP_SUMMARY"',
      'else',
      '  current="$(fetch_published)"',
      '  if [ -n "$current" ] && git merge-base --is-ancestor "$GITHUB_SHA" "$current"; then',
      '    echo "published ${old:-<absent>} -> $current (concurrent run already advanced past $GITHUB_SHA)" >> "$GITHUB_STEP_SUMMARY"',
      '  else',
      '    echo "::error::published push rejected and remote is not a descendant of $GITHUB_SHA"',
      '    exit 1',
      '  fi',
      'fi',
    ].join('\n'),
  },
]
