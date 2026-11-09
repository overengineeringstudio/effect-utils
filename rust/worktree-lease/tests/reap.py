import fcntl, json, os, pathlib, subprocess, tempfile
lease = os.environ['LEASE']
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    def git(*args, cwd=root):
        return subprocess.check_output(['git', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', *args], cwd=cwd, stderr=subprocess.DEVNULL).decode().strip()
    git('init', '-q')
    (root / 'tracked').write_text('initial')
    git('add', 'tracked')
    git('commit', '-qm', 'initial')
    common = root / '.git'
    managed = common / 'gate-worktrees'
    managed.mkdir()
    tree = managed / 'candidate'
    git('worktree', 'add', '--detach', str(tree))
    subprocess.check_call([lease, 'create', str(tree), '--purpose', 'gate', '--creator', 'agent/test', '--holder-pid', str(os.getpid()), '--ttl', '60'], stdout=subprocess.DEVNULL)
    admin = pathlib.Path(git('rev-parse', '--absolute-git-dir', cwd=tree))
    record_path = admin / 'gate-lease.json'
    record = json.loads(record_path.read_text())
    record.update(createdAt='2000-01-01T00:00:00Z', expiresAt='2001-01-01T00:00:00Z')
    record['holder']['pid'] = 2147483647
    record_path.write_text(json.dumps(record))
    git('update-ref', 'refs/remotes/test/main', 'HEAD')
    def reap(*extra):
        result = subprocess.check_output([lease, 'reap', '--common-dir', str(common), *extra, '--', 'true'])
        return {pathlib.Path(d['worktree']).name: d for d in map(json.loads, result.splitlines())}
    decision = reap()['candidate']
    assert decision['_tag'] == 'Eligible' or decision['reason'] == 'CwdLiveOrUnknown', decision
    # Restricted procfs must retain rather than manufacture absence.
    assert reap('--scheduled') == {}
    (managed / 'alias').symlink_to(tree)
    (managed / 'unregistered').mkdir()
    decisions = reap()
    assert decisions['alias']['reason'] == 'NotManagedChild'
    assert decisions['unregistered']['_tag'] == 'Retained'
    child = subprocess.Popen(['sleep', '30'], cwd=tree)
    try:
        assert reap()['candidate']['reason'] == 'CwdLiveOrUnknown'
    finally:
        child.terminate()
        child.wait()
    (tree / 'tracked').write_text('modified')
    assert reap()['candidate']['reason'] == 'Dirty'
    git('checkout', '--', 'tracked', cwd=tree)
    (tree / 'untracked').write_text('new')
    assert reap()['candidate']['reason'] == 'Dirty'
    (tree / 'untracked').unlink()
    git('update-ref', '-d', 'refs/remotes/test/main')
    assert reap()['candidate']['reason'] == 'HeadNotOnRemote'
    assert (common / 'gate-worktrees.reap.cursor').read_bytes()
    (common / 'gate-worktrees.reap.cursor').write_bytes(b'invalid/cursor')
    assert subprocess.run([lease, 'reap', '--common-dir', str(common), '--', 'true'], capture_output=True).returncode == 1
    with (common / 'gate-worktrees.reap.lock').open('r+') as fence:
        fcntl.flock(fence, fcntl.LOCK_EX)
        assert subprocess.run([lease, 'reap', '--common-dir', str(common), '--', 'true'], capture_output=True).returncode == 75
