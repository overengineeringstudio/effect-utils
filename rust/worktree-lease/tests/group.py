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
    return dict(
        line.split(":", 1)
        for line in Path(f"/proc/{pid}/status").read_text().splitlines()
    )


os.setsid()
signal.signal(signal.SIGINT, signal.SIG_IGN)
lease, worktree, root = sys.argv[1:]
payload = """
import os, signal, sys
root = sys.argv[1]
count = 0
def received(*_):
    global count
    count += 1
    if count == 1:
        os.kill(os.getpid(), signal.SIGSTOP)
signal.signal(signal.SIGINT, received)
with open(root + '/ready', 'w') as ready:
    ready.write(str(os.getpid()) + '\\n')
with open(root + '/release') as release:
    release.readline()
sys.exit(0 if count == 1 else 1)
"""
wrapper = subprocess.Popen([
    lease, "run", worktree, "--mode", "shared", "--try", "--agent", "agent/test",
    "--", sys.executable, "-c", payload, root,
])
with open(root + "/ready") as ready:
    child = int(ready.readline())
try:
    os.kill(wrapper.pid, signal.SIGSTOP)
    spin(lambda: status(wrapper.pid)["State"].lstrip().startswith("T"))
    os.killpg(os.getpgrp(), signal.SIGINT)
    spin(lambda: status(child)["State"].lstrip().startswith("T"))
    os.kill(wrapper.pid, signal.SIGCONT)

    def handled():
        masks = status(wrapper.pid)
        return all(int(masks[key], 16) & 2 == 0 for key in ("SigPnd", "ShdPnd", "SigBlk"))

    spin(handled)
    os.kill(child, signal.SIGCONT)
    with open(root + "/release", "w") as release:
        release.write("release\n")
    assert wrapper.wait(timeout=3) == 0
finally:
    if wrapper.poll() is None:
        os.kill(child, signal.SIGKILL)
        wrapper.kill()
        wrapper.wait()
