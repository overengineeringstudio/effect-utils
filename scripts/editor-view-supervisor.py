#!/usr/bin/env python3
"""Own publication admission and process-group cleanup, with optional deadlines."""
import ctypes
import fcntl
import json
import math
import os
import signal
import re
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

def safe_name(value):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.basename(str(value)))[:80]


def record_holder(fd, command, pid):
    # Metadata lives in the flock inode, not a replaceable sidecar. Only an
    # admitted owner writes it; the supervisor retains ownership through cleanup.
    payload = json.dumps({"pid": pid, "command": safe_name(command),
                          "started": time.monotonic()}).encode()
    try:
        os.pwrite(fd, payload, 0)
        os.ftruncate(fd, len(payload))
    except OSError:
        pass  # Diagnostics must not turn successful admission into failure.


def admission_dump(path):
    """Read-only, bounded evidence; never launch a Buck wrapper or probe EX leases."""
    lines = ["[editor-view-admission-wait] begin"]
    try:
        with open(path, "rb") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                lines.append("holder=none-at-observation")
            except BlockingIOError:
                owner = json.loads(lock.read(1024))
                pid, started = owner["pid"], owner["started"]
                if type(pid) is not int or type(started) not in (int, float):
                    raise ValueError("invalid owner")
                elapsed = max(0, time.monotonic() - started)
                lines.append(f"holder recorded-pid={pid} command={safe_name(owner['command'])} "
                             f"held-seconds={elapsed:.1f} identity=advisory")
    except Exception:
        lines.append("holder=unknown")
    isolation = os.environ.get("BUCK_ISOLATION_DIR", "v2")
    native = os.environ.get("BUCK2_NATIVE_BIN")
    # Only an explicitly supplied immutable native executable is safe here.
    # Native status does not start a build; stderr/argv/environment stay private.
    if native and os.path.isabs(native) and native.startswith("/nix/store/"):
        try:
            with tempfile.TemporaryFile() as output:
                result = subprocess.run([native, "--isolation-dir", isolation, "status"],
                                        stdout=output, stderr=subprocess.DEVNULL, timeout=1)
                output.seek(0)
                status = json.loads(output.read(4096))
            pid = status.get("process_info", {}).get("pid", status.get("pid"))
            active = status.get("active_commands")
            lines.append(f"buck isolation={safe_name(isolation)} status-exit={result.returncode} "
                         f"pid={pid if type(pid) is int else 'unknown'} "
                         f"active={len(active) if isinstance(active, list) else 'unknown'}")
        except Exception:
            lines.append(f"buck isolation={safe_name(isolation)} status=unavailable")
    else:
        lines.append(f"buck isolation={safe_name(isolation)} status=unavailable native=not-provided")
    root = os.environ.get("DEVENV_ROOT", os.getcwd())
    for label, suffix in (("root", ".editor-view"),
                          ("genie", "packages/@overeng/genie/.editor-view")):
        count = 0
        try:
            with os.scandir(os.path.join(root, suffix, ".leases")) as entries:
                for entry in entries:
                    count += 1
                    if count == 64:
                        break
            lines.append(f"leases root={label} controls={count} "
                         f"truncated={int(count == 64)} held=unknown")
        except FileNotFoundError:
            lines.append(f"leases root={label} controls=absent held=unknown")
        except OSError:
            lines.append(f"leases root={label} controls=unknown held=unknown")
    # A reader lock probe outside its CAS admission fence could disrupt readers.
    # Inventory is evidence, not a claim that controls are currently held.
    lines.append("[editor-view-admission-wait] end")
    if len(lines) > 40 or len("\n".join(lines).encode()) > 8192:
        lines = lines[:38] + ["[editor-view-admission-wait] truncated"]
    payload = ("\n".join(lines) + "\n").encode()
    if len(payload) > 8192:
        payload = payload[:8100] + b"\n[editor-view-admission-wait] truncated\n"
    os.write(2, payload)


class AdmissionDiagnostic:
    def __init__(self):
        # 600s exceeds the measured valid maximum (399s), avoiding routine log
        # noise. This is diagnostic-only and never changes admission/deadlines.
        try:
            self.threshold = float(os.environ.get("EDITOR_VIEW_ADMISSION_DIAGNOSTIC_SECONDS", "600"))
            if not math.isfinite(self.threshold) or self.threshold < 0:
                raise ValueError("invalid threshold")
        except ValueError:
            self.threshold = 600
        self.attempted = False
        self.child = None

    def observe(self, path, started):
        now = time.monotonic()
        if self.child is not None and now - self.started >= 3:
            self.close()
        if self.attempted or started is None or now - started < self.threshold:
            return
        self.attempted = True
        self.started = now
        try:
            self.child = subprocess.Popen([sys.executable, __file__, "--admission-dump", path],
                                          start_new_session=True, stdout=subprocess.DEVNULL)
        except OSError:
            print("[editor-view-admission-wait] collection=unavailable", file=sys.stderr, flush=True)

    def close(self):
        if self.child is not None:
            if self.child.poll() is None:
                signal_group(self.child.pid, signal.SIGKILL)
                print("[editor-view-admission-wait] collection=cancelled", file=sys.stderr, flush=True)
            self.child.wait()
            self.child = None




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
        record_holder(self.lock.fileno(), self.command, os.getpid())
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
        deferred.command = command[0]
    child = subprocess.Popen(command, start_new_session=True, pass_fds=pass_fds, env=child_env)
    interrupted = []
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda number, _frame: interrupted.append(number))
    started = time.monotonic()
    admitted = waiting_lock is None
    expires = started + deadline if admitted and deadline is not None else float("inf")
    diagnostic = AdmissionDiagnostic()
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
        if waiting_lock is not None and not admitted:
            diagnostic.observe(waiting_lock[0], started)
        elif deferred is not None and not deferred.admitted:
            diagnostic.observe(deferred.path, deferred.wait_started)
        elif diagnostic.child is not None:
            diagnostic.close()
        try:
            result = child.wait(timeout=min(0.05, max(0.001, expires - time.monotonic())))
            observe_admission()  # Also report admission for a child that exits immediately.
            if not interrupted:
                diagnostic.close()
                return result
            break
        except subprocess.TimeoutExpired:
            pass
    diagnostic.close()
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
    with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600), "r+") as lock:
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
    with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600), "r+") as lock, tempfile.TemporaryDirectory(
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
    if sys.argv[1] == "--admission-dump":
        admission_dump(sys.argv[2])
        sys.exit(0)
    elif sys.argv[1] == "--acquire":
        lock_fd, ready_fd = int(sys.argv[2]), int(sys.argv[3])
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        record_holder(lock_fd, sys.argv[4], os.getppid())
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
