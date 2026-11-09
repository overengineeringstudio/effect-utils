import errno
import os
import pty
import select
import signal
import subprocess
import sys
import time

lease, worktree = sys.argv[1:]
payload = "import os; assert input() == 'hello'; assert os.tcgetpgrp(0) == os.getpgrp(); raise SystemExit(23)"
pid, terminal = pty.fork()
if pid == 0:
    signal.alarm(5)
    result = subprocess.run([
        lease, "run", worktree, "--mode", "shared", "--try", "--agent", "agent/test",
        "--", sys.executable, "-c", payload,
    ])
    restored = os.tcgetpgrp(0) == os.getpgrp()
    os._exit(0 if result.returncode == 23 and restored else 1)
reaped = False
try:
    os.write(terminal, b"hello\n")
    deadline = time.monotonic() + 5
    while True:
        remaining = deadline - time.monotonic()
        assert remaining > 0 and select.select([terminal], [], [], remaining)[0]
        try:
            if not os.read(terminal, 4096):
                break
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
    _, status = os.waitpid(pid, 0)
    reaped = True
    assert os.waitstatus_to_exitcode(status) == 0
finally:
    os.close(terminal)
    if not reaped:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
