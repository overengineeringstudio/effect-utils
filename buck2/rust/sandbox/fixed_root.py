"""Linux native Rust action boundary; only declared bytes and Nix closure are visible.

The adjacent generated sandbox-runtime.json supplies bwrap, shell, env and
storePaths. Buck metadata v1 supplies path/digest (sha256:size) entries. Source
views may contain symlinks within the action root: these are materialized from
verified snapshots, never mounted as host symlinks. Output symlinks and special
files are rejected. A failed action or invalid/missing output publishes nothing.

Assumptions: Linux bubblewrap supports unprivileged namespaces; the configured
Nix store is immutable; Buck owns the action root and does not concurrently
mutate its directory layout during publication. No sandbox process survives the
PID namespace. Publication is preflighted, but an OS I/O failure during multiple
renames is not a multi-file filesystem transaction.
"""
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

VROOT = "/build"


class BoundaryError(RuntimeError):
    """An action violated the declared input/output boundary."""


def _relative(value):
    if not isinstance(value, str) or not value or "\x00" in value:
        raise BoundaryError("invalid action path: " + repr(value))
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or path == Path("."):
        raise BoundaryError("path escapes action root: " + value)
    return path


def _open_beneath(root, relative, directory=False, create=False):
    """Walk directory FDs, refusing symlinks in every component."""
    parts = Path(relative).parts
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for index, part in enumerate(parts):
            if part in (".", "..") or "/" in part:
                raise BoundaryError("unsafe path component")
            is_dir = index < len(parts) - 1 or directory
            if create and is_dir:
                try:
                    os.mkdir(part, dir_fd=fd)
                except FileExistsError:
                    pass
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if is_dir:
                flags |= os.O_DIRECTORY
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def _canonical(host, relative):
    source = (host / relative).resolve(strict=True)
    try:
        source.relative_to(host)
    except ValueError as error:
        raise BoundaryError("input symlink escapes action root: " + str(relative)) from error
    return source


def _read_file(host, relative):
    canonical = _canonical(host, relative)
    fd = _open_beneath(host, canonical.relative_to(host))
    with os.fdopen(fd, "rb") as stream:
        mode = os.fstat(stream.fileno()).st_mode
        if not stat.S_ISREG(mode):
            raise BoundaryError("input is not a regular file: " + str(relative))
        return canonical, stream.read(), mode


class Inputs:
    def __init__(self, host, stage, metadata):
        if metadata.get("version") != 1:
            raise BoundaryError("unsupported input metadata")
        self.host, self.stage = host, stage
        self.declared = {}
        self.files = set()
        self.views = set()
        for entry in metadata["digests"]:
            relative = _relative(entry["path"])
            canonical, payload, mode = _read_file(host, relative)
            expected = entry["digest"]
            actual = hashlib.sha256(payload).hexdigest() + ":" + str(len(payload))
            if expected != actual:
                raise BoundaryError("input digest changed: " + str(relative))
            previous = self.declared.get(canonical)
            if previous is not None and previous != (payload, mode & 0o111):
                raise BoundaryError("inconsistent declared input: " + str(relative))
            self.declared[canonical] = (payload, mode & 0o111)
        for entry in metadata["digests"]:
            self.install(_relative(entry["path"]))

    def install(self, relative, ancestors=()):
        relative = _relative(str(relative))
        canonical = _canonical(self.host, relative)
        fd = _open_beneath(self.host, canonical.relative_to(self.host))
        try:
            mode = os.fstat(fd).st_mode
            if stat.S_ISDIR(mode):
                if canonical in ancestors:
                    raise BoundaryError("cyclic input view: " + str(relative))
                (self.stage / relative).mkdir(parents=True, exist_ok=True)
                for name in sorted(os.listdir(fd)):
                    self.install(relative / name, (*ancestors, canonical))
                return
            if not stat.S_ISREG(mode):
                raise BoundaryError("special input: " + str(relative))
        finally:
            os.close(fd)
        if canonical not in self.declared:
            raise BoundaryError("undeclared sandbox input: " + str(relative))
        if relative not in self.files:
            payload, executable = self.declared[canonical]
            target = self.stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            target.chmod(0o555 if executable else 0o444)
            self.files.add(relative)

    def read_declared(self, relative):
        self.install(relative)
        return (self.stage / relative).read_text()


