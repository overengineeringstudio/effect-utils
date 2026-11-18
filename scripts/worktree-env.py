#!/usr/bin/env python3
"""Publish/preflight the Nix-built worktree PATH; never perform implicit setup.

Python is stage-zero glue, matching the existing consumer-root materializer.
Nix and Buck remain the tool-closure and computation authorities respectively.
The Nix launcher retains caller-owned policy wrappers and immutable admission
tools without forwarding ambient executable directories into check runtimes.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile


def git(*args):
    return subprocess.check_output([os.environ.get("WORKTREE_GIT", "git"), *args])


def identity(root):
    # Nix's Git flake source excludes untracked files. Refuse rather than publish
    # a closure that appears to include them; staging is sufficient, no commit.
    untracked = git("ls-files", "--others", "--exclude-standard", "-z")
    if untracked:
        raise RuntimeError("Stage new source files with git add before preparing worktree tools")
    digest = hashlib.sha256(b"effect-utils/worktree-tools/v1\0" + os.fsencode(root))
    digest.update(git("rev-parse", "HEAD"))
    digest.update(git("diff", "HEAD", "--binary", "--no-ext-diff", "--", "."))
    return digest.hexdigest()


def selected(state, root, key):
    try:
        generation = (state / "current").resolve(strict=True)
        # Only our immutable generation directory may select a tool closure.
        if generation.parent != state or not generation.name.startswith("generation-"):
            raise RuntimeError("Invalid worktree tools generation pointer")
        manifest = json.loads((generation / "manifest.json").read_text())
        tools = (generation / "tools").resolve(strict=True)
        if manifest != {"identity": key, "root": str(root), "tools": str(tools)}:
            return None
        if not (tools / "bin/buck2").is_file():
            return None
        return generation, tools
    except (FileNotFoundError, ValueError):
        return None


def main():
    invocation_directory = Path.cwd()
    # Git hooks must never redirect the worktree or index used for identity.
    for variable in git("rev-parse", "--local-env-vars").decode().splitlines():
        os.environ.pop(variable, None)
    inherited = os.environ.get("PATH", "").split(os.pathsep)
    guards = [p for p in inherited if p.endswith("/agent-seat/policy-bin")]
    os.environ["WORKTREE_POLICY_PATH"] = os.pathsep.join(guards)
    root = Path(git("rev-parse", "--show-toplevel").decode().strip()).resolve()
    os.chdir(root)
    state = root / ".worktree-tools/v1"
    args = sys.argv[1:]
    if not args or args[0] not in ("prepare", "check", "run"):
        raise RuntimeError("Usage: worktree-env.py prepare | check OUTPUT | run -- COMMAND...")
    mode = args.pop(0)
    state.mkdir(parents=True, exist_ok=True)
    with (state / "publication.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        key = identity(root)
        publication = selected(state, root, key)
        if mode == "prepare":
            if publication is not None:
                generation, tools = publication
                override = os.environ.get("WORKTREE_CAPABILITIES_PROFILE")
                changed = override and (generation / "profile").resolve() != Path(override).resolve()
                check = subprocess.run([str(tools / "share/worktree-tools/preflight"), str(root), str(generation)])
                if changed or check.returncode:
                    publication = None
            if publication is None:
                generation = Path(tempfile.mkdtemp(prefix="generation-", dir=state))
                # The out-link is a GC root. Generations live until normal safe
                # worktree teardown, so active commands never lose their closure.
                subprocess.run([
                    os.environ.get("WORKTREE_NIX", "nix"), "build", "--out-link",
                    str(generation / "tools"), "git+file:" + str(root) + "#worktree-tools",
                ], check=True)
                tools = (generation / "tools").resolve(strict=True)
                subprocess.run([str(tools / "share/worktree-tools/prepare"), str(root), str(generation)], check=True)
                if identity(root) != key:
                    raise RuntimeError("Worktree changed during preparation; publication refused")
                (generation / "manifest.json").write_text(json.dumps({
                    "identity": key, "root": str(root), "tools": str(tools),
                }) + "\n")
                temporary = state / ("current-" + str(os.getpid()))
                temporary.symlink_to(generation.name)
                os.replace(temporary, state / "current")
                publication = generation, tools
            print(publication[1] / "bin")
            return
        if publication is None:
            repair = "python3 " + shlex.quote(str(Path(__file__).resolve())) + " prepare"
            raise RuntimeError("Missing/stale worktree tools; run " + repair)
        _, tools = publication
        if mode == "check":
            if len(args) != 1 or Path(args[0]).resolve() != tools:
                raise RuntimeError("Selected worktree tools differ from this executable; rerun its prepare command")
            print(publication[0])
            return
        if args and args[0] == "--":
            args.pop(0)
        if not args:
            raise RuntimeError("run requires a command after --")
        # Keep the authenticated agent policy guards before all development tools.
        # Repository products precede the general development tool closure.
        os.environ["PATH"] = os.pathsep.join(guards + [str(root / "node_modules/.bin"), str(tools / "bin")] + inherited)
        os.environ["WORKSPACE_ROOT"] = str(root)
    os.chdir(invocation_directory)
    os.execvpe(args[0], args, os.environ)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print("worktree-env: " + str(error), file=sys.stderr)
        sys.exit(1)
