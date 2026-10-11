#!/usr/bin/env python3
"""Q42 adversarial fixtures; run only inside the heavy gate with nice/ionice."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

BUCK = "/nix/store/rjsknd8qby7h7lydn15vk60asi0fbxih-buck2-unstable-2026-09-01/libexec/buck2"
LOADER = "/nix/store/lm3pknxi0ipypy3lxh1wmm8wvvavdwrn-glibc-2.42-84/lib/ld-linux-x86-64.so.2"


def run(plan, evidence):
    evidence.mkdir(parents=True, exist_ok=True)
    for item in plan:
        root = Path(item["root"])
        name = item["name"]
        target = "//buck2/rust/sandbox-probes:" + item["target"]
        subprocess.run([BUCK, "kill"], cwd=root, capture_output=True, check=False)
        args = [BUCK, "build", "-j", "2", "--show-output", "--no-remote-cache", target,
                "--config", "rust_bakeoff.arm=" + item["arm"],
                "--config", "buck2.default_allow_cache_upload=false"]
        before = os.getloadavg()[0]
        started = time.time()
        result = subprocess.run(args, cwd=root, capture_output=True, text=True,
                                env=os.environ | {"PWD": str(root), "TMPDIR": "/tmp"})
        receipt = {"name": name, "arm": item["arm"], "root": str(root), "command": args,
                   "exit": result.returncode, "elapsedSeconds": time.time() - started,
                   "load1Start": before, "load1End": os.getloadavg()[0]}
        (evidence / (name + ".log")).write_text(result.stdout + result.stderr)
        log = subprocess.run([BUCK, "log", "show", "--recent", "0"], cwd=root,
                             capture_output=True, text=True, check=True)
        with gzip.open(evidence / (name + ".events.jsonl.gz"), "wt") as output:
            output.write(log.stdout)
        if result.returncode == 0:
            output_line = next(line for line in result.stdout.splitlines()
                               if line.partition(" ")[0].endswith(target))
            binary = root / output_line.split(" ", 1)[1]
            payload = binary.read_bytes()
            receipt["binary"] = {"path": str(binary), "sha256": hashlib.sha256(payload).hexdigest(),
                                 "bytes": len(payload)}
            execution = subprocess.run([LOADER, str(binary)], cwd=root, capture_output=True, text=True)
            (evidence / (name + ".compiler-view.txt")).write_text(execution.stdout + execution.stderr)
            receipt["executionExit"] = execution.returncode
            receipt["compilerViewSha256"] = hashlib.sha256(execution.stdout.encode()).hexdigest()
        (evidence / (name + ".json")).write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt), flush=True)
        subprocess.run([BUCK, "kill"], cwd=root, capture_output=True, check=False)
        if bool(result.returncode) != bool(item.get("expectFailure")):
            raise SystemExit("unexpected probe outcome: " + name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    run(json.loads(args.plan.read_text()), args.evidence)
