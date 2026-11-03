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
                    self.assertTrue(selector.select(max(0, deadline - time.monotonic())),
                                    received.decode())
                    chunk = os.read(stream.fileno(), 8192)
                    self.assertTrue(chunk, received.decode())
                    received += chunk
            return received

        for mode in ("--lock", "--deferred-lock"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                lock = root / "publication.lock"
                release = root / "release"
                os.mkfifo(release)
                leases = root / ".editor-view" / ".leases"
                leases.mkdir(parents=True)
                (leases / "generation.lock").touch()
                fixture = r'''
import os, socket, sys
endpoint = os.environ.get("EDITOR_VIEW_PUBLICATION_ADMISSION_SOCKET")
if endpoint:
    admission = socket.socket(socket.AF_UNIX)
    admission.connect(endpoint)
    assert admission.recv(1) == b"1"
print("admitted", flush=True)
if sys.argv[1] == "holder":
    with open(sys.argv[2], "rb", buffering=0) as release:
        assert release.read(1) == b"1"
'''
                env = {**os.environ, "DEVENV_ROOT": scratch,
                       "EDITOR_VIEW_ADMISSION_DIAGNOSTIC_SECONDS": "0",
                       "BUCK_ISOLATION_DIR": str(root / "private-isolation")}
                env.pop("BUCK2_NATIVE_BIN", None)
                command = [sys.executable, script, "5", "0.1", mode, str(lock),
                           sys.executable, "-c", fixture]
                holder = subprocess.Popen([*command, "holder", str(release)], env=env,
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                          start_new_session=True)
                waiter = None
                try:
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
                    with release.open("wb", buffering=0) as fifo:
                        fifo.write(b"1")
                    _, holder_stderr = holder.communicate(timeout=10)
                    stdout, stderr = waiter.communicate(timeout=10)
                    self.assertEqual(holder.returncode, 0, holder_stderr.decode())
                    self.assertEqual(waiter.returncode, 0, stderr.decode())
                    self.assertEqual(stdout, b"admitted\n")
                    self.assertEqual((captured + stderr).count(
                        b"[editor-view-admission-wait] begin"), 1)
                    self.assertIn(b"publication admitted on lock", stderr)
                finally:
                    for process in (holder, waiter):
                        if process is not None:
                            if process.poll() is None:
                                supervisor.signal_group(process.pid, signal.SIGTERM)
                            process.communicate(timeout=10)

    def test_bootstrap_buck_kill_evidence_is_bounded(self):
        repo = Path(__file__).resolve().parent.parent
        bun = os.environ.get("BUN_BIN") or shutil.which("bun")
        self.assertIsNotNone(bun, "Bun is required for the fake-Buck fixture")
        for termination, payload in (
            ("deadline", "lines"), ("SIGTERM", "lines"),
            ("SIGKILL", "bytes"), ("deadline", "bytes"), ("publication", "lines"),
            ("success", "lines"), ("publication-child", "lines"),
            ("deadline", "utf8"), ("deadline", "paths"),
        ):
            with self.subTest(termination=termination, payload=payload), \
                 tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                ready = root / "ready"
                os.mkfifo(root / "release")
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
if os.environ["TERMINATION"] in ("publication", "publication-child", "success"):
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
await reconcileBuckViews({{
  request: {{ packagePaths: [], changedPaths: [], buildTargets: ['//:fake'] }},
  options: {{
    plan: {{ packages: [], globalPaths: [] }}, mode: 'publish',
    repoRoot: process.cwd(), workspaceRoot: process.cwd(),
    buck2: './buck2', editorViewCommand: [process.execPath, '-e',
      process.env.TERMINATION === 'publication-child' ? 'process.kill(process.pid, "SIGTERM")' :
        'require("node:fs").readFileSync(0); require("node:fs").writeFileSync("ready", ""); setInterval(() => {{}}, 1000)'], workspaceAuthority: '',
    cp: '', mv: '', fingerprintTool: '', snapshotRetention: 3,
    batchPublication: process.env.TERMINATION !== 'success',
    diagnosticTaskName: 'buck2:editor:bootstrap',
    run: (options) => runCommand({{ ...options, onStderr: (chunk) => {{
      options.onStderr?.(chunk)
      pending += chunk
      if (!released && pending.includes('BUCK-BLOCKED') && process.env.TERMINATION !== 'publication') {{
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
    }}),
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
sys.exit(supervisor.supervise(sys.argv[1:], 1 if {termination!r} in ("deadline", "publication") else None, 0.2))
'''
                result = subprocess.run(
                    [sys.executable, "-c", driver, bun, str(runner)],
                    cwd=root, capture_output=True, text=True, timeout=10,
                    env={**os.environ, "CI": "1", "PAYLOAD": payload,
                         "HOME": str(Path.home()) + "/private-" + "a" * 180,
                         "TMPDIR": str(Path.home()) + "/private-" + "a" * 180 + "/temp-zone",
                         "TERMINATION": termination, "TRACEPARENT": "",
                         "OTEL_TASK_TRACEPARENT": ""},
                )
                output = result.stderr
                if termination == "success":
                    self.assertEqual(result.returncode, 0, output)
                    self.assertEqual(output, "")
                    self.assertTrue((root / "command-completed-with-event-log").exists())
                    self.assertEqual(list(root.glob(".devenv/otel/buck2-events/*.pb.zst")), [])
                    continue
                self.assertEqual(result.returncode, 124 if termination in ("deadline", "publication") else 1, output)
                self.assertTrue(ready.exists(), output)
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
                for admission in ([], ["--lock", str(Path(scratch) / "publication.lock")],
                                  ["--deferred-lock", str(Path(scratch) / "publication.lock")]):
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

    def test_deferred_preparation_overlaps_but_publication_stays_serial(self):
        with tempfile.TemporaryDirectory() as scratch:
            lock, state = Path(scratch) / "publication.lock", Path(scratch) / ".publish.lock"
            fixture = r'''
import os, pathlib, socket, sys
print("prepared", flush=True)
with socket.socket(socket.AF_UNIX) as admission:
    admission.connect(os.environ["EDITOR_VIEW_PUBLICATION_ADMISSION_SOCKET"])
    assert admission.recv(1) == b"1"
state = pathlib.Path(sys.argv[1])
state.mkdir()
print("publishing", flush=True)
sys.stdin.buffer.read(1)
state.rmdir()
'''
            command = [sys.executable, str(Path(__file__).with_name("editor-view-supervisor.py"))]
            tail = ["0.1", "--deferred-lock", str(lock), sys.executable, "-c", fixture, str(state)]
            first = subprocess.Popen([*command, "none", *tail], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            second = None
            try:
                self.assertEqual(first.stdout.readline().strip(), "prepared")
                self.assertEqual(first.stdout.readline().strip(), "publishing")
                inode = lock.stat().st_ino
                second = subprocess.Popen([*command, "0.3", *tail], stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                self.assertEqual(second.stdout.readline().strip(), "prepared")
                with self.assertRaises(subprocess.TimeoutExpired):
                    second.communicate(timeout=0.6)
                _, stderr = first.communicate("x", timeout=5)
                self.assertEqual(first.returncode, 0, stderr)
                stdout, stderr = second.communicate(timeout=5)
                self.assertEqual(second.returncode, 0, stderr)
                self.assertEqual(stdout.strip(), "publishing")
                self.assertEqual(lock.stat().st_ino, inode)
                self.assertFalse(state.exists())
            finally:
                for process in (first, second):
                    if process is not None:
                        if process.poll() is None:
                            process.terminate()
                        process.communicate(timeout=5)

    def test_buck_exits_before_deferred_admission(self):
        self.check_daemon_admission_order(synthetic_cycle=False)

    def test_synthetic_daemon_admission_cycle_is_detected_and_reaped(self):
        self.check_daemon_admission_order(synthetic_cycle=True)

    def check_daemon_admission_order(self, *, synthetic_cycle):
        repo = Path(__file__).resolve().parent.parent
        bun = os.environ.get("BUN_BIN") or shutil.which("bun")
        self.assertIsNotNone(bun, "Bun is required for the fake-Buck fixture")
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            descriptors, processes = {}, []
            for name in ("events", "request-daemon", "finish-build", "finish-holder"):
                os.mkfifo(root / name)
                descriptors[name] = os.open(root / name, os.O_RDWR | os.O_NONBLOCK)
            common = r'''
import fcntl, os, pathlib, socket, sys
def emit(event):
    with open("events", "wb", buffering=0) as events:
        events.write((event + "\n").encode())
def gate(name):
    with open(name, "rb", buffering=0) as control:
        assert control.read(1) == b"1"
'''
            holder = common + r'''
with open("publication.lock", "a") as outer, open("daemon.lock", "a") as daemon:
    fcntl.flock(outer, fcntl.LOCK_EX)
    emit("outer-held")
    gate("request-daemon")
    try:
        fcntl.flock(daemon, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        emit("holder-daemon-blocked")
    else:
        raise AssertionError("preparer did not retain daemon")
    fcntl.flock(daemon, fcntl.LOCK_EX)
    emit("holder-daemon-complete")
    gate("finish-holder")
'''
            fake = root / "buck2"
            fake.write_text(f"#!{sys.executable}\n" + common + r'''
pathlib.Path(sys.argv[sys.argv.index("--event-log") + 1]).touch()
with open("daemon.lock", "a") as daemon:
    fcntl.flock(daemon, fcntl.LOCK_EX)
    emit("daemon-held")
    gate("finish-build")
    if os.environ["SYNTHETIC_CYCLE"] == "1":
        with socket.socket(socket.AF_UNIX) as admission:
            admission.connect(os.environ["EDITOR_VIEW_PUBLICATION_ADMISSION_SOCKET"])
            assert admission.recv(1) == b"1"
        raise AssertionError("synthetic cycle unexpectedly admitted")
    fcntl.flock(daemon, fcntl.LOCK_UN)
    emit("daemon-released")
''')
            fake.chmod(0o700)
            runner = root / "runner.ts"
            module = repo / "packages/@overeng/buck2-tools/src/buck-watch.ts"
            runner.write_text(f'''
import {{ writeFileSync }} from 'node:fs'
import {{ reconcileBuckViews, runCommand }} from {json.dumps(str(module))}
writeFileSync('preparer-pgid', String(process.pid))
await reconcileBuckViews({{
  request: {{ packagePaths: [], changedPaths: [], buildTargets: ['//:fake'] }},
  options: {{
    plan: {{ packages: [], globalPaths: [] }}, mode: 'publish',
    repoRoot: process.cwd(), workspaceRoot: process.cwd(),
    buck2: './buck2', editorViewCommand: [process.execPath, '-e', ''],
    workspaceAuthority: '', cp: '', mv: '', fingerprintTool: '', snapshotRetention: 3,
    run: async (options) => {{
      const result = await runCommand(options)
      if (options.command === './buck2') writeFileSync('events', 'build-child-closed\\n')
      return result
    }},
  }},
}})
''')
            # Observe the real failed flock attempt, not an elapsed-time proxy
            # for admission waiting. The wrapper never changes admission behavior.
            driver = common + f'''
import importlib.util
spec = importlib.util.spec_from_file_location("supervisor", {str(repo / "scripts/editor-view-supervisor.py")!r})
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)
original = supervisor.DeferredAdmission.observe
def observe(admission, expires):
    was_requested, was_admitted = admission.client is not None, admission.admitted
    result = original(admission, expires)
    if not was_requested and admission.client is not None:
        emit("admission-request")
    if not admission.admitted and admission.client is not None and not was_requested:
        emit("preparer-outer-blocked")
    if not was_admitted and admission.admitted:
        emit("admission-granted")
    return result
supervisor.DeferredAdmission.observe = observe
sys.exit(supervisor.supervise_deferred(sys.argv[1:], None, 0.1, "publication.lock"))
'''
            events, pending = [], b""
            def await_event(expected):
                nonlocal pending
                deadline = time.monotonic() + 10
                with selectors.DefaultSelector() as selector:
                    selector.register(descriptors["events"], selectors.EVENT_READ)
                    while expected not in events:
                        self.assertTrue(
                            selector.select(max(0, deadline - time.monotonic())),
                            f"missing {expected}; observed {events}",
                        )
                        pending += os.read(descriptors["events"], 65536)
                        while b"\n" in pending:
                            event, pending = pending.split(b"\n", 1)
                            events.append(event.decode())
            def release(name):
                os.write(descriptors[name], b"1")
            def assert_locked(name):
                with (root / name).open("a") as probe:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                held = subprocess.Popen(
                    [sys.executable, "-c", holder], cwd=root, start_new_session=True,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                processes.append(held)
                await_event("outer-held")
                prepared = subprocess.Popen(
                    [sys.executable, "-c", driver, bun, str(runner)], cwd=root,
                    env={**os.environ, "CI": "1", "SYNTHETIC_CYCLE": str(int(synthetic_cycle)),
                         "TRACEPARENT": "", "OTEL_TASK_TRACEPARENT": ""},
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                processes.append(prepared)
                await_event("daemon-held")
                release("request-daemon")
                await_event("holder-daemon-blocked")
                assert_locked("publication.lock")
                assert_locked("daemon.lock")
                release("finish-build")
                await_event("preparer-outer-blocked")
                if synthetic_cycle:
                    # Both real nonblocking attempts failed while each actor
                    # retained the resource needed by the other: H -> P -> H.
                    assert_locked("publication.lock")
                    assert_locked("daemon.lock")
                    self.assertNotIn("holder-daemon-complete", events)
                    self.assertNotIn("build-child-closed", events)
                    self.assertNotIn("admission-granted", events)
                    print("Detected synthetic cycle: H holds outer -> daemon(P) -> outer(H)")
                    prepared.terminate()  # Supervisor kills and reaps its child group.
                    _, stderr = prepared.communicate(timeout=10)
                    self.assertEqual(prepared.returncode, 143, stderr)
                    os.killpg(held.pid, signal.SIGTERM)
                    self.assertEqual(held.communicate(timeout=10), ("", ""))
                    self.assertEqual(held.returncode, -signal.SIGTERM)
                else:
                    await_event("holder-daemon-complete")
                    self.assertLess(events.index("daemon-released"), events.index("build-child-closed"))
                    self.assertLess(events.index("build-child-closed"), events.index("admission-request"))
                    release("finish-holder")
                    _, stderr = held.communicate(timeout=10)
                    self.assertEqual(held.returncode, 0, stderr)
                    await_event("admission-granted")
                    self.assertLess(events.index("holder-daemon-complete"), events.index("admission-granted"))
                    _, stderr = prepared.communicate(timeout=10)
                    self.assertEqual(prepared.returncode, 0, stderr)
                supervisor = load_supervisor()
                for pgid in (held.pid, int((root / "preparer-pgid").read_text())):
                    self.assertFalse(supervisor.signal_group(pgid, 0))
            finally:
                for process in processes:
                    if process.poll() is None:
                        if process is processes[0]:
                            os.killpg(process.pid, signal.SIGTERM)
                        else:
                            process.terminate()
                    process.communicate(timeout=10)
                for descriptor in descriptors.values():
                    os.close(descriptor)

    def test_deferred_preparation_and_admitted_work_share_execution_budget(self):
        request = (
            "import os,socket,time; "
            "s=socket.socket(socket.AF_UNIX); "
            "s.connect(os.environ['EDITOR_VIEW_PUBLICATION_ADMISSION_SOCKET']); "
            "assert s.recv(1)==b'1'; s.close(); "
        )
        with tempfile.TemporaryDirectory() as scratch:
            for code in ("import time; time.sleep(60)", request + "time.sleep(60)",
                         "import time; time.sleep(0.2); " + request + "time.sleep(0.2)"):
                with self.subTest(code=code):
                    result = subprocess.run(
                        [sys.executable, str(Path(__file__).with_name("editor-view-supervisor.py")),
                         "0.3", "0.1", "--deferred-lock", str(Path(scratch) / "publication.lock"),
                         sys.executable, "-c", code], capture_output=True, text=True, timeout=5,
                    )
                    self.assertEqual(result.returncode, 124, result.stderr)
                    self.assertIn("exceeded its 0.3s", result.stderr)

    def test_deferred_admission_rejects_replaced_flock_identity(self):
        with tempfile.TemporaryDirectory() as scratch:
            lock = Path(scratch) / "publication.lock"
            with lock.open("a") as holder:
                fcntl.flock(holder, fcntl.LOCK_EX)
                process = subprocess.Popen(
                    [sys.executable, str(Path(__file__).with_name("editor-view-supervisor.py")),
                     "1", "0.1", "--deferred-lock", str(lock), sys.executable, "-c",
                     "import os,socket; print('prepared',flush=True); "
                     "s=socket.socket(socket.AF_UNIX); "
                     "s.connect(os.environ['EDITOR_VIEW_PUBLICATION_ADMISSION_SOCKET']); "
                     "assert s.recv(1)==b'1'; print('committed',flush=True)"],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                try:
                    self.assertEqual(process.stdout.readline().strip(), "prepared")
                    with self.assertRaises(subprocess.TimeoutExpired):
                        process.communicate(timeout=0.2)
                    lock.unlink()
                    lock.touch()
                    fcntl.flock(holder, fcntl.LOCK_UN)
                    stdout, stderr = process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 143, stderr)
                    self.assertNotIn("committed", stdout)
                    self.assertIn("flock pathname identity changed", stderr)
                finally:
                    if process.poll() is None:
                        process.terminate()
                    process.communicate(timeout=5)

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
import socket
admission = socket.socket(socket.AF_UNIX)
admission.connect(os.environ["EDITOR_VIEW_PUBLICATION_ADMISSION_SOCKET"])
assert admission.recv(1) == b"1"
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
                 "0.25", "0.5", "--deferred-lock", str(Path(scratch) / "publication.lock"),
                 sys.executable, "-c", fixture, str(pids)],
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
            with (Path(scratch) / "publication.lock").open("a") as released:
                fcntl.flock(released, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_preserves_success_and_failure(self):
        for deadline in ("2", "none"):
            for code in (0, 7):
                result = subprocess.run([sys.executable, str(Path(__file__).with_name("editor-view-supervisor.py")),
                                         deadline, "0.1", sys.executable, "-c", f"raise SystemExit({code})"], timeout=5)
                self.assertEqual(result.returncode, code)


if __name__ == "__main__":
    unittest.main()