def _expand(arguments, inputs, active=()):
    result = []
    for argument in arguments:
        if argument.startswith("@"):
            path = _relative(argument[1:])
            if path in active:
                raise BoundaryError("cyclic response file: " + str(path))
            result.extend(_expand(inputs.read_declared(path).splitlines(), inputs, (*active, path)))
        else:
            result.append(argument)
    return result


def _outputs(manifest):
    outputs = []
    for group in manifest["outputs"]:
        for value in group if isinstance(group, list) else [group]:
            path = _relative(value)
            if path not in outputs:
                outputs.append(path)
    for path in outputs:
        if any(other in path.parents for other in outputs):
            raise BoundaryError("nested declared outputs: " + str(path))
    if not outputs:
        raise BoundaryError("action declares no outputs")
    return outputs


def _copy_output(source_root, relative, target):
    """Copy only regular files/directories, never following output symlinks."""
    fd = _open_beneath(source_root, relative)
    try:
        mode = os.fstat(fd).st_mode
        if stat.S_ISREG(mode):
            with os.fdopen(os.dup(fd), "rb") as source, target.open("xb") as dest:
                shutil.copyfileobj(source, dest)
            target.chmod(0o755 if mode & 0o111 else 0o644)
        elif stat.S_ISDIR(mode):
            target.mkdir()
            for name in sorted(os.listdir(fd)):
                _copy_output(source_root, relative / name, target / name)
        else:
            raise BoundaryError("special output: " + str(relative))
    finally:
        os.close(fd)


def _publish(host, output_stage, outputs, scratch):
    # Validate and snapshot EVERY output before even creating host directories.
    prepared = scratch / "publish"
    prepared.mkdir()
    for index, output in enumerate(outputs):
        try:
            _copy_output(output_stage, output, prepared / str(index))
        except OSError as error:
            raise BoundaryError("missing or unsafe declared output: " + str(output)) from error
    # Check existing host ancestors and targets before publication. Missing parents
    # are allowed, but existing symlinks (including dangling ones) are not.
    for index, output in enumerate(outputs):
        current = host
        for part in output.parts:
            current /= part
            try:
                mode = current.lstat().st_mode
            except FileNotFoundError:
                break
            if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise BoundaryError("unsafe host output destination: " + str(output))
            if current != host / output and not stat.S_ISDIR(mode):
                raise BoundaryError("non-directory output ancestor: " + str(output))
        target = host / output
        if target.exists() and target.is_dir() != (prepared / str(index)).is_dir():
            raise BoundaryError("output destination type mismatch: " + str(output))
        if target.is_dir() and any(target.iterdir()):
            raise BoundaryError("existing nonempty output directory: " + str(output))
    for index, output in enumerate(outputs):
        parent_fd = _open_beneath(host, output.parent, directory=True, create=True)
        try:
            # Scratch may be on a different filesystem. Stage the validated copy
            # beside its final destination and rename atomically per output.
            with tempfile.TemporaryDirectory(prefix=".rust-publish-", dir=host / output.parent) as temporary:
                staged = Path(temporary) / "output"
                source = prepared / str(index)
                if source.is_dir():
                    shutil.copytree(source, staged)
                else:
                    shutil.copyfile(source, staged)
                    shutil.copymode(source, staged)
                os.replace(staged, output.name, dst_dir_fd=parent_fd)
        finally:
            os.close(parent_fd)


def _runtime():
    runtime = json.loads(Path(__file__).with_name("sandbox-runtime.json").read_text())
    roots = runtime["storePaths"]
    if not roots or len(set(roots)) != len(roots):
        raise BoundaryError("invalid immutable closure")
    for root in roots:
        path = Path(root)
        if path.parent != Path("/nix/store") or not re.fullmatch(r"[0-9a-z]{32}-[^/]+", path.name) or path.is_symlink():
            raise BoundaryError("not an immutable Nix store root: " + root)
    for key in ("bwrap", "shell", "env"):
        path = Path(runtime[key])
        if not path.is_absolute() or ".." in path.parts or not any(Path(root) in path.parents for root in roots):
            raise BoundaryError("runtime tool outside declared closure: " + key)
    executable = Path(sys.executable).resolve()
    if not any(Path(root) in executable.parents for root in roots):
        raise BoundaryError("Python outside declared closure")
    return runtime, str(executable)


