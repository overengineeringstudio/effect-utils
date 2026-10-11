"""Linux-only Q42 experiment. No host root or entire Nix store is mounted."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

VROOT = "/build"


def launch(script, argv):
    host = Path.cwd()
    runtime = json.loads(Path(__file__).with_name("sandbox-runtime.json").read_text())
    metadata = json.loads(Path(os.environ["RUST_SANDBOX_METADATA"]).read_text())
    if metadata["version"] != 1:
        raise RuntimeError("unsupported input metadata")
    # Expanded action arguments are already declared action inputs.
    def expand(arguments):
        result = []
        for arg in arguments:
            if arg.startswith("@"):
                result.extend(expand(Path(arg[1:]).read_text().splitlines()))
            else:
                result.append(arg)
        return result
    expanded = expand(argv)
    manifest_arg = next(x for x in expanded if x.startswith("--sandbox-outputs="))
    manifest = json.loads(Path(manifest_arg.split("=", 1)[1]).read_text())
    expanded = [x for x in expanded if not x.startswith("--sandbox-outputs=")]
    with tempfile.TemporaryDirectory(prefix="q42-root-", dir=os.environ.get("BUCK_SCRATCH_PATH")) as scratch:
        stage = Path(scratch).resolve() / "root"
        stage.mkdir()
        snapshots = Path(scratch).resolve() / "inputs"
        snapshots.mkdir()
        declared = {}
        for entry in metadata["digests"]:
            path = Path(entry["path"])
            if path.is_absolute() or ".." in path.parts:
                raise RuntimeError("input outside the declared root: " + str(path))
            source = host / path
            digest, size = entry["digest"].split(":")
            payload = source.read_bytes()
            if len(payload) != int(size) or hashlib.sha256(payload).hexdigest() != digest:
                raise RuntimeError("input digest changed: " + str(path))
            executable = bool(source.stat().st_mode & 0o111)
            snapshot = snapshots / (digest + ("-x" if executable else "-r"))
            if not snapshot.exists():
                snapshot.write_bytes(payload)
                snapshot.chmod(0o555 if executable else 0o444)
            declared.setdefault(str(source.resolve()), snapshot)
        mounts = []
        staged = set()
        def install(relative):
            relative = os.path.normpath(str(relative))
            if relative in staged:
                return
            if relative.startswith("/") or relative == ".." or relative.startswith("../"):
                raise RuntimeError("path escapes virtual root: " + relative)
            source = host / relative
            target = stage / relative
            if source.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                staged.add(relative)
                for child in sorted(source.iterdir()):
                    install(os.path.join(relative, child.name))
                return
            canonical = declared.get(str(source.resolve()))
            if canonical is None:
                raise RuntimeError("undeclared sandbox input: " + relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
            mounts.extend(["--ro-bind", str(canonical), VROOT + "/" + relative])
            staged.add(relative)
        for entry in metadata["digests"]:
            install(entry["path"])
        # Reconstitute source/dependency views, but only from declared bytes.
        for view in manifest["views"]:
            install(view)
        for arg in expanded:
            for candidate in re.findall(r"buck-out/[^\s,=\"']+", arg):
                candidate = candidate.rstrip(";:")
                if (host / candidate).exists() and candidate not in manifest["outputs"]:
                    install(candidate)
        for output in manifest["outputs"]:
            path = Path(output)
            if path.is_absolute() or ".." in path.parts:
                raise RuntimeError("output escapes virtual root")
            (stage / path).parent.mkdir(parents=True, exist_ok=True)
        command = [runtime["bwrap"], "--unshare-all", "--die-with-parent", "--new-session", "--hostname", "rust-sandbox", "--clearenv", "--cap-drop", "ALL", "--tmpfs", "/", "--bind", str(stage), VROOT, "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/home/build", "--dir", "/nix/store"]
        for store_path in runtime["storePaths"]:
            command.extend(["--ro-bind", store_path, store_path])
        command.extend(mounts)
        # Linker wrapper uses /bin/sh, but only the pinned shell may provide it.
        shell = runtime["shell"]
        command.extend(["--dir", "/bin", "--symlink", shell, "/bin/sh", "--chdir", VROOT])
        for key, value in {"LC_ALL": "C", "TZ": "UTC", "HOME": "/home/build", "PWD": VROOT, "TMPDIR": "/tmp", "BUCK_SCRATCH_PATH": "/tmp", "RUST_SANDBOX_INNER": "1"}.items():
            command.extend(["--setenv", key, value])
        command.extend([sys.executable, script, *expanded])
        result = subprocess.run(command, check=False)
        for output in manifest["outputs"]:
            source = stage / output
            target = host / output
            if source.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                if source.is_dir():
                    shutil.copytree(source, target, dirs_exist_ok=True)
                else:
                    shutil.copy2(source, target)
        return result.returncode
