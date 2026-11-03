#!/usr/bin/env python3
"""Own publication admission and process-group cleanup, with optional deadlines."""
import ctypes
import fcntl
import os
import signal
import subprocess
import socket
import stat
import tempfile
import sys
import time

def signal_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        if sys.platform != "darwin":
            raise
        # Darwin can report EPERM for an exited/zombie-only group. Never hide
        # a real denial: an unreadable census or any live member must fail.
        census = subprocess.check_output(["/bin/ps", "-axo", "pgid=,stat="], text=True)
        for line in census.splitlines():
            group, state = line.split()
            if group == str(pgid) and not state.startswith("Z"):
                raise
        return False



class DeferredAdmission:
    """Retain flock ownership through cleanup, but admit only after authority/build."""
    def __init__(self, lock, path, listener, endpoint):
        self.lock, self.path, self.listener, self.endpoint = lock, path, listener, endpoint
        self.client = None
        self.wait_started = None
        self.admitted = False
        self.remaining = float("inf")

    def observe(self, expires):
        if self.admitted:
            return expires
        now = time.monotonic()
        if self.client is None:
            try:
                self.client, _ = self.listener.accept()
            except BlockingIOError:
                return expires
            self.wait_started = now
            self.remaining = max(0, expires - now)
        try:
            fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return float("inf")
        held, named = os.fstat(self.lock.fileno()), os.stat(self.path, follow_symlinks=False)
        if not stat.S_ISREG(named.st_mode) or (held.st_dev, held.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError("publication flock pathname identity changed")
        self.client.sendall(b"1")
        # Retain the accepted channel through cleanup; premature close can reset an unread ack.
        self.admitted = True
        print(f"Editor-view publication admitted on lock {self.path} after waiting {now - self.wait_started:.3f}s.", file=sys.stderr, flush=True)
        return now + self.remaining


def supervise(command, deadline, grace, pass_fds=(), waiting_lock=None, deferred=None):
    # Reap orphaned descendants ourselves on Linux, including TERM-resistant helpers.
    if sys.platform == "linux":
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "cannot become publication subreaper")
    # Popen deliberately closes every descriptor outside this supervisor's
    # lock/admission protocol. Lease mappings belong to the launching process,
    # not this new child: its native source launcher must discover fresh leases.
    child_env = os.environ.copy()
    child_env.pop("EDITOR_VIEW_LEASE_FDS", None)
    child_env.pop("EDITOR_VIEW_LEASE_ACTIVE", None)
    child_env.pop("EDITOR_VIEW_PUBLICATION_ADMISSION_SOCKET", None)
    if deferred is not None:
        child_env["EDITOR_VIEW_PUBLICATION_ADMISSION_SOCKET"] = deferred.endpoint
    child = subprocess.Popen(command, start_new_session=True, pass_fds=pass_fds, env=child_env)
    interrupted = []
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda number, _frame: interrupted.append(number))
    started = time.monotonic()
    admitted = waiting_lock is None
    expires = started + deadline if admitted and deadline is not None else float("inf")
    def observe_admission():
        nonlocal admitted, expires
        if not admitted:
            lock_path, ready_fd = waiting_lock
            try:
                admitted = os.read(ready_fd, 1) == b"1"
            except BlockingIOError:
                pass
            if admitted:
                now = time.monotonic()
                expires = now + deadline if deadline is not None else float("inf")
                print(f"Editor-view publication admitted on lock {lock_path} after waiting {now - started:.3f}s.", file=sys.stderr, flush=True)
    while not interrupted and time.monotonic() < expires:
        observe_admission()
        if deferred is not None:
            try:
                expires = deferred.observe(expires)
            except Exception as error:
                print(f"Editor-view publication admission failed: {error}", file=sys.stderr, flush=True)
                interrupted.append(signal.SIGTERM)
                break
        try:
            result = child.wait(timeout=min(0.05, max(0.001, expires - time.monotonic())))
            observe_admission()  # Also report admission for a child that exits immediately.
            if not interrupted:
                return result
            break
        except subprocess.TimeoutExpired:
            pass
    status = 128 + interrupted[0] if interrupted else 124
    if deferred is not None and deferred.wait_started is not None and not deferred.admitted:
        print(f"Editor-view publication was waiting for another publication on lock {deferred.path}.", file=sys.stderr, flush=True)
    if waiting_lock is not None and not admitted:
        print(f"Editor-view publication was waiting for another publication on lock {waiting_lock[0]}.", file=sys.stderr, flush=True)
    reason = "was interrupted" if interrupted else f"exceeded its {deadline:g}s execution deadline"
    print(f"Editor-view publication {reason}; terminating process group (grace {grace:g}s), publication failed.", file=sys.stderr, flush=True)
    signal_group(child.pid, signal.SIGTERM)
    # Do not reap the leader yet: retain its PID/group identity through escalation.
    time.sleep(grace)
    signal_group(child.pid, signal.SIGKILL)  # Authority exit must not cancel escalation.
    child.wait()
    while True:
        try:
            os.waitpid(-child.pid, 0)
        except ChildProcessError:
            break
    # On non-Linux, init reaps orphaned descendants rather than this subreaper.
    while signal_group(child.pid, 0):
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


def supervise_deferred(command, deadline, grace, lock_path):
    os.makedirs(os.path.dirname(os.path.abspath(lock_path)), exist_ok=True)
    # Runtime IPC needs a short canonical path, independent of long worktree TMPDIRs.
    with open(lock_path, "a") as lock, tempfile.TemporaryDirectory(
        prefix="eu-ev-", dir=os.environ.get("XDG_RUNTIME_DIR", "/tmp")
    ) as directory:
        endpoint = os.path.join(os.path.realpath(directory), "socket")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(endpoint)
            listener.listen(1)
            listener.setblocking(False)
            admission = DeferredAdmission(lock, lock_path, listener, endpoint)
            try:
                return supervise(command, deadline, grace, deferred=admission)
            finally:
                if admission.client is not None:
                    admission.client.close()


if __name__ == "__main__":
    if sys.argv[1] == "--acquire":
        lock_fd, ready_fd = int(sys.argv[2]), int(sys.argv[3])
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        os.write(ready_fd, b"1")
        os.close(ready_fd)
        os.set_inheritable(lock_fd, True)
        os.execvp(sys.argv[4], sys.argv[4:])
    else:
        deadline = None if sys.argv[1] == "none" else float(sys.argv[1])
        if sys.argv[3] == "--lock":
            sys.exit(supervise_locked(sys.argv[5:], deadline, float(sys.argv[2]), sys.argv[4]))
        elif sys.argv[3] == "--deferred-lock":
            sys.exit(supervise_deferred(sys.argv[5:], deadline, float(sys.argv[2]), sys.argv[4]))
        else:
            sys.exit(supervise(sys.argv[3:], deadline, float(sys.argv[2])))
