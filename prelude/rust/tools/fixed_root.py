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
    manifest["outputs"] = [path for group in manifest["outputs"] for path in (group if isinstance(group, list) else [group])]
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
        input_files = set()
        input_dirs = set()
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
                input_dirs.add(Path(relative))
                for child in sorted(source.iterdir()):
                    install(os.path.join(relative, child.name))
                return
            canonical = declared.get(str(source.resolve()))
            if canonical is None:
                raise RuntimeError("undeclared sandbox input: " + relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            os.link(canonical, target)
            input_files.add(Path(relative))
            staged.add(relative)
        for entry in metadata["digests"]:
            install(entry["path"])
        env_input = Path(__file__).with_name("sandbox-env")
        env_relative = env_input.relative_to(host) if env_input.is_absolute() else env_input
        install(env_relative)
        # Reconstitute source/dependency views, but only from declared bytes.
        for view in manifest["views"]:
            install(view)
        for arg in expanded:
            for candidate in re.findall(r"buck-out/[^\s,=\"']+", arg):
                candidate = candidate.rstrip(";:")
                if (host / candidate).exists() and candidate not in manifest["outputs"]:
                    install(candidate)
        output_parents = []
        for output in manifest["outputs"]:
            path = Path(output)
            if path.is_absolute() or ".." in path.parts:
                raise RuntimeError("output escapes virtual root")
            (stage / path).parent.mkdir(parents=True, exist_ok=True)
        for parent in sorted({Path(output).parent for output in manifest["outputs"]}, key=lambda path: (len(path.parts), str(path))):
            if not any(parent == outer or outer in parent.parents for outer in output_parents):
                output_parents.append(parent)
        output_stage = Path(scratch).resolve() / "outputs"
        output_stage.mkdir()
        command = [runtime["bwrap"], "--unshare-all", "--die-with-parent", "--new-session", "--hostname", "rust-sandbox", "--clearenv", "--cap-drop", "ALL", "--tmpfs", "/", "--ro-bind", str(stage), VROOT, "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/home/build", "--dir", "/nix/store"]
        for store_path in runtime["storePaths"]:
            command.extend(["--ro-bind", store_path, store_path])
        # One read-only declared-input tree avoids a mount per input file.
        # Only output parents become writable; protect any overlapping inputs.
        for parent in output_parents:
            if any(parent == directory or directory in parent.parents for directory in input_dirs):
                raise RuntimeError("output parent overlaps an immutable input view: " + str(parent))
            writable = output_stage / parent
            shutil.copytree(stage / parent, writable, copy_function=os.link)
            command.extend(["--bind", str(writable), VROOT + "/" + str(parent)])
            protected_dirs = []
            for directory in sorted(input_dirs, key=lambda path: (len(path.parts), str(path))):
                if parent in directory.parents and not any(outer in directory.parents for outer in protected_dirs):
                    protected_dirs.append(directory)
                    command.extend(["--ro-bind", str(stage / directory), VROOT + "/" + str(directory)])
            for path in sorted(input_files):
                if parent in path.parents and not any(directory in path.parents for directory in protected_dirs):
                    command.extend(["--ro-bind", str(stage / path), VROOT + "/" + str(path)])
        # Prelude's declared linker wrappers use /usr/bin/env bash.
        shell = runtime["shell"]
        command.extend(["--dir", "/bin", "--symlink", shell, "/bin/sh", "--dir", "/usr", "--dir", "/usr/bin", "--symlink", VROOT + "/" + str(env_relative), "/usr/bin/env", "--chdir", VROOT])
        fixed_path = str(Path(shell).parent) + ":" + str(Path(runtime["env"]).parent)
        for key, value in {"LC_ALL": "C", "TZ": "UTC", "HOME": "/home/build", "PWD": VROOT, "PATH": fixed_path, "TMPDIR": "/tmp", "BUCK_SCRATCH_PATH": "/tmp", "RUST_SANDBOX_INNER": "1"}.items():
            command.extend(["--setenv", key, value])
        command.extend([sys.executable, script, *expanded])
        result = subprocess.run(command, check=False)
        for output in manifest["outputs"]:
            source = output_stage / output
            target = host / output
            if source.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                if source.is_dir():
                    shutil.copytree(source, target, dirs_exist_ok=True)
                else:
                    shutil.copy2(source, target)
        return result.returncode
