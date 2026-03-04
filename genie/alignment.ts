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
 * Runs `mr sync --pull --all`, optionally runs devenv tasks per member (e.g. pnpm:install,
 * nix:hash), detects dirty files in member worktrees, and for each dirty member pushes an
 * alignment branch + creates/updates a PR.
 *
 * Auto-merges only when the diff is exclusively safe files (lock files, Nix build hashes,
 * genie-generated configs). Non-safe changes are labeled `alignment-needs-review` for manual handling.
 */
export const alignmentCoordinatorWorkflow = (opts?: {
  /** Members to exclude from alignment (e.g. beads repos, reference repos) */
  excludeMembers?: string[]
  /**
   * Devenv tasks to run per member after sync.
   * Each member's tasks are run in order via the member's pinned devenv from devenv.lock.
   * Members not listed here skip devenv entirely (no overhead).
   */
  memberTasks?: Record<string, [string, ...string[]]>
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
          ...(opts?.memberTasks && Object.keys(opts.memberTasks).length > 0
            ? [memberTasksStep(opts.memberTasks)]
            : []),
          coordinatorScript(opts?.excludeMembers ?? []),
        ],
      },
    },
  } satisfies GitHubWorkflowArgs)

/**
 * Generate a step that runs devenv tasks for configured members.
 * Each member's pinned devenv is resolved from its devenv.lock.
 * Task failures are logged as warnings but don't abort the coordinator.
 */
const memberTasksStep = (
  memberTasks: Record<string, [string, ...string[]]>,
) => {
  const calls = Object.entries(memberTasks)
    .map(
      ([member, tasks]) =>
        `run_devenv_tasks "${member}" ${tasks.map((t) => `"${t}"`).join(' ')}`,
    )
    .join('\n')

  return {
    name: 'Run devenv tasks per member',
    shell: 'bash',
    run: `set -euo pipefail

# Provide perl for nix:hash tasks (update-all-hashes script needs it)
PERL_BIN=$(nix build nixpkgs#perl --no-link --print-out-paths)/bin
export PATH="$PERL_BIN:$PATH"

run_devenv_tasks() {
  local member_name="$1"; shift
  local member_dir="repos/$member_name"
  [ -d "$member_dir" ] || return 0

  if [ ! -f "$member_dir/devenv.lock" ]; then
    echo "::warning::$member_name has no devenv.lock — skipping devenv tasks"
    return 0
  fi

  local devenv_rev
  devenv_rev=$(jq -r .nodes.devenv.locked.rev "$member_dir/devenv.lock")
  if [ -z "$devenv_rev" ] || [ "$devenv_rev" = "null" ]; then
    echo "::warning::$member_name devenv.lock missing devenv rev — skipping"
    return 0
  fi

  echo "::group::devenv tasks for $member_name"
  local devenv_bin
  devenv_bin=$(nix build --no-link --print-out-paths "github:cachix/devenv/$devenv_rev#devenv")/bin/devenv

  (
    cd "$member_dir"
    for task in "$@"; do
      echo "  Running: $task"
      CI= NIX_CONFIG="restrict-eval = false" "$devenv_bin" tasks run "$task" --mode before || \\
        echo "::warning::Task $task failed in $member_name"
    done
  )
  echo "::endgroup::"
}

${calls}`,
  }
}

const coordinatorScript = (excludeMembers: string[]) => ({
  name: 'Create alignment PRs for dirty members',
  shell: 'bash',
  run: `set -euo pipefail

# Make gh CLI available via nix shell (not globally installed on self-hosted runners)
GH_BIN=$(nix build nixpkgs#gh --no-link --print-out-paths)/bin/gh

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

  # Check for any dirty files after sync + devenv tasks
  files_changed=$(cd "$member_dir" && git diff --name-only 2>/dev/null || true)
  [ -z "$files_changed" ] && continue

  # Determine if all changed files are safe for auto-merge
  # Safe: lock files, Nix build hashes, or any file with a corresponding .genie.ts template
  safe_only=true
  while IFS= read -r f; do
    case "$f" in
      *.lock|pnpm-lock.yaml|*/pnpm-lock.yaml|nix/build.nix|*/nix/build.nix) ;;
      *) [ -f "$member_dir/\${f}.genie.ts" ] || { safe_only=false; break; } ;;
    esac
  done <<< "$files_changed"

  # Extract owner/repo from URL
  repo_slug=$(echo "$member_url" | sed -E 's|https://github.com/||; s|\\.git$||')
  branch_name="$BRANCH_PREFIX/$SOURCE_REPO"

  echo "::group::$member_name ($repo_slug)"
  echo "Changed files:"
  echo "$files_changed" | sed 's/^/  /'
  echo "Safe-only: $safe_only"

  # Stage all changes, commit, push
  (
    cd "$member_dir"
    git checkout -B "$branch_name"
    git add -A
    git -c user.name="schickling-assistant" \\
        -c user.email="schickling-assistant@users.noreply.github.com" \\
        commit -m "chore: align dependency files (upstream update)"
    git push "https://x-access-token:\${GH_TOKEN}@github.com/$repo_slug.git" \\
        "$branch_name" --force
  )

  # Determine default branch from megarepo config
  member_ref=$(jq -r --arg m "$member_name" '.members[$m].ref' megarepo.lock)

  # Create or update PR
  PR_TITLE="chore: align dependency files (upstream update)"
  PR_BODY="Automated dependency alignment.

Updates lock files and dependency hashes to match latest upstream commits.

---
*Created by the megarepo alignment coordinator.*"

  existing_pr=$($GH_BIN pr list --repo "$repo_slug" --head "$branch_name" --base "$member_ref" --state open --json number -q '.[0].number' 2>/dev/null || true)

  if [ -n "$existing_pr" ]; then
    echo "Updating existing PR #$existing_pr"
  else
    echo "Creating new PR"
    $GH_BIN pr create --repo "$repo_slug" \\
      --head "$branch_name" \\
      --base "$member_ref" \\
      --title "$PR_TITLE" \\
      --body "$PR_BODY" 2>&1 || true
    existing_pr=$($GH_BIN pr list --repo "$repo_slug" --head "$branch_name" --base "$member_ref" --state open --json number -q '.[0].number' 2>/dev/null || true)
  fi

  # Auto-merge gate: only if all changed files are safe (lock files, Nix hashes, genie-generated configs)
  if [ "$safe_only" = true ] && [ -n "$existing_pr" ]; then
    echo "Safe-only diff — enabling auto-merge"
    $GH_BIN pr merge "$existing_pr" --repo "$repo_slug" --auto --squash 2>/dev/null || \\
      echo "::warning::Could not enable auto-merge for $repo_slug#$existing_pr (may need branch protection)"
  elif [ -n "$existing_pr" ]; then
    echo "::warning::Non-safe files changed in $member_name — skipping auto-merge"
    $GH_BIN pr edit "$existing_pr" --repo "$repo_slug" --add-label "alignment-needs-review" 2>/dev/null || true
  fi

  echo "::endgroup::"
done <<< "$MEMBERS"

echo "Alignment coordinator completed"`,
})
