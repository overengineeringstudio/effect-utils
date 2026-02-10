# Prevent commits on the default branch and optionally enforce a worktree-only
# workflow by refusing commits from the primary worktree.
#
# Also detects megarepo store worktrees (refs/heads/<ref>) and prevents commits
# when the worktree path implies a different ref than the current git HEAD.
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
  hookId ? "branch-worktree-guard",
}:
{ pkgs, lib, ... }:
{
  git-hooks.enable = lib.mkDefault true;
  git-hooks.hooks.${hookId} = {
    enable = true;
    entry = "${pkgs.writeShellScript "worktree-guard" ''
      set -euo pipefail

      git=${pkgs.git}/bin/git

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

      # Determine default branch from <remote>/HEAD (fallback: ${fallbackDefaultBranch})
      originHeadRef="$($git symbolic-ref --quiet refs/remotes/${remoteName}/HEAD 2>/dev/null || true)"
      defaultBranch="${fallbackDefaultBranch}"
      if [ -n "$originHeadRef" ]; then
        defaultBranch="''${originHeadRef##*/}"
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
}
