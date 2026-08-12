"""Validate and stage a Nix-exported portable toolchain archive."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tarfile
from typing import NoReturn, Sequence


HEX = frozenset("0123456789abcdef")
DESCRIPTOR_KEYS = {
    "artifact",
    "entrypoints",
    "kind",
    "name",
    "normalization",
    "platform",
    "provenance",
    "schemaVersion",
}
MAX_ARCHIVE_MEMBER_BYTES = 1024 * 1024 * 1024
MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024
TAR_BLOCK_BYTES = 512
TAR_END_MARKER_BYTES = 2 * TAR_BLOCK_BYTES


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_sri(hex_digest: str) -> str:
    return "sha256-" + base64.b64encode(bytes.fromhex(hex_digest)).decode("ascii")


def parse_sha256(value: object, field: str) -> str:
    if not isinstance(value, str) or len(value) != 64 or any(character not in HEX for character in value):
        fail(f"{field} must contain exactly 64 lowercase hexadecimal characters")
    return value


def normalized_relative_path(value: object, field: str) -> PurePosixPath:
    if not isinstance(value, str) or not value:
        fail(f"{field} must be a non-empty string")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        fail(f"{field} must not contain control characters")
    if "\\" in value:
        fail(f"{field} must use portable POSIX separators")
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value:
        fail(f"{field} must be a normalized relative path: {value!r}")
    if any(component in ("", ".", "..") for component in path.parts):
        fail(f"{field} must not traverse or contain empty components: {value!r}")
    return path


def read_descriptor(path: Path, expected_entrypoint: str) -> dict[str, object]:
    try:
        descriptor = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"invalid portable toolchain descriptor: {error}")
    if not isinstance(descriptor, dict) or set(descriptor) != DESCRIPTOR_KEYS:
        fail("portable toolchain descriptor has an unexpected top-level shape")
    if descriptor["schemaVersion"] != 1 or descriptor["kind"] != "buck2-portable-toolchain-artifact":
        fail("unsupported portable toolchain descriptor contract")
    entrypoints = descriptor["entrypoints"]
    if not isinstance(entrypoints, list) or not entrypoints:
        fail("portable toolchain descriptor entrypoints must be a non-empty list")
    parsed_entrypoints = [str(normalized_relative_path(entrypoint, "descriptor entrypoint")) for entrypoint in entrypoints]
    if len(set(parsed_entrypoints)) != len(parsed_entrypoints):
        fail("portable toolchain descriptor entrypoints must be unique")
    if expected_entrypoint not in parsed_entrypoints:
        fail(f"requested entrypoint is absent from descriptor: {expected_entrypoint}")
    artifact = descriptor["artifact"]
    if not isinstance(artifact, dict) or set(artifact) != {"digest", "file", "format", "sizeBytes"}:
        fail("portable toolchain descriptor artifact has an unexpected shape")
    digest = artifact["digest"]
    if not isinstance(digest, dict) or set(digest) != {"algorithm", "sri"} or digest["algorithm"] != "sha256":
        fail("portable toolchain descriptor requires a sha256 digest")
    if artifact["file"] != "artifact.tar" or artifact["format"] != "tar":
        fail("portable toolchain descriptor requires artifact.tar in tar format")
    if not isinstance(artifact["sizeBytes"], int) or isinstance(artifact["sizeBytes"], bool) or artifact["sizeBytes"] <= 0:
        fail("portable toolchain descriptor sizeBytes must be a positive integer")
    if not isinstance(descriptor["normalization"], dict) or not isinstance(descriptor["provenance"], dict):
        fail("portable toolchain normalization and provenance must be objects")
    return descriptor


def validate_descriptor_platform(descriptor: dict[str, object], expected_platform: str) -> None:
    if descriptor["platform"] != expected_platform:
        fail(
            "portable toolchain platform mismatch: "
            f"expected {expected_platform}, got {descriptor['platform']!r}"
        )


def archive_member_path(name: str) -> PurePosixPath | None:
    while name.startswith("./"):
        name = name[2:]
    if name in ("", "."):
        return None
    return normalized_relative_path(name.rstrip("/"), "archive member")


def ensure_no_path_collisions(paths: Sequence[PurePosixPath], field: str) -> None:
    seen: list[PurePosixPath] = []
    for path in paths:
        if path in seen:
            fail(f"duplicate {field}: {path}")
        for prior in seen:
            if path in prior.parents or prior in path.parents:
                # Directory ancestors are valid and are checked separately by
                # the caller. This helper is for file-like paths only.
                fail(f"{field} file/ancestor collision: {prior} and {path}")
        seen.append(path)


def validate_symlink_target(member_path: PurePosixPath, target: str) -> None:
    if not target or any(ord(character) < 32 or ord(character) == 127 for character in target):
        fail("archive symlink target must be non-empty and contain no control characters")
    if target.startswith("/") or "\\" in target:
        fail("archive symlink target must be portable and relative")
    components = target.split("/")
    if any(component in ("", ".") for component in components):
        fail("archive symlink target must be normalized")
    depth = len(member_path.parent.parts)
    for component in components:
        if component == "..":
            depth -= 1
        else:
            depth += 1
        if depth < 0:
            fail(f"archive symlink escapes toolchain root: {member_path} -> {target}")


def validate_archive(archive: tarfile.TarFile) -> list[tuple[tarfile.TarInfo, PurePosixPath]]:
    members: list[tuple[tarfile.TarInfo, PurePosixPath]] = []
    file_like_paths: list[PurePosixPath] = []
    directory_paths: set[PurePosixPath] = set()
    member_paths: set[PurePosixPath] = set()
    archive_bytes = 0
    for member in archive.getmembers():
        path = archive_member_path(member.name)
        if path is None:
            continue
        if path in member_paths:
            fail(f"duplicate archive member: {path}")
        member_paths.add(path)
        if member.isdir():
            directory_paths.add(path)
        elif member.isfile():
            if member.sparse is not None:
                fail(f"sparse archive member is unsupported: {path}")
            if member.size < 0 or member.size > MAX_ARCHIVE_MEMBER_BYTES:
                fail(f"archive member exceeds extracted-size limit: {path} ({member.size} bytes)")
            archive_bytes += member.size
            if archive_bytes > MAX_ARCHIVE_BYTES:
                fail(f"archive exceeds aggregate extracted-size limit: {archive_bytes} bytes")
            file_like_paths.append(path)
        elif member.issym():
            validate_symlink_target(path, member.linkname)
            file_like_paths.append(path)
        else:
            fail(f"unsupported archive member type: {member.name}")
        members.append((member, path))
    ensure_no_path_collisions(file_like_paths, "archive member")
    for path in file_like_paths:
        if path in directory_paths:
            fail(f"archive member is both a directory and file-like path: {path}")
        for parent in path.parents:
            if parent in file_like_paths:
                fail(f"archive member file/ancestor collision: {parent} and {path}")
    for path in directory_paths:
        for parent in path.parents:
            if parent in file_like_paths:
                fail(f"archive member file/ancestor collision: {parent} and {path}")
    return members


def validate_archive_end(archive_path: Path, logical_end: int) -> None:
    if archive_path.stat().st_size % TAR_BLOCK_BYTES != 0:
        fail("portable toolchain archive size must be block-aligned")
    if logical_end % TAR_BLOCK_BYTES != 0:
        fail("portable toolchain archive has an invalid physical end marker offset")
    remaining = archive_path.stat().st_size - logical_end
    if remaining < TAR_END_MARKER_BYTES:
        fail("portable toolchain archive is missing its physical end marker")
    with archive_path.open("rb") as source:
        source.seek(logical_end)
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            if any(chunk):
                fail(
                    "portable toolchain archive contains nonzero bytes after its physical end marker"
                )


def stage(args: argparse.Namespace) -> None:
    expected_archive = parse_sha256(args.archive_sha256, "archive_sha256")
    expected_descriptor = parse_sha256(args.descriptor_sha256, "descriptor_sha256")
    entrypoint = str(normalized_relative_path(args.entrypoint, "entrypoint"))
    expected_platform = str(normalized_relative_path(args.expected_platform, "expected_platform"))
    archive_path = Path(args.archive)
    descriptor_path = Path(args.descriptor)
    actual_archive = sha256_file(archive_path)
    actual_descriptor = sha256_file(descriptor_path)
    if actual_archive != expected_archive:
        fail(f"portable toolchain archive identity mismatch: expected {expected_archive}, got {actual_archive}")
    if actual_descriptor != expected_descriptor:
        fail(f"portable toolchain descriptor identity mismatch: expected {expected_descriptor}, got {actual_descriptor}")
    descriptor = read_descriptor(descriptor_path, entrypoint)
    validate_descriptor_platform(descriptor, expected_platform)
    artifact = descriptor["artifact"]
    assert isinstance(artifact, dict)
    digest = artifact["digest"]
    assert isinstance(digest, dict)
    if digest["sri"] != sha256_sri(actual_archive):
        fail("portable toolchain descriptor digest does not match the archive")
    if artifact["sizeBytes"] != archive_path.stat().st_size:
        fail("portable toolchain descriptor sizeBytes does not match the archive")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive_path, "r:") as archive:
        members = validate_archive(archive)
        validate_archive_end(archive_path, archive.offset)
        for member, path in sorted(members, key=lambda item: (len(item[1].parts), str(item[1]))):
            destination = out.joinpath(*path.parts)
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    fail(f"could not read archive member: {member.name}")
                with destination.open("wb") as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
                destination.chmod(0o555 if member.mode & stat.S_IXUSR else 0o444)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(member.linkname, destination)

    for root, directories, _files in os.walk(out, topdown=False):
        for name in directories:
            Path(root, name).chmod(0o555)
    out.chmod(0o555)

    executable = out.joinpath(*PurePosixPath(entrypoint).parts)
    if not executable.is_file() or not os.access(executable, os.X_OK):
        fail(f"portable toolchain entrypoint is not executable: {entrypoint}")


def add_member(archive: tarfile.TarFile, name: str, content: bytes | None, mode: int) -> None:
    info = tarfile.TarInfo(name)
    info.mtime = 1
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


def fixture(args: argparse.Namespace) -> None:
    payload = b'#!/bin/sh\nset -eu\nprintf "%s\\n" portable-toolchain-ok > "$1"\n'
    archive_path = Path(args.archive)
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "w", format=tarfile.GNU_FORMAT) as archive:
        add_member(archive, "./bin", None, 0o555)
        add_member(archive, "./bin/fixture-tool", payload, 0o555)
    digest = sha256_file(archive_path)
    descriptor = {
        "artifact": {
            "digest": {"algorithm": "sha256", "sri": sha256_sri(digest)},
            "file": "artifact.tar",
            "format": "tar",
            "sizeBytes": archive_path.stat().st_size,
        },
        "entrypoints": ["bin/fixture-tool"],
        "kind": "buck2-portable-toolchain-artifact",
        "name": "synthetic-portable-tool",
        "normalization": {
            "dataMode": "0444",
            "directoryMode": "0555",
            "executableMode": "0555",
            "groupId": 0,
            "mtimeSeconds": 1,
            "ownerId": 0,
            "schemaVersion": 1,
        },
        "platform": "x86_64-linux",
        "provenance": {
            "producer": "effect-utils.buck2.synthetic-portable-toolchain-fixture",
            "recipeId": "synthetic-portable-tool-v1",
            "sourceDigest": "sha256:synthetic-portable-tool-v1",
        },
        "schemaVersion": 1,
    }
    Path(args.descriptor).write_text(json.dumps(descriptor, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)
    stage_parser = commands.add_parser("stage")
    stage_parser.add_argument("--archive", required=True)
    stage_parser.add_argument("--descriptor", required=True)
    stage_parser.add_argument("--archive-sha256", required=True)
    stage_parser.add_argument("--descriptor-sha256", required=True)
    stage_parser.add_argument("--entrypoint", required=True)
    stage_parser.add_argument("--expected-platform", required=True)
    stage_parser.add_argument("--out", required=True)
    stage_parser.set_defaults(handler=stage)
    fixture_parser = commands.add_parser("fixture")
    fixture_parser.add_argument("--archive", required=True)
    fixture_parser.add_argument("--descriptor", required=True)
    fixture_parser.set_defaults(handler=fixture)
    return result


def main(argv: Sequence[str] | None = None) -> None:
    args = parser().parse_args(argv)
    args.handler(args)


if __name__ == "__main__":
    main()
