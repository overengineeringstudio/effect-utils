import fcntl, json, os, pathlib, shutil, subprocess, tempfile
lease = os.environ['LEASE']
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp).resolve()
    repo, tree = root / 'repo', root / 'tree'
    subprocess.check_call(['git', 'init', '-q', str(repo)])
    subprocess.check_call(['git', '-C', str(repo), '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '--allow-empty', '-qm', 'initial'])
    subprocess.check_call(['git', '-C', str(repo), 'worktree', 'add', '-q', str(tree)])
    admin = repo / '.git/worktrees/tree'
    def guard(path=admin):
        return subprocess.run([lease, 'guard', '--orphan-admin', str(path), '--agent', 'unit/maintenance.service'], capture_output=True)
    assert guard().returncode != 0
    subprocess.check_call([lease, 'create', str(tree), '--purpose', 'gate', '--creator', 'agent/test', '--holder-pid', str(os.getpid()), '--ttl', '60'], stdout=subprocess.DEVNULL)
    shutil.rmtree(tree)
    assert guard().returncode != 0  # Live record evidence still vetoes an orphan.
    record_path = admin / 'gate-lease.json'
    record = json.loads(record_path.read_text())
    record.update(createdAt='2000-01-01T00:00:00Z', expiresAt='2001-01-01T00:00:00Z')
    record['holder']['pid'] = 2147483647
    record_path.write_text(json.dumps(record))
    assert guard().returncode == 0
    with (admin / 'gate-lease.lock').open('r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        result = guard()
        assert result.returncode == 75 and b'Busy' in result.stderr, result
    for name in ['gate-lease.lock', 'gate-lease.json']:
        path = admin / name
        if path.exists(): path.unlink()
        path.symlink_to(root / 'missing')
        assert guard().returncode != 0
        path.unlink()
    (admin / 'gate-lease.json').write_text('{}')
    assert guard().returncode != 0
    (admin / 'gate-lease.json').unlink()
    (admin / 'reclaim-keep').touch()
    assert guard().returncode != 0
    (admin / 'reclaim-keep').unlink()
    link = root / 'link'
    link.symlink_to(admin)
    assert guard(link).returncode != 0
    outside = root / 'outside'
    shutil.copytree(admin, outside)
    (outside / 'commondir').write_text(str(repo / '.git'))
    escape = repo / '.git/worktrees/escape'
    escape.symlink_to(outside)
    assert guard(escape).returncode != 0
    assert guard(outside).returncode != 0
    # Existing directory with a .git file that no longer points back is orphaned.
    tree.mkdir()
    (tree / '.git').write_text('gitdir: ' + str(outside))
    assert guard().returncode == 0
    # Reattachment invalidates the orphan identity again.
    (tree / '.git').write_text('gitdir: ' + str(admin))
    assert guard().returncode != 0
