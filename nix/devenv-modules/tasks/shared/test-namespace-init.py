"""Run one test command as a readable PID-namespace init and reap adopted helpers."""

import os
import sys

child = os.fork()
if child == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
while True:
    pid, status = os.wait()
    if pid == child:
        sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
