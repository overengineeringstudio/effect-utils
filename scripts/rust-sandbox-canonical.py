#!/usr/bin/env python3
"""Offline Q42 canonical output identity; invoke under the heavy gate."""
import argparse
import hashlib
import json
from pathlib import Path


def snapshot(evidence, name):
    receipt = json.loads((evidence / (name + ".json")).read_text())
    root = Path(receipt["root"])
    paths = sorted({line for line in (evidence / (name + ".log")).read_text().splitlines()
                    if line.startswith("buck-out/")})
    files = {}
    directories = {}
    for relative in paths:
        path = root / relative
        if path.is_dir():
            members = sorted(path.rglob("*"))
            directories[relative] = [str(member.relative_to(path)) for member in members]
        else:
            members = [path]
        for member in members:
            if member.is_file():
                payload = member.read_bytes()
                files[str(member.relative_to(root))] = {
                    "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}
    return {"root": str(root), "ensuredOutputs": len(paths), "files": files,
            "directories": directories}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    first = snapshot(args.evidence, "tree-sandbox-cold")
    second = snapshot(args.evidence, "tree-sandbox-independent")
    differences = [key for key in sorted(first["files"].keys() | second["files"].keys())
                   if first["files"].get(key) != second["files"].get(key)]
    result = {"first": first, "second": second, "fileDifferences": differences,
              "directoryShapesEqual": first["directories"] == second["directories"]}
    (args.evidence / "tree-canonical-identity.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"ensuredOutputs": first["ensuredOutputs"], "files": len(first["files"]),
                      "directories": len(first["directories"]), "fileDifferences": differences,
                      "directoryShapesEqual": result["directoryShapesEqual"]}))
    if differences or not result["directoryShapesEqual"] or len(first["files"]) != 267:
        raise SystemExit(1)
