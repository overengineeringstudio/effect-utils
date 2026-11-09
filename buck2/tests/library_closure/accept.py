#!/usr/bin/env python3
"""External closure acceptance plus packaged archive/descriptor consistency.

Usage: python3 accept.py PAYLOAD_DIR EXACT_TOOLCHAIN_RUSTC --metadata JSON --artifact TAR --descriptor JSON [--ar llvm-ar]
Run in the producer's native compiler/linker environment. Store references are
reported and rejected: nonzero counts require remapping investigation (DQ2).
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("payload", type=Path)
parser.add_argument("rustc")
parser.add_argument("--ar", default="ar", help="native ar or LLVM ar (also on Darwin)")
parser.add_argument("--metadata", type=Path, required=True)
parser.add_argument("--artifact", type=Path, required=True)
parser.add_argument("--descriptor", type=Path, required=True)
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
product = json.loads(args.metadata.read_text())
descriptor = json.loads(args.descriptor.read_text())
archive_bytes = args.artifact.read_bytes()
digest = "sha256-" + base64.b64encode(hashlib.sha256(archive_bytes).digest()).decode("ascii")
if descriptor["payload"]["sizeBytes"] != len(archive_bytes) or descriptor["payload"]["digest"]["sri"] != digest:
    raise SystemExit("Packaged archive size/digest differs from the validated descriptor")
library = descriptor["library"]
if any(library[key] != value for key, value in product.items()):
    raise SystemExit("Packaged descriptor compiler/crate metadata differs from the closure")
inventory = {entry["path"]: entry["sha256"] for entry in library["artifacts"]}
# The fixture reaches one leaf twice and a second version via alternate_leaf.
leaves = [path for path in inventory if re.fullmatch(r"lib/libgeneric_leaf-[^/]+\.rlib", path)]
if len(leaves) != 2:
    raise SystemExit(f"Expected exactly two distinct generic_leaf versions after duplicate-edge deduplication: {leaves}")
primaries = [path for path in inventory if re.fullmatch(r"lib/libexample_library(?:-[^/]+)?\.rlib", path)]
if primaries != ["lib/libexample_library.rlib"]:
    raise SystemExit(f"Expected only the stable primary rlib, without a hashed alias: {primaries}")
with tarfile.open(args.artifact, mode="r:") as archive:
    members = archive.getmembers()
    if len({member.name for member in members}) != len(members):
        raise SystemExit("Packaged archive contains duplicate member paths")
    if {member.name for member in members} != {"lib", *inventory}:
        raise SystemExit("Packaged archive members differ from the descriptor inventory")
    for member in members:
        if member.name == "lib":
            if not member.isdir():
                raise SystemExit("Packaged lib member is not a directory")
            continue
        if not member.isfile():
            raise SystemExit(f"Packaged artifact is not a regular file: {member.name}")
        contents = archive.extractfile(member).read()
        if hashlib.sha256(contents).hexdigest() != inventory[member.name]:
            raise SystemExit(f"Packaged artifact hash differs from inventory: {member.name}")
        if contents != (payload / member.name.removeprefix("lib/")).read_bytes():
            raise SystemExit(f"Packaged artifact bytes differ from producer closure: {member.name}")
if set(inventory) != {f"lib/{path.name}" for path in payload.iterdir()}:
    raise SystemExit("Packaged inventory omits or adds producer closure artifacts")
print("Real library descriptor accepted; archive digest, inventory and closure bytes agree.", flush=True)
compiler = product["rustc"]
underlying = str(Path(compiler["compilerStorePath"]) / "bin/rustc")
version = subprocess.check_output([underlying, "-vV"], text=True).rstrip("\n") + "\n"
sysroot = Path(subprocess.check_output([underlying, "--print", "sysroot"], text=True).strip()).resolve()
if version != compiler["verboseVersion"] or str(sysroot) != compiler["sysroot"]:
    raise SystemExit("Underlying compiler identity evidence does not match")
if product["crateName"] != "example_library" or product["panicStrategy"] != "unwind":
    raise SystemExit("Unchanged external consumer requires example_library with unwind")
if product["targetTriple"] != product["hostTriple"]:
    raise SystemExit("External acceptance requires a native library")
print(json.dumps(product), flush=True)
with tempfile.TemporaryDirectory(prefix="effect-utils-library-consumer-") as work:
    executable = str(Path(work) / "consumer")
    subprocess.run([args.rustc, "--edition=2024", str(Path(__file__).with_name("consumer.rs")),
                    "--extern", f"example_library={payload}/libexample_library.rlib",
                    "-L", f"dependency={payload}", "-o", executable], check=True)
    subprocess.run([executable], check=True)
if metadata_missing:
    raise SystemExit(f"Missing rlib metadata members: {metadata_missing}")
print("External consumer compile/link/run and archive metadata checks passed.")
