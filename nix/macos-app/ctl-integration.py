#!/usr/bin/env python3
"""Real codesign/keychain/rename/socket tests for macos-app-ctl.

Signing uses a throwaway keychain in tmp/ holding a self-signed, non-extractable
code-signing identity. The keychain is never added to the search list, the login
keychain is never touched, and the keychain file is removed afterwards. A fake
launchctl on PATH starts real hosts directly, so no background item is registered.
Every keychain operation has a timeout: a hang means a UI prompt and aborts the run.

From the Darwin checkout root:
  nix run .#macos-app-ctl-integration --option builders '' --option max-jobs 2
An existing macos-app-example store path can be passed as the first argument.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import sys
import tempfile

root = Path.cwd()
example = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(subprocess.check_output([
    'nix', 'build', '.#macos-app-example', '--no-link', '--print-out-paths',
    '--option', 'builders', '', '--option', 'max-jobs', '2'], text=True).strip())
scratch = root / 'tmp'
scratch.mkdir(exist_ok=True)
work = Path(tempfile.mkdtemp(prefix='macos-app-ctl-', dir=scratch))
with (scratch / 'TEMPORARY_FILES.md').open('a') as log:
    log.write(f'\n- `{work.relative_to(root)}`: primitive integration apps, fake launchctl state, '
              'signing logs; its throwaway keychain file is removed by the runner.\n')
ctl = example / 'primitives/bin/macos-app-ctl'
base_config = json.loads((example / 'ctl-config.json').read_text())
bin_dir = work / 'bin'
bin_dir.mkdir()
state = work / 'state'
app = work / 'apps/SyntheticHost.app'
plists = work / 'plists'
sock = str(work.relative_to(root) / 'host.sock')
desired = example / 'hostApp/SyntheticHost.app'
uid = os.getuid()
first = work / 'generation-first'
second = work / 'generation-second'
for source, target in [(example / 'generation', first), (example / 'secondGeneration', second)]:
    target.mkdir()
    manifest = json.loads((source / 'manifest.json').read_text())
    manifest['statusAllowedUids'] = [uid]
    (target / 'manifest.json').write_text(json.dumps(manifest))

PROMPT_TIMEOUT = 15
def tool(*args, check=True):
    try:
        result = subprocess.run(list(args), capture_output=True, text=True, timeout=PROMPT_TIMEOUT)
    except subprocess.TimeoutExpired:
        sys.exit(f'ABORT: {args[0]} {args[1]} hung; a keychain UI prompt may be pending. Stopping.')
    if check and result.returncode != 0:
        raise RuntimeError(f'{args}: {result.stderr}')
    return result

# Throwaway signing keychain; the password is test-only and may appear in test argv.
search_list = tool('/usr/bin/security', 'list-keychains', '-d', 'user').stdout
keychain = work / 'signing.keychain-db'
password = 'macos-app-ctl-test-' + os.urandom(8).hex()
identity = 'macos-app-ctl test signer'
(work / 'cs.cnf').write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n'
    f'[dn]\nCN={identity}\n[ext]\nbasicConstraints=critical,CA:false\n'
    'keyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n')
tool('/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(work / 'key.pem'),
     '-out', str(work / 'cert.pem'), '-days', '2', '-config', str(work / 'cs.cnf'))
tool('/usr/bin/openssl', 'pkcs12', '-export', '-inkey', str(work / 'key.pem'), '-in', str(work / 'cert.pem'),
     '-out', str(work / 'id.p12'), '-passout', 'pass:p12', '-name', identity)
(work / 'key.pem').unlink()
leaf = tool('/usr/bin/openssl', 'x509', '-in', str(work / 'cert.pem'), '-noout', '-fingerprint', '-sha1').stdout
leaf = leaf.split('=', 1)[1].strip().replace(':', '').lower()

hosts = []
def cleanup():
    if (work / 'jobs.json').exists():
        for job in json.loads((work / 'jobs.json').read_text()).values():
            try: os.kill(job['pid'], signal.SIGTERM)
            except ProcessLookupError: pass
    # File removal only: the keychain was never on the search list.
    keychain.unlink(missing_ok=True)
    assert tool('/usr/bin/security', 'list-keychains', '-d', 'user').stdout == search_list

try:
    tool('/usr/bin/security', 'create-keychain', '-p', password, str(keychain))
    # -x: the imported private key is non-extractable; the PEM/P12 copies are deleted at once.
    tool('/usr/bin/security', 'import', str(work / 'id.p12'), '-k', str(keychain), '-P', 'p12', '-x',
         '-T', '/usr/bin/codesign')
    (work / 'id.p12').unlink()
    # Minimal partition list: codesign: alone lets codesign use the key without a prompt.
    tool('/usr/bin/security', 'set-key-partition-list', '-S', 'codesign:', '-s', '-k', password, str(keychain))
    assert tool('/usr/bin/security', 'list-keychains', '-d', 'user').stdout == search_list
    tool('/usr/bin/security', 'lock-keychain', str(keychain))
    print('PASS throwaway keychain: not on search list, partition list codesign: only', flush=True)

    security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    def unlocked():
        reference = ctypes.c_void_p()
        assert security.SecKeychainOpen(str(keychain).encode(), ctypes.byref(reference)) == 0
        status = ctypes.c_uint32()
        # SecKeychainGetStatus reads state only; it never shows UI.
        assert security.SecKeychainGetStatus(reference, ctypes.byref(status)) == 0
        return bool(status.value & 1)
    def unlock_for_test():
        tool('/usr/bin/security', 'unlock-keychain', '-p', password, str(keychain))
        assert unlocked()

    unlock_for_test()
    exported = tool('/usr/bin/security', 'export', '-k', str(keychain), '-t', 'identities', '-f', 'pkcs12',
                    '-P', 'export', '-o', str(work / 'exported.p12'), check=False)
    assert exported.returncode != 0 and not (work / 'exported.p12').exists(), exported
    tool('/usr/bin/security', 'lock-keychain', str(keychain))
    print('PASS signing key is non-extractable: identity export fails while unlocked', flush=True)

    requirement = f'identifier "dev.example.synthetic-host" and certificate leaf = H"{leaf}"'
    config = dict(base_config, requirement=requirement, signer={'teamId': 'TEST', 'identity': identity})
    config_file = work / 'config.json'
    def write_config(**changes):
        config_file.write_text(json.dumps(dict(config, **changes)))
    write_config()

    # The substitute models per-domain jobs and starts actual hosts directly, without launchd.
    launchctl = bin_dir / 'launchctl'
    launchctl.write_text(f'#!{sys.executable}\n' + r'''
import json, os, signal, subprocess, sys, time, plistlib
from pathlib import Path
base = Path(os.environ['MACOS_APP_TEST_WORK'])
args = sys.argv[1:]
jobs_file = base / 'jobs.json'
jobs = json.loads(jobs_file.read_text()) if jobs_file.exists() else {}
if args[0] == 'print':
    target = args[1]
    if target.count('/') < 2:
        if target.startswith('gui/') and (base / 'gui-absent').exists(): sys.exit(1)
        sys.exit(0)
    if target not in jobs: sys.exit(1)
    print('pid =', jobs[target]['pid'])
    sys.exit(0)
if (base / 'launchctl-fail').exists():
    print('test-injected launchctl failure', file=sys.stderr)
    sys.exit(5)
with (base / 'launchctl.log').open('a') as log: log.write(json.dumps(args) + '\n')
def stop(job):
    os.kill(job['pid'], signal.SIGTERM)
    for _ in range(500):
        if not Path(job['socket']).exists(): return
        time.sleep(.01)
    raise RuntimeError('host did not remove socket')
def start(plist_path):
    with open(plist_path, 'rb') as f: plist = plistlib.load(f)
    argv = plist['ProgramArguments']
    assert plist['Program'] == argv[0] and '/Contents/MacOS/' in argv[0]
    log = (base / 'host.log').open('ab')
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    sock = argv[argv.index('--socket') + 1]
    for _ in range(500):
        if Path(sock).exists(): break
        if process.poll() is not None: raise RuntimeError('host failed to start')
        time.sleep(.01)
    else: raise RuntimeError('host not ready')
    return plist['Label'], {'pid': process.pid, 'socket': sock, 'plist': plist_path}
if args[0] == 'bootout':
    stop(jobs.pop(args[1]))
elif args[0] == 'bootstrap':
    label, job = start(args[2])
    jobs[args[1] + '/' + label] = job
elif args[:2] == ['kickstart', '-k']:
    stop(jobs[args[2]])
    jobs[args[2]] = start(jobs[args[2]]['plist'])[1]
else: raise RuntimeError('unexpected launchctl operation')
jobs_file.write_text(json.dumps(jobs))
''')
    launchctl.chmod(0o755)
    # Pass-through codesign that records argv (to prove the password never appears) and can
    # inject a signing failure without touching any keychain.
    codesign = bin_dir / 'codesign'
    codesign.write_text(f'#!{sys.executable}\n' + r'''
import json, os, subprocess, sys
from pathlib import Path
base = Path(os.environ['MACOS_APP_TEST_WORK'])
args = sys.argv[1:]
with (base / 'codesign.log').open('a') as log: log.write(json.dumps({'argv': args, 'env': sorted(os.environ.items())}) + '\n')
if '--sign' in args:
    with (base / 'sign.log').open('a') as log: log.write('sign\n')
    if (base / 'sign-fail').exists():
        print('test-injected signing failure', file=sys.stderr)
        sys.exit(1)
sys.exit(subprocess.call(['/usr/bin/codesign'] + args))
''')
    codesign.chmod(0o755)
    env = dict(os.environ, PATH=f'{bin_dir}:/usr/bin:/bin', MACOS_APP_TEST_WORK=str(work))

    common = ['--config', str(config_file), '--app-dir', str(app), '--state', str(state),
              '--socket', sock, '--plist-dir', str(plists)]
    def call(action, *args, code=0, secret=None, hold_open=False, failpoint=None):
        """`secret` str is sent with one trailing newline; bytes are sent verbatim.
        `hold_open` keeps the writer open so the reader never sees EOF."""
        fds = ()
        write = None
        if secret is not None:
            read, write = os.pipe()
            os.write(write, secret if isinstance(secret, bytes) else secret.encode() + b'\n')
            if not hold_open:
                os.close(write)
                write = None
            fds = (read,)
            args = (*args, '--keychain-password-fd', str(read))
        run_env = dict(env, MACOS_APP_CTL_TEST_FAILPOINT=failpoint) if failpoint else env
        try:
            process = subprocess.run([str(ctl), action, *common, *map(str, args)], env=run_env,
                                     capture_output=True, text=True, pass_fds=fds, timeout=60)
        except subprocess.TimeoutExpired:
            sys.exit(f'ABORT: {action} hung; a keychain UI prompt may be pending. Stopping.')
        finally:
            for fd in fds: os.close(fd)
            if write is not None: os.close(write)
        assert process.returncode == code, (action, process.returncode, process.stdout, process.stderr)
        if code == 137: return None
        lines = process.stdout.splitlines()
        assert len(lines) == 1, process.stdout
        return json.loads(lines[0])
    def install(desired_app, secret=password, *extra, code=0, failpoint=None):
        return call('install-host', '--desired', desired_app, '--keychain', keychain, *extra, code=code,
                    secret=secret, failpoint=failpoint)

    def contents(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()
    # The keychain database belongs to securityd, whose lock bookkeeping is not a ctl write.
    def snapshots():
        return {str(p.relative_to(work)): (p.lstat().st_mtime_ns, p.lstat().st_size)
                for p in work.rglob('*') if p.name not in ['host.log', 'codesign.log', keychain.name]}
    def log(path):
        return path.read_text() if path.exists() else ''

    assert install(desired)['result']['changed']
    assert not unlocked(), 'keychain left unlocked after signing'
    assert call('select-generation', '--generation', first)['result']['consumerRootRequired']
    assert call('converge-launchd')['result']['changed']
    call('verify', '--desired', desired, '--generation', first)
    print('PASS headless install: fd password, dedicated keychain, relocked afterwards', flush=True)

    before = snapshots()
    mutation_log = log(work / 'launchctl.log')
    signing_log = log(work / 'sign.log')
    # A previous run killed mid-window could leave the keychain unlocked; every run relocks first.
    unlock_for_test()
    assert not install(desired)['result']['changed']
    assert not unlocked(), 'install-host did not relock at start'
    assert not call('select-generation', '--generation', first)['result']['changed']
    assert not call('converge-launchd')['result']['changed']
    call('verify', '--desired', desired, '--generation', first)
    assert snapshots() == before, 'no-op wrote files or changed mtimes'
    assert log(work / 'launchctl.log') == mutation_log
    assert log(work / 'sign.log') == signing_log
    print('PASS no-op: no writes, signing or launchctl mutations; keychain relocked unconditionally', flush=True)

    call('select-generation', '--generation', second)
    assert not call('converge-launchd')['result']['changed']
    call('verify', '--desired', desired, '--generation', second)
    assert log(work / 'launchctl.log') == mutation_log
    print('PASS generation-only swap: running host rereads pointer, no restart', flush=True)

    changed = work / 'changed.app'
    shutil.copytree(desired, changed)
    for path in changed.rglob('*'):
        if not path.is_symlink(): path.chmod(path.stat().st_mode | 0o200)
    changed_executable = changed / 'Contents/MacOS/macos-app-host'
    subprocess.run(['/usr/bin/codesign', '--remove-signature', str(changed_executable)], check=True)
    original_hash = (changed / 'Contents/Resources/host-source-hash').read_text().strip()
    changed_hash = 'f' * 64
    host_bytes = changed_executable.read_bytes()
    assert original_hash.encode() in host_bytes
    changed_executable.write_bytes(host_bytes.replace(original_hash.encode(), changed_hash.encode()))
    (changed / 'Contents/Resources/host-source-hash').write_text(changed_hash)
    incumbent = contents(app / 'Contents/MacOS/macos-app-host')

    def expect_signing_failure(category, *args, secret=password, keychain_path=keychain, auth_pending=False,
                               hold_open=False, failpoint=None):
        extra = ['--signing-auth-pending'] if auth_pending else ['--keychain', keychain_path]
        result = call('install-host', '--desired', changed, *extra, *args, code=20,
                      secret=None if auth_pending else secret, hold_open=hold_open, failpoint=failpoint)
        assert result['error']['kind'] == 'signing-failed' and result['error']['category'] == category, result
        assert contents(app / 'Contents/MacOS/macos-app-host') == incumbent
        assert call('status')['result']['signingFailure']['category'] == category
        assert not list(app.parent.glob('.*stage*')), 'failed stage left behind'
    unlock_for_test()
    expect_signing_failure('signing-auth-pending', auth_pending=True)
    assert unlocked(), 'signing-auth-pending touched the keychain'
    tool('/usr/bin/security', 'lock-keychain', str(keychain))
    expect_signing_failure('keychain-missing', keychain_path=work / 'absent.keychain-db')
    expect_signing_failure('unlock-failed', secret='wrong-password')
    write_config(signer={'teamId': 'TEST', 'identity': 'identity absent from keychain'})
    expect_signing_failure('identity-missing')
    write_config(requirement=f'identifier "dev.example.synthetic-host" and certificate leaf = H"{"0" * 40}"')
    expect_signing_failure('dr-mismatch')
    write_config()
    (work / 'sign-fail').touch()
    expect_signing_failure('sign-failed')
    (work / 'sign-fail').unlink()
    assert not unlocked()
    signing_log = log(work / 'sign.log')
    expect_signing_failure('password-invalid', secret=b'')
    expect_signing_failure('password-invalid', secret=b'x' * 1025)
    # The correct password with the writer held open: no EOF within the deadline is rejected, not trusted.
    expect_signing_failure('password-invalid', secret=password.encode() + b'\n', hold_open=True)
    assert log(work / 'sign.log') == signing_log and not unlocked(), 'password-invalid reached unlock/codesign'
    expect_signing_failure('relock-failed', failpoint='relock')
    assert log(work / 'sign.log') != signing_log, 'relock failpoint fired before codesign ran'
    assert not unlocked()
    login = Path.home() / 'Library/Keychains/login.keychain-db'
    refused = call('install-host', '--desired', changed, '--keychain', login, code=64, secret='unused')
    assert 'login keychain' in refused['error']['reason']
    write_config(signer={'teamId': 'TEST', 'identity': '-'})
    assert call('install-host', '--desired', changed, '--keychain', keychain, code=64, secret=password)['error']['kind'] == 'invalid-input'
    write_config()
    print('PASS signing failures keep the incumbent: signing-auth-pending (keychain untouched), '
          'keychain-missing, unlock-failed, identity-missing, dr-mismatch, sign-failed, '
          'password-invalid (empty, over-long, no EOF) before unlock, relock-failed; '
          'login keychain and ad-hoc refused', flush=True)

    write_config(requirement=f'identifier "dev.example.synthetic-host" and certificate leaf = H"{"0" * 40}"')
    call('verify', '--desired', desired, '--generation', second, code=22)
    write_config()
    print('PASS verify rejects an installed host whose DR differs from the declared requirement', flush=True)

    assert install(changed, failpoint='after-exchange', code=137) is None
    assert contents(app / 'Contents/MacOS/macos-app-host') != incumbent
    status = call('status')['result']
    assert status['interruptedTransaction'] and status['hostArchive'] is None, status
    reconciled = install(changed)['result']
    assert reconciled['reconciled'] == 'archive-published' and not reconciled['changed'], reconciled
    status = call('status')['result']
    assert not status['interruptedTransaction'] and Path(status['hostArchive']).is_dir()
    assert status['hostArchiveGeneration'] == str(second) and status['signingFailure'] is None, status
    assert call('converge-launchd')['result']['changed']
    call('verify', '--desired', changed, '--generation', second)
    print('PASS crash after exchange: next install reconciles the archive pointer instead of losing it', flush=True)

    call('rollback', '--restore-host')
    assert contents(app / 'Contents/MacOS/macos-app-host') == incumbent
    assert state.joinpath('current').readlink() == second, 'host-only rollback moved the generation'
    call('verify', '--desired', desired, '--generation', second)
    assert call('status')['result']['hostArchive'] is None
    assert not list(app.parent.glob('.*stage*')), 'rolled-away host left behind'
    mutation_log = log(work / 'launchctl.log')
    call('rollback')
    assert state.joinpath('current').readlink() == first
    call('verify', '--desired', desired, '--generation', first)
    assert log(work / 'launchctl.log') == mutation_log, 'generation rollback restarted the host'
    print('PASS host-only rollback keeps the generation it archived with; generation rollback uses S/previous', flush=True)

    installed = install(changed)['result']
    assert installed['changed'] and Path(installed['archive']).is_dir() and installed['reconciled'] is None
    assert call('converge-launchd')['result']['changed']
    call('verify', '--desired', changed, '--generation', first)
    metadata = work / 'metadata.app'
    shutil.copytree(changed, metadata)
    for path in metadata.rglob('*'):
        if not path.is_symlink(): path.chmod(path.stat().st_mode | 0o200)
    with (metadata / 'Contents/Info.plist').open('rb') as f: info = plistlib.load(f)
    info['LSBackgroundOnly'] = not info.get('LSBackgroundOnly', False)
    with (metadata / 'Contents/Info.plist').open('wb') as f: plistlib.dump(info, f)
    first_archive = installed['archive']
    # Removing the superseded archive is post-commit cleanup: its failure is a leftover, not an undo.
    reinstalled = install(metadata, failpoint='cleanup')['result']
    assert reinstalled['changed'] and reinstalled['hostSourceHash'] == installed['hostSourceHash']
    assert reinstalled['bundleMetadataDigest'] != installed['bundleMetadataDigest']
    assert reinstalled['leftovers'] == [first_archive], reinstalled
    status = call('status')['result']
    assert status['hostArchive'] == reinstalled['archive'] != first_archive and not status['interruptedTransaction']
    assert status['bundleMetadataDigest'] == reinstalled['bundleMetadataDigest'], 'cleanup failure undid the exchange'
    shutil.rmtree(first_archive)
    assert len(list(app.parent.glob('.*stage*'))) == 1
    call('verify', '--desired', changed, '--generation', first, code=22)
    assert call('converge-launchd')['result']['changed'], 'metadata-only exchange did not restart'
    call('verify', '--desired', metadata, '--generation', first)
    assert not install(metadata)['result']['changed']
    print('PASS metadata-only change (same host hash) re-signs, exchanges and restarts; verify checks Info.plist', flush=True)

    third = work / 'generation-owner-only'
    third.mkdir()
    manifest = json.loads((second / 'manifest.json').read_text())
    manifest['socketMode'] = 0o600
    (third / 'manifest.json').write_text(json.dumps(manifest))
    call('select-generation', '--generation', third)
    call('verify', '--desired', metadata, '--generation', third, code=22)
    converged = call('converge-launchd')['result']
    assert converged['changed'] and converged['restart'] == 'socket-mode', converged
    assert json.loads(log(work / 'launchctl.log').splitlines()[-1])[:2] == ['kickstart', '-k']
    call('verify', '--desired', metadata, '--generation', third)
    assert call('status')['result']['socketMode'] == 0o600
    assert not call('converge-launchd')['result']['changed']
    print('PASS startup-only socketMode change restarts via kickstart; verify checks the socket mode', flush=True)

    def stages():
        return sorted(str(p) for p in app.parent.glob('.*stage*'))
    metadata_archive = call('status')['result']['hostArchive']
    assert install(changed, failpoint='after-archive-pointer', code=137) is None
    status = call('status')['result']
    assert status['interruptedTransaction'] and status['hostArchive'] != metadata_archive
    published = install(changed)['result']
    assert published['reconciled'] == 'archive-published' and not published['changed'] and published['leftovers'] == []
    assert not Path(metadata_archive).exists() and stages() == [call('status')['result']['hostArchive']]
    assert call('converge-launchd')['result']['changed']
    call('verify', '--desired', changed, '--generation', third)
    print('PASS crash after the archive pointer: reconcile rolls publication forward and removes the superseded archive', flush=True)

    (work / 'launchctl-fail').touch()
    call('rollback', '--restore-host', code=23)
    status = call('status')['result']
    assert status['interruptedRollback'] and status['hostArchive'] and status['hostArchiveGeneration'] == str(third), status
    (work / 'launchctl-fail').unlink()
    resumed = call('rollback', '--restore-host')['result']
    assert resumed['resumed'] and resumed['leftovers'] == [], resumed
    call('verify', '--desired', metadata, '--generation', third)
    status = call('status')['result']
    assert not status['interruptedRollback'] and status['hostArchive'] is None and stages() == []
    restored = contents(app / 'Contents/MacOS/macos-app-host')
    assert call('rollback', '--restore-host', code=22)['error']['reason'] == 'No archived host'
    assert contents(app / 'Contents/MacOS/macos-app-host') == restored, 'repeated rollback flipped back'
    print('PASS host rollback survives a launchctl failure after the exchange and resumes to verify', flush=True)

    assert install(changed)['result']['changed']
    call('converge-launchd')
    assert call('rollback', '--restore-host', failpoint='rollback-after-exchange', code=137) is None
    assert call('status')['result']['interruptedRollback']
    resumed = call('rollback')['result']
    assert resumed['resumed'] and state.joinpath('current').readlink() == third
    call('verify', '--desired', metadata, '--generation', third)
    assert call('status')['result']['hostArchive'] is None and stages() == []
    assert install(changed)['result']['changed']
    call('converge-launchd')
    assert call('rollback', '--restore-host', failpoint='rollback-after-exchange', code=137) is None
    reinstalled = install(changed)['result']
    assert reinstalled['reconciled'] == 'rollback-host-restored' and reinstalled['changed'], reinstalled
    status = call('status')['result']
    assert not status['interruptedRollback'] and status['hostArchiveGeneration'] == str(third), status
    call('converge-launchd')
    call('verify', '--desired', changed, '--generation', third)
    print('PASS crash after the rollback exchange: rollback resumes to verify; install-host completes it first', flush=True)

    calls = [json.loads(line) for line in log(work / 'codesign.log').splitlines()]
    assert calls and all(password not in json.dumps(entry) for entry in calls)
    print('PASS keychain password never appears in codesign argv or environment', flush=True)

    (work / 'gui-absent').touch()
    write_config(session='gui-agent')
    before_log = log(work / 'launchctl.log')
    assert call('converge-launchd', code=21)['error']['kind'] == 'gui-absent'
    assert log(work / 'launchctl.log') == before_log
    assert call('status')['result']['session'] == 'background-only'
    write_config(session='gui-agent')
    assert call('converge-launchd', '--domain', 'user', code=64)['error']['kind'] == 'invalid-input'
    write_config()
    assert call('converge-launchd', '--domain', 'system', code=64)['error']['kind'] == 'invalid-input'
    assert log(work / 'launchctl.log') == before_log
    assert call('status')['result']['launchd']['domain'] == f'user/{uid}'
    print('PASS GUI-absent is explicit; gui-agent/user and background-agent/system overrides refused; '
          'background agent resolves user domain', flush=True)
    (work / 'gui-absent').unlink()

    other = work / 'Other.app'
    shutil.copytree(desired, other)
    for path in other.rglob('*'):
        if not path.is_symlink(): path.chmod(path.stat().st_mode | 0o200)
    with (other / 'Contents/Info.plist').open('rb') as f: info = plistlib.load(f)
    info['CFBundleIdentifier'] = 'dev.example.other-host'
    with (other / 'Contents/Info.plist').open('wb') as f: plistlib.dump(info, f)
    config = dict(config, bundleId='dev.example.other-host',
                  requirement=f'identifier "dev.example.other-host" and certificate leaf = H"{leaf}"',
                  launchd=dict(config['launchd'], label='dev.example.other-host'))
    write_config()
    other_app = work / 'apps/Other.app'
    common[common.index('--app-dir') + 1] = str(other_app)
    common[common.index('--state') + 1] = str(work / 'other-state')
    common[common.index('--socket') + 1] = str(work.relative_to(root) / 'other.sock')
    install(other)
    call('select-generation', '--generation', first)
    call('converge-launchd')
    call('verify', '--desired', other, '--generation', first)
    dr_a = subprocess.run(['/usr/bin/codesign', '-d', '-r-', str(app)], capture_output=True, text=True).stdout
    dr_b = subprocess.run(['/usr/bin/codesign', '-d', '-r-', str(other_app)], capture_output=True, text=True).stdout
    assert 'identifier "dev.example.synthetic-host"' in dr_a and 'identifier "dev.example.other-host"' in dr_b
    jobs = json.loads((work / 'jobs.json').read_text())
    assert len({job['socket'] for job in jobs.values()}) == 2
    assert plists.joinpath('dev.example.synthetic-host.plist').is_file()
    assert plists.joinpath('dev.example.other-host.plist').is_file()
    print('PASS two products: distinct DR, app directory, label and socket', flush=True)

    # Host-only rollback for a product that never had a generation swap (no S/previous).
    other_changed = work / 'OtherChanged.app'
    shutil.copytree(changed, other_changed)
    for path in other_changed.rglob('*'):
        if not path.is_symlink(): path.chmod(path.stat().st_mode | 0o200)
    shutil.copy(other / 'Contents/Info.plist', other_changed / 'Contents/Info.plist')
    assert not (work / 'other-state/previous').exists()
    assert install(other_changed)['result']['changed']
    call('converge-launchd')
    call('verify', '--desired', other_changed, '--generation', first)
    call('rollback', '--restore-host')
    assert (work / 'other-state/current').readlink() == first
    call('verify', '--desired', other, '--generation', first)
    print('PASS host-only rollback works without a previous generation', flush=True)
finally:
    cleanup()
print('PASS throwaway keychain removed; user search list unchanged')
print(f'PASS primitive integration; scratch: {work.relative_to(root)}')
