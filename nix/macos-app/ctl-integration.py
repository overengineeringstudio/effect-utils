#!/usr/bin/env python3
"""Real codesign/keychain/rename/socket tests for macos-app-ctl.

Signing uses throwaway keychains under tmp/<work>/Library/Keychains/ (a partition-capable location,
so securityd's partition checks are real) provisioned by the ctl primitives: a non-extractable key,
a CSR signed by a test CA, the imported certificate and the codesign pin. The keychains are never
on the search list, the login keychain is never touched, and only the keychain files are removed.
A fake launchctl on PATH starts real hosts directly, so no background item is registered.
Every keychain operation has a timeout, and every ctl call is watched for a new on-screen
SecurityAgent window: a hang or a window means a UI prompt and aborts the run loudly.

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
import time
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

# Tripwire: on-screen windows owned by SecurityAgent (owner names need no TCC grant).
core_foundation = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
core_graphics = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
core_graphics.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
core_graphics.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
core_foundation.CFArrayGetCount.restype = ctypes.c_long
core_foundation.CFArrayGetCount.argtypes = [ctypes.c_void_p]
core_foundation.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
core_foundation.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
core_foundation.CFDictionaryGetValue.restype = ctypes.c_void_p
core_foundation.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
core_foundation.CFStringGetCString.restype = ctypes.c_bool
core_foundation.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
core_foundation.CFRelease.argtypes = [ctypes.c_void_p]
owner_key = ctypes.c_void_p.in_dll(core_graphics, 'kCGWindowOwnerName').value
def security_agent_windows():
    windows = core_graphics.CGWindowListCopyWindowInfo(1, 0)  # on-screen only
    try:
        names = []
        for i in range(core_foundation.CFArrayGetCount(windows)):
            name = core_foundation.CFDictionaryGetValue(core_foundation.CFArrayGetValueAtIndex(windows, i), owner_key)
            buffer = ctypes.create_string_buffer(256)
            if name and core_foundation.CFStringGetCString(name, buffer, 256, 0x08000100): names.append(buffer.value)
        return names.count(b'SecurityAgent')
    finally:
        core_foundation.CFRelease(windows)
agent_baseline = security_agent_windows()
def watched(argv, **kwargs):
    """Runs argv, killing its process group and aborting if a SecurityAgent window appears."""
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                               start_new_session=True, **kwargs)
    deadline = time.monotonic() + 60
    while process.poll() is None:
        if security_agent_windows() > agent_baseline or time.monotonic() > deadline:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            sys.exit(f'ABORT: {argv[1]} raised a SecurityAgent window or hung; a keychain prompt was requested. Stopping.')
        time.sleep(0.1)
    stdout, stderr = process.communicate()
    assert security_agent_windows() <= agent_baseline, f'{argv[1]} left a SecurityAgent window'
    return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)

# Throwaway signing keychains; the password is test-only and may appear in test argv.
search_list = tool('/usr/bin/security', 'list-keychains', '-d', 'user').stdout
keychains = work / 'Library/Keychains'
keychains.mkdir(parents=True)
keychain = keychains / 'signing.keychain-db'
unpinned = keychains / 'unpinned.keychain-db'
password = 'macos-app-ctl-test-' + os.urandom(8).hex()
identity = 'macos-app-ctl test signer'
# A test CA issues the code-signing certificates from the CSRs the ctl primitives write.
tool('/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(work / 'ca.key'),
     '-out', str(work / 'ca.pem'), '-days', '2', '-subj', '/CN=macos-app-ctl test CA')
(work / 'leaf.cnf').write_text('basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\n'
                               'extendedKeyUsage=critical,codeSigning\n')
def issue(csr, cert):
    tool('/usr/bin/openssl', 'x509', '-req', '-in', str(csr), '-CA', str(work / 'ca.pem'), '-CAkey', str(work / 'ca.key'),
         '-CAcreateserial', '-out', str(cert), '-days', '2', '-extfile', str(work / 'leaf.cnf'))

hosts = []
def cleanup():
    if (work / 'jobs.json').exists():
        for job in json.loads((work / 'jobs.json').read_text()).values():
            try: os.kill(job['pid'], signal.SIGTERM)
            except ProcessLookupError: pass
    # File removal only: the keychains were never on the search list.
    keychain.unlink(missing_ok=True)
    unpinned.unlink(missing_ok=True)
    for path in (keychain, unpinned):
        Path(f'{path}.acl.json').unlink(missing_ok=True)
    (work / 'ca.key').unlink(missing_ok=True)
    assert tool('/usr/bin/security', 'list-keychains', '-d', 'user').stdout == search_list

try:
    security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    def unlocked(path=keychain):
        reference = ctypes.c_void_p()
        assert security.SecKeychainOpen(str(path).encode(), ctypes.byref(reference)) == 0
        status = ctypes.c_uint32()
        # SecKeychainGetStatus reads state only; it never shows UI.
        assert security.SecKeychainGetStatus(reference, ctypes.byref(status)) == 0
        return bool(status.value & 1)
    def unlock_for_test():
        tool('/usr/bin/security', 'unlock-keychain', '-p', password, str(keychain))
        assert unlocked()

    config = dict(base_config, signer={'teamId': 'TEST', 'identity': identity})
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
# exec keeps the pid, so ctl's signing deadline kills the real codesign, not just this shim.
os.execv('/usr/bin/codesign', ['codesign'] + args)
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
            process = watched([str(ctl), action, *common, *map(str, args)], env=run_env, pass_fds=fds)
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

    # Provisioning: key and CSR by ctl, certificate by the test CA, then the codesign pin.
    def key_call(action, path, *args, code=0, secret=password):
        return call(action, '--keychain', path, *args, code=code, secret=secret)
    provisioned = key_call('provision-signing-key', keychain, '--common-name-hint', identity, '--csr-out', work / 'signing.csr')['result']
    assert provisioned['createdKeychain'] and provisioned['mode'] == '0600' and provisioned['retainedPrivateKeys'] == []
    assert provisioned['lockOnSleep'] and provisioned['lockIntervalSeconds'] == 300
    assert oct(keychain.stat().st_mode & 0o777) == '0o600' and not unlocked()
    record_path = Path(f'{keychain}.acl.json')
    record = json.loads(record_path.read_text())
    assert oct(record_path.stat().st_mode & 0o777) == '0o600' and record['keychain'] == str(keychain), record
    ctl_path = provisioned['ctlPath']
    assert record['keys'] == {provisioned['publicKeySha256']: {'ctlPath': ctl_path, 'ctlCdhash': provisioned['ctlCdhash']}}, record
    assert Path(ctl_path).name == 'macos-app-ctl' and len(provisioned['ctlCdhash']) == 40, provisioned
    assert tool('/usr/bin/security', 'list-keychains', '-d', 'user').stdout == search_list
    assert tool('/usr/bin/openssl', 'req', '-in', str(work / 'signing.csr'), '-noout', '-verify').returncode == 0
    issue(work / 'signing.csr', work / 'signing.pem')
    refused = key_call('provision-signing-key', keychain, '--common-name-hint', identity, '--csr-out', work / 'again.csr', code=64)
    assert 'already holds 1 private key' in refused['error']['reason'] and not (work / 'again.csr').exists()
    assert key_call('import-signing-cert', keychain, '--cert', work / 'ca.pem', code=22)['error']['kind'] == 'verification-failed'
    imported = key_call('import-signing-cert', keychain, '--cert', work / 'signing.pem')['result']
    assert imported['imported'] and imported['identity'] and imported['subject'] == identity
    assert not key_call('import-signing-cert', keychain, '--cert', work / 'signing.pem')['result']['imported']
    leaf = imported['certificateSha1']
    # codesign embeds the chain up to a self-signed root; the test CA stands in for Apple's roots.
    # A certificate add uses no key, so no key ACL is consulted; interaction stays disabled.
    def add_ca(path):
        tool('/usr/bin/openssl', 'x509', '-in', str(work / 'ca.pem'), '-outform', 'DER', '-out', str(work / 'ca.der'))
        blob = (work / 'ca.der').read_bytes()
        void = ctypes.c_void_p
        core_foundation.CFDataCreate.restype = void
        core_foundation.CFDataCreate.argtypes = [void, ctypes.c_char_p, ctypes.c_long]
        core_foundation.CFDictionaryCreate.restype = void
        core_foundation.CFDictionaryCreate.argtypes = [void, void, void, ctypes.c_long, void, void]
        security.SecCertificateCreateWithData.restype = void
        security.SecCertificateCreateWithData.argtypes = [void, void]
        security.SecItemAdd.argtypes = [void, void]
        security.SecKeychainUnlock.argtypes = [void, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_bool]
        security.SecKeychainSetUserInteractionAllowed(False)
        reference = void()
        assert security.SecKeychainOpen(str(path).encode(), ctypes.byref(reference)) == 0
        assert security.SecKeychainUnlock(reference, len(password), password.encode(), True) == 0
        certificate = security.SecCertificateCreateWithData(None, core_foundation.CFDataCreate(None, blob, len(blob)))
        symbol = lambda name: void.in_dll(security, name).value
        keys = (void * 3)(symbol('kSecClass'), symbol('kSecValueRef'), symbol('kSecUseKeychain'))
        values = (void * 3)(symbol('kSecClassCertificate'), certificate, reference.value)
        callbacks = lambda name: ctypes.addressof(void.in_dll(core_foundation, name))
        query = core_foundation.CFDictionaryCreate(None, keys, values, 3, callbacks('kCFTypeDictionaryKeyCallBacks'),
                                                   callbacks('kCFTypeDictionaryValueCallBacks'))
        assert security.SecItemAdd(query, None) in (0, -25299)  # added or already present
        security.SecKeychainLock(reference)
        assert not unlocked(path)
    add_ca(keychain)
    login = Path.home() / 'Library/Keychains/login.keychain-db'
    assert 'login keychain' in key_call('provision-signing-key', login, '--common-name-hint', 'x', '--csr-out', work / 'x.csr', code=64, secret='unused')['error']['reason']
    assert 'Library/Keychains' in key_call('provision-signing-key', work / 'elsewhere.keychain-db', '--common-name-hint', 'x', '--csr-out', work / 'x.csr', code=64)['error']['reason']
    assert key_call('prove-signing-key', keychain, code=20, secret=b'')['error']['category'] == 'password-invalid'
    assert not (work / 'elsewhere.keychain-db').exists() and not (work / 'x.csr').exists()
    print('PASS provisioning: 0600 keychain off the search list, lock on sleep/300s, CSR verifies, '
          'existing key refused, non-pairing cert refused, idempotent import, login/elsewhere/empty password refused', flush=True)

    # Dry pass first: pin and guard without running codesign, then the full proof.
    dry = key_call('prove-signing-key', keychain, '--no-sign')['result']
    assert dry['guardReady'] and dry['signOk'] is None and dry['signSkipped'], dry
    assert dry['exportAttempted'] and dry['exportRefused'] and dry['exportStatus'] != 0, dry
    proof = key_call('prove-signing-key', keychain)['result']
    assert proof['partitionCapable'] and proof['guardReady'] and proof['signOk'] is True, proof
    assert proof['partitionList'] == ['apple:'] and proof['signAclExact'] and proof['recordedCtlPath'] == ctl_path, proof
    assert proof['securityToolExcluded'], proof
    assert proof['keyExtractable'] is False and proof['exportRefused'] and not proof['exportAttempted'], proof
    assert proof['lockedAfterWindow'] and proof['lockOnSleep'] and proof['lockIntervalSeconds'] == 300, proof
    assert not unlocked()
    print(f'PASS signing-key proof: {json.dumps(proof, sort_keys=True)}', flush=True)

    # --replace adds a key and never deletes; an unpinned identity is refused before codesign.
    unpinned_identity = 'macos-app-ctl unpinned signer'
    key_call('provision-signing-key', unpinned, '--common-name-hint', unpinned_identity, '--csr-out', work / 'unpinned.csr')
    replaced = key_call('provision-signing-key', unpinned, '--common-name-hint', unpinned_identity, '--csr-out', work / 'unpinned2.csr', '--replace')['result']
    assert replaced['retainedPrivateKeys'] == [unpinned_identity], replaced
    assert len(json.loads(Path(f'{unpinned}.acl.json').read_text())['keys']) == 2
    issue(work / 'unpinned2.csr', work / 'unpinned.pem')
    key_call('import-signing-cert', unpinned, '--cert', work / 'unpinned.pem')
    print('PASS --replace keeps the existing key, reports it and records the new key', flush=True)

    requirement = f'identifier "dev.example.synthetic-host" and certificate leaf = H"{leaf}"'
    config['requirement'] = requirement
    write_config()

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
    expect_signing_failure('keychain-missing', keychain_path=keychains / 'absent.keychain-db')
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
    elsewhere = call('install-host', '--desired', changed, '--keychain', work / 'elsewhere.keychain-db', code=64, secret=password)
    assert 'Library/Keychains' in elsewhere['error']['reason']
    # A real identity whose key was never pinned: refused by the guard, codesign never runs.
    signing_log = log(work / 'sign.log')
    write_config(signer={'teamId': 'TEST', 'identity': unpinned_identity})
    guarded = call('install-host', '--desired', changed, '--keychain', unpinned, code=22, secret=password)
    assert 'Codesign guard refused' in guarded['error']['reason'], guarded
    assert log(work / 'sign.log') == signing_log and not unlocked(unpinned), 'guard refusal reached codesign'
    write_config()
    # The ACL record decides which ctl the guard admits: missing refuses (64), a different
    # recorded path refuses (22); neither reaches codesign. Renames keep the record's mtime.
    def with_record(body, code, needle):
        saved = record_path.with_name(record_path.name + '.saved')
        record_path.rename(saved)
        try:
            if body is not None:
                record_path.write_text(json.dumps(body))
                record_path.chmod(0o600)
            refused = call('install-host', '--desired', changed, '--keychain', keychain, code=code, secret=password)
            assert needle in refused['error']['reason'], refused
        finally:
            record_path.unlink(missing_ok=True)
            saved.rename(record_path)
        assert log(work / 'sign.log') == signing_log and not unlocked(), 'ACL record refusal reached codesign'
    with_record(None, 64, 'ACL record')
    other = {key: {**entry, 'ctlPath': '/nix/store/0000-other/bin/macos-app-ctl'} for key, entry in record['keys'].items()}
    with_record({**record, 'keys': other}, 22, 'Codesign guard refused')
    assert contents(app / 'Contents/MacOS/macos-app-host') == incumbent
    write_config()
    print('PASS signing failures keep the incumbent: signing-auth-pending (keychain untouched), '
          'keychain-missing, unlock-failed, identity-missing, dr-mismatch, sign-failed, '
          'password-invalid (empty, over-long, no EOF) before unlock, relock-failed; '
          'login keychain, keychain outside Library/Keychains, ad-hoc and unpinned key (guard, no codesign), '
          'missing or mismatched ACL record refused', flush=True)

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
print('PASS throwaway keychains removed; user search list unchanged')
print(f'PASS primitive integration; scratch: {work.relative_to(root)}')
