#!/usr/bin/env python3
"""Real production StoreGC/reader fixture for the controlled joint NixOS VM."""

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time


ACTOR = r"""
import ctypes
import os
import sys
if sys.argv[1] == 'file':
    held = os.open(sys.argv[2], os.O_RDONLY)
else:
    os.chdir(sys.argv[2])
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
    raise OSError(ctypes.get_errno(), 'PR_SET_DUMPABLE')
print('ready', flush=True)
os.read(0, 1)
"""


@contextlib.contextmanager
def opaque_actor(kind, target, base):
    child = subprocess.Popen(
        [sys.executable, '-c', ACTOR, kind, str(target)],
        cwd=base,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        assert child.stdout.readline() == 'ready\n', 'Opaque actor did not become ready'
        try:
            os.readlink(f'/proc/{child.pid}/cwd')
        except PermissionError:
            pass
        else:
            raise AssertionError('Ordinary UID can inspect the intended opaque actor')
        yield child.pid
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
            raise
        assert child.returncode == 0, 'Owned actor failed during fixture teardown'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bound', required=True, type=Path)
    parser.add_argument('--plain', required=True, type=Path)
    parser.add_argument('--git', required=True, type=Path)
    parser.add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    assert sys.platform == 'linux' and os.getuid() == os.geteuid() == 1000
    status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines())
    assert status['Uid'].split() == ['1000'] * 4
    assert int(status['CapEff'].strip(), 16) == 0, 'The collector caller must be unprivileged'
    for executable in [args.bound, args.plain, args.git]:
        assert executable.is_absolute() and executable.is_file()
        assert str(executable.resolve()).startswith('/nix/store/')
    assert args.bound.resolve() != args.plain.resolve()
    base = args.root
    assert base.is_absolute() and base.parent.resolve(strict=True) == base.parent
    base.mkdir(mode=0o700)  # Refuse an existing path; never take custody of another case.
    home = base / 'home'
    home.mkdir(mode=0o700)
    repo = base / 'repo.git'
    root = base / 'retired-root'
    store = root / '.devenv/pnpm-store-pure-v1'
    payload = store / 'v11/files/sentinel'
    payload.parent.mkdir(parents=True)
    payload.write_bytes(b'preserve\n')
    initial = payload.stat()
    identity = (initial.st_dev, initial.st_ino)
    state = base / 'bound-state'
    env = dict(os.environ, HOME=str(home), XDG_STATE_HOME=str(state))
    for key in list(env):
        if key in ('GITHUB_ACTIONS', 'PNPM_JOB_LOCAL_STORE') or key.startswith('PNPM_GC_TEST_'):
            del env[key]
    subprocess.run([str(args.git), 'init', '--bare', '--quiet', str(repo)], env=env, check=True)
    rounds = []

    def preserved():
        current = payload.stat()
        assert (current.st_dev, current.st_ino) == identity
        assert payload.read_bytes() == b'preserve\n'

    def collect(executable, mode, state_home=state):
        result = subprocess.run(
            [str(executable), '--git-dir', str(repo), '--root', str(root), mode],
            cwd=base,
            env=dict(env, XDG_STATE_HOME=str(state_home)),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
        )
        rounds.append({'collector': str(executable), 'mode': mode, 'exit': result.returncode, 'output': result.stdout})
        preserved()
        return result

    with opaque_actor('file', payload, base) as pid:
        plain = collect(args.plain, '--observe', base / 'plain-state')
        assert plain.returncode == 0 and '\nprotected\t' in plain.stdout, plain.stdout
        assert 'grace\t' not in plain.stdout
        observed = collect(args.bound, '--observe')
        assert observed.returncode == 0 and '\ngrace\t' in observed.stdout, observed.stdout
        assert 'protected\t' not in observed.stdout
        records = list((state / 'effect-utils/pnpm-store-gc').glob('*.observation'))
        assert len(records) == 1
        record = records[0]
        first = record.read_text()
        timestamp = int(first.split('\n', 1)[0])
        assert 0 <= int(time.time()) - timestamp < 24 * 60 * 60
        lease = store / '.effect-utils-pnpm-store-cache-maintenance.lock'
        lease_stat = lease.stat()
        lease_identity = (lease_stat.st_dev, lease_stat.st_ino)
        applied = collect(args.bound, '--apply')
        assert applied.returncode == 0 and '\ngrace\t' in applied.stdout, applied.stdout
        assert record.read_text() == first, 'Immediate apply changed first observation'
        assert os.path.samestat(lease_stat, lease.stat()), 'Maintenance lease inode changed'
        rounds.append({'opaqueRegularFilePid': pid, 'effect': 'RetainedBytes accepted only by immutable-store adapter', 'prematureDeletion': False})

    with opaque_actor('cwd', store, base) as pid:
        active = collect(args.bound, '--observe')
        assert active.returncode == 0 and '\nprotected\t' in active.stdout, active.stdout
        assert 'grace\t' not in active.stdout
        assert record.read_text() == 'protected', 'A live directory reference must invalidate eligibility'
        rounds.append({'opaqueCwdPid': pid, 'effect': 'InUse veto'})

    observed = collect(args.bound, '--observe')
    assert observed.returncode == 0 and '\ngrace\t' in observed.stdout, observed.stdout
    renewed = record.read_text()
    assert 0 <= int(time.time()) - int(renewed.split('\n', 1)[0]) < 24 * 60 * 60
    with lease.open('r+b') as shared:
        fcntl.flock(shared, fcntl.LOCK_SH | fcntl.LOCK_NB)
        busy = collect(args.bound, '--observe')
        assert busy.returncode != 0 and 'maintenance lease busy' in busy.stdout, busy.stdout
        assert record.read_text() == renewed
    current_lease = lease.stat()
    assert (current_lease.st_dev, current_lease.st_ino) == lease_identity
    preserved()
    print(json.dumps({
        'fixture': 'real production StoreGC, fixed adapter and production-profile root reader',
        'uid': os.getuid(),
        'effectiveCapabilities': 0,
        'root': str(base),
        'rounds': rounds,
        'clockOrObservationTampering': False,
        'testCfgOrMockCollector': False,
        'payloadDeleted': False,
        'retainedForInspection': True,
    }), flush=True)


if __name__ == '__main__':
    main()
