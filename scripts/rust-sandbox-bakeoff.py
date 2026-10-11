#!/usr/bin/env python3
"""Q42 local experiment: invoke inside gate-slot --class heavy, nice/ionice."""
import argparse
import collections
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

BUCK = "/nix/store/rjsknd8qby7h7lydn15vk60asi0fbxih-buck2-unstable-2026-09-01/libexec/buck2"


def run(plan, evidence):
    evidence.mkdir(parents=True, exist_ok=True)
    cohort = json.loads((Path(__file__).resolve().parent.parent / "buck2/rust/sandbox-cohort.json").read_text())["rustc"]
    expected = {(x["target"], x["configuration"], x["identifier"]) for x in cohort}
    target_configs = {(x["target"], x["configuration"]) for x in cohort}
    for item in plan:
        root = Path(item["root"])
        name = item["name"]
        subprocess.run([BUCK, "kill"], cwd=root, check=False, capture_output=True)
        config = ["--config", "rust_bakeoff.arm=" + item["arm"], "--config", "buck2.default_allow_cache_upload=false"]
        if item.get("instance"):
            config.extend(["--config", "buck2_re_client.instance_name=" + item["instance"]])
        args = [BUCK, "bxl", "-j", "2", "//buck2/rust/sandbox-cohort.bxl:run", *config]
        if item.get("noCache"):
            args.append("--no-remote-cache")
        before = os.getloadavg()[0]
        started = time.time()
        result = subprocess.run(args, cwd=root, capture_output=True, text=True, env=os.environ | {"PWD": str(root), "TMPDIR": "/tmp"})
        elapsed = time.time() - started
        after = os.getloadavg()[0]
        (evidence / (name + ".timing.json")).write_text(json.dumps({"exit": result.returncode, "elapsedSeconds": elapsed, "startedEpoch": started, "load1Start": before, "load1End": after}) + "\n")
        (evidence / (name + ".log")).write_text(result.stdout + result.stderr)
        log = subprocess.run([BUCK, "log", "show", "--recent", "0"], cwd=root, capture_output=True, text=True, check=True)
        with gzip.open(evidence / (name + ".events.jsonl.gz"), "wt") as output:
            output.write(log.stdout)
        actions = []
        for line in log.stdout.splitlines():
            entry = json.loads(line)
            action = entry.get("Event", {}).get("data", {}).get("SpanEnd", {}).get("data", {}).get("ActionExecution")
            if not action:
                continue
            owner = action.get("key", {}).get("owner", {}).get("TargetLabel")
            if not owner:
                continue
            target = owner["label"]["package"] + ":" + owner["label"]["name"]
            cfg = owner["configuration"]["full_name"]
            category = action["name"]["category"]
            ident = action["name"]["identifier"]
            if (category == "rustc" and (target, cfg, ident) in expected) or (category == "deps" and (target, cfg) in target_configs):
                command = action.get("commands", [{}])[0].get("details", {}).get("command_kind", {}).get("command", {})
                actions.append({"target": target, "configuration": cfg, "category": category, "identifier": ident, "kind": action["execution_kind"], "wallUs": action.get("wall_time_us", 0), "uploaded": action.get("cache_upload_result"), "command": command})
        snapshots = {}
        for directory, _, files in os.walk(root / "buck-out/v2/art"):
            for filename in files:
                if not filename.endswith("-sandbox-outputs.json"):
                    continue
                manifest = json.loads((Path(directory) / filename).read_text())
                cfg_label = manifest.get("configuredTarget", "")
                cfg = cfg_label.split(" (", 1)[-1].removesuffix(")")
                if (manifest.get("target"), cfg, manifest.get("identifier")) not in expected:
                    continue
                for path in {path for group in manifest["outputs"] for path in (group if isinstance(group, list) else [group])}:
                    output = root / path
                    output_files = sorted(output.rglob("*")) if output.is_dir() else [output]
                    for output_file in output_files:
                        if not output_file.is_file():
                            continue
                        payload = output_file.read_bytes()
                        output_name = output.name + "/" + str(output_file.relative_to(output)) if output.is_dir() else output.name
                        key = "|".join([manifest["target"], cfg, manifest["identifier"], output_name])
                        snapshots[key] = {"sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload), "path": str(output_file.relative_to(root))}
        usage = subprocess.run(["du", "-s", "-B1", str(root / "buck-out")], capture_output=True, text=True, check=True)
        apparent = subprocess.run(["du", "-s", "-B1", "--apparent-size", str(root / "buck-out")], capture_output=True, text=True, check=True)
        receipt = {"name": name, "arm": item["arm"], "root": str(root), "command": args, "exit": result.returncode, "startedEpoch": started, "elapsedSeconds": elapsed, "load1Start": before, "load1End": after, "cohortCommands": len(actions), "cohortKinds": dict(collections.Counter(x["kind"] for x in actions)), "cohortWallSeconds": sum(x["wallUs"] for x in actions)/1e6, "buckOutAllocatedBytes": int(usage.stdout.split()[0]), "buckOutApparentBytes": int(apparent.stdout.split()[0]), "actions": actions, "outputs": snapshots}
        (evidence / (name + ".json")).write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({k: v for k, v in receipt.items() if k not in ("actions", "outputs")}), flush=True)
        subprocess.run([BUCK, "kill"], cwd=root, check=False, capture_output=True)
        if result.returncode:
            raise SystemExit(result.returncode)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    run(json.loads(args.plan.read_text()), args.evidence)