def launch(script, argv):
    if os.environ.get("RUST_SANDBOX_INNER") == "1":
        raise BoundaryError("recursive sandbox launch")
    host = Path.cwd().resolve()
    runtime, python = _runtime()
    metadata = json.loads(Path(os.environ["RUST_SANDBOX_METADATA"]).read_text())
    with tempfile.TemporaryDirectory(prefix="rust-sandbox-", dir=os.environ.get("BUCK_SCRATCH_PATH")) as temporary:
        scratch = Path(temporary).resolve()
        stage = scratch / "inputs"
        stage.mkdir()
        inputs = Inputs(host, stage, metadata)
        expanded = _expand(argv, inputs)
        manifests = [arg for arg in expanded if arg.startswith("--sandbox-outputs=")]
        if len(manifests) != 1:
            raise BoundaryError("expected one declared-output manifest")
        manifest = json.loads(inputs.read_declared(_relative(manifests[0].split("=", 1)[1])))
        outputs = _outputs(manifest)
        expanded = [arg for arg in expanded if not arg.startswith("--sandbox-outputs=")]
        script_path = Path(script)
        if script_path.is_absolute():
            script_path = script_path.relative_to(host)
        inputs.install(script_path)
        env_path = Path(__file__).with_name("sandbox-env")
        env_relative = env_path.relative_to(host) if env_path.is_absolute() else env_path
        inputs.install(env_relative)
        for view in manifest["views"]:
            relative = _relative(view)
            inputs.install(relative)
            inputs.views.add(relative)
        # Dependency search directories are not metadata files; reconstruct them
        # solely from declared snapshots, including Buck's symlinked views.
        for arg in expanded:
            for candidate in re.findall(r"buck-out/[^\s,=\"']+", arg):
                relative = _relative(candidate.rstrip(";:"))
                if relative not in outputs and (host / relative).exists():
                    inputs.install(relative)
        for output in outputs:
            if any(output == path or output in path.parents or path in output.parents for path in inputs.files | inputs.views):
                raise BoundaryError("output overlaps declared input: " + str(output))
            (stage / output).parent.mkdir(parents=True, exist_ok=True)
        parents = []
        for parent in sorted({path.parent for path in outputs}, key=lambda path: (len(path.parts), str(path))):
            if not any(outer == parent or outer in parent.parents for outer in parents):
                parents.append(parent)
        writable = scratch / "outputs"
        writable.mkdir()
        command = [runtime["bwrap"], "--unshare-all", "--die-with-parent", "--new-session", "--hostname", "rust-sandbox", "--clearenv", "--cap-drop", "ALL", "--tmpfs", "/", "--ro-bind", str(stage), VROOT, "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/home/build", "--dir", "/nix/store"]
        for root in runtime["storePaths"]:
            command.extend(["--ro-bind", root, root])
        for parent in parents:
            if any(view == parent or view in parent.parents for view in inputs.views):
                raise BoundaryError("output parent overlaps immutable view: " + str(parent))
            destination = writable / parent
            shutil.copytree(stage / parent, destination, dirs_exist_ok=True)
            command.extend(["--bind", str(destination), VROOT + "/" + str(parent)])
            for view in sorted(inputs.views):
                if parent in view.parents or parent == Path("."):
                    command.extend(["--ro-bind", str(stage / view), VROOT + "/" + str(view)])
            for path in sorted(inputs.files):
                if (parent in path.parents or parent == Path(".")) and not any(view in path.parents or view == path for view in inputs.views):
                    command.extend(["--ro-bind", str(stage / path), VROOT + "/" + str(path)])
        shell = runtime["shell"]
        command.extend(["--dir", "/bin", "--symlink", shell, "/bin/sh", "--dir", "/usr", "--dir", "/usr/bin", "--symlink", VROOT + "/" + str(env_relative), "/usr/bin/env", "--chdir", VROOT])
        environment = {"LC_ALL": "C", "TZ": "UTC", "HOME": "/home/build", "PWD": VROOT, "PATH": str(Path(shell).parent) + ":" + str(Path(runtime["env"]).parent), "TMPDIR": "/tmp", "BUCK_SCRATCH_PATH": "/tmp", "RUST_SANDBOX_INNER": "1"}
        for key, value in environment.items():
            command.extend(["--setenv", key, value])
        command.extend([python, str(script_path), *expanded])
        result = subprocess.run(command, check=False)
        if result.returncode == 0:
            _publish(host, writable, outputs, scratch)
        return result.returncode
