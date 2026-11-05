"""Job-local identity receipt; a miss always returns to the ordinary publisher."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def digest(data):
    return hashlib.sha256(data).hexdigest()


def job_token(root):
    temporary = os.environ.get("RUNNER_TEMP")
    if not temporary:
        raise ValueError("no job-local RUNNER_TEMP")
    return Path(temporary) / f"editor-view-job-{digest(os.fsencode(root))}"

def capture(root, scope, inputs_only=False):
    job = [os.environ.get(key) for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB")]
    if not all(job):
        raise ValueError("no GitHub job identity")
    # GitHub cleans RUNNER_TEMP between jobs, even when a worktree is reused.
    job.append(job_token(root).read_text())
    git = lambda *args: subprocess.check_output(["git", "-C", str(root), *args])
    dirty = git("diff", "--binary", "HEAD") + git("status", "--porcelain=v1", "-z")
    for name in git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0"):
        if name:
            path = root / os.fsdecode(name)
            dirty += name + (os.fsencode(os.readlink(path)) if path.is_symlink() else path.read_bytes())
    if inputs_only:
        return {"job": job, "head": git("rev-parse", "HEAD").decode().strip(), "dirty": digest(dirty)}
    snapshots = {}
    for package in scope:
        directory = root / package
        editor = root / ".editor-view" if package == "." else directory.parent.parent / ".editor-view"
        pointer = editor / ("root" if package == "." else directory.name)
        snapshot = pointer.resolve(strict=True)
        record = snapshot / "editor-view.json"
        status = snapshot.stat()
        snapshots[package] = [os.readlink(pointer), str(snapshot), status.st_dev, status.st_ino,
                              status.st_mtime_ns, status.st_ctime_ns, digest(record.read_bytes()),
                              os.readlink(directory / "node_modules")]
    versions = [root / "scripts/editor-view-authority.ts", root / "scripts/editor-view-receipt.py"]
    versions += sorted((root / "packages/@overeng/buck2-tools/src").glob("*.ts"))
    return {"schema": 1, "job": job, "root": str(root), "scope": scope,
            "head": git("rev-parse", "HEAD").decode().strip(), "dirty": digest(dirty),
            "graph": digest((root / "devenv.nix").read_bytes() +
                            (root / "nix/devenv-modules/tasks/shared/test.nix").read_bytes()),
            "authority": digest((root / ".devenv/editor-workspace-authority.json").read_bytes()),
            "versions": digest(b"".join(path.read_bytes() for path in versions)), "snapshots": snapshots}


def main():
    action, directory, name, serialized = sys.argv[1:]
    root = Path(directory).resolve()
    receipt = root / ".devenv" / f"editor-view-{name}-receipt.json"
    pending = receipt.with_suffix(".pending.json")
    try:
        scope = sorted(set(json.loads(serialized)))
        if action == "begin":
            try:
                with job_token(root).open("x") as token:
                    token.write(str(uuid.uuid4()))
            except FileExistsError:
                pass
            receipt.parent.mkdir(parents=True, exist_ok=True)
            pending.write_text(json.dumps(capture(root, scope, inputs_only=True)))
            return 0
        if action == "write" and json.loads(pending.read_text()) != capture(root, scope, inputs_only=True):
            raise ValueError("publication inputs changed while publishing")
        current = capture(root, scope)
        if action == "check":
            if json.loads(receipt.read_text()) != current:
                raise ValueError("graph, git state, authority, version, scope or snapshot identity changed")
            print(f"editor-view receipt: reusing {name}; no publication lock needed", file=sys.stderr)
        elif action == "write":
            temporary = receipt.with_suffix(f".tmp-{os.getpid()}")
            temporary.write_text(json.dumps(current, sort_keys=True))
            temporary.replace(receipt)
        else:
            raise ValueError(f"unknown receipt action: {action}")
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"editor-view receipt: {name} unavailable ({error}); using normal scoped publication", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
