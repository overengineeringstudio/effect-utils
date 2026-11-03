#!/usr/bin/env python3
"""FIFO-controlled coverage of the generated outer launcher's diagnostics only."""
import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = (ROOT / "genie/ci-scripts/nix-gc-race-retry.sh").read_text()


class PreparationWatchdogTest(unittest.TestCase):
    def exercise(self, terminate=False, tasks=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("tick", "release"):
                os.mkfifo(root / name)
            # O_RDWR keeps the handshake channels open without an ordering race.
            tick = os.open(root / "tick", os.O_RDWR)
            release = os.open(root / "release", os.O_RDWR)
            self.addCleanup(os.close, tick)
            self.addCleanup(os.close, release)
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
            env = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}", FIXTURE=str(root),
                       CI_PREPARATION_DIAGNOSTIC_SECONDS="0")
            process = subprocess.Popen(
                ["bash", "-euo", "pipefail", "-c",
                 'source "$FIXTURE/helper.sh"; run_nix_gc_race_retry "devenv tasks run fixture" devenv'],
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


if __name__ == "__main__":
    unittest.main()
