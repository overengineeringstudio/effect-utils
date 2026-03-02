/**
 * Reusable alignment automation building blocks for genie workflow files.
 *
 * Provides a dispatch step (for upstream repos) and a coordinator workflow factory
 * (for megarepo-all) that automates lock-file-only dependency propagation.
 *
 * Design rationale: see context/megarepo-alignment-automation.md in dotfiles.
 */

import {
  githubWorkflow,
  type GitHubWorkflowArgs,
} from '../packages/@overeng/genie/src/runtime/mod.ts'
import {
  checkoutStep,
  installNixStep,
  installMegarepoStep,
  selfHostedRunner,
  bashShellDefaults,
} from './ci-workflow.ts'

/**
 * Step that dispatches `upstream-changed` repository_dispatch to a target repo.
 * Add this to upstream CI workflows so merges to main trigger downstream alignment.
 *
 * Requires `MEGAREPO_ALIGNMENT_TOKEN` secret (fine-grained PAT with Contents + Pull Requests write).
 */
export const dispatchAlignmentStep = (opts: {
  /** Target repo that receives the dispatch (e.g. 'schickling/megarepo-all') */
  targetRepo: string
  /** Event type sent in the dispatch (default: 'upstream-changed') */
  eventType?: string
}) =>
  ({
    name: 'Dispatch alignment to coordinator',
    env: { GH_TOKEN: '${{ secrets.MEGAREPO_ALIGNMENT_TOKEN }}' },
    run: `printf '{"event_type":"${opts.eventType ?? 'upstream-changed'}","client_payload":{"source_repo":"%s","source_sha":"%s"}}' "\${{ github.repository }}" "\${{ github.sha }}" | gh api repos/${opts.targetRepo}/dispatches --input -`,
    shell: 'bash',
  })

/**
 * Coordinator workflow factory for megarepo-all.
 *
 * Triggers on `repository_dispatch` (upstream-changed) and `workflow_dispatch` (manual testing).
 * Runs `mr sync --pull --all`, detects dirty lock files in member worktrees,
 * and for each dirty member pushes an alignment branch + creates/updates a PR.
 *
 * Auto-merges only when the diff is exclusively lock files. Non-lock changes
 * are labeled `alignment-needs-review` for manual handling.
 */
export const alignmentCoordinatorWorkflow = (opts?: {
  /** Members to exclude from alignment (e.g. beads repos, reference repos) */
  excludeMembers?: string[]
}) =>
  githubWorkflow({
    name: 'Alignment Coordinator',
    on: {
      repository_dispatch: { types: ['upstream-changed'] },
      workflow_dispatch: null,
    },
    concurrency: {
      group: 'alignment-coordinator',
      'cancel-in-progress': true,
    },
    jobs: {
      coordinate: {
        'runs-on': selfHostedRunner,
        defaults: bashShellDefaults,
        env: {
          FORCE_SETUP: '1',
          CI: 'true',
          GITHUB_TOKEN: '${{ github.token }}',
          GH_TOKEN: '${{ secrets.MEGAREPO_ALIGNMENT_TOKEN }}',
        },
        steps: [
          checkoutStep(),
          installNixStep(),
          installMegarepoStep,
          {
            name: 'Sync all members to latest',
            run: 'mr sync --pull --all',
            shell: 'bash',
          },
          coordinatorScript(opts?.excludeMembers ?? []),
        ],
      },
    },
  } satisfies GitHubWorkflowArgs)

const coordinatorScript = (excludeMembers: string[]) => ({
  name: 'Create alignment PRs for dirty members',
  shell: 'bash',
  run: `set -euo pipefail

SOURCE_REPO="\${{ github.event.client_payload.source_repo || 'manual' }}"
SOURCE_SHA="\${{ github.event.client_payload.source_sha || 'unknown' }}"
BRANCH_PREFIX="auto/alignment"
EXCLUDE_MEMBERS="${excludeMembers.join(' ')}"

MEMBERS=$(jq -r '.members | to_entries[] | "\\(.key) \\(.value.url)"' megarepo.lock)

while IFS=' ' read -r member_name member_url; do
  # Skip excluded members
  for excluded in $EXCLUDE_MEMBERS; do
    [ "$member_name" = "$excluded" ] && continue 2
  done

  member_dir="repos/$member_name"
  [ -d "$member_dir" ] || continue

  # Check for dirty lock files after sync
  lock_files_changed=$(cd "$member_dir" && git diff --name-only -- '*.lock' 2>/dev/null || true)
  [ -z "$lock_files_changed" ] && continue

  # Determine if diff is lock-files-only
  all_files_changed=$(cd "$member_dir" && git diff --name-only 2>/dev/null || true)
  lock_only=true
  while IFS= read -r f; do
    case "$f" in
      *.lock) ;;
      *) lock_only=false; break ;;
    esac
  done <<< "$all_files_changed"

  # Extract owner/repo from URL
  repo_slug=$(echo "$member_url" | sed -E 's|https://github.com/||; s|\\.git$||')
  branch_name="$BRANCH_PREFIX/$SOURCE_REPO"

  echo "::group::$member_name ($repo_slug)"
  echo "Changed: $lock_files_changed"
  echo "Lock-only: $lock_only"

  # Stage lock files, commit, push
  (
    cd "$member_dir"
    git checkout -B "$branch_name"
    git add -- *.lock */*.lock 2>/dev/null || git add -- *.lock
    git -c user.name="megarepo-alignment[bot]" \\
        -c user.email="alignment@megarepo.local" \\
        commit -m "chore: align lock files (upstream update)"
    git push "https://x-access-token:\${GH_TOKEN}@github.com/$repo_slug.git" \\
        "$branch_name" --force
  )

  # Determine default branch from megarepo config
  member_ref=$(jq -r --arg m "$member_name" '.members[$m].ref' megarepo.lock)

  # Create or update PR
  PR_TITLE="chore: align lock files (upstream update)"
  PR_BODY="Automated lock file alignment.

Updates Nix lock files to match latest upstream commits.

---
*Created by the megarepo alignment coordinator.*"

  existing_pr=$(gh pr list --repo "$repo_slug" --head "$branch_name" --base "$member_ref" --state open --json number -q '.[0].number' 2>/dev/null || true)

  if [ -n "$existing_pr" ]; then
    echo "Updating existing PR #$existing_pr"
  else
    echo "Creating new PR"
    gh pr create --repo "$repo_slug" \\
      --head "$branch_name" \\
      --base "$member_ref" \\
      --title "$PR_TITLE" \\
      --body "$PR_BODY" 2>&1 || true
    existing_pr=$(gh pr list --repo "$repo_slug" --head "$branch_name" --base "$member_ref" --state open --json number -q '.[0].number' 2>/dev/null || true)
  fi

  # Auto-merge gate: only if diff is exclusively lock files
  if [ "$lock_only" = true ] && [ -n "$existing_pr" ]; then
    echo "Lock-only diff — enabling auto-merge"
    gh pr merge "$existing_pr" --repo "$repo_slug" --auto --squash 2>/dev/null || \\
      echo "::warning::Could not enable auto-merge for $repo_slug#$existing_pr (may need branch protection)"
  elif [ -n "$existing_pr" ]; then
    echo "::warning::Non-lock files changed in $member_name — skipping auto-merge"
    gh pr edit "$existing_pr" --repo "$repo_slug" --add-label "alignment-needs-review" 2>/dev/null || true
  fi

  echo "::endgroup::"
done <<< "$MEMBERS"

echo "Alignment coordinator completed"`,
})
