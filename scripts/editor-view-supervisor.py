#!/usr/bin/env python3
"""Own the publication process group through unconditional deadline escalation."""
import ctypes
import fcntl
import os
import signal
import subprocess
import sys
import time


def supervise(command, deadline, grace, pass_fds=(), waiting_lock=None):
    # Reap orphaned descendants ourselves on Linux, including TERM-resistant helpers.
    if sys.platform == "linux":
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "cannot become publication subreaper")
    child = subprocess.Popen(command, start_new_session=True, pass_fds=pass_fds)
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
    if waiting_lock is not None:
        lock_path, ready_fd = waiting_lock
        # The helper writes once after its blocking flock succeeds. No polling
        # or lock-file existence test can distinguish a queued waiter safely.
        try:
            acquired = os.read(ready_fd, 1) == b"1"
        except BlockingIOError:
            acquired = False
        if not acquired:
            print(f"Editor-view publication was waiting for another publication on lock {lock_path}.", file=sys.stderr, flush=True)
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


def supervise_locked(command, deadline, grace, lock_path):
    os.makedirs(os.path.dirname(os.path.abspath(lock_path)), exist_ok=True)
    # Keep the shared open-file description alive in the supervisor until all
    # descendants have been killed/reaped, not merely until the authority exits.
    with open(lock_path, "a") as lock:
        ready_read, ready_write = os.pipe()
        os.set_blocking(ready_read, False)
        try:
            return supervise(
                [sys.executable, __file__, "--acquire", str(lock.fileno()), str(ready_write), *command],
                deadline, grace,
                pass_fds=(lock.fileno(), ready_write),
                waiting_lock=(lock_path, ready_read),
            )
        finally:
            os.close(ready_read)
            os.close(ready_write)


if __name__ == "__main__":
    if sys.argv[1] == "--acquire":
        lock_fd, ready_fd = int(sys.argv[2]), int(sys.argv[3])
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        os.write(ready_fd, b"1")
        os.close(ready_fd)
        os.set_inheritable(lock_fd, True)
        os.execvp(sys.argv[4], sys.argv[4:])
    elif sys.argv[3] == "--lock":
        sys.exit(supervise_locked(sys.argv[5:], float(sys.argv[1]), float(sys.argv[2]), sys.argv[4]))
    else:
        sys.exit(supervise(sys.argv[3:], float(sys.argv[1]), float(sys.argv[2])))
