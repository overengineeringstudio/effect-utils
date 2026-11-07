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
