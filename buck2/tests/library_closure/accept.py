#!/usr/bin/env python3
"""External acceptance/measurement only, not a portable-product validator.

Usage: python3 accept.py PAYLOAD_DIR EXACT_TOOLCHAIN_RUSTC [--ar llvm-ar]
Run in the producer's native compiler/linker environment. Store references are
reported and rejected: nonzero counts require remapping investigation (DQ2).
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("payload", type=Path)
parser.add_argument("rustc")
parser.add_argument("--ar", default="ar", help="native ar or LLVM ar (also on Darwin)")
args = parser.parse_args()
payload = args.payload.resolve(strict=True)
store = re.compile(rb"/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+")
total = 0
store_paths = set()
metadata_missing = []
for artifact in sorted(payload.iterdir()):
    if not artifact.is_file() or artifact.is_symlink():
        raise SystemExit(f"Not a flat copied payload file: {artifact}")
    references = store.findall(artifact.read_bytes())
    total += len(references)
    store_paths.update(p.decode("ascii") for p in references)
    print(json.dumps({"file": artifact.name, "storeReferenceCount": len(references),
                      "storePaths": sorted({p.decode("ascii") for p in references})}), flush=True)
    if artifact.suffix == ".rlib":
        # Archive inspection is object-format independent: no ELF-only readelf.
        members = subprocess.check_output([args.ar, "t", str(artifact)], text=True).splitlines()
        metadata = [member for member in members if member.endswith(".rmeta")]
        print(json.dumps({"file": artifact.name, "metadataMembers": metadata}), flush=True)
        if not metadata:
            metadata_missing.append(artifact.name)
print(json.dumps({"totalStoreReferenceCount": total,
                  "DQ2": "remapping investigation required" if total else "no embedded store references observed"}), flush=True)
if total:
    raise SystemExit(f"DQ2, remapping investigation required: {sorted(store_paths)}")
subprocess.run([args.rustc, "-vV"], check=True)
with tempfile.TemporaryDirectory(prefix="effect-utils-library-consumer-") as work:
    executable = str(Path(work) / "consumer")
    subprocess.run([args.rustc, "--edition=2024", str(Path(__file__).with_name("consumer.rs")),
                    "--extern", f"example_library={payload}/libexample_library.rlib",
                    "-L", f"dependency={payload}", "-o", executable], check=True)
    subprocess.run([executable], check=True)
if metadata_missing:
    raise SystemExit(f"Missing rlib metadata members: {metadata_missing}")
print("External consumer compile/link/run and archive metadata checks passed.")
