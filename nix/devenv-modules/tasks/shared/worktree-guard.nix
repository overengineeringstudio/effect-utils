# Prevent commits on the default branch and optionally enforce a worktree-only
# workflow by refusing commits from the primary worktree.
#
# Also detects megarepo store worktrees (refs/heads/<ref>) and:
# - prevents commits when the worktree path implies a different ref than HEAD
# - prevents branch/ref switching via a post-checkout hook that automatically
#   restores the expected ref
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.worktree-guard {})
#   ];
{
  remoteName ? "origin",
  fallbackDefaultBranch ? "main",
  enforcePrimaryWorktree ? true,
  enforceMegarepoStoreRefMatch ? true,
  enforceMegarepoStoreCheckout ? true,
  hookId ? "branch-worktree-guard",
}:
{ pkgs, lib, ... }:
let
  gitBin = "${pkgs.git}/bin/git";

  # Shared store worktree detection logic.
  # After evaluation sets: git, repoRoot, repoName, repoRootPhysical,
  # storeExpectedRef, storeExpectedType, storeBase, encodedRef
  storeDetect = ''
    git=${gitBin}

    repoRoot="$($git rev-parse --show-toplevel)"
    repoName="''${repoRoot##*/}"
    repoRootPhysical="$(cd "$repoRoot" && pwd -P)"
    repoRootPhysical="''${repoRootPhysical%/}"

    url_decode() {
      # Percent-decoding using printf escape sequences.
      # encodeURIComponent emits %XX escapes (no '+').
      printf '%b' "''${1//%/\\x}"
    }

    storeExpectedRef=""
    storeExpectedType=""
    storeBase=""
    encodedRef=""

    case "$repoRootPhysical" in
      */refs/heads/*)
        storeBase="''${repoRootPhysical%%/refs/heads/*}"
        encodedRef="''${repoRootPhysical#"$storeBase/refs/heads/"}"
        if [ -d "$storeBase/.bare" ]; then
          storeExpectedType="branch"
          storeExpectedRef="$(url_decode "$encodedRef")"
        fi
        ;;
      */refs/tags/*)
        storeBase="''${repoRootPhysical%%/refs/tags/*}"
        encodedRef="''${repoRootPhysical#"$storeBase/refs/tags/"}"
        if [ -d "$storeBase/.bare" ]; then
          storeExpectedType="tag"
          storeExpectedRef="$(url_decode "$encodedRef")"
        fi
        ;;
      */refs/commits/*)
        storeBase="''${repoRootPhysical%%/refs/commits/*}"
        encodedRef="''${repoRootPhysical#"$storeBase/refs/commits/"}"
        if [ -d "$storeBase/.bare" ]; then
          storeExpectedType="commit"
          storeExpectedRef="$encodedRef"
        fi
        ;;
    esac
  '';
in
{
  git-hooks.enable = lib.mkDefault true;

  # ── Pre-commit: prevent commits on wrong branch/worktree ──────────────

  git-hooks.hooks.${hookId} = {
    enable = true;
    entry = "${pkgs.writeShellScript "worktree-guard" ''
      set -euo pipefail

      ${storeDetect}

      # Determine default branch from <remote>/HEAD (fallback: ${fallbackDefaultBranch})
      originHeadRef="$($git symbolic-ref --quiet refs/remotes/${remoteName}/HEAD 2>/dev/null || true)"
      defaultBranch="${fallbackDefaultBranch}"
      if [ -n "$originHeadRef" ]; then
        remotePrefix="refs/remotes/${remoteName}/"
        case "$originHeadRef" in
          "$remotePrefix"*)
            # Keep multi-segment branch names (e.g. refs/remotes/origin/release/main -> release/main)
            defaultBranch="''${originHeadRef#"$remotePrefix"}"
            ;;
        esac
      fi

      branch="$($git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
      if [ -z "$branch" ]; then
        if [ "${if enforceMegarepoStoreRefMatch then "1" else "0"}" = "1" ] && [ "$storeExpectedType" = "branch" ]; then
          commitSha="$($git rev-parse --short HEAD 2>/dev/null || echo unknown)"
          echo "error: ref mismatch: store path implies '$storeExpectedRef' but worktree is detached at $commitSha" >&2
          echo "hint: use 'mr pin <member> -c $commitSha' to create proper worktree, or 'git checkout $storeExpectedRef' to restore expected state" >&2
        else
          echo "error: refusing to commit in detached HEAD (expected a branch)." >&2
          echo "hint: create a worktree + branch for your change." >&2
        fi
        exit 1
      fi

      if [ "$branch" = "$defaultBranch" ]; then
        echo "error: refusing to commit on default branch '$defaultBranch'." >&2
        echo "hint: create a worktree on a feature branch, then commit from there." >&2
        echo >&2
        if [ -n "$storeExpectedType" ]; then
          echo "  mr pin <member> -c my-branch   # from the megarepo root" >&2
        else
          echo "  git fetch ${remoteName}" >&2
          echo "  git worktree add ../''${repoName}--my-branch -b my-branch ${remoteName}/$defaultBranch" >&2
        fi
        exit 1
      fi

      if [ "${if enforceMegarepoStoreRefMatch then "1" else "0"}" = "1" ] && [ "$storeExpectedType" = "branch" ] && [ "$branch" != "$storeExpectedRef" ]; then
        echo "error: ref mismatch: store path implies '$storeExpectedRef' but worktree HEAD is '$branch'" >&2
        echo "hint: use 'mr pin <member> -c $branch' to create proper worktree, or 'git checkout $storeExpectedRef' to restore expected state" >&2
        exit 1
      fi

      if [ "${if enforcePrimaryWorktree then "1" else "0"}" = "1" ]; then
        gitDir="$($git rev-parse --git-dir)"
        commonDir="$($git rev-parse --git-common-dir)"
        if [ "$gitDir" = "$commonDir" ]; then
          branchPath="$(echo "$branch" | tr '/' '-')"
          echo "error: refusing to commit from the primary worktree." >&2
          echo "hint: keep the primary worktree on '$defaultBranch' and do work in linked worktrees." >&2
          echo >&2
          echo "  git switch $defaultBranch" >&2
          echo "  git worktree add ../''${repoName}--$branchPath $branch" >&2
          exit 1
        fi
      fi
    ''}";
    stages = [ "pre-commit" ];
    always_run = true;
    pass_filenames = false;
  };

  # ── Post-checkout: prevent ref switching in megarepo store worktrees ──

  git-hooks.hooks."${hookId}-checkout" = {
    enable = enforceMegarepoStoreCheckout;
    entry = "${pkgs.writeShellScript "worktree-checkout-guard" ''
      set -euo pipefail

      # Recursion guard: skip when we are restoring the expected ref
      if [ "''${_WORKTREE_GUARD_RESTORING:-}" = "1" ]; then
        exit 0
      fi

      # post-checkout args: $1=prev_ref $2=new_ref $3=flag
      # flag=1 → branch/ref checkout, flag=0 → file checkout
      if [ "''${3:-}" != "1" ]; then
        exit 0
      fi

      ${storeDetect}

      # Only guard megarepo store worktrees
      if [ -z "$storeExpectedType" ]; then
        exit 0
      fi

      # Skip during in-progress git operations that temporarily change HEAD
      gitDir="$($git rev-parse --git-dir)"
      if [ -d "$gitDir/rebase-merge" ] || [ -d "$gitDir/rebase-apply" ] || [ -f "$gitDir/BISECT_START" ]; then
        exit 0
      fi

      # Determine if current state diverged from what the store path expects
      restoreTarget=""
      case "$storeExpectedType" in
        branch)
          currentBranch="$($git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
          if [ "$currentBranch" != "$storeExpectedRef" ]; then
            restoreTarget="$storeExpectedRef"
          fi
          ;;
        tag)
          currentBranch="$($git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
          if [ -n "$currentBranch" ]; then
            restoreTarget="tags/$storeExpectedRef"
          else
            currentSha="$($git rev-parse HEAD 2>/dev/null)"
            expectedSha="$($git rev-parse "tags/''${storeExpectedRef}^{}" 2>/dev/null || true)"
            if [ -n "$expectedSha" ] && [ "$currentSha" != "$expectedSha" ]; then
              restoreTarget="tags/$storeExpectedRef"
            fi
          fi
          ;;
        commit)
          currentBranch="$($git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
          if [ -n "$currentBranch" ]; then
            restoreTarget="$storeExpectedRef"
          else
            currentSha="$($git rev-parse HEAD 2>/dev/null)"
            expectedSha="$($git rev-parse "$storeExpectedRef" 2>/dev/null || true)"
            if [ -n "$expectedSha" ] && [ "$currentSha" != "$expectedSha" ]; then
              restoreTarget="$storeExpectedRef"
            fi
          fi
          ;;
      esac

      if [ -n "$restoreTarget" ]; then
        echo "error: ref switching is not allowed in megarepo store worktrees." >&2
        echo "hint: this worktree is pinned to $storeExpectedType '$storeExpectedRef'" >&2
        echo "hint: use 'mr pin <member> -c <ref>' to create a new worktree for a different ref." >&2
        echo >&2
        echo "Restoring $storeExpectedType '$storeExpectedRef'..." >&2
        if ! _WORKTREE_GUARD_RESTORING=1 $git checkout "$restoreTarget" >/dev/null 2>&1; then
          echo "warning: automatic restore failed. Run 'git checkout $restoreTarget' manually." >&2
        fi
        exit 1
      fi
    ''}";
    stages = [ "post-checkout" ];
    always_run = true;
    pass_filenames = false;
  };
}
