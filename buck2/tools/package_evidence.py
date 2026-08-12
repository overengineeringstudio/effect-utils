"""Build a deterministic, relocatable package-evidence artifact."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
from typing import NoReturn, Sequence


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_relative(value: str, field: str) -> str:
    if not value or "\x00" in value or "\n" in value or "\r" in value:
        fail(f"{field} must be non-empty and contain no control characters")
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(part in ("", ".", "..") for part in path.parts):
        fail(f"{field} must be a normalized relative path: {value!r}")
    return value


def safe_text(value: str, field: str) -> str:
    if not value or any(character in value for character in ("\x00", "\n", "\r")):
        fail(f"{field} must be non-empty and contain no control characters")
    return value


def nix_name(value: str, field: str) -> str:
    safe_text(value, field)
    if re.fullmatch(r"[A-Za-z0-9._+-]+", value) is None:
        fail(f"{field} is not accepted by the Nix artifact importer: {value!r}")
    return value


def digest_path(path: Path) -> tuple[str, str]:
    if path.is_symlink():
        fail(f"declared input must not be a symlink: {path.name}")
    if path.is_file():
        return "file", sha256_file(path)
    if not path.is_dir():
        fail(f"declared input must be a regular file or directory: {path.name}")

    records: list[dict[str, str]] = []
    for child in sorted(path.rglob("*"), key=lambda item: item.relative_to(path).as_posix()):
        relative = child.relative_to(path).as_posix()
        if child.is_symlink():
            fail(f"declared directory input contains a symlink: {relative}")
        if child.is_dir():
            records.append({"kind": "directory", "path": relative})
        elif child.is_file():
            records.append({"kind": "file", "path": relative, "sha256": sha256_file(child)})
        else:
            fail(f"declared directory input contains a non-regular entry: {relative}")
    return "directory", sha256_bytes(canonical_json(records))


def input_records(labels: Sequence[str], paths: Sequence[str], role: str) -> list[dict[str, str]]:
    if len(labels) != len(paths):
        fail(f"each {role} requires both a logical label and an artifact")
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for label, raw_path in zip(labels, paths, strict=True):
        logical = normalized_relative(label, f"{role} label")
        if logical in seen:
            fail(f"duplicate {role} label: {logical}")
        seen.add(logical)
        artifact_kind, digest = digest_path(Path(raw_path))
        result.append({"artifactKind": artifact_kind, "path": logical, "sha256": digest})
    return sorted(result, key=lambda record: record["path"])


def dependency_records(labels: Sequence[str], paths: Sequence[str]) -> list[dict[str, str]]:
    if len(labels) != len(paths):
        fail("each dependency requires both a target label and an artifact")
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for label, raw_path in zip(labels, paths, strict=True):
        safe_text(label, "dependency label")
        if label in seen:
            fail(f"duplicate dependency label: {label}")
        seen.add(label)
        artifact_kind, digest = digest_path(Path(raw_path))
        result.append({"artifactKind": artifact_kind, "label": label, "sha256": digest})
    return sorted(result, key=lambda record: record["label"])


def add_tar_member(archive: tarfile.TarFile, name: str, content: bytes | None, mode: int) -> None:
    info = tarfile.TarInfo(name)
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mode = mode
    if content is None:
        info.type = tarfile.DIRTYPE
        info.size = 0
        archive.addfile(info)
    else:
        info.type = tarfile.REGTYPE
        info.size = len(content)
        archive.addfile(info, io.BytesIO(content))


def package(args: argparse.Namespace) -> None:
    name = nix_name(args.name, "name")
    package_path = normalized_relative(args.package_path, "package path")
    kind = safe_text(args.kind, "kind")
    target = safe_text(args.target, "target")
    platform = nix_name(args.platform, "platform")
    closure_label = normalized_relative(args.closure_label, "closure label")
    closure_path = Path(args.closure_descriptor)
    try:
        closure_value = json.loads(closure_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"closure descriptor must be valid UTF-8 JSON: {error}")
    if not isinstance(closure_value, dict):
        fail("closure descriptor root must be an object")

    sources = input_records(args.source_label, args.source, "source")
    configs = input_records(args.config_label, args.config, "config")
    dependencies = dependency_records(args.dep_label, args.dep_artifact)
    manifest = {
        "closure": {"path": closure_label, "sha256": sha256_file(closure_path)},
        "configs": configs,
        "dependencies": dependencies,
        "kind": kind,
        "packagePath": package_path,
        "schemaVersion": 1,
        "sources": sources,
        "target": target,
    }
    manifest_bytes = canonical_json(manifest)
    action_digest = sha256_bytes(manifest_bytes)
    shell_payload = manifest_bytes.decode().rstrip("\n").replace("'", "'\"'\"'")
    entrypoint = f"#!/bin/sh\nset -eu\nprintf '%s\\n' '{shell_payload}'\n".encode()

    archive_path = Path(args.archive)
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "w", format=tarfile.USTAR_FORMAT) as archive:
        add_tar_member(archive, "bin", None, 0o555)
        add_tar_member(archive, "bin/package-evidence", entrypoint, 0o555)
        add_tar_member(archive, "share", None, 0o555)
        add_tar_member(archive, "share/package-evidence", None, 0o555)
        add_tar_member(archive, "share/package-evidence/manifest.json", manifest_bytes, 0o444)

    archive_bytes = archive_path.read_bytes()
    archive_digest = hashlib.sha256(archive_bytes).digest()
    descriptor = {
        "artifact": {
            "digest": {
                "algorithm": "sha256",
                "sri": "sha256-" + base64.b64encode(archive_digest).decode(),
            },
            "file": "artifact.tar",
            "format": "tar",
            "sizeBytes": len(archive_bytes),
        },
        "entrypoints": ["bin/package-evidence"],
        "kind": "buck2-package-evidence",
        "name": name,
        "platform": platform,
        "provenance": {
            "actionDigest": "sha256:" + action_digest,
            "producer": "effect-utils/buck2/package-evidence@1",
            "sourceRevision": "content-addressed",
            "target": target,
        },
        "schemaVersion": 1,
    }
    descriptor_path = Path(args.descriptor)
    descriptor_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor_path.write_bytes(canonical_json(descriptor))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)
    package_parser = commands.add_parser("package")
    package_parser.add_argument("--name", required=True)
    package_parser.add_argument("--package-path", required=True)
    package_parser.add_argument("--kind", required=True)
    package_parser.add_argument("--target", required=True)
    package_parser.add_argument("--platform", required=True)
    package_parser.add_argument("--closure-label", required=True)
    package_parser.add_argument("--closure-descriptor", required=True)
    package_parser.add_argument("--source-label", action="append", default=[])
    package_parser.add_argument("--source", action="append", default=[])
    package_parser.add_argument("--config-label", action="append", default=[])
    package_parser.add_argument("--config", action="append", default=[])
    package_parser.add_argument("--dep-label", action="append", default=[])
    package_parser.add_argument("--dep-artifact", action="append", default=[])
    package_parser.add_argument("--archive", required=True)
    package_parser.add_argument("--descriptor", required=True)
    package_parser.set_defaults(handler=package)
    return result


def main(argv: Sequence[str] | None = None) -> None:
    args = parser().parse_args(argv)
    args.handler(args)


if __name__ == "__main__":
    main()
