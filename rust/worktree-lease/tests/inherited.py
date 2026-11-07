import fcntl, json, os, pathlib, subprocess, tempfile
lease = os.environ['LEASE']
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    subprocess.check_call(['git', 'init', '-q', str(root)])
    lock = root / '.git/gate-lease.lock'
    def validate(fd, expected, inherit=True):
        result = subprocess.run([lease, 'validate-inherited', str(root), '--lock-fd', str(fd)], pass_fds=(fd,) if inherit else (), capture_output=True)
        assert (result.returncode == 0) == expected, result
        assert json.loads(result.stdout if expected else result.stderr)['_tag'] == ('Validated' if expected else 'UnsafeLock')
    with lock.open('w+') as scope:
        fd = scope.fileno()
        validate(fd, False)
        fcntl.flock(fd, fcntl.LOCK_SH)
        validate(fd, False)
        fcntl.flock(fd, fcntl.LOCK_EX)
        validate(fd, True)
        validate(fd, False, inherit=False)
        # Validation neither unlocks nor downgrades the caller's description.
        with lock.open('r+') as independent:
            try:
                fcntl.flock(independent, fcntl.LOCK_SH | fcntl.LOCK_NB)
                raise AssertionError('exclusive fence was lost')
            except BlockingIOError:
                pass
        with (root / 'other').open('w+') as other:
            fcntl.flock(other, fcntl.LOCK_EX)
            validate(other.fileno(), False)
    base = [lease, 'run', str(root), '--mode', 'exclusive', '--try', '--agent', 'agent/test']
    payload = """
import fcntl, os, pathlib, subprocess
fd = int(os.environ['WORKTREE_LEASE_LOCK_FD'])
assert pathlib.Path(os.environ['WORKTREE_LEASE_WORKTREE']) == pathlib.Path.cwd().resolve()
fcntl.fcntl(fd, fcntl.F_GETFD)
base = [os.environ['LEASE'], 'run', str(pathlib.Path.cwd()), '--mode', 'exclusive', '--try', '--agent', 'agent/test']
assert subprocess.run(base + ['--inherited', '--', 'true'], pass_fds=(fd,)).returncode == 0
assert subprocess.run(base + ['--', 'true']).returncode == 75
assert subprocess.run(base + ['--inherited', '--', 'true']).returncode != 0
with open('foreign', 'w+') as other:
    fcntl.flock(other, fcntl.LOCK_EX)
    env = dict(os.environ, WORKTREE_LEASE_LOCK_FD=str(other.fileno()))
    assert subprocess.run(base + ['--inherited', '--', 'true'], env=env, pass_fds=(other.fileno(),)).returncode != 0
"""
    subprocess.check_call(base + ['--', 'python3', '-c', payload], cwd=root)
    # A surviving descendant's duplicate is explicitly unlocked when the payload exits.
    descendant = """
import os, pathlib, subprocess, sys
fd = int(os.environ['WORKTREE_LEASE_LOCK_FD'])
code = "import os,pathlib,time,subprocess; p=pathlib.Path('release');\\nwhile not p.exists(): time.sleep(.01)\\nr=subprocess.run([os.environ['LEASE'],'validate-inherited',str(pathlib.Path.cwd()),'--lock-fd',os.environ['WORKTREE_LEASE_LOCK_FD']],pass_fds=(int(os.environ['WORKTREE_LEASE_LOCK_FD']),),capture_output=True);pathlib.Path('result').write_text(str(r.returncode))"
subprocess.Popen([sys.executable, '-c', code], pass_fds=(fd,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
"""
    subprocess.check_call(base + ['--', 'python3', '-c', descendant], cwd=root)
    (root / 'release').touch()
    import time
    for _ in range(500):
        if (root / 'result').exists():
            break
        time.sleep(.01)
    assert (root / 'result').read_text() != '0'
