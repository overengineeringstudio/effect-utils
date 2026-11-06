#!/usr/bin/env python3
"""FIFO-controlled coverage of the generated outer launcher's diagnostics only."""
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = (ROOT / "genie/ci-scripts/nix-gc-race-retry.sh").read_text()


class PreparationWatchdogTest(unittest.TestCase):
    def exercise(self, terminate=False, tasks=False, portable_ps=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("tick", "release"):
                os.mkfifo(root / name)
            # O_RDWR keeps the handshake channels open without an ordering race.
            tick = os.open(root / "tick", os.O_RDWR)
            release = os.open(root / "release", os.O_RDWR)
            self.addCleanup(os.close, tick)
            self.addCleanup(os.close, release)
            diag = root / "diagnostics"
            (diag / "locked-input-prefetch").mkdir(parents=True)
            (diag / "locked-input-prefetch/fetch-0.log").write_text(
                "https://user:private-password@example.test/?token=hidden\n"
                "--token fixture-sensitive-value\n"
            )
            (root / "helper.sh").write_text(SCRIPT)
            (root / "sleep").write_text(
                '#!/usr/bin/env bash\necho clock-ready\nread -r tick < "$FIXTURE/tick"\n'
            )
            (root / "devenv").write_text(
                '#!/usr/bin/env bash\n'
                'for ((i=0;i<30;i++)); do echo "• Downloading $HOME/private/fixture-$i"; done\n'
                'echo "• Building completed"; echo "✓ Building completed in 1.0s"\n'
                + ('echo "• Running tasks"\n' if tasks else '')
                + 'echo "substitution-started $$"\n'
                'read -r release < "$FIXTURE/release"\nexit 37\n'
            )
            for name in ("sleep", "devenv"):
                (root / name).chmod(0o755)
            if portable_ps:
                (root / "ps").write_text(
                    '#!/usr/bin/env bash\n'
                    'case "$*" in\n'
                    '  *wchan*) echo "unsupported wchan" >&2; exit 1 ;;\n'
                    '  *pgid*) read -r group < <("$REAL_PS" -o pgid= -p $$)\n'
                    '    printf "424242 1 %s S 00:01 portable-fixture\\n" "$group" ;;\n'
                    '  *) exec "$REAL_PS" "$@" ;;\n'
                    'esac\n'
                )
                (root / "ps").chmod(0o755)
            env = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}", FIXTURE=str(root),
                       REAL_PS=shutil.which("ps"), CI_PREPARATION_DIAGNOSTIC_SECONDS="0",
                       NIX_STORE_DIAGNOSTICS_DIR=str(diag))
            process = subprocess.Popen(
                ["bash", "-euo", "pipefail", "-c",
                 'source "$FIXTURE/helper.sh"; '
                 'mktemp() { if [ "$#" -eq 0 ]; then '
                 ': > "$FIXTURE/attempt.log"; printf "%s\\n" "$FIXTURE/attempt.log"; '
                 'else command mktemp "$@"; fi; }; '
                 'run_nix_gc_race_retry "devenv tasks run fixture" devenv'],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
                start_new_session=True,
            )
            output = bytearray()
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)

            def until(needle, count=1):
                while output.count(needle) < count:
                    self.assertTrue(selector.select(10), f"missing {needle!r}: {output!r}")
                    chunk = os.read(process.stdout.fileno(), 65536)
                    self.assertTrue(chunk, f"early EOF: {output!r}")
                    output.extend(chunk)

            try:
                until(b"clock-ready\n")
                until(b"substitution-started ")
                while b"\n" not in output.split(b"substitution-started ")[1]:
                    self.assertTrue(selector.select(10))
                    output.extend(os.read(process.stdout.fileno(), 65536))
                child = int(output.split(b"substitution-started ")[1].split(b"\n")[0])
                # tee can publish stdout before its log write; gate on the actual log.
                marker = f"substitution-started {child}\n".encode()
                deadline = time.monotonic() + 10
                while marker not in (root / "attempt.log").read_bytes():
                    self.assertLess(time.monotonic(), deadline, "readiness missing from attempt log")
                os.write(tick, b"tick\n")
                until(b"phase: tasks started" if tasks else b"preparation diagnostics end")
                # Two observed cadences prove the dump is one-shot, without sleeps.
                until(b"clock-ready\n", 2)
                os.write(tick, b"tick\n")
                until(b"clock-ready\n", 3)
                self.assertIsNone(process.poll(), "diagnostics must not terminate preparation")
                if terminate:
                    os.kill(child, signal.SIGTERM)
                else:
                    os.write(release, b"finish\n")
                rest, _ = process.communicate(timeout=10)
                output.extend(rest)
                self.assertEqual(process.returncode, 143 if terminate else 37)
                text = output.decode()
                self.assertIn("phase: environment realization started", text)
                self.assertEqual(text.count("preparation diagnostics begin"), 0 if tasks else 1)
                if not tasks:
                    dump = text.split("::notice::[ci] preparation diagnostics begin")[1].split("preparation diagnostics end")[0]
                    self.assertLessEqual(len(dump.splitlines()) + 1, 40)
                    self.assertLessEqual(len(dump.encode()) + 100, 8192)
                    self.assertNotIn(os.environ["HOME"], dump)
                    self.assertNotIn("/private/", dump)
                    self.assertIn("pending downloading: fixture-0", dump)
                    self.assertNotIn("pending building: completed", dump)
                    self.assertIn("truncated", dump)
                    self.assertLessEqual(dump.count("process pid="), 8)
                    snapshots = list(diag.glob("preparation-*.log"))
                    self.assertEqual(len(snapshots), 1)
                    snapshot = snapshots[0].read_text()
                    self.assertIn("wchan", snapshot)
                    self.assertIn("prefetch tail: fetch-0.log", snapshot)
                    self.assertIn("[REDACTED_URL]", snapshot)
                    self.assertNotIn("private-password", snapshot)
                    self.assertNotIn("fixture-sensitive-value", snapshot)
                    self.assertNotIn("token=hidden", snapshot)
                    if portable_ps:
                        self.assertIn("424242 1 S - 00:01 portable-fixture", snapshot)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)
                selector.close()
                process.stdout.close()

    def test_blocked_substitution_exit_unchanged(self):
        self.exercise()

    def test_blocked_substitution_termination_unchanged(self):
        self.exercise(terminate=True)

    def test_tasks_marker_disables_preparation_dump(self):
        self.exercise(tasks=True)

    def test_ps_without_wait_channel_uses_portable_fallback(self):
        self.exercise(portable_ps=True)

    def test_resolve_build_stderr_is_live_and_persisted_before_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            os.mkfifo(root / "release")
            release = os.open(root / "release", os.O_RDWR)
            self.addCleanup(os.close, release)
            (root / "nix").write_text(
                '#!/usr/bin/env bash\necho live-build-marker >&2\n'
                'read -r release < "$DIAG_ROOT/release"\n'
            )
            (root / "nix").chmod(0o755)
            process = subprocess.Popen(
                ["bash", "-euo", "pipefail", "-c",
                 'source "$RESOLVE_SCRIPT"; resolve_devenv'],
                env=dict(os.environ, PATH=f"{root}:{os.environ['PATH']}",
                         DIAG_ROOT=str(root), DEVENV_REV="fixture",
                         RESOLVE_SCRIPT=str(ROOT / "genie/ci-scripts/resolve-devenv.sh")),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
            )
            selector = selectors.DefaultSelector()
            selector.register(process.stderr, selectors.EVENT_READ)
            try:
                self.assertTrue(selector.select(10), "stderr must arrive before nix returns")
                self.assertIn(b"live-build-marker", os.read(process.stderr.fileno(), 4096))
                deadline = time.monotonic() + 10
                while not any("live-build-marker" in p.read_text()
                              for p in root.glob("resolve-devenv.nix-build.*.log")):
                    self.assertLess(time.monotonic(), deadline, "persisted copy missing")
                self.assertIsNone(process.poll())
                os.killpg(process.pid, signal.SIGTERM)
                process.communicate(timeout=10)
                self.assertTrue(any("live-build-marker" in p.read_text()
                                    for p in root.glob("resolve-devenv.nix-build.*.log")))
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=10)
                selector.close()


if __name__ == "__main__":
    unittest.main()
