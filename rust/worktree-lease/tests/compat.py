"""Run with LEASE_PACKAGE pointing to the installed native product."""
import fcntl, json, os, pathlib, socket, subprocess, sys, tempfile, time
package = pathlib.Path(os.environ['LEASE_PACKAGE'])
sys.path.insert(0, str(package / 'share/worktree-lease'))
import gate_worktree_lease as bridge
from reclaim_worktree_guard import guard_git_dir, lease_lock
native = str(package / 'bin/worktree-lease')
writer = str(package / 'bin/gate-lease-write')
guard = str(package / 'bin/reclaim-worktree-guard')
def call(*args, **kwargs):
    return subprocess.run(list(map(str, args)), capture_output=True, **kwargs)
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    subprocess.check_call(['git', 'init', '-q', str(root)])
    admin = root / '.git'
    record_path = admin / 'gate-lease.json'
    assert call(writer, root, 'gate', 'agent/test').returncode == 0
    record = json.loads(record_path.read_text())
    assert record['holder']['pid'] == os.getpid(), record
    assert call(writer, root, 'gate', 'agent/test').returncode == 2
    assert call(writer, root, 'bad', 'agent/test').returncode == 2
    assert call(writer, root, 'gate', 'agent/test', env=os.environ | {'WORKTREE_LEASE_BIN': '/missing-native'}).returncode == 2
    assert call(guard, admin).returncode == 1
    record['holder'].pop('pidNamespace', None)
    record['holder']['pid'] = 2147483647
    record['expiresAt'] = '2001-01-01T00:00:00Z'
    record['createdAt'] = '2000-01-01T00:00:00Z'
    record_path.write_text(json.dumps(record))
    assert not bridge.dead_expired(record, time.time())
    assert call(guard, admin).returncode == 1
    record_path.unlink()
    lock = admin / 'gate-lease.lock'
    with lock.open('a+') as old:
        fcntl.flock(old, fcntl.LOCK_SH)
        assert call(guard, admin).returncode == 1
        assert call(guard, '--lock-exec', admin, '--', 'true').returncode == 1
        assert call(native, 'run', root, '--mode', 'exclusive', '--try', '--agent', 'agent/test', '--', 'true').returncode == 75
    child = subprocess.Popen([native, 'run', str(root), '--mode', 'shared', '--try', '--', sys.executable, '-c', 'import sys; print("ready", flush=True); sys.stdin.read()'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        assert child.stdout.readline() == b'ready\n'
        with lock.open('r+') as old:
            try:
                fcntl.flock(old, fcntl.LOCK_EX | fcntl.LOCK_NB)
                raise AssertionError('mixed-version fence lost')
            except BlockingIOError:
                pass
        assert call(guard, '--lock-exec', admin, '--', 'true').returncode == 1
        assert call(guard, admin).returncode == 1
    finally:
        child.communicate()
    with lease_lock(admin) as fd:
        guard_git_dir(admin)
        assert call(guard, '--check-lock', admin, '--inherit-fd', fd, pass_fds=(fd,)).returncode == 0
        assert call(native, 'run', root, '--mode', 'shared', '--try', '--', 'true').returncode == 75
    assert call(guard, '--lock-exec', admin, '--', 'sh', '-c', 'exit 23').returncode == 23
    channel, peer = socket.socketpair()
    with channel, peer:
        env = os.environ | {'TEST_REFERENCE_FD': str(channel.fileno())}
        check = 'import os; os.fstat(int(os.environ["TEST_REFERENCE_FD"]))'
        before = os.get_inheritable(channel.fileno())
        assert call(guard, '--reference-fd-env', 'TEST_REFERENCE_FD', '--lock-exec', admin, '--', sys.executable, '-c', check, env=env, pass_fds=(channel.fileno(),)).returncode == 0
        assert os.get_inheritable(channel.fileno()) == before
        assert call(guard, '--lock-exec', admin, '--', sys.executable, '-c', check, env=env | {'WORKTREE_LEASE_REFERENCE_FD_ENV': 'TEST_REFERENCE_FD'}, pass_fds=(channel.fileno(),)).returncode == 0
        assert call(guard, '--lock-exec', admin, '--', sys.executable, '-c', check, env=env | {'WORKTREE_LEASE_REFERENCE_FD_ENV': ''}, pass_fds=(channel.fileno(),)).returncode != 0
