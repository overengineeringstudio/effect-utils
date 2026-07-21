# Resolve a megarepo member for Nix evaluation, guaranteeing that the
# materialized checkout matches `megarepo.lock`.
#
# WHY THIS EXISTS
#
# Repos whose `devenv.nix` imports Nix helpers from a megarepo member (rather
# than only from the pinned flake input) need the member's *Nix* outputs and the
# member's *TypeScript generator sources* to come from the same revision — the
# `genie` CLI built by Nix evaluates `.genie.ts` sources read from the same
# checkout. Reading `./repos/<member>` directly achieves that lockstep, but it
# feeds an untracked, unversioned directory into Nix evaluation: if the checkout
# drifts from `megarepo.lock` (e.g. the lock moved but `mr apply` was never
# re-run), evaluation fails with an opaque error such as
# `error: attribute 'gh-labels' missing` before the shell can even be entered —
# and the diagnostic that would explain it (`mr:lock-sync-check`) lives *inside*
# that shell. See livestorejs/livestore#1467.
#
# This helper keeps the lockstep property but makes drift an explicit, actionable
# error instead of an opaque one.
#
# WORKTREE MODES
#
# `mr` materializes members in one of two modes, distinguishable from the
# worktree name recorded in the member's `.git` file
# (`gitdir: …/.bare/worktrees/<name>`):
#
#   * commit mode   — `<name>` is a 40-char sha; the member is pinned to exactly
#                     that revision, so it MUST match `megarepo.lock`.
#   * tracking mode — `<name>` is a branch; the member is deliberately editable
#                     (`mr config pin <member> --checkout <ref>`) for
#                     co-development, so its revision is EXPECTED to differ and
#                     is left alone.
#
# Anything we cannot positively identify as drifted is allowed through: we only
# fail when we are certain the checkout disagrees with the lock.
{ lib }:
{
  /*
    Resolve a member to a flake, preferring the materialized checkout.

    - not materialized      -> `pinned` (the flake input)
    - tracking worktree     -> local checkout (deliberate co-development)
    - commit worktree, match-> local checkout (lockstep holds)
    - commit worktree, drift-> throw with the exact remediation
  */
  resolve =
    {
      # Member name as it appears in `megarepo.lock`, e.g. "effect-utils".
      name,
      # Path to the materialized member, e.g. `./repos/effect-utils`.
      memberPath,
      # Path to the repo's `megarepo.lock`.
      lockFile,
      # Flake input to fall back to when the member is not materialized.
      pinned,
    }:
    let
      gitPath = memberPath + "/.git";

      # A materialized member is a git *worktree*, so `.git` is a regular file
      # containing `gitdir: <path>`; a plain clone has a `.git/` directory (and
      # therefore a `.git/HEAD`). Probing for `.git/HEAD` distinguishes the two
      # using only `pathExists` — `readFileType` refuses to inspect a path
      # reached through the member symlink.
      isWorktree = builtins.pathExists gitPath && !builtins.pathExists (memberPath + "/.git/HEAD");

      worktreeName =
        if !isWorktree then
          null
        else
          lib.last (lib.splitString "/" (lib.removeSuffix "\n" (builtins.readFile gitPath)));

      # 40 hex chars => the worktree is pinned to a concrete commit.
      isCommitMode = worktreeName != null && builtins.match "[0-9a-f]{40}" worktreeName != null;

      lockedCommit = (builtins.fromJSON (builtins.readFile lockFile)).members.${name}.commit;

      localFlake = builtins.getFlake (builtins.toString memberPath);
    in
    if !builtins.pathExists (memberPath + "/flake.nix") then
      pinned
    else if !isCommitMode then
      # Tracking worktree (or an unidentifiable checkout): deliberate override.
      localFlake
    else if worktreeName == lockedCommit then
      localFlake
    else
      throw ''
        megarepo member '${name}' is out of sync with megarepo.lock.

          materialized: ${worktreeName}
          expected:     ${lockedCommit}

        Nix helpers and generator sources are both read from this checkout, so a
        mismatch would silently pair the '${name}' Nix build with generator
        sources from a different revision.

        Fix it by re-materializing the member (runnable outside the dev shell):

          mr apply

        To co-develop '${name}' instead, switch it to a tracking worktree:

          mr config pin ${name} --checkout <ref>
      '';
}
