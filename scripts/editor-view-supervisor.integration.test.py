import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import selectors
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

def load_supervisor():
    spec = importlib.util.spec_from_file_location(
        "editor_view_supervisor", Path(__file__).with_name("editor-view-supervisor.py")
    )
    supervisor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervisor)
    return supervisor



def owned_authority(lock, body):
    # Execute in the authority itself: no wrapper or child receives this flock.
    # Keep the CLOEXEC descriptor alive until the authority's work has finished.
    return f'''
import fcntl, json, os, sys, time
owner_fd = os.open({str(lock)!r}, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
fcntl.flock(owner_fd, fcntl.LOCK_EX)
metadata = json.dumps({{"pid": os.getpid(), "command": sys.executable,
                       "started": time.monotonic()}}).encode()
os.ftruncate(owner_fd, 0)
os.write(owner_fd, metadata)
ready_fd = int(os.environ.pop("EDITOR_VIEW_ADMISSION_READY_FD"))
os.write(ready_fd, b"1")
os.close(ready_fd)
''' + body



def notification_command(lock, deadline, fixture):
    # Exercise the consumer before (and independently of) the CLI producer handoff.
    supervisor = str(Path(__file__).with_name("editor-view-supervisor.py"))
    driver = f'''
import os, runpy, sys
supervisor = runpy.run_path({supervisor!r})
read_fd, write_fd = os.pipe()
os.set_blocking(read_fd, False)
try:
    result = supervisor["supervise"](
        sys.argv[1:], {deadline!r}, 0.1, pass_fds=(write_fd,),
        waiting_lock=({str(lock)!r}, read_fd), admission_write_fd=write_fd)
finally:
    os.close(read_fd)
sys.exit(result)
'''
    return [sys.executable, "-c", driver, sys.executable, "-c", fixture]


