import os
from pathlib import Path
import signal
import subprocess
import sys
import time

if sys.platform != "linux":
    sys.exit(0)


def spin(predicate):
    deadline = time.monotonic() + 3
    while not predicate():
        assert time.monotonic() < deadline
        os.sched_yield()


def status(pid):
    return dict(line.split(":", 1) for line in Path(f"/proc/{pid}/status").read_text().splitlines())


lease, worktree, root = sys.argv[1:]
payload = """
import os, signal, sys
count = 0
def received(*_):
    global count
    count += 1
    if count == 1:
        os.kill(os.getpid(), signal.SIGSTOP)
signal.signal(signal.SIGTERM, received)
with open(sys.argv[1] + '/ready', 'w') as ready:
    ready.write(str(os.getpid()) + '\\n')
with open(sys.argv[1] + '/release') as release:
    release.readline()
sys.exit(23 if count == 1 else 1)
"""
for group in (False, True):
    wrapper = subprocess.Popen([
        lease, "run", worktree, "--mode", "shared", "--try", "--agent", "agent/test",
        "--", sys.executable, "-c", payload, root,
    ], start_new_session=group)
    with open(root + "/ready") as ready:
        child = int(ready.readline())
    try:
        os.kill(-wrapper.pid if group else wrapper.pid, signal.SIGTERM)
        spin(lambda: status(child)["State"].lstrip().startswith("T"))
        spin(lambda: all(int(status(wrapper.pid)[key], 16) & (1 << 14) == 0 for key in ("SigPnd", "ShdPnd", "SigBlk")))
        os.kill(child, signal.SIGCONT)
        with open(root + "/release", "w") as release:
            release.write("release\n")
        assert wrapper.wait(timeout=3) == 23
    finally:
        if wrapper.poll() is None:
            os.kill(child, signal.SIGKILL)
            wrapper.kill()
            wrapper.wait()
