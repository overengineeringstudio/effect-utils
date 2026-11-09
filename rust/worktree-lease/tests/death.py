import os
import select
import signal
import subprocess
import sys

if sys.platform != "linux":
    sys.exit(0)

lease, worktree, root = sys.argv[1:]
payload = """
import os, signal, sys
with open(sys.argv[1] + '/ready', 'w') as ready:
    ready.write(str(os.getpid()) + '\\n')
signal.pause()
"""
wrapper = subprocess.Popen([
    lease, "run", worktree, "--mode", "shared", "--try", "--agent", "agent/test",
    "--", sys.executable, "-c", payload, root,
])
with open(root + "/ready") as ready:
    child = int(ready.readline())
child_fd = os.pidfd_open(child)
poller = select.poll()
poller.register(child_fd, select.POLLIN)
try:
    wrapper.kill()
    wrapper.wait(timeout=3)
    assert poller.poll(3000), "payload survived its supervisor"
finally:
    try:
        signal.pidfd_send_signal(child_fd, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(child_fd)