class AdmissionNotificationTest(unittest.TestCase):
    def test_missing_or_malformed_admission_fails_closed_even_without_deadline(self):
        for notification, exits_cleanly in (
            (b"", False), (b"2", False), (b"\xff", False),
            (b"", True), (b"2", True), (b"\xff", True),
        ):
            with self.subTest(notification=notification, exits_cleanly=exits_cleanly), tempfile.TemporaryDirectory() as scratch:
                fixture = f'''
import os, time
fd = int(os.environ.pop("EDITOR_VIEW_ADMISSION_READY_FD"))
os.write(fd, {notification!r})
os.close(fd)
{"pass" if exits_cleanly else "time.sleep(60)"}
'''
                result = subprocess.run(
                    notification_command(Path(scratch) / "publication.lock", None, fixture),
                    capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("failed to notify owner admission", result.stderr)
                self.assertNotIn("publication admitted on lock", result.stderr)
                self.assertFalse((Path(scratch) / "publication.lock").exists())

    def test_explicit_no_publication_does_not_start_execution_deadline(self):
        with tempfile.TemporaryDirectory() as scratch:
            lock = Path(scratch) / "publication.lock"
            fixture = '''
import os, time
fd = int(os.environ.pop("EDITOR_VIEW_ADMISSION_READY_FD"))
os.write(fd, b"0")
os.close(fd)
time.sleep(0.1)
'''
            result = subprocess.run(
                notification_command(lock, 0.001, fixture),
                capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("publication admitted on lock", result.stderr)
            self.assertNotIn("execution deadline", result.stderr)
            self.assertFalse(lock.exists())

    def test_authority_keeps_owner_private_across_exec_and_child_join(self):
        with tempfile.TemporaryDirectory() as scratch:
            lock = Path(scratch) / "publication.lock"
            child = r'''
import errno, fcntl, os, sys
assert "EDITOR_VIEW_ADMISSION_READY_FD" not in os.environ
try:
    os.fstat(int(sys.argv[2]))
except OSError as error:
    assert error.errno == errno.EBADF
else:
    raise AssertionError("owner descriptor crossed exec")
with open(sys.argv[1], "r+b") as probe:
    try:
        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pass
    else:
        raise AssertionError("authority owner was released before child joined")
'''
            fixture = owned_authority(lock, f'''
import subprocess
subprocess.run([sys.executable, "-c", {child!r}, {str(lock)!r}, str(owner_fd)],
               check=True, close_fds=False)
probe = os.open({str(lock)!r}, os.O_RDWR | os.O_CLOEXEC)
try:
    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    pass
else:
    raise AssertionError("owner was released before child cleanup")
finally:
    os.close(probe)
''')
            result = subprocess.run(
                notification_command(lock, None, fixture),
                capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("admitted on lock", result.stderr)
            with lock.open("r+b") as probe:
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)


class PublicationSupervisorTest(unittest.TestCase):
    def test_admission_wait_dump_is_once_bounded_and_preserves_admission(self):
        supervisor = load_supervisor()
        script = str(Path(__file__).with_name("editor-view-supervisor.py"))

        def until(stream, marker):
            received = b""
            deadline = time.monotonic() + 10
            with selectors.DefaultSelector() as selector:
                selector.register(stream, selectors.EVENT_READ)
                while marker not in received:
                    self.assertTrue(selector.select(max(0, deadline - time.monotonic())), received.decode())
                    chunk = os.read(stream.fileno(), 8192)
                    self.assertTrue(chunk, received.decode())
                    received += chunk
            return received

        garbage_cases = (b'{"pid":', b"\xff\x00" + str(Path.home()).encode(), b"x" * 16384 + str(Path.home()).encode())
        for mode, garbage in (("--lock", g) for g in garbage_cases):
            with self.subTest(mode=mode, bytes=len(garbage)), tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                lock = root / "publication.lock"
                lock.write_bytes(garbage)
                release = root / "release"
                os.mkfifo(release)
                leases = root / ".editor-view" / ".leases"
                leases.mkdir(parents=True)
                (leases / "generation.lock").touch()
                fixture = r'''
import sys
print("admitted", flush=True)
if sys.argv[1] == "holder":
    with open(sys.argv[2], "rb", buffering=0) as release: assert release.read(1) == b"1"
'''
                env = {**os.environ, "DEVENV_ROOT": scratch,
                       "EDITOR_VIEW_ADMISSION_DIAGNOSTIC_SECONDS": "0",
                       "BUCK_ISOLATION_DIR": str(root / "private-isolation")}
                env.pop("BUCK2_NATIVE_BIN", None)
                # A crashed owner's metadata must never be required or echoed.
                with lock.open("r+b") as corrupt_holder:
                    fcntl.flock(corrupt_holder, fcntl.LOCK_EX)
                    corrupt_dump = subprocess.run(
                        [sys.executable, script, "--admission-dump", str(lock)],
                        env=env, capture_output=True, timeout=10,
                    )
                self.assertEqual(corrupt_dump.returncode, 0)
                self.assertIn(b"holder=unparseable\n", corrupt_dump.stderr)
                self.assertNotIn(b"/", corrupt_dump.stderr)
                self.assertLessEqual(len(corrupt_dump.stderr), 8192)
                self.assertLessEqual(len(corrupt_dump.stderr.splitlines()), 40)
                # Acquisition must overwrite this same inode and admit normally.
                command = [sys.executable, script, "none", "0.1", mode, str(lock), sys.executable, "-c", fixture]
                release_fd = os.open(release, os.O_RDWR)
                holder = waiter = None
                try:
                    holder = subprocess.Popen([*command, "holder", str(release)], env=env,
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                              start_new_session=True)
                    until(holder.stdout, b"admitted\n")
                    waiter = subprocess.Popen([*command, "waiter"], env=env,
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                              start_new_session=True)
                    captured = until(waiter.stderr, b"[editor-view-admission-wait] end\n")
                    begin = captured.index(b"[editor-view-admission-wait] begin\n")
                    dump = captured[begin:]
                    self.assertIn(f"recorded-pid={holder.pid}".encode(), dump)
                    self.assertIn(f"command={Path(sys.executable).name}".encode(), dump)
                    self.assertIn(b"held-seconds=", dump)
                    self.assertIn(b"buck isolation=private-isolation status=unavailable", dump)
                    self.assertIn(b"leases root=root controls=1", dump)
                    self.assertNotIn(b"/", dump)
                    self.assertNotIn(str(Path.home()).encode(), dump)
                    self.assertLessEqual(len(dump), 8192)
                    self.assertLessEqual(len(dump.splitlines()), 40)
                    os.write(release_fd, b"1")
                    _, holder_stderr = holder.communicate(timeout=10)
                    stdout, stderr = waiter.communicate(timeout=10)
                    self.assertEqual(holder.returncode, 0, holder_stderr.decode())
                    self.assertEqual(waiter.returncode, 0, stderr.decode())
                    self.assertEqual(stdout, b"admitted\n")
                    self.assertEqual((captured + stderr).count(
                        b"[editor-view-admission-wait] begin"), 1)
                    self.assertIn(b"publication admitted on lock", stderr)
                finally:
                    try:
                        for process in (holder, waiter):
                            if process is not None:
                                if process.poll() is None:
                                    supervisor.signal_group(process.pid, signal.SIGTERM)
                                process.communicate(timeout=10)
                    finally:
                        os.close(release_fd)

    def test_collector_backpressure_parent_death_and_own_timeout(self):
        supervisor = load_supervisor()
        script = str(Path(__file__).with_name("editor-view-supervisor.py"))
        for action in ("close", "death", "alarm"):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as scratch:
                read_fd, write_fd = os.pipe()
                os.set_blocking(write_fd, False)
                try:
                    while True:
                        os.write(write_fd, b"x")
                except BlockingIOError:
                    pass
                os.set_blocking(write_fd, True)
                collector = (f'import os,runpy; s=runpy.run_path({script!r}); '
                             's["guard_collector"](int(__import__("sys").argv[1])); '
                             'print("ready",flush=True); os.write(2,b"x")')
                driver = f'''
import os,runpy,subprocess,sys
s=runpy.run_path({script!r})
if {action!r} == "close":
    d=s["AdmissionDiagnostic"](); d.threshold=0
    d.observe("missing",0); print("ready",flush=True)
    sys.stdin.buffer.read(1); d.close(); print("closed",flush=True)
else:
    r,w=os.pipe()
    p=subprocess.Popen([sys.executable,"-c",{collector!r},str(r)],pass_fds=(r,),start_new_session=True)
    os.close(r); sys.stdin.buffer.read(1); p.wait()
'''
                parent = subprocess.Popen([sys.executable, "-c", driver], cwd=scratch,
                                          stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                          stderr=write_fd, start_new_session=True)
                os.close(write_fd)
                try:
                    with selectors.DefaultSelector() as selector:
                        selector.register(parent.stdout, selectors.EVENT_READ)
                        self.assertTrue(selector.select(10))
                        self.assertEqual(parent.stdout.readline(), b"ready\n")
                        if action == "death":
                            supervisor.signal_group(parent.pid, signal.SIGKILL)
                        elif action == "close":
                            parent.stdin.write(b"1"); parent.stdin.flush()
                            self.assertTrue(selector.select(5))  # Stderr is still full.
                            self.assertEqual(parent.stdout.readline(), b"closed\n")
                        else:
                            parent.stdin.write(b"1"); parent.stdin.flush()
                    parent.wait(timeout=5)
                    with selectors.DefaultSelector() as selector:
                        selector.register(read_fd, selectors.EVENT_READ)
                        while True:
                            self.assertTrue(selector.select(5))
                            if not os.read(read_fd, 8192):
                                break  # No collector can retain the capture after parent exit.
                finally:
                    if parent.poll() is None:
                        supervisor.signal_group(parent.pid, signal.SIGKILL)
                    parent.communicate(timeout=5)
                    os.close(read_fd)

    def test_bootstrap_buck_kill_evidence_is_bounded(self):
        repo = Path(__file__).resolve().parent.parent
        bun = os.environ.get("BUN_BIN") or shutil.which("bun")
        self.assertIsNotNone(bun, "Bun is required for the fake-Buck fixture")
        for termination, payload in (
            ("deadline", "lines"), ("SIGTERM", "lines"),
            ("SIGKILL", "bytes"), ("deadline", "bytes"), ("publication", "lines"),
            ("success", "lines"), ("publication-child", "lines"), ("publication-kill", "lines"),
            ("deadline", "utf8"), ("deadline", "paths"),
        ):
            with self.subTest(termination=termination, payload=payload), \
                 tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                ready = root / "ready"
                os.mkfifo(root / "release")
                publication = termination in ("publication", "publication-child", "publication-kill")
                if publication:
                    for tool in ("CP_BIN", "MV_BIN", "FINGERPRINT_BIN", "NIX_STORE_BIN"):
                        self.assertTrue(os.environ.get(tool), f"{tool} is required for real publication")
                        self.assertTrue(os.environ[tool].startswith("/nix/store/"), tool)

                    def add_to_store(path):
                        # Same real immutable-fixture boundary as capability publisher tests.
                        result = subprocess.run(
                            [os.environ["NIX_STORE_BIN"], "--add", str(path)],
                            capture_output=True, text=True, timeout=30,
                        )
                        self.assertEqual(result.returncode, 0, result.stderr)
                        store_path = result.stdout.strip()
                        self.assertTrue(store_path.startswith("/nix/store/"), result.stdout)
                        gcroot = root / "gcroots" / path.name
                        gcroot.parent.mkdir(exist_ok=True)
                        rooted = subprocess.run(
                            [os.environ["NIX_STORE_BIN"], "--add-root", str(gcroot),
                             "--indirect", "--realise", store_path],
                            capture_output=True, text=True, timeout=30,
                        )
                        self.assertEqual(rooted.returncode, 0, rooted.stderr)
                        self.assertEqual(rooted.stdout.strip(), store_path)
                        self.assertEqual(gcroot.resolve(strict=True), Path(store_path))
                        return store_path
                    package = root / "packages" / "app"
                    package.mkdir(parents=True)
                    (package / "package.json").write_text("{}\n")
                    inputs = root / "inputs"
                    inputs.mkdir()
                    (inputs / "install-descriptor.json").write_text('{"revision":1}\n')
                    immutable_inputs = add_to_store(inputs)
                    (root / "editor-inputs.json").write_text(json.dumps({
                        "schema": "effect-utils/editor-view-inputs/v1",
                        "editorInputs": immutable_inputs,
                        "packageTree": str(package),
                        "readRoots": [],
                    }))
                    (root / "workspace-authority.json").write_text(json.dumps({
                        "schema": "effect-utils/workspace-dependency-authority/v1",
                        "requiredPackages": ["packages/app"],
                        "ownedPackages": ["packages/app"],
                    }))
                    copy = root / "cp"
                    # Native tool launchers intentionally have cwd=/ and env={PATH:""}.
                    # Bake fixture controls into the actual immutable executable.
                    copy.write_text(f'''#!{sys.executable}
import os, pathlib, signal, subprocess, sys
subprocess.run([{os.environ["CP_BIN"]!r}, *sys.argv[1:]], check=True)
if {termination!r} == "publication-kill":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
pathlib.Path({str(root / 'copy-pid')!r}).write_text(str(os.getpid()))
pathlib.Path({str(ready)!r}).touch()
if {termination!r} == "publication-child":
    os.kill(os.getpid(), signal.SIGTERM)
with open({str(root / "release")!r}, "rb", buffering=0) as release:
    assert release.read(1) == b"1"
''')
                    copy.chmod(0o700)
                    immutable_copy = add_to_store(copy)
                fake = root / "buck2"
                fake.write_text(f"#!{sys.executable}\n" + r'''
import os, pathlib, signal, sys, time
event = sys.argv[sys.argv.index("--event-log") + 1]
pathlib.Path(event).touch()
if os.environ["PAYLOAD"] == "lines":
    for i in range(80):
        print(f"progress-{i:02d} {os.getcwd()}/input {os.path.expanduser('~')}/cache", file=sys.stderr)
elif os.environ["PAYLOAD"] == "utf8":
    os.write(2, b"\xe7")
    os.write(2, b"\x95\x8c" + ("界" * 11000).encode())
elif os.environ["PAYLOAD"] == "paths":
    sys.stderr.write("z" * 20000 + os.path.expanduser("~") + "/cache " +
                     os.environ["TMPDIR"] + "/blob /tmp/external " + "界" * 5400)
else:
    sys.stderr.write("x" * 32768)
sys.stderr.write("\nBUCK-BLOCKED\n")
sys.stderr.flush()
if os.environ["TERMINATION"] in ("publication", "publication-child", "publication-kill", "success"):
    print("//packages/app:editor_view_inputs editor-inputs.json", flush=True)
    sys.exit(0)
with open("release", "rb", buffering=0) as release:
    assert release.read(1) == b"1"
if os.environ["TERMINATION"] != "deadline":
    os.kill(os.getpid(), getattr(signal, os.environ["TERMINATION"]))
time.sleep(60)
''')
                fake.chmod(0o700)
                runner = root / "runner.ts"
                module = repo / "packages/@overeng/buck2-tools/src/buck-watch.ts"
                runner.write_text(f'''
import {{ existsSync, writeFileSync }} from 'node:fs'
import {{ reconcileBuckViews, runCommand }} from {json.dumps(str(module))}
let pending = ''
let released = false
const shutdown = new AbortController()
process.on('SIGTERM', () => shutdown.abort(new Error('SIGTERM')))
const publication = ['publication', 'publication-child', 'publication-kill'].includes(process.env.TERMINATION ?? '')
const packages = publication ? [{{
  packagePath: 'packages/app', sourceFiles: [], sourceRoots: [], workspaceDependencies: [],
  targets: {{ packageTree: '//packages/app:package_tree', typecheck: '//packages/app:typecheck' }},
  editor: {{ cell: 'fixture', viewName: 'app', target: '//packages/app:editor_inputs',
    inputsManifestTarget: '//packages/app:editor_view_inputs', consumerCache: '.devenv/vite-cache/app' }},
}}] : []
await reconcileBuckViews({{
  request: {{ packagePaths: publication ? ['packages/app'] : [], changedPaths: [], buildTargets: ['//:fake'] }},
  options: {{
    plan: {{ packages, globalPaths: [] }}, mode: 'publish', signal: shutdown.signal,
    repoRoot: process.cwd(), workspaceRoot: process.cwd(),
    buck2: './buck2',
    editorViewCommand: [process.execPath, {json.dumps(str(module.with_name('editor-view.ts')))}],
    workspaceAuthority: './workspace-authority.json',
    cp: {json.dumps(immutable_copy if publication else '')},
    mv: process.env.MV_BIN ?? '', fingerprintTool: process.env.FINGERPRINT_BIN ?? '',
    snapshotRetention: 3,
    batchPublication: process.env.TERMINATION !== 'success',
    diagnosticTaskName: 'buck2:editor:bootstrap',
    // Existing fake-Buck subprocess protocol fixture; not a native ABI proof.
    run: async (options) => {{
      return await runCommand({{ ...options, onStderr: (chunk) => {{
      options.onStderr?.(chunk)
      pending += chunk
      if (!released && pending.includes('BUCK-BLOCKED') && !publication) {{
        released = true
        if (['deadline', 'SIGTERM', 'SIGKILL'].includes(process.env.TERMINATION ?? '')) writeFileSync('release', '1')
        writeFileSync('ready', '')
      }}
    }} }}).then((result) => {{
      if (options.command === './buck2' && process.env.TERMINATION === 'success') {{
        if (result.stderr !== '') throw new Error('build stderr was captured twice')
        const event = options.args[options.args.indexOf('--event-log') + 1]
        if (!existsSync(event)) throw new Error('event log deleted before command resolved')
        writeFileSync('command-completed-with-event-log', '')
      }}
      return result
    }})
    }},
  }},
}}).catch((error) => {{ console.error(error.message); process.exitCode = 1 }})
''')
                # Inject elapsed time only after the ring has consumed the marker:
                # no startup-speed dependency, real supervisor TERM/KILL escalation.
                driver = f'''
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("supervisor", {str(repo / "scripts/editor-view-supervisor.py")!r})
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)
supervisor.time.monotonic = lambda: 2 if pathlib.Path("ready").exists() else 0
sys.exit(supervisor.supervise(sys.argv[1:], 1 if {termination!r} in ("deadline", "publication", "publication-kill") else None, 0.2))
'''
                with subprocess.Popen(
                    [sys.executable, "-c", driver, bun, str(runner)],
                    cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                    env={**os.environ, "CI": "1", "PAYLOAD": payload,
                         "HOME": str(Path.home()) + "/private-" + "a" * 180,
                         "TMPDIR": str(Path.home()) + "/private-" + "a" * 180 + "/temp-zone",
                         "TERMINATION": termination, "TRACEPARENT": "",
                         "OTEL_TASK_TRACEPARENT": ""},
                ) as process:
                    try:
                        stdout, stderr = process.communicate(timeout=10)
                    finally:
                        if process.poll() is None:
                            # Keep GC roots until the supervisor joins its real group.
                            process.terminate()
                            process.communicate()
                    result = subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
                output = result.stderr
                if termination == "success":
                    self.assertEqual(result.returncode, 0, output)
                    self.assertEqual(output, "")
                    self.assertTrue((root / "command-completed-with-event-log").exists())
                    self.assertEqual(list(root.glob(".devenv/otel/buck2-events/*.pb.zst")), [])
                    continue
                self.assertEqual(result.returncode, 124 if termination in ("deadline", "publication", "publication-kill") else 1, output)
                self.assertTrue(ready.exists(), output)
                if termination == "publication-kill":
                    # Forced group KILL cannot flush Bun's in-process diagnostic ring.
                    with self.assertRaises(ProcessLookupError):
                        os.kill(int((root / "copy-pid").read_text()), 0)
                    self.assertEqual(len(list(root.glob(".devenv/otel/buck2-events/*.pb.zst"))), 1)
                    continue
                self.assertIn("BUCK-BLOCKED\n", output)
                code = 0 if termination.startswith("publication") else 137 if termination == "SIGKILL" else 143
                outcome = (r"interrupted by SIGTERM after Buck completed \(code 0\)"
                           if termination.startswith("publication") else f"Buck exited with code {code}")
                self.assertRegex(output, rf"buck2:editor:bootstrap: {outcome}; event log: \.devenv/otel/buck2-events/editor-view-[\w-]+\.pb\.zst")
                self.assertNotIn(str(root), output)
                self.assertNotIn(str(Path.home()), output)
                self.assertLess(len(output.encode()), 17 * 1024)
                self.assertNotIn("\ufffd", output)
                if payload == "paths":
                    self.assertIn("<home>/cache <tmp>/blob <tmp>/external", output)
                    self.assertNotIn("private-", output)
                    self.assertNotIn("a" * 20, output)
                if payload == "lines":
                    self.assertNotIn("progress-00", output)
                    self.assertIn("progress-79 input <home>/cache", output)
                    self.assertLessEqual(output.count("progress-"), 39)
                self.assertEqual(len(list(root.glob(".devenv/otel/buck2-events/*.pb.zst"))), 1)

    def test_descriptor_boundary_drops_mappings_but_parent_lease_remains_held(self):
        with tempfile.TemporaryDirectory() as scratch:
            control = Path(scratch) / "reader.lock"
            supervisor = str(Path(__file__).with_name("editor-view-supervisor.py"))
            fixture = r'''
import errno, fcntl, os, sys
assert "EDITOR_VIEW_LEASE_FDS" not in os.environ
assert "EDITOR_VIEW_LEASE_ACTIVE" not in os.environ
with open(sys.argv[1], "a") as probe:
    try:
        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pass
    else:
        raise AssertionError("parent lease was released")
try:
    inherited = os.fstat(int(sys.argv[2]))
except OSError as error:
    assert error.errno == errno.EBADF
else:
    assert inherited.st_ino != int(sys.argv[3]), "closed lease was passed through"
print("fresh-discovery-required")
'''
            with control.open("a") as holder:
                fcntl.flock(holder, fcntl.LOCK_SH)
                env = {
                    **os.environ,
                    "EDITOR_VIEW_LEASE_FDS": str(holder.fileno()),
                    "EDITOR_VIEW_LEASE_ACTIVE": "1",
                }
                for admission in ([], ["--lock", str(Path(scratch) / "publication.lock")]):
                    result = subprocess.run(
                        [sys.executable, supervisor, "5", "0.1", *admission,
                         sys.executable, "-c", fixture, str(control),
                         str(holder.fileno()), str(os.fstat(holder.fileno()).st_ino)],
                        env=env, pass_fds=(holder.fileno(),),
                        capture_output=True, text=True, timeout=10,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip(), "fresh-discovery-required")
            with control.open("a") as released:
                fcntl.flock(released, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_serializes_scoped_publishers_and_releases_after_exit(self):
        with tempfile.TemporaryDirectory() as scratch:
            lock = Path(scratch) / "publication.lock"
            state = Path(scratch) / ".publish.lock"
            supervisor = str(Path(__file__).with_name("editor-view-supervisor.py"))
            fixture = (
                "import os,pathlib,sys; p=pathlib.Path(sys.argv[1]); p.mkdir(); "
                "print('publishing',flush=True); sys.stdin.buffer.read(1); p.rmdir()"
            )
            command = [sys.executable, supervisor, "none", "0.1", "--lock", str(lock),
                       sys.executable, "-c", fixture, str(state)]
            first = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
            second = None
            try:
                self.assertEqual(first.stdout.readline().strip(), "publishing")
                second = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, text=True)
                # The second real mkdir publisher must remain queued, not fail
                # EEXIST or enter publication while the first owns the state root.
                with selectors.DefaultSelector() as selector:
                    selector.register(second.stdout, selectors.EVENT_READ)
                    self.assertEqual(selector.select(timeout=0.2), [])
                _, stderr = first.communicate("x", timeout=5)
                self.assertEqual(first.returncode, 0, stderr)
                stdout, stderr = second.communicate("x", timeout=5)
                self.assertEqual(second.returncode, 0, stderr)
                self.assertEqual(stdout.strip(), "publishing")
                self.assertFalse(state.exists())
                self.assertTrue(lock.exists())  # Never unlink the flock inode.
            finally:
                for process in (first, second):
                    if process is not None:
                        if process.poll() is None:
                            process.kill()
                        process.communicate(timeout=10)

    def test_long_admission_wait_does_not_consume_execution_deadline(self):
        with tempfile.TemporaryDirectory() as scratch:
            lock_path = Path(scratch) / "publication.lock"
            entered = Path(scratch) / "entered"
            command = [sys.executable, str(Path(__file__).with_name("editor-view-supervisor.py")),
                       "0.3", "0.1", "--lock", str(lock_path), sys.executable, "-c",
                       "import pathlib,sys; pathlib.Path(sys.argv[1]).touch()", str(entered)]
            with lock_path.open("a") as holder:
                fcntl.flock(holder, fcntl.LOCK_EX)
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    with self.assertRaises(subprocess.TimeoutExpired):
                        process.communicate(timeout=0.6)
                    self.assertFalse(entered.exists())
                finally:
                    fcntl.flock(holder, fcntl.LOCK_UN)
                    _, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertTrue(entered.exists())
            self.assertRegex(stderr, r"admitted on lock .* after waiting \d+\.\d{3}s")
            self.assertIn(str(lock_path), stderr)

    def test_queued_publisher_has_a_separate_finite_execution_deadline(self):
        with tempfile.TemporaryDirectory() as scratch:
            lock_path = Path(scratch) / "publication.lock"
            entered = Path(scratch) / "entered"
            env = {**os.environ, "DEVENV_ROOT": scratch,
                   "EDITOR_VIEW_ADMISSION_DIAGNOSTIC_SECONDS": "0",
                   "BUCK_ISOLATION_DIR": str(Path(scratch) / "private-isolation")}
            env.pop("BUCK2_NATIVE_BIN", None)
            with lock_path.open("a") as holder:
                fcntl.flock(holder, fcntl.LOCK_EX)
                process = subprocess.Popen(
                    [sys.executable, str(Path(__file__).with_name("editor-view-supervisor.py")),
                     "1", "0.1", "--lock", str(lock_path), sys.executable, "-c",
                     "import pathlib,sys,time; pathlib.Path(sys.argv[1]).touch(); time.sleep(60)",
                     str(entered)],
                    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                try:
                    # Observe actual queued admission before waiting longer than
                    # the execution budget; process startup is not the clock.
                    captured = b""
                    with selectors.DefaultSelector() as selector:
                        selector.register(process.stderr, selectors.EVENT_READ)
                        while b"[editor-view-admission-wait] end\n" not in captured:
                            self.assertTrue(selector.select(timeout=10), captured.decode())
                            chunk = os.read(process.stderr.fileno(), 8192)
                            self.assertTrue(chunk, captured.decode())
                            captured += chunk
                    with self.assertRaises(subprocess.TimeoutExpired):
                        process.communicate(timeout=2)
                    self.assertFalse(entered.exists())
                    fcntl.flock(holder, fcntl.LOCK_UN)
                    _, stderr = process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 124, stderr)
                    self.assertTrue(entered.exists())
                    self.assertIn("admitted on lock", stderr)
                    self.assertIn("exceeded its 1s execution deadline", stderr)
                finally:
                    fcntl.flock(holder, fcntl.LOCK_UN)
                    if process.poll() is None:
                        process.terminate()
                    process.communicate(timeout=5)

    def test_signal_cancels_queued_admission_and_names_lock(self):
        with tempfile.TemporaryDirectory() as scratch:
            lock_path = Path(scratch) / "publication.lock"
            with lock_path.open("a") as holder:
                fcntl.flock(holder, fcntl.LOCK_EX)
                process = subprocess.Popen(
                    [sys.executable, str(Path(__file__).with_name("editor-view-supervisor.py")),
                     "0.1", "0.1", "--lock", str(lock_path), sys.executable, "-c", "raise SystemExit(0)"],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                try:
                    with self.assertRaises(subprocess.TimeoutExpired):
                        process.communicate(timeout=0.3)
                    process.terminate()
                    _, stderr = process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 143, stderr)
                    self.assertIn("waiting for another publication", stderr)
                    self.assertIn(str(lock_path), stderr)
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=5)

    def test_admitted_work_still_has_execution_deadline(self):
        with tempfile.TemporaryDirectory() as scratch:
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("editor-view-supervisor.py")),
                 "0.2", "0.1", "--lock", str(Path(scratch) / "publication.lock"),
                 sys.executable, "-c", "import time; time.sleep(60)"],
                capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 124, result.stderr)
            self.assertIn("admitted on lock", result.stderr)
            self.assertIn("exceeded its 0.2s", result.stderr)

    def test_crashed_publisher_does_not_leave_admission_locked(self):
        with tempfile.TemporaryDirectory() as scratch:
            lock_path = Path(scratch) / "publication.lock"
            supervisor = str(Path(__file__).with_name("editor-view-supervisor.py"))
            for code in (7, 0):
                result = subprocess.run(
                    [sys.executable, supervisor, "2", "0.1", "--lock", str(lock_path),
                     sys.executable, "-c", f"import os; os._exit({code})"],
                    capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertIn("admitted on lock", result.stderr)

    def test_signal_during_wait_overrides_direct_child_success(self):
        supervisor = load_supervisor()
        child = mock.Mock(pid=9999999)
        first_wait = True
        def finish_after_signal(**_kwargs):
            nonlocal first_wait
            if first_wait:
                first_wait = False
                signal.raise_signal(signal.SIGTERM)
            return 0
        child.wait.side_effect = finish_after_signal
        handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)}
        try:
            with mock.patch.object(supervisor.subprocess, "Popen", return_value=child), \
                 mock.patch.object(supervisor.os, "killpg", side_effect=ProcessLookupError) as kill, \
                 mock.patch.object(supervisor.os, "waitpid", side_effect=ChildProcessError), \
                 mock.patch.object(supervisor.time, "sleep"):
                self.assertEqual(supervisor.supervise(["fixture"], None, 0.1), 143)
                self.assertEqual(kill.call_args_list, [
                    mock.call(child.pid, signal.SIGTERM),
                    mock.call(child.pid, signal.SIGKILL),
                    mock.call(child.pid, 0),
                ])
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)

    def test_darwin_eperm_for_exited_group_still_reaps_child(self):
        supervisor = load_supervisor()
        child = mock.Mock(pid=9999999)
        with mock.patch.object(supervisor.sys, "platform", "darwin"), \
             mock.patch.object(supervisor.subprocess, "Popen", return_value=child), \
             mock.patch.object(supervisor.signal, "signal"), \
             mock.patch.object(supervisor.os, "killpg", side_effect=[None, PermissionError, PermissionError]), \
             mock.patch.object(supervisor.subprocess, "check_output", return_value="9999999 Z\n"), \
             mock.patch.object(supervisor.os, "waitpid", side_effect=ChildProcessError), \
             mock.patch.object(supervisor.time, "sleep"):
            self.assertEqual(supervisor.supervise(["fixture"], 0, 0.1), 124)
            child.wait.assert_called_once_with()

    def test_permission_failure_is_ignored_only_without_live_darwin_members(self):
        supervisor = load_supervisor()
        with mock.patch.object(supervisor.os, "killpg", side_effect=PermissionError), \
             mock.patch.object(supervisor.subprocess, "check_output") as census:
            with mock.patch.object(supervisor.sys, "platform", "darwin"):
                for output in ("", "123 Z\n123 Z+\n", "456 S\n123 Z\n"):
                    census.return_value = output
                    self.assertFalse(supervisor.signal_group(123, signal.SIGKILL))
                census.return_value = "123 Z\n123 S\n"
                with self.assertRaises(PermissionError):
                    supervisor.signal_group(123, signal.SIGKILL)
                census.side_effect = subprocess.CalledProcessError(1, "ps")
                with self.assertRaises(subprocess.CalledProcessError):
                    supervisor.signal_group(123, signal.SIGKILL)
            with mock.patch.object(supervisor.sys, "platform", "linux"):
                with self.assertRaises(PermissionError):
                    supervisor.signal_group(123, signal.SIGKILL)

    def test_kills_term_resistant_child_and_late_grandchild(self):
        with tempfile.TemporaryDirectory() as scratch:
            pids = Path(scratch) / "pids"
            # The authority exits on TERM; its child ignores TERM and creates a
            # grandchild after the group's initial TERM. Both require escalation.
            fixture = r'''
import os, signal, subprocess, sys, time
child = r"""
import os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open(sys.argv[1], 'a') as f: f.write(str(os.getpid()) + '\n'); f.flush()
time.sleep(0.35)
p = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'])
with open(sys.argv[1], 'a') as f: f.write(str(p.pid) + '\n'); f.flush()
time.sleep(60)
"""
subprocess.Popen([sys.executable, '-c', child, sys.argv[1]])
time.sleep(60)
'''
            start = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("editor-view-supervisor.py")),
                 "0.25", "0.5", sys.executable, "-c", fixture, str(pids)],
                capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 124, result.stderr)
            self.assertIn("publication failed", result.stderr)
            self.assertLess(time.monotonic() - start, 3)
            descendants = pids.read_text().splitlines()
            self.assertEqual(len(descendants), 2)
            for pid in descendants:
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(pid), 0)

    def test_preserves_success_and_failure(self):
        for deadline in ("2", "none"):
            for code in (0, 7):
                result = subprocess.run([sys.executable, str(Path(__file__).with_name("editor-view-supervisor.py")),
                                         deadline, "0.1", sys.executable, "-c", f"raise SystemExit({code})"], timeout=5)
                self.assertEqual(result.returncode, code)


if __name__ == "__main__":
    unittest.main()
