"""Copy validated product trees without stripping or rewriting their artifacts."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

inputs = json.loads(Path(sys.argv[1]).read_text())
plan = json.loads(Path(sys.argv[2]).read_text())
output = Path(sys.argv[3])
entries = []
directories = []
for row, descriptor in zip(inputs, plan["descriptors"], strict=True):
    root = Path(row["root"])
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            source = Path(directory) / name
            if source.is_symlink() or not source.is_dir():
                entries.append((source.relative_to(root).as_posix(), descriptor["name"], source))
            else:
                directories.append((source.relative_to(root).as_posix(), descriptor["name"], source))
    for artifact in descriptor.get("library", {}).get("artifacts", []):
        actual = hashlib.sha256((root / artifact["path"]).read_bytes()).hexdigest()
        if actual != artifact["sha256"]:
            raise SystemExit(f"library artifact hash mismatch: {descriptor['name']}/{artifact['path']}")
    paths = ([a["path"] for a in descriptor["library"]["artifacts"]]
             if descriptor.get("kind") == "library" else descriptor["entrypoints"])
    for path in paths:
        if not (root / path).is_file():
            raise SystemExit(f"missing product artifact: {descriptor['name']}/{path}")
entries.sort()
owners = {}
for path, owner, _ in entries:
    conflict = next((str(p) for p in [Path(path), *Path(path).parents] if str(p) in owners), None)
    if conflict is not None:
        raise SystemExit(f"destination collision {path}: {owners[conflict]}, {owner}")
    owners[path] = owner
for path, owner, _ in directories:
    conflict = next((str(p) for p in [Path(path), *Path(path).parents] if str(p) in owners), None)
    if conflict is not None:
        raise SystemExit(f"destination collision {path}: {owners[conflict]}, {owner}")
output.mkdir()
for path, _, _ in directories:
    (output / path).mkdir(parents=True, exist_ok=True)
for path, _, source in entries:
    destination = output / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
        assert os.readlink(destination) == os.readlink(source)
    else:
        shutil.copy2(source, destination)
        assert hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256(destination.read_bytes()).digest()
        assert source.stat().st_mode == destination.stat().st_mode
for path, _, source in reversed(directories):
    shutil.copystat(source, output / path)
