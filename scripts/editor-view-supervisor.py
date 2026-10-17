#!/usr/bin/env python3
"""Own the publication process group through unconditional deadline escalation."""
import ctypes
import os
import signal
import subprocess
import sys
import time


def supervise(command, deadline, grace):
    # Reap orphaned descendants ourselves on Linux, including TERM-resistant helpers.
    if sys.platform == "linux":
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "cannot become publication subreaper")
    child = subprocess.Popen(command, start_new_session=True)
    interrupted = []
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda number, _frame: interrupted.append(number))
    expires = time.monotonic() + deadline
    while not interrupted and time.monotonic() < expires:
        try:
            result = child.wait(timeout=min(0.05, max(0.001, expires - time.monotonic())))
            if not interrupted:
                return result
            break
        except subprocess.TimeoutExpired:
            pass
    status = 128 + interrupted[0] if interrupted else 124
    print(f"Editor-view publication exceeded its {deadline:g}s total deadline or was interrupted; terminating process group (grace {grace:g}s), publication failed.", file=sys.stderr, flush=True)
    def send(sig):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass
    send(signal.SIGTERM)
    # Do not reap the leader yet: retain its PID/group identity through escalation.
    time.sleep(grace)
    send(signal.SIGKILL)  # Unconditional: authority exit must not cancel escalation.
    child.wait()
    while True:
        try:
            os.waitpid(-child.pid, 0)
        except ChildProcessError:
            break
    # On non-Linux, init reaps orphaned descendants rather than this subreaper.
    while True:
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.01)
    return status


if __name__ == "__main__":
    sys.exit(supervise(sys.argv[3:], float(sys.argv[1]), float(sys.argv[2])))
