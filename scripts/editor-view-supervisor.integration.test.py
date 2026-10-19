import fcntl
import importlib.util
import os
from pathlib import Path
import signal
import selectors
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
