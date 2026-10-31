#!/usr/bin/env python3
"""Retire an explicitly selected, self-contained pnpm cache under its maintenance lease."""

import argparse
import collections
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import uuid

LEASE = ".effect-utils-pnpm-store-cache-maintenance.lock"


class Refusal(Exception):
    def __init__(self, message, offending_roots=()):
        super().__init__(message)
        self.offending_roots = offending_roots


def identity(value):
    return value.st_dev, value.st_ino


def overlaps(left, right):
    return left == right or left in right.parents or right in left.parents


def run(*args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise Refusal(f"enumeration failed ({' '.join(map(str, args))}): {os.fsdecode(result.stderr).strip()}")
    return result.stdout


def worktrees(*git_args):
    records = run("git", *git_args, "worktree", "list", "--porcelain", "-z").split(b"\0\0")
    roots = []
    for record in records:
        if not record:
            continue
        fields = record.split(b"\0")
        if not fields[0].startswith(b"worktree "):
            raise Refusal("unrecognized git worktree enumeration")
        if b"bare" in fields:
            continue
        if any(field.startswith(b"prunable") for field in fields):
            raise Refusal("registered worktree is prunable; cannot prove it has no consumers")
        roots.append(Path(os.fsdecode(fields[0][9:])).resolve(strict=True))
    return roots


def registered_roots():
    roots = worktrees()
    if shutil.which("mr"):
        listing = json.loads(run("mr", "store", "ls", "--output", "json"))
        if not isinstance(listing, dict) or listing.get("_tag") != "Ls":
            raise Refusal("unrecognized mr store ls JSON")
        base = listing.get("basePath")
        repos = listing.get("repos")
        if not isinstance(base, str) or not Path(base).is_absolute() or not isinstance(repos, list):
            raise Refusal("invalid mr store ls JSON")
        base = Path(base).resolve(strict=True)
        for repo in repos:
            relative = repo.get("relativePath") if isinstance(repo, dict) else None
            if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
                raise Refusal("invalid mr repository path")
            repository = (base / relative).resolve(strict=True)
            if base not in repository.parents:
                raise Refusal("mr repository escapes store")
            roots.extend(worktrees("--git-dir", str(repository / ".bare")))
    roots = sorted(set(roots))
    if not roots:
        raise Refusal("no registered worktrees; run inside the current repository")
    for root in roots:
        if not root.is_dir():
            raise Refusal(f"registered worktree is not a directory: {root}")
    return roots


def protected_stores(contract):
    data = json.loads(Path(contract).read_text())
    default = data["storeContract"]["localDevelopment"]["defaultPath"]
    if not isinstance(default, str) or not default:
        raise Refusal("contract has no default shared store")
    paths = [Path(default).expanduser()]
    if "PNPM_SHARED_STORE_DIR" in os.environ:
        configured = os.environ["PNPM_SHARED_STORE_DIR"]
        if not configured:
            raise Refusal("PNPM_SHARED_STORE_DIR is empty")
        paths.append(Path(configured).expanduser())
    # resolve(strict=False) resolves existing aliases even when the leaf does not exist.
    return [path.resolve() for path in paths]


def validate_target(raw, contract):
    lexical = Path(os.path.abspath(os.path.expanduser(raw)))
    target = lexical.resolve(strict=True)
    for protected in protected_stores(contract):
        if overlaps(target, protected):
            raise Refusal(f"target overlaps a protected shared store: {protected}")
    if lexical != target:
        raise Refusal("target has a symlink alias; select its canonical path")
    for path in (target, target / "v11", target / "v11/files"):
        metadata = path.lstat()
        if not stat.S_ISDIR(metadata.st_mode):
            raise Refusal(f"not a self-contained v11/files pnpm store: {path}")
    return target


def store_snapshot(target, validate_symlinks=True):
    """Census every internal link, but compare consumers only to CAS payload inodes."""
    links = collections.Counter()
    payloads = set()
    metadata = {}
    symlinks = {}
    size = 0
    pending = [target]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                path = Path(entry.path)
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    if validate_symlinks:
                        resolved = path.resolve(strict=True)
                        if resolved != target and target not in resolved.parents:
                            raise Refusal(f"store layout contains a symlink outside target: {path}")
                    key = identity(info)
                    links[key] += 1
                    metadata[key] = (info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                    symlinks[str(path.relative_to(target))] = (
                        identity(info), info.st_nlink, info.st_mtime_ns,
                        info.st_ctime_ns, os.readlink(path),
                    )
                    continue
                if stat.S_ISDIR(info.st_mode):
                    if info.st_dev != target.stat().st_dev:
                        raise Refusal(f"store layout crosses a filesystem: {path}")
                    pending.append(path)
                elif stat.S_ISREG(info.st_mode):
                    key = identity(info)
                    links[key] += 1
                    metadata[key] = (info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                    if target / "v11/files" in path.parents:
                        payloads.add(key)
                    if links[key] == 1:
                        size += info.st_size
                else:
                    raise Refusal(f"store contains a special file: {path}")
    for key, count in links.items():
        if metadata[key][0] != count:
            raise Refusal(f"store inode has unidentified external hardlinks: dev={key[0]} ino={key[1]}")
    return links, payloads, metadata, size, symlinks


def scan_consumers(roots, target, payloads):
    offences = []
    for root in roots:
        try:
            _scan_root_consumers([root], target, payloads)
        except (Refusal, OSError, RuntimeError) as error:
            offences.append({"root": str(root), "reason": str(error)})
    if offences:
        raise Refusal("consumer scan refused: " + "; ".join(
            f"{item['root']}: {item['reason']}" for item in offences
        ), offending_roots=offences)


def _scan_root_consumers(roots, target, payloads):
    discovery_seen = set()
    modules_seen = set()
    # Follow directory aliases too: workspace packages can themselves be links.
    # Separate visited sets ensure discovery cannot hide a node_modules scan.
    pending = [(root, False) for root in roots]
    while pending:
        path, in_modules = pending.pop()
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            try:
                resolved = path.resolve(strict=True)
            except (OSError, RuntimeError) as error:
                raise Refusal(f"cannot resolve symlink while scanning {path}: {error}") from error
            if in_modules and (resolved == target or target in resolved.parents):
                raise Refusal(f"consumer symlink resolves into target: {path} -> {resolved}")
            if in_modules or resolved.is_dir():
                pending.append((resolved, in_modules))
            continue
        if stat.S_ISREG(info.st_mode):
            if in_modules and identity(info) in payloads:
                raise Refusal(f"consumer hardlink references target files: {path}")
            continue
        if not stat.S_ISDIR(info.st_mode):
            if in_modules:
                raise Refusal(f"cannot scan special node_modules entry: {path}")
            continue
        if path == target or target in path.parents:
            if in_modules or path in roots:
                raise Refusal(f"consumer directory resolves into target: {path}")
            # Store contents are independently censused, never discovery roots.
            continue
        seen = modules_seen if in_modules else discovery_seen
        key = identity(info)
        if key in seen:
            continue
        seen.add(key)
        with os.scandir(path) as entries:
            for entry in entries:
                if not in_modules and entry.name == ".git":
                    continue
                child_modules = in_modules or entry.name == "node_modules"
                if child_modules or entry.is_dir(follow_symlinks=False) or entry.is_symlink():
                    pending.append((Path(entry.path), child_modules))


def ensure_lease(target, expected_root):
    if identity(target.lstat()) != expected_root:
        raise Refusal("target changed while acquiring maintenance lease")
    lock = (target / LEASE).lstat()
    held = os.fstat(202)
    if not stat.S_ISREG(lock.st_mode) or lock.st_nlink != 1 or identity(lock) != identity(held):
        raise Refusal("maintenance lease pathname/inode changed")


def retire(target, apply, expected_root):
    ensure_lease(target, expected_root)
    roots = registered_roots()
    # Scan first so identified consumers get an actionable pathname; the inode
    # census also refuses unregistered/unknown external hardlinks afterwards.
    payloads = set()
    for directory, dirs, files in os.walk(target / "v11/files", followlinks=False, onerror=lambda error: (_ for _ in ()).throw(error)):
        for name in dirs + files:
            info = (Path(directory) / name).lstat()
            if stat.S_ISREG(info.st_mode):
                payloads.add(identity(info))
    scan_consumers(roots, target, payloads)
    snapshot = store_snapshot(target)
    ensure_lease(target, expected_root)
    if not apply:
        return {"verdict": "eligible", "mode": "dry-run", "target": str(target), "bytes": snapshot[3], "registeredRoots": len(roots)}

    parent_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    tombstone = f"{target.name}.retired-{uuid.uuid4().hex}"
    renamed = False
    try:
        if identity(os.fstat(parent_fd)) != identity(target.parent.stat()):
            raise Refusal("target parent changed")
        ensure_lease(target, expected_root)
        if store_snapshot(target) != snapshot or registered_roots() != roots:
            raise Refusal("store or registered roots changed during proof")
        os.rename(target.name, tombstone, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        renamed = True
        retired = target.parent / tombstone
        if identity(os.stat(tombstone, dir_fd=parent_fd, follow_symlinks=False)) != expected_root:
            raise Refusal("renamed directory is not the proved store")
        # Never restore over a recreated live pathname, nor delete a store whose
        # links changed across rename. An interrupted/refused apply stays retired.
        if os.path.lexists(target):
            raise Refusal("target was recreated after retirement rename")
        ensure_lease(retired, expected_root)
        scan_consumers(registered_roots(), retired, snapshot[1])
        # The original proof established link containment. After rename, compare
        # link text and inode metadata without resolving old absolute namespaces.
        after = store_snapshot(retired, validate_symlinks=False)
        if after != snapshot or registered_roots() != roots:
            raise Refusal("store or registered roots changed after retirement rename")
        if os.path.lexists(target):
            raise Refusal("target was recreated before removal")
        ensure_lease(retired, expected_root)
        if not shutil.rmtree.avoids_symlink_attacks:
            raise Refusal("platform lacks fd-safe recursive removal")
        shutil.rmtree(tombstone, dir_fd=parent_fd)
        if os.path.lexists(target):
            raise Refusal("target was recreated during removal; replacement was not touched")
        return {"verdict": "retired", "mode": "apply", "target": str(target), "bytes": snapshot[3], "registeredRoots": len(roots)}
    except BaseException as error:
        if renamed:
            print(f"pnpm-store-retire: retirement tombstone: {target.parent / tombstone}", file=sys.stderr)
        raise error
    finally:
        os.close(parent_fd)


def main():
    # The package supplies these immutable inputs before user arguments; neither
    # contract authority nor the lease implementation is selected by the caller.
    contract, helpers = sys.argv[1:3]
    parser = argparse.ArgumentParser(description="Safely retire an explicit self-contained v11 pnpm store; default is dry-run.")
    parser.add_argument("target", nargs="?", default=os.environ.get("PNPM_RETIRE_STORE_DIR"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(sys.argv[3:])
    if not args.target:
        raise Refusal("explicit target argument or PNPM_RETIRE_STORE_DIR is required")
    target = validate_target(args.target, contract)
    if os.environ.get("_PNPM_RETIRE_LEASED") != "1":
        # Pin the directory inode across lease admission too, so deleting and
        # recreating a pathname cannot pass through inode-number reuse.
        root_fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        os.dup2(root_fd, 201, inheritable=True)
        if root_fd != 201:
            os.close(root_fd)
        root = identity(os.fstat(201))
        lock_fd = os.open(target / LEASE, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            lock = os.fstat(lock_fd)
            if not stat.S_ISREG(lock.st_mode) or lock.st_nlink != 1:
                raise Refusal("maintenance lease is not a private regular file")
        finally:
            os.close(lock_fd)
        environment = dict(os.environ, _PNPM_RETIRE_LEASED="1", _PNPM_RETIRE_ROOT=f"{root[0]}:{root[1]}")
        # exec preserves fd 202 from the existing helper across the entire scan,
        # rename and removal; the helper owns the exact same installer lease.
        script = 'set -euo pipefail; source "$1"; acquire_pnpm_store_cache_lease flock exclusive "$2" 600; shift 2; exec "$@"'
        os.execvpe("bash", ["bash", "-c", script, "pnpm-store-retire", helpers, str(target), sys.executable, *sys.argv], environment)
    expected_root = tuple(map(int, os.environ["_PNPM_RETIRE_ROOT"].split(":")))
    if identity(os.fstat(201)) != expected_root:
        raise Refusal("pinned target directory identity changed")
    result = retire(target, args.apply or os.environ.get("PNPM_RETIRE_APPLY") == "1", expected_root)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (Refusal, OSError, ValueError, KeyError, RuntimeError) as error:
        report = {"verdict": "refused", "reason": str(error)}
        if isinstance(error, Refusal) and error.offending_roots:
            report["offendingRoots"] = error.offending_roots
        print(json.dumps(report, sort_keys=True), file=sys.stderr)
        sys.exit(1)
