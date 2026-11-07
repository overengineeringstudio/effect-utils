import fcntl, json, os, pathlib, subprocess, tempfile
lease = os.environ['LEASE']
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    subprocess.check_call(['git', 'init', '-q', str(root)])
    def invoke(*args, **kwargs):
        return subprocess.run([lease, *args], capture_output=True, **kwargs)
    for actor in ['unit/maintenance@daily.service', 'launchd/org.example.maintenance']:
        assert invoke('run', str(root), '--mode', 'exclusive', '--try', '--agent', actor, '--', 'true').returncode == 0
        assert invoke('guard', '--git-dir', str(root / '.git'), '--agent', actor).returncode == 0
        for args in [
            ['create', str(root), '--purpose', 'gate', '--creator', actor, '--holder-pid', str(os.getpid()), '--ttl', '60'],
            ['compat', 'write', str(root), 'gate', actor, str(os.getpid()), '60'],
        ]:
            assert invoke(*args, env={'PATH': os.environ['PATH']}).returncode != 0
        assert not (root / '.git/gate-lease.json').exists()
    assert invoke('create', str(root), '--purpose', 'gate', '--creator', 'agent/test', '--holder-pid', str(os.getpid()), '--ttl', '60').returncode == 0
    original = (root / '.git/gate-lease.json').read_bytes()
    for actor in ['unit/maintenance.service', 'launchd/org.example']:
        assert invoke('renew', str(root), '--agent', actor, '--holder-pid', str(os.getpid()), '--ttl', '120').returncode != 0
        assert (root / '.git/gate-lease.json').read_bytes() == original
        for field in ['creatorSeat', 'holder']:
            record = json.loads(original)
            if field == 'holder':
                record[field]['agent'] = actor
            else:
                record[field] = actor
            (root / '.git/gate-lease.json').write_text(json.dumps(record))
            assert invoke('inspect', str(root), '--json').returncode != 0
            (root / '.git/gate-lease.json').write_bytes(original)
        with (root / '.git/gate-lease.lock').open('r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            assert invoke('validate-inherited', str(root), '--lock-fd', str(lock.fileno()), '--agent', actor, pass_fds=(lock.fileno(),)).returncode == 0
        result = invoke('reap', '--common-dir', str(root / '.git'), '--agent', actor, '--', 'true')
        assert result.returncode == 0, result
    for actor in ['unit/a/b.service', 'launchd/.hidden', 'launchd/a:b', 'unit/a.timer']:
        assert invoke('run', str(root), '--mode', 'exclusive', '--try', '--agent', actor, '--', 'true').returncode != 0
