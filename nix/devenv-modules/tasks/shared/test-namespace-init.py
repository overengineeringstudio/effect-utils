"""Keep a foreign root-owned namespace init; run tests at their original non-root UID."""

import os
import sys

uid, gid = int(sys.argv[1]), int(sys.argv[2])
if os.getuid() != 0 or uid == 0:
    raise RuntimeError("namespace fixtures require a privileged init and a non-root test UID")

child = os.fork()
if child == 0:
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    os.execvp(sys.argv[3], sys.argv[3:])
while True:
    pid, status = os.wait()
    if pid == child:
        sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
