"""Temporary native-backed creation and reclamation compatibility surface."""
import array
import contextlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys


def native(*args, **kwargs):
    binary = os.environ.get('WORKTREE_LEASE_BIN') or str(Path(__file__).resolve().parents[2] / 'bin/worktree-lease')
    return subprocess.run([binary, 'compat', *map(str, args)], **kwargs)


def dead_expired(record, epoch):
    return native('dead', epoch, input=json.dumps(record).encode()).returncode == 0


def publish(git_dir, purpose, creator, pid, ttl, renew=False):
    result = native('publish', git_dir, purpose, creator, pid, ttl, *(['--renew'] if renew else []))
    if result.returncode:
        raise ValueError('lease publication refused')


@contextlib.contextmanager
def lease_lock(git_dir, inherited_fd=None):
    parent, child = socket.socketpair()
    descriptors = array.array('i')
    try:
        with parent, child:
            inherited = () if inherited_fd is None else (int(inherited_fd),)
            result = native('lock', git_dir, child.fileno(), *inherited,
                            pass_fds=(child.fileno(), *inherited))
            child.close()
            data, ancillary, flags, _ = parent.recvmsg(1, socket.CMSG_SPACE(descriptors.itemsize))
            for level, kind, payload in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    descriptors.frombytes(payload)
            if result.returncode or data != b'\0' or flags or len(descriptors) != 1:
                raise ValueError('exclusive lease refused')
            os.set_inheritable(descriptors[0], False)
            yield descriptors[0]
    finally:
        for fd in descriptors:
            os.close(fd)


def guard_git_dir(git_dir, now=None):
    if native('check', git_dir, *(() if now is None else (now,))).returncode:
        raise ValueError('worktree protected')


def writer_main():
    try:
        worktree, purpose, creator = sys.argv[1:]
        # Capture before starting Git or native helpers: this is the original caller.
        pid = os.getppid()
        ttl = os.environ.get('GATE_WORKTREE_LEASE_SECONDS', '7500')
        result = native('write', worktree, purpose, creator, pid, ttl)
        return 0 if result.returncode == 0 else 2
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2


def guard_main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock-exec', action='store_true')
    parser.add_argument('--check-lock', action='store_true')
    parser.add_argument('git_dir', type=Path)
    parser.add_argument('--inherit-fd', type=int)
    parser.add_argument('--reference-fd-env', default=os.environ.get('WORKTREE_LEASE_REFERENCE_FD_ENV'))
    args, command = parser.parse_known_args()
    if command[:1] == ['--']:
        command = command[1:]
    try:
        if args.check_lock:
            if args.lock_exec or args.inherit_fd is None or command:
                raise ValueError('check-lock requires only git-dir and inherit-fd')
            with lease_lock(args.git_dir, args.inherit_fd):
                return 0
        if args.lock_exec:
            if not command:
                raise ValueError('lock-exec requires a command')
            with lease_lock(args.git_dir, args.inherit_fd) as fd:
                guard_git_dir(args.git_dir)
                environment = dict(os.environ, RECLAIM_GATE_LEASE_LOCK_FD=str(fd))
                preserve = (fd,) + ((int(environment[args.reference_fd_env]),)
                                   if args.reference_fd_env else ())
                status = subprocess.run(command, env=environment, pass_fds=preserve).returncode
                return status if status >= 0 else 128 - status
        if command or args.inherit_fd is not None:
            raise ValueError('unexpected command or descriptor')
        with lease_lock(args.git_dir):
            guard_git_dir(args.git_dir)
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1
