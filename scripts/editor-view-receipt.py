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

def file_digest(path):
    try:
        if path.is_symlink():
            return b"link:" + os.fsencode(os.readlink(path))
        with path.open("rb") as source:
            return hashlib.file_digest(source, "sha256").digest()
    except FileNotFoundError:
        return b"deleted"


def workspace_inputs(root, scope):
    # Reuse the publisher's lockfile importer graph, including generated root Buck aliases.
    script = """
import { workspaceEditorDependencies } from './editor-view-authority.ts';
import { readFileSync } from 'node:fs';
const [root, scope] = process.argv.slice(-2);
const graph = workspaceEditorDependencies({
  serialized: readFileSync(`${root}/pnpm-lock.yaml`, 'utf8'),
  rootBuck: readFileSync(`${root}/BUCK`, 'utf8'),
});
const pending = JSON.parse(scope), paths = new Set();
while (pending.length) {
  const path = pending.pop();
  if (paths.has(path)) continue;
  if (!Array.isArray(graph[path])) throw new Error(`missing workspace importer ${path}`);
  paths.add(path);
  pending.push(...graph[path]);
}
console.log(JSON.stringify([...paths].sort()));
"""
    return json.loads(subprocess.check_output(
        [os.environ.get("BUN_BIN", "bun"), "-e", script, str(root), json.dumps(scope)],
        cwd=Path(__file__).parent, timeout=30))


def git_input_state(root, scope):
    git = lambda *args: subprocess.check_output(["git", "-C", str(root), *args])
    workspace = workspace_inputs(root, scope)
    # "." is the bootstrap manifest, not permission to fingerprint every CI artifact.
    inputs = [
        "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "pnpm-install-contract.json",
        "BUCK", ".buckconfig", ".buckroot", ".gitignore", ".gitattributes", "buck2",
        "buck2-member.json", "buck2-test-authority.json", "buck2-operation-dispositions.json",
        "devenv.nix", "devenv.lock", "devenv.yaml", "flake.nix", "flake.lock",
        "genie/packages.ts", "genie/ci-workflow/test-scheduling.json",
        "genie/ci-workflow/test-platforms.json", "nix/devenv-modules/tasks/shared/test.nix",
        "scripts/editor-view-authority.ts", "scripts/editor-view-supervisor.py",
        "scripts/editor-view-receipt.py", "packages/@overeng/buck2-tools",
        *(package for package in workspace if package != "."),
    ]
    # Explicit exclusions also work before/without repository ignore rules. Do not
    # materialize binary diffs or concatenate raw untracked contents (quadratic).
    outputs = (".editor-view", ".devenv", "node_modules")
    exclusions = [f":(exclude,glob)**/{name}{suffix}" for name in outputs for suffix in ("", "/**")]
    status = git("status", "--porcelain=v2", "-z", "--untracked-files=all",
                 "--no-renames", "--ignore-submodules=none", "--", *inputs, *exclusions)
    dirty = hashlib.sha256()
    files = {}
    for entry in status.split(b"\0"):
        if not entry:
            continue
        kind = entry[:1]
        fields = {b"1": 8, b"u": 10, b"?": 1}.get(kind)
        if fields is None:
            raise ValueError(f"unexpected Git status record: {kind!r}")
        name = entry.split(b" ", fields)[fields]
        value = digest(entry + b"\0" + file_digest(root / os.fsdecode(name)))
        files[os.fsdecode(name)] = value
        dirty.update(name + b"\0" + value.encode())
    return {"head": git("rev-parse", "HEAD").decode().strip(),
            "dirty": dirty.hexdigest(), "inputFiles": files, "inputPaths": workspace}


def changed_paths(before, after):
    old, new = before.get("inputFiles", {}), after.get("inputFiles", {})
    names = sorted(name for name in old.keys() | new.keys() if old.get(name) != new.get(name))
    return f"paths={json.dumps(names[:10])}; headChanged={before.get('head') != after.get('head')}"


def capture(root, scope, inputs_only=False):
    job = [os.environ.get(key) for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB")]
    if not all(job):
        raise ValueError("no GitHub job identity")
    # GitHub cleans RUNNER_TEMP between jobs, even when a worktree is reused.
    job.append(job_token(root).read_text())
    inputs = git_input_state(root, scope)
    if inputs_only:
        return {"job": job, "scope": scope, **inputs}
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
    return {"schema": 4, "job": job, "root": str(root), "scope": scope, **inputs,
            "graph": digest((root / "devenv.nix").read_bytes() +
                            (root / "nix/devenv-modules/tasks/shared/test.nix").read_bytes()),
            "authority": digest((root / ".devenv/editor-workspace-authority.json").read_bytes()),
            # HEAD + changed-input digest bind source versions without rereading
            # the entire unchanged publisher/verifier TypeScript source tree.
            "versions": [inputs["head"], inputs["dirty"]], "snapshots": snapshots}


def main():
    action, directory, name, serialized = sys.argv[1:]
    root = Path(directory).resolve()
    receipt = root / ".devenv" / f"editor-view-{name}-receipt.json"
    pending = receipt.with_suffix(".pending.json")
    try:
        scope = sorted(set(json.loads(serialized)))
        previous = json.loads(receipt.read_text()) if action == "check" else None
        if action == "begin":
            try:
                with job_token(root).open("x") as token:
                    token.write(str(uuid.uuid4()))
            except FileExistsError:
                pass
            receipt.parent.mkdir(parents=True, exist_ok=True)
            pending.write_text(json.dumps(capture(root, scope, inputs_only=True)))
            return 0
        current = capture(root, scope)
        if action == "write":
            before = json.loads(pending.read_text())
            if before != {key: current[key] for key in ("job", "scope", "head", "dirty", "inputFiles", "inputPaths")}:
                raise ValueError(f"publication inputs changed while publishing ({changed_paths(before, current)})")
        if action == "check":
            if previous != current:
                raise ValueError("graph, git state, authority, version, scope or snapshot identity changed "
                                 f"({changed_paths(previous, current)})")
            print(f"editor-view receipt: reusing {name}; no publication lock needed", file=sys.stderr)
        elif action == "write":
            temporary = receipt.with_suffix(f".tmp-{os.getpid()}")
            temporary.write_text(json.dumps(current, sort_keys=True))
            temporary.replace(receipt)
        else:
            raise ValueError(f"unknown receipt action: {action}")
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"editor-view receipt: {name} unavailable ({error}); using normal scoped publication", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
