"""Stage an explicit workspace and compile a standalone Bun CLI."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import tempfile


def _safe_relative(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"unsafe repo-relative source label: {value!r}")
    return path


def _source_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--dependency-root", required=True)
    parser.add_argument("--native-package", action="append", default=[])
    parser.add_argument("--source-label", action="append", default=[])
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--source-tree-prefix", action="append", default=[])
    parser.add_argument("--source-tree", action="append", default=[])


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    check_parser = commands.add_parser("check")
    _source_arguments(check_parser)
    check_parser.add_argument("--tsgo", required=True)
    check_parser.add_argument("--tsconfig", required=True)
    check_parser.add_argument("--output", required=True)
    check_parser.set_defaults(handler=check)
    bundle_parser = commands.add_parser("bundle")
    _source_arguments(bundle_parser)
    bundle_parser.add_argument("--bun", required=True)
    bundle_parser.add_argument("--patchelf", required=True)
    bundle_parser.add_argument("--validation", required=True)
    bundle_parser.add_argument("--validation-project", required=True)
    bundle_parser.add_argument("--entry", required=True)
    bundle_parser.add_argument("--binary-name", required=True)
    bundle_parser.add_argument("--revision", required=True)
    bundle_parser.add_argument("--commit-timestamp", required=True, type=int)
    bundle_parser.add_argument("--dirty", required=True, choices=("true", "false"))
    bundle_parser.add_argument("--output", required=True)
    bundle_parser.add_argument("--archive", required=True)
    bundle_parser.add_argument("--descriptor", required=True)
    bundle_parser.add_argument("--target", required=True)
    bundle_parser.add_argument("--platform", required=True)
    bundle_parser.set_defaults(handler=bundle)
    return parser


def _stage_sources(root: Path, labels: list[str], sources: list[str]) -> None:
    if len(labels) != len(sources) or not sources:
        raise ValueError("source labels and paths must be non-empty and paired")
    seen: set[PurePosixPath] = set()
    for label, source in zip(labels, sources, strict=True):
        relative = _safe_relative(label)
        if relative in seen:
            raise ValueError(f"duplicate staged source label: {relative}")
        seen.add(relative)
        destination = root.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)


def _stage_source_trees(root: Path, prefixes: list[str], trees: list[str]) -> None:
    if len(prefixes) != len(trees):
        raise ValueError("source tree prefixes and paths must be paired")
    for prefix, tree_value in zip(prefixes, trees, strict=True):
        relative_prefix = _safe_relative(prefix)
        tree = Path(tree_value)
        if not tree.is_dir():
            raise ValueError(f"declared source tree is not a directory: {tree}")
        for source in sorted(path for path in tree.rglob("*") if path.is_file()):
            relative = source.relative_to(tree)
            destination = root.joinpath(*relative_prefix.parts, *relative.parts)
            if destination.exists():
                raise ValueError(f"duplicate staged source: {destination.relative_to(root)}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)


def _hardlink_or_copy(source: str, destination: str) -> str:
    try:
        os.link(source, destination)
        return destination
    except OSError:
        return shutil.copyfile(source, destination)


def _copy_dependency_tree(source: Path, destination: Path) -> None:
    shutil.copytree(
        source,
        destination,
        copy_function=_hardlink_or_copy,
        dirs_exist_ok=True,
        symlinks=True,
    )
    writable_directories = [
        destination,
        *(path for path in destination.rglob("*") if path.is_dir() and not path.is_symlink()),
    ]
    for directory in writable_directories:
        directory.chmod(directory.stat().st_mode | stat.S_IWUSR | stat.S_IXUSR)


def _stage_node_modules(workspace: Path, dependency_root: Path) -> None:
    _copy_dependency_tree(dependency_root / "node_modules", workspace / "node_modules")
    packages = dependency_root / "packages"
    if not packages.is_dir():
        raise ValueError(f"configured dependency root has no package layouts: {dependency_root}")
    for source in sorted(packages.rglob("node_modules")):
        if source.is_dir():
            relative_package = source.parent.relative_to(dependency_root)
            _copy_dependency_tree(source, workspace / relative_package / "node_modules")


def _stage_native_packages(workspace: Path, packages: list[str]) -> None:
    (workspace / "node_modules").chmod(0o755)
    for value in packages:
        if "=" not in value:
            raise ValueError(f"native package must be NAME=PATH: {value!r}")
        name, source_value = value.split("=", 1)
        relative = _safe_relative(name)
        source = Path(source_value)
        if not source.is_dir():
            raise ValueError(f"native package path is not a directory: {source}")
        destination = workspace / "node_modules" / Path(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() or destination.is_symlink():
            destination.unlink()
        os.symlink(source, destination, target_is_directory=True)


def _validate_dependency_root(dependency_root: Path) -> None:
    if not (dependency_root / "node_modules").is_dir():
        raise ValueError(f"configured dependency root has no node_modules: {dependency_root}")


def check(args: argparse.Namespace) -> None:
    tsgo = Path(args.tsgo)
    dependency_root = Path(args.dependency_root)
    if not tsgo.is_file() or not os.access(tsgo, os.X_OK):
        raise ValueError(f"configured tsgo is not executable: {tsgo}")
    _validate_dependency_root(dependency_root)
    tsconfig = _safe_relative(args.tsconfig)
    with tempfile.TemporaryDirectory(prefix="buck2-typescript-check-") as temporary:
        workspace = Path(temporary) / "workspace"
        workspace.mkdir()
        _stage_sources(workspace, args.source_label, args.source)
        _stage_source_trees(workspace, args.source_tree_prefix, args.source_tree)
        _stage_node_modules(workspace, dependency_root)
        _stage_native_packages(workspace, args.native_package)
        staged_config = workspace.joinpath(*tsconfig.parts)
        if not staged_config.is_file():
            raise ValueError(f"tsconfig is absent from the declared source graph: {tsconfig}")
        subprocess.run(
            [str(tsgo), "--build", str(staged_config), "--force", "--pretty", "false"],
            cwd=workspace,
            env={
                "DEVENV_TASK_PASSTHROUGH": "1",
                "HOME": str(Path(temporary) / "home"),
                "PATH": "/nonexistent",
            },
            check=True,
        )
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(
            {"schema": "effect-utils-buck2-typescript-check/v1", "project": str(tsconfig)},
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def _declared_input_digest(args: argparse.Namespace) -> str:
    digest = hashlib.sha256()
    metadata = {
        "binaryName": args.binary_name,
        "bun": args.bun,
        "commitTimestamp": args.commit_timestamp,
        "dependencyRoot": args.dependency_root,
        "dirty": args.dirty,
        "entry": args.entry,
        "nativePackages": sorted(args.native_package),
        "patchelf": args.patchelf,
        "platform": args.platform,
        "revision": args.revision,
        "target": args.target,
    }
    digest.update(json.dumps(metadata, separators=(",", ":"), sort_keys=True).encode())
    for label, source in sorted(zip(args.source_label, args.source, strict=True)):
        digest.update(label.encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(Path(source).read_bytes()).digest())
    for prefix, tree_value in sorted(zip(args.source_tree_prefix, args.source_tree, strict=True)):
        tree = Path(tree_value)
        for source in sorted(path for path in tree.rglob("*") if path.is_file()):
            digest.update(f"{prefix}/{source.relative_to(tree).as_posix()}".encode())
            digest.update(b"\0")
            digest.update(hashlib.sha256(source.read_bytes()).digest())
    digest.update(hashlib.sha256(Path(args.validation).read_bytes()).digest())
    return digest.hexdigest()


def bundle(args: argparse.Namespace) -> None:
    bun = Path(args.bun)
    patchelf = Path(args.patchelf)
    dependency_root = Path(args.dependency_root)
    if not bun.is_file() or not os.access(bun, os.X_OK):
        raise ValueError(f"configured Bun is not executable: {bun}")
    if not patchelf.is_file() or not os.access(patchelf, os.X_OK):
        raise ValueError(f"configured patchelf is not executable: {patchelf}")
    _validate_dependency_root(dependency_root)
    validation = json.loads(Path(args.validation).read_text(encoding="utf-8"))
    if validation.get("schema") != "effect-utils-buck2-typescript-check/v1":
        raise ValueError("TypeScript validation marker has an unsupported schema")
    if validation.get("project") != args.validation_project:
        raise ValueError("TypeScript validation marker belongs to a different project")
    entry = _safe_relative(args.entry)
    binary_name = _safe_relative(args.binary_name)
    if len(binary_name.parts) != 1:
        raise ValueError(f"binary name must be a single path component: {args.binary_name!r}")
    output = Path(args.output)
    archive = Path(args.archive)
    descriptor = Path(args.descriptor)

    with tempfile.TemporaryDirectory(prefix="buck2-typescript-cli-") as temporary:
        workspace = Path(temporary) / "workspace"
        workspace.mkdir()
        _stage_sources(workspace, args.source_label, args.source)
        _stage_source_trees(workspace, args.source_tree_prefix, args.source_tree)
        _stage_node_modules(workspace, dependency_root)
        _stage_native_packages(workspace, args.native_package)
        staged_entry = workspace.joinpath(*entry.parts)
        if not staged_entry.is_file():
            raise ValueError(f"entry is absent from the declared source graph: {entry}")
        stable_output = Path(temporary) / "output" / args.binary_name
        stable_output.parent.mkdir()
        build_stamp_metadata = {
            "type": "nix",
            "rev": args.revision,
            "commitTs": args.commit_timestamp,
            "dirty": args.dirty == "true",
        }
        build_stamp_expression = (
            "JSON.stringify(Object.assign("
            + json.dumps(build_stamp_metadata, separators=(",", ":"), sort_keys=True)
            + ", { version: MR_VERSION }))"
        )
        source_text = staged_entry.read_text(encoding="utf-8")
        placeholder = "const buildStamp = '__CLI_BUILD_STAMP__'"
        if source_text.count(placeholder) != 1:
            raise ValueError("entry must contain exactly one CLI build-stamp placeholder")
        staged_entry.write_text(
            source_text.replace(placeholder, "const buildStamp = " + build_stamp_expression),
            encoding="utf-8",
        )
        subprocess.run(
            [str(bun), "build", str(staged_entry), "--compile", "--outfile", str(stable_output)],
            cwd=workspace,
            env={"HOME": str(Path(temporary) / "home"), "PATH": "/nonexistent"},
            check=True,
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(stable_output, output)
        output.chmod(0o755)
        subprocess.run(
            [str(patchelf), "--set-interpreter", "/lib64/ld-linux-x86-64.so.2", "--remove-rpath", str(output)],
            env={"PATH": "/nonexistent"},
            check=True,
        )
        output.chmod(0o555)

    archive.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "w", format=tarfile.USTAR_FORMAT) as tar:
        directory_info = tarfile.TarInfo("bin")
        directory_info.type = tarfile.DIRTYPE
        directory_info.mode = 0o555
        directory_info.mtime = 1
        tar.addfile(directory_info)
        binary_info = tar.gettarinfo(str(output), arcname=f"bin/{args.binary_name}")
        binary_info.uid = 0
        binary_info.gid = 0
        binary_info.uname = ""
        binary_info.gname = ""
        binary_info.mode = 0o555
        binary_info.mtime = 1
        with output.open("rb") as binary:
            tar.addfile(binary_info, binary)

    declared_input_digest = _declared_input_digest(args)
    digest_bytes = hashlib.sha256(archive.read_bytes()).digest()
    digest_hex = digest_bytes.hex()
    digest_sri = "sha256-" + base64.b64encode(digest_bytes).decode("ascii")
    payload = {
        "schemaVersion": 1,
        "kind": "buck2-build-artifact",
        "name": args.binary_name,
        "platform": args.platform,
        "entrypoints": [f"bin/{args.binary_name}"],
        "artifact": {
            "file": "artifact.tar",
            "format": "tar",
            "digest": {"algorithm": "sha256", "hex": digest_hex, "sri": digest_sri},
            "sizeBytes": archive.stat().st_size,
        },
        "provenance": {
            "producer": "effect-utils.buck2.typescript-cli.v1",
            "target": args.target,
            "sourceRevision": args.revision,
            "declaredInputDigest": "sha256:" + declared_input_digest,
        },
    }
    descriptor.parent.mkdir(parents=True, exist_ok=True)
    descriptor.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> None:
    args = _parser().parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
