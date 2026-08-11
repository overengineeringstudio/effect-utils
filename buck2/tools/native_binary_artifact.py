"""Normalize one Buck-built ELF binary into a deterministic store-independent artifact."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile


PORTABLE_INTERPRETER = "/lib64/ld-linux-x86-64.so.2"
NIX_BASE32 = frozenset("0123456789abcdfghijklmnpqrsvwxyz")
NIX_NAME = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-._?=")


def _fail(message: str) -> None:
    raise ValueError(message)


def _canonical_json(value: object) -> bytes:
    return (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_binary_name(value: str) -> str:
    path = PurePosixPath(value)
    if (
        not value
        or value in {".", ".."}
        or path.is_absolute()
        or len(path.parts) != 1
        or path.parts[0] != value
        or "\x00" in value
        or "\n" in value
        or "\r" in value
    ):
        _fail(f"binary name must be one safe path component: {value!r}")
    return value


def _nix_executable(value: str, role: str) -> Path:
    path = Path(value)
    parts = path.parts
    if len(parts) < 5 or parts[:3] != ("/", "nix", "store") or any(part in {"", ".", ".."} for part in parts[3:]):
        _fail(f"configured {role} must be below an immutable absolute /nix/store path: {value!r}")
    store_name = parts[3]
    if (
        len(store_name) < 34
        or store_name[32] != "-"
        or any(character not in NIX_BASE32 for character in store_name[:32])
        or any(character not in NIX_NAME for character in store_name[33:])
    ):
        _fail(f"configured {role} must use a canonical Nix store root: {value!r}")
    if not path.is_file() or not os.access(path, os.X_OK):
        _fail(f"configured {role} is not executable: {value!r}")
    return path


def _build_stamp(args: argparse.Namespace) -> tuple[str, int, bool]:
    revision = args.revision
    if len(revision) != 40 or any(character not in "0123456789abcdef" for character in revision):
        _fail("revision must be a full lowercase 40-character Git SHA")
    try:
        timestamp = int(args.commit_timestamp)
    except ValueError:
        _fail("commit timestamp must be a non-negative integer")
    if timestamp < 0 or str(timestamp) != args.commit_timestamp:
        _fail("commit timestamp must be a canonical non-negative integer")
    if args.dirty not in {"true", "false"}:
        _fail("dirty must be true or false")
    return revision, timestamp, args.dirty == "true"


def _run(argv: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        check=True,
        env={"PATH": "/nonexistent"},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _validate_input(path: Path) -> None:
    if not path.is_file() or path.is_symlink():
        _fail(f"native binary input must be one regular non-symlink file: {path}")
    if not os.access(path, os.X_OK):
        _fail(f"native binary input must be executable: {path}")
    with path.open("rb") as source:
        magic = source.read(4)
    if magic != b"\x7fELF":
        _fail(f"native binary input must be an ELF executable: {path}")


def _assert_normalized(binary: Path, patchelf: Path) -> None:
    interpreter = _run([str(patchelf), "--print-interpreter", str(binary)]).stdout.strip()
    if interpreter != PORTABLE_INTERPRETER:
        _fail(f"normalized ELF interpreter mismatch: {interpreter!r}")
    rpath = _run([str(patchelf), "--print-rpath", str(binary)]).stdout.strip()
    if rpath:
        _fail(f"normalized ELF still has an RPATH: {rpath!r}")
    if b"/nix/store/" in binary.read_bytes():
        _fail("normalized ELF still contains a /nix/store reference")


def _scrub_removed_dynamic_paths(binary: Path, removed_paths: tuple[str, ...]) -> None:
    """Zero one stale ELF string-table copy of each removed dynamic-loader path.

    patchelf removes an active RPATH but can leave its old bytes in `.dynstr`.
    The strict Nix bridge scans raw bytes, so erase only the exact, NUL-terminated
    metadata value that was observed before normalization. Multiple copies are
    ambiguous and fail closed rather than risking a runtime string.
    """
    data = binary.read_bytes()
    for value in removed_paths:
        encoded = value.encode("utf-8")
        if not value or b"/nix/store/" not in encoded:
            continue
        needle = encoded + b"\x00"
        occurrences = data.count(needle)
        if occurrences > 1:
            _fail("removed dynamic-loader path has multiple stale ELF copies")
        if occurrences == 1:
            data = data.replace(needle, b"\x00" * len(needle), 1)
    binary.write_bytes(data)


def package(args: argparse.Namespace) -> None:
    if args.platform != "x86_64-linux":
        _fail(f"native binary artifacts currently support only x86_64-linux: {args.platform!r}")
    binary_name = _safe_binary_name(args.binary_name)
    revision, commit_timestamp, dirty = _build_stamp(args)
    source = Path(args.input)
    _validate_input(source)
    python = _nix_executable(args.python, "Python")
    patchelf = _nix_executable(args.patchelf, "patchelf")
    strip = _nix_executable(args.strip, "strip")

    output = Path(args.output)
    archive = Path(args.archive)
    descriptor = Path(args.descriptor)
    for role, path in (("output", output), ("archive", archive), ("descriptor", descriptor)):
        if path.exists() and (path.is_dir() or path.is_symlink()):
            _fail(f"{role} path must be a file destination: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)

    source_digest = _sha256(source)
    shutil.copyfile(source, output)
    output.chmod(0o700)
    original_interpreter = _run([str(patchelf), "--print-interpreter", str(output)]).stdout.strip()
    original_rpath = _run([str(patchelf), "--print-rpath", str(output)]).stdout.strip()
    _run([str(strip), "--strip-all", str(output)])
    _run([str(patchelf), "--set-interpreter", PORTABLE_INTERPRETER, "--remove-rpath", str(output)])
    _scrub_removed_dynamic_paths(output, (original_interpreter, original_rpath))
    _assert_normalized(output, patchelf)
    output.chmod(0o555)

    with tarfile.open(archive, "w", format=tarfile.USTAR_FORMAT) as tar:
        directory = tarfile.TarInfo("bin")
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o555
        directory.uid = 0
        directory.gid = 0
        directory.uname = ""
        directory.gname = ""
        directory.mtime = 1
        tar.addfile(directory)
        info = tar.gettarinfo(str(output), arcname=f"bin/{binary_name}")
        info.mode = 0o555
        info.uid = 0
        info.gid = 0
        info.uname = ""
        info.gname = ""
        info.mtime = 1
        with output.open("rb") as binary:
            tar.addfile(info, binary)

    declared_inputs = {
        "binary": {"sha256": source_digest},
        "binaryName": binary_name,
        "binaryTarget": args.binary_target,
        "builder": {"sha256": _sha256(Path(args.builder_source))},
        "buildStamp": {
            "commitTimestamp": commit_timestamp,
            "dirty": dirty,
            "revision": revision,
        },
        "platform": args.platform,
        "target": args.target,
        "tools": {
            "patchelf": str(patchelf),
            "python": str(python),
            "strip": str(strip),
        },
    }
    declared_input_digest = hashlib.sha256(_canonical_json(declared_inputs)).hexdigest()
    archive_bytes = archive.read_bytes()
    digest_bytes = hashlib.sha256(archive_bytes).digest()
    payload = {
        "artifact": {
            "digest": {
                "algorithm": "sha256",
                "hex": digest_bytes.hex(),
                "sri": "sha256-" + base64.b64encode(digest_bytes).decode("ascii"),
            },
            "file": "artifact.tar",
            "format": "tar",
            "sizeBytes": len(archive_bytes),
        },
        "entrypoints": [f"bin/{binary_name}"],
        "kind": "buck2-build-artifact",
        "name": binary_name,
        "platform": args.platform,
        "runtimeAbi": "glibc-dynamic",
        "provenance": {
            "binaryTarget": args.binary_target,
            "declaredInputDigest": "sha256:" + declared_input_digest,
            "producer": "effect-utils.buck2.native-binary-artifact.v1",
            "sourceCommitTimestamp": commit_timestamp,
            "sourceDirty": dirty,
            "sourceRevision": revision,
            "target": args.target,
        },
        "schemaVersion": 1,
    }
    descriptor.write_bytes(json.dumps(payload, indent=2, sort_keys=True).encode("utf-8") + b"\n")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--descriptor", required=True)
    parser.add_argument("--binary-name", required=True)
    parser.add_argument("--binary-target", required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--builder-source", required=True)
    parser.add_argument("--patchelf", required=True)
    parser.add_argument("--strip", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--commit-timestamp", required=True)
    parser.add_argument("--dirty", required=True)
    return parser


def main() -> None:
    package(_parser().parse_args())


if __name__ == "__main__":
    main()
