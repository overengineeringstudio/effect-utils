"""Hermetic action tool for exact dependency-closure projections."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
from typing import NoReturn, Sequence


HEX = frozenset("0123456789abcdef")
RESERVED_METADATA_PATH = PurePosixPath("closure-manifest.json")


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_projection_path(value: object) -> PurePosixPath:
    if not isinstance(value, str) or not value:
        fail("projectionPath must be a non-empty string")
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value:
        fail(f"projectionPath must be a normalized relative path: {value!r}")
    if any(component in ("", ".", "..") for component in path.parts):
        fail(f"projectionPath must not traverse or contain empty components: {value!r}")
    return path


def parse_sha256(value: object) -> str:
    if not isinstance(value, str) or len(value) != 64 or any(char not in HEX for char in value):
        fail("sha256 must contain exactly 64 lowercase hexadecimal characters")
    return value


def read_manifest(path: Path) -> list[dict[str, str]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"invalid closure manifest: {error}")
    if not isinstance(value, dict) or set(value) != {"packages", "schemaVersion"}:
        fail("closure manifest must contain exactly packages and schemaVersion")
    if value["schemaVersion"] != 1:
        fail(f"unsupported closure manifest schemaVersion: {value['schemaVersion']!r}")
    if not isinstance(value["packages"], list):
        fail("closure manifest packages must be a list")

    result: list[dict[str, str]] = []
    prior_id: str | None = None
    seen_paths: set[str] = set()
    parsed_paths: list[PurePosixPath] = []
    for index, entry in enumerate(value["packages"]):
        if not isinstance(entry, dict) or set(entry) != {"id", "projectionPath", "sha256"}:
            fail(f"package entry {index} must contain exactly id, projectionPath, and sha256")
        package_id = entry["id"]
        if not isinstance(package_id, str) or not package_id:
            fail(f"package entry {index} id must be a non-empty string")
        if prior_id is not None and package_id <= prior_id:
            fail("closure manifest package ids must be unique and strictly increasing")
        parsed_path = parse_projection_path(entry["projectionPath"])
        projection_path = str(parsed_path)
        if parsed_path == RESERVED_METADATA_PATH or RESERVED_METADATA_PATH in parsed_path.parents:
            fail(f"projectionPath collides with reserved metadata path: {projection_path}")
        if projection_path in seen_paths:
            fail(f"duplicate projectionPath: {projection_path}")
        for prior_path in parsed_paths:
            if parsed_path in prior_path.parents or prior_path in parsed_path.parents:
                fail(f"projectionPath file/ancestor collision: {prior_path} and {parsed_path}")
        seen_paths.add(projection_path)
        parsed_paths.append(parsed_path)
        prior_id = package_id
        result.append({
            "id": package_id,
            "projectionPath": projection_path,
            "sha256": parse_sha256(entry["sha256"]),
        })
    return result


def stage(args: argparse.Namespace) -> None:
    widths = {
        len(args.package_id),
        len(args.projection_path),
        len(args.sha256),
        len(args.artifact),
    }
    if len(widths) != 1:
        fail("each package requires id, projection path, sha256, and artifact")

    declared: list[dict[str, str | Path]] = []
    for package_id, projection_path, sha256, artifact in zip(
        args.package_id,
        args.projection_path,
        args.sha256,
        args.artifact,
        strict=True,
    ):
        declared.append({
            "id": package_id,
            "projectionPath": str(parse_projection_path(projection_path)),
            "sha256": parse_sha256(sha256),
            "artifact": Path(artifact),
        })

    manifest = read_manifest(Path(args.manifest))
    manifest_contract = [
        {key: entry[key] for key in ("id", "projectionPath", "sha256")}
        for entry in manifest
    ]
    declared_contract = [
        {key: str(entry[key]) for key in ("id", "projectionPath", "sha256")}
        for entry in declared
    ]
    if manifest_contract != declared_contract:
        fail(
            "manifest packages do not exactly match declared Buck package edges\n"
            f"manifest={json.dumps(manifest_contract, sort_keys=True)}\n"
            f"declared={json.dumps(declared_contract, sort_keys=True)}"
        )

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    for entry in declared:
        artifact = entry["artifact"]
        assert isinstance(artifact, Path)
        if not artifact.is_file():
            fail(f"package artifact must be a regular file: {artifact}")
        actual = file_sha256(artifact)
        if actual != entry["sha256"]:
            fail(
                f"package digest mismatch for {entry['id']}: "
                f"expected {entry['sha256']}, got {actual}"
            )
        destination = out.joinpath(*PurePosixPath(str(entry["projectionPath"])).parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(artifact, destination)

    canonical = {"packages": manifest, "schemaVersion": 1}
    (out / "closure-manifest.json").write_text(
        json.dumps(canonical, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    for root, directories, files in os.walk(out):
        for name in directories:
            Path(root, name).chmod(stat.S_IRUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        for name in files:
            Path(root, name).chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)


def probe(args: argparse.Namespace) -> None:
    tree = Path(args.tree)
    manifest = read_manifest(tree / "closure-manifest.json")
    packages = []
    for entry in manifest:
        artifact = tree.joinpath(*PurePosixPath(entry["projectionPath"]).parts)
        actual = file_sha256(artifact)
        if actual != entry["sha256"]:
            fail(f"staged package digest mismatch for {entry['id']}")
        packages.append({"id": entry["id"], "sha256": actual})
    evidence = {
        "packages": packages,
        "schemaVersion": 1,
        "sourceSha256": file_sha256(Path(args.source)),
    }
    Path(args.out).write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)
    stage_parser = commands.add_parser("stage")
    stage_parser.add_argument("--manifest", required=True)
    stage_parser.add_argument("--out", required=True)
    stage_parser.add_argument("--package-id", action="append", default=[])
    stage_parser.add_argument("--projection-path", action="append", default=[])
    stage_parser.add_argument("--sha256", action="append", default=[])
    stage_parser.add_argument("--artifact", action="append", default=[])
    stage_parser.set_defaults(handler=stage)
    probe_parser = commands.add_parser("probe")
    probe_parser.add_argument("--tree", required=True)
    probe_parser.add_argument("--source", required=True)
    probe_parser.add_argument("--out", required=True)
    probe_parser.set_defaults(handler=probe)
    return result


def main(argv: Sequence[str] | None = None) -> None:
    args = parser().parse_args(argv)
    args.handler(args)


if __name__ == "__main__":
    main()
