#!/usr/bin/env python3
"""Real codesign/keychain/rename/socket tests for macos-app-ctl.

Signing uses throwaway keychains under tmp/<work>/Library/Keychains/ (a partition-capable location,
so securityd's partition checks are real) provisioned by the ctl primitives: a non-extractable key,
a feature-built self-signed test certificate and the codesign pin. An unanchored CA-issued leaf is
a negative chain-preflight case. Keychains never enter the search list; login is never touched.
A fake launchctl on PATH starts real hosts directly, so no background item is registered.
Every keychain operation is bounded and watched for new SecurityAgent windows.
A missing window server is accepted only with read-only audit-session evidence
that graphics and console access are absent; it is never reported as zero windows.

From the Darwin checkout root:
  nix run .#macos-app-ctl-integration --option builders '' --option max-jobs 2
An existing macos-app-example store path can be passed as the first argument.
"""
import ctypes
from concurrent.futures import ThreadPoolExecutor
import fcntl
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
ctl = example / 'testPrimitives/bin/macos-app-ctl'
base_config = json.loads((example / 'ctl-config.json').read_text())
bin_dir = work / 'bin'
bin_dir.mkdir()
state = work / 'state'
app_bundle_name = base_config['appBundleName']
assert app_bundle_name == 'Synthetic Host.app', base_config
app = work / 'apps' / app_bundle_name
plists = work / 'plists'
sock = str(work.relative_to(root) / 'host.sock')
# The incoming desired filename is deliberately not the pinned product name.
desired = work / 'incoming/UnrelatedBuildOutput.app'
desired.parent.mkdir()
shutil.copytree(example / 'hostAppBundle', desired)
uid = os.getuid()
first = work / 'generation-first'
second = work / 'generation-second'
for source, target in [(example / 'generation', first), (example / 'secondGeneration', second)]:
    target.mkdir()
    manifest = json.loads((source / 'manifest.json').read_text())
    manifest['statusAllowedUids'] = [uid]
    (target / 'manifest.json').write_text(json.dumps(manifest))


def assert_bundle_copies(parent, bundle_name):
    """Managed output trees must never turn uniqueness into a bundle filename."""
    if not parent.exists():
        return
    for path in parent.rglob('*'):
        if path.is_dir() and (path.name.endswith('.app') or '.app.stage-' in path.name):
            assert path.name == bundle_name, f'noncanonical managed bundle: {path}'
            assert path.name != 'host.app' and not path.name.startswith('retained-'), path

def assert_managed_layout(installed, bundle_name, *extra_roots):
    assert installed.name == bundle_name, installed
    assert_bundle_copies(installed.parent, bundle_name)
    for parent in extra_roots:
        assert_bundle_copies(parent, bundle_name)
    journal = installed.with_suffix('.txn.json')
    if journal.exists():
        stage = Path(json.loads(journal.read_text())['stage'])
        assert stage.name == bundle_name and stage.parent != installed.parent, stage
        assert stage.is_dir(), stage

def assert_archive_pointer(reply, installed, bundle_name):
    for key in ('archive', 'hostArchive'):
        value = reply.get('result', {}).get(key)
        if value is not None:
            bundle = Path(value)
            assert bundle.name == bundle_name and bundle.parent != installed.parent, bundle
            assert bundle.is_dir(), bundle

PROMPT_TIMEOUT = 15
def tool(*args, check=True):
    if Path(args[0]).name == 'codesign' and any(flag in args for flag in ('-s', '--sign')):
        assert '-s' in args and args[args.index('-s') + 1] == '-'
        assert '--sign' not in args and '--keychain' not in args, 'Direct signing must be keyless explicit -s -'
    result = watched(list(args), timeout=PROMPT_TIMEOUT, env=globals().get('env'))
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
libc = ctypes.CDLL(None, use_errno=True)
class AuditMask(ctypes.Structure):
    _fields_ = [('success', ctypes.c_uint32), ('failure', ctypes.c_uint32)]
class AuditTerminal(ctypes.Structure):
    _fields_ = [('port', ctypes.c_int32), ('type', ctypes.c_uint32), ('address', ctypes.c_uint32 * 4)]
class AuditSession(ctypes.Structure):
    _fields_ = [('uid', ctypes.c_uint32), ('mask', AuditMask), ('terminal', AuditTerminal),
                ('session', ctypes.c_int32), ('flags', ctypes.c_uint64)]
libc.getaudit_addr.argtypes = [ctypes.POINTER(AuditSession), ctypes.c_int]
libc.getaudit_addr.restype = ctypes.c_int
def no_ui_session():
    audit = AuditSession()
    if libc.getaudit_addr(ctypes.byref(audit), ctypes.sizeof(audit)) != 0:
        raise RuntimeError('ABORT: unavailable window list and unreadable audit session')
    # SDK AU_SESSION_FLAG_HAS_GRAPHIC_ACCESS / HAS_CONSOLE_ACCESS.
    if audit.flags & (0x0010 | 0x2000):
        raise RuntimeError('ABORT: unavailable window list in a graphics/console-capable session')
    return audit.flags
def security_agent_windows():
    windows = core_graphics.CGWindowListCopyWindowInfo(1, 0)  # on-screen only
    if not windows:
        no_ui_session()  # Reprove absence of UI capability on every observation.
        return None
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
if agent_baseline not in (0, None):
    sys.exit('ABORT before keychain tests: SecurityAgent window baseline must be zero')
print(f'SecurityAgent before: {agent_baseline}' if agent_baseline is not None else
      f'SecurityAgent before: unavailable; no-UI audit session flags={no_ui_session():#x}', flush=True)
def watched(argv, terminate_when=None, timeout=60, observer=None, **kwargs):
    """Every monitor failure tears down the reserved process group before unwinding."""
    # Fail closed before any child can reach Security.framework or codesign,
    # including indirect ctl calls. Window observations alone are not this gate.
    no_ui_session()
    observe = observer or security_agent_windows
    if observe() != agent_baseline:
        raise RuntimeError(f'ABORT before {argv[1]}: SecurityAgent window present')
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                               start_new_session=True, **kwargs)
    deadline = time.monotonic() + timeout
    terminated = False
    try:
        # WNOWAIT reserves the leader PID/PGID until group teardown has completed.
        while os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
            if observe() != agent_baseline or time.monotonic() > deadline:
                raise RuntimeError(f'ABORT: {argv[1]} changed the window observation or hung')
            if terminate_when is not None and terminate_when.exists() and not terminated:
                os.killpg(process.pid, signal.SIGTERM)
                terminated = True
            time.sleep(0.1)
        if observe() != agent_baseline:
            raise RuntimeError(f'ABORT: {argv[1]} changed the window observation')
    except BaseException:
        # Observer exceptions, audit failures and cancellation take the same path.
        # Kill all descendants before reaping the leader or draining inherited pipes.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            # Protected platform children may reject signals even after exit.
            # Still drain/wait below; never unwind into keychain cleanup first.
            pass
        process.communicate()
        raise
    # A successful leader must not leave descendants holding our pipes open either.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        # The leader was observed terminal without reaping. macOS can return
        # EPERM for signalling an exited protected Apple binary.
        pass
    stdout, stderr = process.communicate()
    result = subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
    result.pid = process.pid  # Kernel peer identity oracle for the helper probe.
    return result

def observer_failure_test():
    """Real child, deterministic observer exception: it must be killed and reaped."""
    pid_file = work / 'observer-child.pid'
    def observe():
        baseline = security_agent_windows()
        if pid_file.exists():
            raise RuntimeError('observer self-test failure')
        return baseline
    try:
        watched([sys.executable, '-c',
                 'import os,time; from pathlib import Path; '
                 f'Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(60)'],
                observer=observe)
    except RuntimeError as error:
        assert str(error) == 'observer self-test failure', error
    else:
        raise AssertionError('Observer failure did not abort the child')
    pid = int(pid_file.read_text())
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        pass
    else:
        raise AssertionError('Observer failure left a child running or unreaped')
    pid_file.unlink()
    print('PASS observer exception kills and reaps the watched child before unwinding', flush=True)

observer_failure_test()

# Throwaway signing keychains; the password is test-only and may appear in test argv.
search_list = tool('/usr/bin/security', 'list-keychains', '-d', 'user').stdout
keychains = work / 'Library/Keychains'
keychains.mkdir(parents=True)
keychain = keychains / 'signing.keychain-db'
unpinned = keychains / 'unpinned.keychain-db'
chain_missing = keychains / 'chain-missing.keychain-db'
fixture_keychain = keychains / 'fixture.keychain-db'
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
    for path in (keychain, unpinned, chain_missing, fixture_keychain):
        path.unlink(missing_ok=True)
        Path(f'{path}.acl.json').unlink(missing_ok=True)
        Path(f'{path}.fixture-identity.json').unlink(missing_ok=True)
    (work / 'ca.key').unlink(missing_ok=True)
    assert tool('/usr/bin/security', 'list-keychains', '-d', 'user').stdout == search_list

try:
    security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    def unlocked(path=keychain):
        no_ui_session()
        reference = ctypes.c_void_p()
        assert security.SecKeychainOpen(str(path).encode(), ctypes.byref(reference)) == 0
        status = ctypes.c_uint32()
        # SecKeychainGetStatus reads state only; it never shows UI.
        no_ui_session()
        assert security.SecKeychainGetStatus(reference, ctypes.byref(status)) == 0
        return bool(status.value & 1)
    def unlock_for_test(path=keychain):
        result = watched(['/usr/bin/security', 'unlock-keychain', '-p', password, str(path)])
        assert result.returncode == 0, result.stderr
        assert unlocked(path)

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
import json, os, subprocess, sys, time
from pathlib import Path
import ctypes
class AuditMask(ctypes.Structure):
    _fields_ = [('success', ctypes.c_uint32), ('failure', ctypes.c_uint32)]
class AuditTerminal(ctypes.Structure):
    _fields_ = [('port', ctypes.c_int32), ('type', ctypes.c_uint32), ('address', ctypes.c_uint32 * 4)]
class AuditSession(ctypes.Structure):
    _fields_ = [('uid', ctypes.c_uint32), ('mask', AuditMask), ('terminal', AuditTerminal),
                ('session', ctypes.c_int32), ('flags', ctypes.c_uint64)]
def no_ui_session():
    libc = ctypes.CDLL(None, use_errno=True)
    audit = AuditSession()
    libc.getaudit_addr.argtypes = [ctypes.POINTER(AuditSession), ctypes.c_int]
    libc.getaudit_addr.restype = ctypes.c_int
    if libc.getaudit_addr(ctypes.byref(audit), ctypes.sizeof(audit)) != 0 or audit.flags & (0x0010 | 0x2000):
        sys.exit('ABORT codesign shim: no-UI audit evidence unavailable or graphics/console present')
base = Path(os.environ['MACOS_APP_TEST_WORK'])
args = sys.argv[1:]
with (base / 'codesign.log').open('a') as log: log.write(json.dumps({'argv': args, 'env': sorted(os.environ.items())}) + '\n')
if '--sign' in args or '-s' in args:
    with (base / 'sign.log').open('a') as log: log.write('sign\n')
    if (base / 'sign-fail').exists():
        print('test-injected signing failure', file=sys.stderr)
        sys.exit(1)
    if (base / 'sign-fork-mode').exists():
        (base / 'fork-leader-pid').write_text(str(os.getpid()))
        descendant = os.fork()
        if descendant == 0:
            (base / 'fork-descendant-pid').write_text(str(os.getpid()))
            (base / 'fork-ready').touch()  # Descendant now holds inherited stdout/stderr.
            time.sleep(60)
            os._exit(0)
        time.sleep(60)  # Keep the leader alive until the test's signal or deadline.
        os._exit(0)
    if (base / 'sign-slow').exists():
        (base / 'slow-child-pid').write_text(str(os.getpid()))
        (base / 'slow-ready').touch()
        time.sleep(60)
# exec keeps the pid, so ctl's signing deadline kills the real codesign, not just this shim.
no_ui_session()
os.execv('/usr/bin/codesign', ['codesign'] + args)
''')
    codesign.chmod(0o755)
    env = dict(os.environ, PATH=f'{bin_dir}:/usr/bin:/bin', MACOS_APP_TEST_WORK=str(work))

    common = ['--config', str(config_file), '--app-dir', str(app), '--state', str(state),
              '--socket', sock, '--plist-dir', str(plists)]
    def call(action, *args, code=0, secret=None, hold_open=False, failpoint=None, terminate_when=None):
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
            process = watched([str(ctl), action, *common, *map(str, args)], env=run_env, pass_fds=fds, terminate_when=terminate_when)
        finally:
            for fd in fds: os.close(fd)
            if write is not None: os.close(write)
        assert process.returncode == code, (action, process.returncode, process.stdout, process.stderr)
        assert_managed_layout(Path(common[common.index('--app-dir') + 1]),
                              config['appBundleName'])
        if code == 137: return None
        lines = process.stdout.splitlines()
        assert len(lines) == 1, process.stdout
        reply = json.loads(lines[0])
        assert_archive_pointer(reply, Path(common[common.index('--app-dir') + 1]),
                               config['appBundleName'])
        return reply
    def install(desired_app, secret=password, *extra, code=0, failpoint=None):
        return call('install-host', '--desired', desired_app, '--keychain', keychain, *extra, code=code,
                    secret=secret, failpoint=failpoint)

    def thin_contract_cases():
        """Public fixtures only: real signatures/bytes, offline launchd, no signing key."""
        thin_config = dict(base_config, requirement=f'identifier "{base_config["bundleId"]}"',
                           nestedCode=[], entitlements=None, signingOptions=[])
        thin_config_path = work / 'thin-config.json'
        thin_state = work / 'thin-state'
        thin_app = work / 'thin-apps' / app_bundle_name
        archive = work / 'thin-archive'
        thin_config_path.write_text(json.dumps(thin_config))
        def invoke(action, *args, refusal=False, fds=(), config_override=None):
            result = watched([str(ctl), action, '--config',
                              str(config_override or thin_config_path), '--app-dir', str(thin_app),
                              '--state', str(thin_state), '--archive-dir', str(archive),
                              '--socket', str(work / 'thin.sock'), *map(str, args)], env=env, pass_fds=fds)
            assert_managed_layout(thin_app, thin_config['appBundleName'], archive)
            if '--output' in args:
                output = Path(args[args.index('--output') + 1])
                if output.exists():
                    assert_bundle_copies(output, thin_config['appBundleName'])
            lines = result.stdout.splitlines()
            assert len(lines) == 1, (result.stdout, result.stderr)
            reply = json.loads(lines[0])
            assert_archive_pointer(reply, thin_app, thin_config['appBundleName'])
            if refusal:
                assert result.returncode != 0 and 'error' in reply, (action, result, reply)
            else:
                assert result.returncode == 0 and 'result' in reply, (action, result, reply)
            return reply
        def copy_bundle(name):
            target = work / Path(name).stem / app_bundle_name
            target.parent.mkdir()
            shutil.copytree(desired, target)
            for path in [target, *target.rglob('*')]:
                if not path.is_symlink():
                    path.chmod(path.stat().st_mode | 0o200)
            return target
        def describe(target, **policy):
            path = thin_config_path
            if policy:
                path = work / 'thin-policy.json'
                path.write_text(json.dumps(dict(thin_config, **policy)))
            return invoke('describe-host', '--desired', target, config_override=path)
        unsigned = copy_bundle('ThinUnsigned.app')
        descriptor = describe(unsigned)['result']
        assert descriptor == describe(unsigned)['result'], 'descriptor is nondeterministic'
        descriptor_path = work / 'thin-descriptor.json'
        descriptor_path.write_text(json.dumps(descriptor))
        resource = unsigned / 'Contents/Resources/contract-resource.txt'
        resource.parent.mkdir(exist_ok=True)
        resource.write_text('public revision fixture\n')
        changed = describe(unsigned)['result']
        assert changed['hostRevision'] != descriptor['hostRevision'], (descriptor, changed)
        resource.unlink()
        assert describe(unsigned)['result'] == descriptor
        print('PASS deterministic descriptor binds actual resource bytes', flush=True)

        nested_path = 'Contents/Helpers/contract-helper'
        helper = unsigned / nested_path
        helper.parent.mkdir(exist_ok=True)
        executable = unsigned / 'Contents/MacOS' / base_config['hostExecutable']
        shutil.copy2(executable, helper)
        nested_policy = {'path': nested_path, 'identifier': 'dev.example.synthetic-host.helper',
                         'requirement': 'identifier "dev.example.synthetic-host.helper"',
                         'entitlements': None, 'options': []}
        invoke('describe-host', '--desired', unsigned, refusal=True)
        describe(unsigned, nestedCode=[nested_policy])
        for entries in ([nested_policy, nested_policy],
                        [dict(nested_policy, path='../outside')],
                        [dict(nested_policy, path='/absolute')]):
            thin_config_path.write_text(json.dumps(dict(thin_config, nestedCode=entries)))
            invoke('describe-host', '--desired', unsigned, refusal=True)
        thin_config_path.write_text(json.dumps(thin_config))
        # Strict nested verification must evaluate the declared object predicate,
        # not merely accept a structurally valid outer signature.
        tool(str(codesign), '--force', '-s', '-', '--identifier',
             'dev.example.wrong-helper', str(helper))
        tool(str(codesign), '--force', '-s', '-', '--identifier',
             thin_config['bundleId'], str(unsigned))
        thin_config_path.write_text(json.dumps(dict(thin_config, nestedCode=[nested_policy])))
        invoke('seal-fixture-artifact', '--desired', unsigned,
               '--output', work / 'must-not-publish-nested-release', refusal=True)
        assert not (work / 'must-not-publish-nested-release').exists()
        thin_config_path.write_text(json.dumps(thin_config))
        helper.unlink()
        escape = unsigned / 'Contents/Helpers/escape'
        escape.symlink_to(executable)
        thin_config_path.write_text(json.dumps(dict(thin_config, nestedCode=[
            dict(nested_policy, path='Contents/Helpers/escape')])))
        invoke('describe-host', '--desired', unsigned, refusal=True)
        escape.unlink()
        thin_config_path.write_text(json.dumps(thin_config))
        print('PASS undeclared Mach-O, duplicate and escaping inventory refuse', flush=True)

        # A matching predicate need not equal the embedded diagnostic DR.
        signed = copy_bundle('ThinSigned.app')
        tool(str(codesign), '--force', '-s', '-', '--identifier', thin_config['bundleId'],
             str(signed))
        diagnostic = tool(str(codesign), '-d', '-r-', str(signed))
        assert 'cdhash' in diagnostic.stdout + diagnostic.stderr
        tool(str(codesign), '--verify', '--strict', '-R=' + thin_config['requirement'], str(signed))
        wrong = tool(str(codesign), '--verify', '--strict',
                     '-R=identifier "dev.example.wrong-product"', str(signed), check=False)
        assert wrong.returncode != 0
        invalid = tool(str(codesign), '--verify', '--strict', '-R=identifier (',
                       str(signed), check=False)
        assert invalid.returncode != 0
        thin_config_path.write_text(json.dumps(dict(thin_config, requirement='identifier "dev.example.wrong-product"')))
        invoke('seal-fixture-artifact', '--desired', signed,
               '--output', work / 'must-not-publish-wrong-release', refusal=True)
        thin_config_path.write_text(json.dumps(thin_config))
        assert describe(signed)['result'] == descriptor
        # Policy hashes are not proof that the real CodeDirectory carries the
        # declared flags: this ad-hoc signature was made without --options hard.
        hard_config = work / 'thin-hard-config.json'
        hard_config.write_text(json.dumps(dict(thin_config, signingOptions=['hard'])))
        hard_descriptor = invoke('describe-host', '--desired', signed,
                                 config_override=hard_config)['result']
        assert hard_descriptor['hostRevision'] != descriptor['hostRevision']
        invoke('seal-fixture-artifact', '--desired', signed,
               '--output', work / 'must-not-publish-hard-release',
               config_override=hard_config, refusal=True)
        assert not (work / 'must-not-publish-hard-release').exists()
        print('PASS required signing flag absent from real signature refuses despite matching policy descriptor', flush=True)
        release = work / 'thin-release'
        invoke('seal-fixture-artifact', '--desired', signed, '--output', release)
        assert sorted(path.name for path in release.iterdir()) == [
            app_bundle_name, 'descriptor.json', 'receipt.json']
        assert (release / app_bundle_name).is_dir()
        receipt = json.loads((release / 'receipt.json').read_text())
        assert receipt['hostRevision'] == descriptor['hostRevision'] and receipt['sealedRevision']
        assert json.loads((release / 'descriptor.json').read_text()) == descriptor
        for path in [release, *release.rglob('*')]:
            if not path.is_symlink():
                assert path.stat().st_mode & 0o222 == 0, f'mutable published artifact: {path}'
        old_release = work / 'old-layout-release'
        shutil.copytree(release, old_release)
        old_release.chmod(0o700)
        (old_release / app_bundle_name).rename(old_release / 'host.app')
        old_release.chmod(0o500)
        refused = invoke('install-host', '--desired', descriptor_path,
                         '--artifact', old_release, refusal=True)
        assert refused['error']['kind'] == 'reseal-required', refused
        refused = invoke('rollback', '--desired', descriptor_path,
                         '--artifact', old_release, '--generation', first, refusal=True)
        assert refused['error']['kind'] == 'rollback-unavailable', refused
        assert not thin_app.exists() and not thin_app.with_suffix('.txn.json').exists()
        print('PASS old sealed layout requires resealing; cross-cutover rollback is typed unavailable', flush=True)
        signing_before = (work / 'sign.log').read_text()
        invoke('seal-host', '--desired', signed, '--output', release,
               '--keychain', work / 'must-not-open.keychain-db', '--keychain-password-fd', '999')
        assert (work / 'sign.log').read_text() == signing_before
        print('PASS pinned predicate accepts differing diagnostic DR; wrong predicate rejects; seal reuses verified artifact without signing', flush=True)
        raced = work / 'thin-raced' / app_bundle_name
        raced.parent.mkdir()
        shutil.copytree(signed, raced)
        env['MACOS_APP_CTL_TEST_FAILPOINT'] = 'seal-source-after-describe'
        try:
            refused = invoke('seal-fixture-artifact', '--desired', raced,
                             '--output', work / 'must-not-publish-raced-release', refusal=True)
            assert 'Staged source changed' in refused['error']['reason'], refused
        finally:
            env.pop('MACOS_APP_CTL_TEST_FAILPOINT', None)
        assert not (work / 'must-not-publish-raced-release').exists()
        assert (work / 'sign.log').read_text() == signing_before
        print('PASS source mutation after describing refuses before signing or publication', flush=True)

        missing_release = work / 'absent-release'
        invoke('install-host', '--desired', descriptor_path, '--artifact', missing_release,
               refusal=True)
        no_receipt = work / 'thin-no-receipt-release'
        shutil.copytree(release, no_receipt)
        no_receipt.chmod(0o700)
        (no_receipt / 'receipt.json').unlink()
        invoke('install-host', '--desired', descriptor_path, '--artifact', no_receipt, refusal=True)
        for credential in (['--keychain', work / 'forbidden.keychain-db'],
                           ['--keychain-password-fd', '999']):
            invoke('install-host', '--desired', descriptor_path, '--artifact', release,
                   *credential, refusal=True)
        assert not thin_app.exists()
        assert (work / 'sign.log').read_text() == signing_before
        invoke('install-host', '--desired', descriptor_path, '--artifact', release)
        installed_bytes = (thin_app / 'Contents/MacOS' / base_config['hostExecutable']).read_bytes()
        tampered = work / 'thin-tampered-release'
        shutil.copytree(release, tampered)
        bad_binary = tampered / app_bundle_name / 'Contents/MacOS' / base_config['hostExecutable']
        bad_binary.chmod(0o700)
        with bad_binary.open('ab') as output:
            output.write(b'tamper')
        invoke('install-host', '--desired', descriptor_path, '--artifact', tampered, refusal=True)
        assert (thin_app / 'Contents/MacOS' / base_config['hostExecutable']).read_bytes() == installed_bytes
        unrelated = dict(descriptor, hostRevision='0' * 64)
        unrelated_path = work / 'thin-unrelated-descriptor.json'
        unrelated_path.write_text(json.dumps(unrelated))
        invoke('install-host', '--desired', unrelated_path, '--artifact', release, refusal=True)
        assert (work / 'sign.log').read_text() == signing_before
        print('PASS verify-only import rejects credentials, missing/tampered artifacts without fallback or installed mutation', flush=True)
        print('NOT RUN: root-to-user artifact destination (requires parent-owned root execution)', flush=True)
        # Crash before exchange leaves an immutable candidate inode in the stage,
        # not at D. Reconcile must restore owner writability only to discard it.
        abandoned_parent = Path(tempfile.mkdtemp(prefix='.macos-app-stage-', dir=thin_app.parent))
        abandoned = abandoned_parent / app_bundle_name
        shutil.copytree(release / app_bundle_name, abandoned)
        incumbent_inode = thin_app.stat().st_ino
        incumbent_revision = invoke('status', '--desired', descriptor_path,
                                    '--artifact', release)['result']['sealedRevision']
        journal = thin_app.with_suffix('.txn.json')
        journal.write_text(json.dumps({'stage': str(abandoned),
                                       'stageInode': abandoned.stat().st_ino,
                                       'generation': None, 'immutable': True}))
        reconciled = invoke('install-host', '--desired', descriptor_path,
                            '--artifact', release)['result']
        assert reconciled['changed'] is False and reconciled['reconciled'] == 'stage-discarded', reconciled
        assert not abandoned_parent.exists() and not journal.exists()
        assert thin_app.stat().st_ino == incumbent_inode
        assert invoke('status', '--desired', descriptor_path, '--artifact', release)['result']['sealedRevision'] == incumbent_revision
        print('PASS immutable unexchanged transaction stage discarded with incumbent inode and revision preserved', flush=True)

        # Two valid embedded DRs can satisfy the same independently pinned
        # predicate and unsigned descriptor while carrying different sealed bytes.
        signed_again = work / 'thin-signed-again' / app_bundle_name
        signed_again.parent.mkdir()
        shutil.copytree(signed, signed_again)
        tool(str(codesign), '--force', '-s', '-', '--identifier', thin_config['bundleId'],
             '--requirements', '=designated => ' + thin_config['requirement'], str(signed_again))
        assert describe(signed_again)['result'] == descriptor
        second_release = work / 'thin-second-release'
        invoke('seal-fixture-artifact', '--desired', signed_again, '--output', second_release)
        second_receipt = json.loads((second_release / 'receipt.json').read_text())
        assert second_receipt['hostRevision'] == receipt['hostRevision']
        assert second_receipt['sealedRevision'] != receipt['sealedRevision']
        replaced = invoke('install-host', '--desired', descriptor_path,
                          '--artifact', second_release)['result']
        assert replaced['changed'] is True, replaced
        exact = invoke('status', '--desired', descriptor_path, '--artifact', second_release)['result']
        assert exact['artifactValid'] and exact['sealedRevision'] == second_receipt['sealedRevision'], exact
        # Restore the first exact release for the subsequent lock/no-op fixtures.
        invoke('install-host', '--desired', descriptor_path, '--artifact', release)
        print('PASS distinct sealed signatures for identical unsigned content require exact artifact replacement', flush=True)

        # Isolate cutovers from the installed app used by the remaining fixtures.
        # All fixture signatures are explicitly ad-hoc; imports receive no credentials.
        original_app, original_state = thin_app, thin_state
        try:
            helper_candidate = copy_bundle('ThinCutoverCandidate.app')
            candidate_helper = helper_candidate / nested_path
            candidate_helper.parent.mkdir(exist_ok=True)
            shutil.copy2(helper_candidate / 'Contents/MacOS' / base_config['hostExecutable'],
                         candidate_helper)
            tool(str(codesign), '--force', '-s', '-', '--identifier',
                 nested_policy['identifier'], str(candidate_helper))
            tool(str(codesign), '--force', '-s', '-', '--identifier',
                 thin_config['bundleId'], str(helper_candidate))
            cutover_config = work / 'thin-cutover-config.json'
            cutover_policy = dict(thin_config, nestedCode=[nested_policy])
            cutover_config.write_text(json.dumps(cutover_policy))
            cutover_descriptor = work / 'thin-cutover-descriptor.json'
            cutover_descriptor.write_text(json.dumps(invoke(
                'describe-host', '--desired', helper_candidate,
                config_override=cutover_config)['result']))
            cutover_release = work / 'thin-cutover-release'
            invoke('seal-fixture-artifact', '--desired', helper_candidate,
                   '--output', cutover_release, config_override=cutover_config)

            for case in ('valid', 'wrong-bundle-id', 'wrong-pinned-requirement',
                         'invalid-outer-signature'):
                thin_app = work / f'thin-legacy-{case}' / app_bundle_name
                thin_app.parent.mkdir()
                shutil.copytree(desired, thin_app)
                for path in [thin_app, *thin_app.rglob('*')]:
                    if not path.is_symlink():
                        path.chmod(path.stat().st_mode | 0o200)
                thin_state = work / f'thin-legacy-{case}-state'
                if case == 'wrong-bundle-id':
                    info = thin_app / 'Contents/Info.plist'
                    plist = plistlib.loads(info.read_bytes())
                    plist['CFBundleIdentifier'] = 'dev.example.wrong-product'
                    info.write_bytes(plistlib.dumps(plist))
                identifier = ('dev.example.wrong-product'
                              if case == 'wrong-pinned-requirement'
                              else thin_config['bundleId'])
                tool(str(codesign), '--force', '-s', '-', '--identifier',
                     identifier, str(thin_app))
                if case == 'invalid-outer-signature':
                    with (thin_app / 'Contents/MacOS' / base_config['hostExecutable']).open('ab') as output:
                        output.write(b'legacy signature tamper')
                inode = thin_app.stat().st_ino
                before_import = (work / 'sign.log').read_text()
                invoke('install-host', '--desired', cutover_descriptor,
                       '--artifact', cutover_release, config_override=cutover_config,
                       refusal=True)
                assert thin_app.stat().st_ino == inode
                result = invoke('install-host', '--desired', cutover_descriptor,
                                '--artifact', cutover_release, '--incumbent', 'legacy',
                                config_override=cutover_config, refusal=case != 'valid')
                if case == 'valid':
                    assert result['result']['changed'] is True, result
                    assert (thin_app / nested_path).is_file()
                    installed = thin_app.stat()
                    record = thin_state / 'host-configs' / f'{installed.st_dev}-{installed.st_ino}.json'
                    assert json.loads(record.read_text()) == cutover_policy
                else:
                    assert thin_app.stat().st_ino == inode, case
                    assert not (thin_app / nested_path).exists(), case
                assert (work / 'sign.log').read_text() == before_import
            print('PASS helper-layout legacy cutover requires opt-in and still rejects wrong plist identity, pinned requirement and outer signature', flush=True)

            thin_app = work / 'thin-recorded-apps' / app_bundle_name
            thin_state = work / 'thin-recorded-state'
            before_import = (work / 'sign.log').read_text()
            invoke('install-host', '--desired', descriptor_path, '--artifact', release)
            plain_inode = thin_app.stat()
            plain_record = thin_state / 'host-configs' / f'{plain_inode.st_dev}-{plain_inode.st_ino}.json'
            assert json.loads(plain_record.read_text()) == thin_config
            # Candidate inventory adds a helper absent from the recorded incumbent.
            result = invoke('install-host', '--desired', cutover_descriptor,
                            '--artifact', cutover_release, config_override=cutover_config)
            assert result['result']['changed'] is True, result
            assert (thin_app / nested_path).is_file()
            installed = thin_app.stat()
            record = thin_state / 'host-configs' / f'{installed.st_dev}-{installed.st_ino}.json'
            recorded_config = record.read_text()
            assert json.loads(recorded_config) == cutover_policy

            # A candidate without the helper must not mask a recorded helper policy.
            bad_policy = dict(cutover_policy, nestedCode=[
                dict(nested_policy, requirement='identifier "dev.example.wrong-helper"')])
            for invalid_config in (json.dumps(bad_policy), '{"invalid":true}'):
                record.write_text(invalid_config)
                try:
                    for opt_in in ((), ('--incumbent', 'legacy')):
                        invoke('install-host', '--desired', descriptor_path,
                               '--artifact', release, *opt_in, refusal=True)
                        assert thin_app.stat().st_ino == installed.st_ino
                        assert record.read_text() == invalid_config
                finally:
                    record.write_text(recorded_config)
            result = invoke('install-host', '--desired', descriptor_path, '--artifact', release)
            assert result['result']['changed'] is True, result
            assert not (thin_app / nested_path).exists()
            print('PASS recorded own-config verification permits helper addition/removal without opt-in; legacy cannot bypass invalid recorded config or nested policy', flush=True)

            invoke('install-host', '--desired', cutover_descriptor, '--artifact', cutover_release,
                   config_override=cutover_config)
            installed = thin_app.stat()
            recorded_helper = thin_app / nested_path
            recorded_helper.chmod(recorded_helper.stat().st_mode | 0o200)
            with recorded_helper.open('ab') as output:
                output.write(b'recorded helper signature tamper')
            for opt_in in ((), ('--incumbent', 'legacy')):
                invoke('install-host', '--desired', descriptor_path,
                       '--artifact', release, *opt_in, refusal=True)
                assert thin_app.stat().st_ino == installed.st_ino
                assert recorded_helper.read_bytes().endswith(b'recorded helper signature tamper')
            assert (work / 'sign.log').read_text() == before_import
            print('PASS legacy opt-in cannot bypass invalid recorded incumbent signatures; all cutover imports avoid signing', flush=True)
        finally:
            thin_app, thin_state = original_app, original_state

        # Validate ordinary consumer plists offline; never load a launchd job.
        plist_path = work / 'thin-job.plist'
        entrypoint = str(thin_app / 'Contents/MacOS' / base_config['hostExecutable'])
        argv = [entrypoint]
        if base_config['hostExecutable'] == 'macos-app-host':
            argv += ['serve', '--socket', str(work / 'thin.sock'),
                     '--generation-pointer', str(thin_state / 'current')]
        job = {'Label': thin_config['bundleId'], 'Program': entrypoint,
               'ProgramArguments': argv, 'StartInterval': 3600}
        def validate(value, domain=f'user/{uid}', target=uid, evidence='scheduled', refusal=False):
            plist_path.write_bytes(plistlib.dumps(value))
            return invoke('converge-launchd', '--plist', plist_path, '--domain', domain,
                          '--target-uid', target, '--evidence', evidence, '--validate-only',
                          refusal=refusal)
        validate(job)
        for value in (dict(job, Program='/usr/bin/true'),
                      dict(job, ProgramArguments=['/usr/bin/true']),
                      dict(job, ProgramArguments=[entrypoint, '--unknown-operation']),
                      dict(job, Label='dev.example.other-product')):
            validate(value, refusal=True)
        validate(job, domain=f'user/{uid + 1}', refusal=True)
        validate(job, domain='invalid/0', refusal=True)
        # Exact scheduled evidence must not claim an offline idle job is running.
        evidence = validate(job)['result']
        assert not evidence.get('running') and not evidence.get('pid'), evidence
        print('PASS supplied plist identity/direct-entrypoint/argv/domain refusals and offline scheduled idle evidence', flush=True)
        for target in (plist_path, Path(entrypoint), thin_app / 'Contents'):
            tool('/bin/chmod', '+a', 'everyone allow write', str(target))
            try:
                refused = validate(job, refusal=True)
                assert 'ACL' in refused['error']['reason'], refused
            finally:
                tool('/bin/chmod', '-N', str(target))
            validate(job)
        print('PASS granting ACLs on plist, installed entrypoint and ancestor refuse', flush=True)

        lock_path = thin_state / 'lifecycle.lock'
        thin_state.mkdir(exist_ok=True)
        lock_path.touch(exist_ok=True)
        lock_path.chmod(0o600)
        thin_config['lifecycleLockPath'] = str(lock_path)
        thin_config_path.write_text(json.dumps(thin_config))
        def mutation_snapshot():
            return {str(path.relative_to(work)): (path.lstat().st_ino, path.lstat().st_mode,
                    path.lstat().st_size, path.lstat().st_mtime_ns) for path in work.rglob('*')}
        before_invalid_validation = mutation_snapshot()
        refused = invoke('converge-launchd', '--validate-only', refusal=True)
        assert refused['error']['kind'] == 'invalid-input' and '--plist' in refused['error']['reason'], refused
        assert mutation_snapshot() == before_invalid_validation, 'Invalid offline form performed I/O mutations'
        print('PASS validate-only without supplied plist refuses before file writes or launchctl despite configured lock', flush=True)
        borrowed = os.open(lock_path, os.O_RDWR)
        other = os.open(lock_path, os.O_RDWR)
        foreign = os.open(work / 'wrong-lifecycle.lock', os.O_RDWR | os.O_CREAT, 0o600)
        def locked_install(fd, refusal=True):
            return invoke('install-host', '--desired', descriptor_path, '--artifact', release,
                          '--lifecycle-fd', fd, refusal=refusal, fds=(fd,) if fd != 999 else ())
        try:
            locked_install(999)
            locked_install(borrowed, refusal=False)  # ctl may acquire on this inherited OFD.
            fcntl.flock(borrowed, fcntl.LOCK_UN)
            fcntl.flock(borrowed, fcntl.LOCK_SH)
            locked_install(borrowed, refusal=False)  # Own shared lock can upgrade when uncontended.
            fcntl.flock(borrowed, fcntl.LOCK_UN)
            fcntl.flock(borrowed, fcntl.LOCK_EX)
            locked_install(other)
            fcntl.flock(foreign, fcntl.LOCK_EX)
            locked_install(foreign)
            locked_install(borrowed, refusal=False)
            for action, args in (
                ('select-generation', ['--generation', first]),
                ('converge-launchd', ['--plist', plist_path, '--domain', f'user/{uid}',
                                     '--target-uid', uid, '--evidence', 'scheduled', '--validate-only']),
                ('rollback', ['--artifact', release, '--generation', first]),
                ('provision-signing-key', ['--keychain', work / 'never-open.keychain-db']),
                ('import-signing-cert', ['--keychain', work / 'never-open.keychain-db']),
                ('prove-signing-key', ['--keychain', work / 'never-open.keychain-db']),
                ('sign-fixture', ['--keychain', work / 'never-open.keychain-db']),
            ):
                rejected = invoke(action, *args, '--lifecycle-fd', other,
                                  refusal=True, fds=(other,))
                assert 'lifecycle' in rejected['error']['reason'].lower(), rejected
            invoke('select-generation', '--generation', first, '--lifecycle-fd', borrowed,
                   fds=(borrowed,))
            invoke('converge-launchd', '--plist', plist_path, '--domain', f'user/{uid}',
                   '--target-uid', uid, '--evidence', 'scheduled', '--validate-only',
                   '--lifecycle-fd', borrowed, fds=(borrowed,))
        finally:
            for fd in (borrowed, other, foreign):
                os.close(fd)
        print('PASS lifecycle configured path/inode and missing inherited FD refusal; '
              'unlocked/shared-own acquisition, competing OFD refusal and held exclusive success', flush=True)
        print('NOT VERIFIED: inherited descriptor proves present exclusivity, not a prior consumer-held interval', flush=True)
        # Real kernel peer tokens, not mocked process IDs or UID-only sockets.
        display = tool(str(codesign), '-d', '-r-', str(ctl))
        predicates = [line.partition('designated => ')[2]
                      for line in (display.stdout + '\n' + display.stderr).splitlines()
                      if 'designated => ' in line]
        assert len(predicates) == 1 and predicates[0], (display.stdout, display.stderr)
        caller_requirement = predicates[0]
        # Darwin's AF_UNIX limit applies to the resolved absolute path, not cwd.
        endpoint_temp = tempfile.TemporaryDirectory(prefix='macos-peer-', dir='/private/tmp')
        endpoint_parent = Path(endpoint_temp.name)
        def probe_command(mode, socket_path, evidence, target_uid, requirement):
            no_ui_session()  # Reprove independently for each concurrent launch.
            return watched([str(ctl), 'test-security-helper', '--config', str(thin_config_path),
                            '--mode', mode, '--socket', str(socket_path),
                            '--evidence', evidence, '--target-uid', str(target_uid),
                            '--requirement', requirement], env=env, timeout=10)
        def probe_reply(result):
            lines = result.stdout.splitlines()
            assert len(lines) == 1, (result.returncode, result.stdout, result.stderr)
            return json.loads(lines[0])
        cases = [('fresh', uid, caller_requirement, False),
                 ('wrong-uid', uid + 1, caller_requirement, True),
                 ('wrong-requirement', uid, 'identifier "dev.example.forbidden-helper"', True),
                 ('exit', uid, caller_requirement, False),
                 ('exec', uid, caller_requirement, False)]
        with ThreadPoolExecutor(max_workers=1) as executor:
            for name, target_uid, requirement, refused in cases:
                evidence_kind = name if name in ('exit', 'exec') else 'fresh'
                probe_socket = endpoint_parent / f'{name}.sock'
                server_future = executor.submit(probe_command, 'server', probe_socket,
                                                evidence_kind, target_uid, requirement)
                deadline = time.monotonic() + 4
                while not probe_socket.exists():
                    if server_future.done():
                        failed = server_future.result()
                        raise AssertionError(('server failed before bind', failed.stdout, failed.stderr))
                    if time.monotonic() >= deadline:
                        raise AssertionError('Helper socket did not become ready within bound')
                    time.sleep(0.01)
                client = probe_command('client', probe_socket, evidence_kind, uid, caller_requirement)
                server = server_future.result(timeout=10)
                server_reply = probe_reply(server)
                if refused:
                    assert server.returncode != 0 and client.returncode != 0, (server, client)
                    assert server_reply['error']['kind'] == 'helper-authentication-failed', server_reply
                    assert 'error' in probe_reply(client)
                else:
                    assert server.returncode == 0 and client.returncode == 0, (server, client)
                    identity = server_reply['result']
                    assert identity['effectiveUid'] == uid and identity['realUid'] == uid, identity
                    assert identity['pid'] == client.pid and identity['pidVersion'] > 0, (identity, client.pid)
                    if evidence_kind == 'fresh':
                        assert identity['authenticated'] is True, identity
                        assert probe_reply(client)['result']['clientCompleted'] is True
                    else:
                        assert identity['staleRejected'] is True and identity['evidence'] == evidence_kind, identity
                        if evidence_kind == 'exit':
                            assert probe_reply(client)['result']['clientExiting'] is True
                        else:
                            assert client.stdout == '', 'Fixed exec oracle must replace ctl at the same PID'
                assert not probe_socket.exists(), 'Owned probe endpoint was not cleaned up'
        endpoint_temp.cleanup()
        print('PASS real kernel audit-token UID+DR conjunction, exited-token refusal and same-PID exec incarnation refusal', flush=True)
        print('NOTE: helper pure unit suite runs separately in the macos-app-host Nix check '
              'for unsafe/ACL/symlink/writable paths and stale owned-socket inode cases', flush=True)

    thin_contract_cases()

    # Provisioning: key and CSR by ctl, certificate by the test CA, then the codesign pin.
    def key_call(action, path, *args, code=0, secret=password, failpoint=None):
        return call(action, '--keychain', path, *args, code=code, secret=secret, failpoint=failpoint)
    provisioned = key_call('provision-signing-key', keychain, '--common-name-hint', identity, '--csr-out', work / 'signing.csr',
                           '--test-self-signed-cert-out', work / 'signing.pem')['result']
    assert provisioned['createdKeychain'] and provisioned['mode'] == '0600' and provisioned['retainedPrivateKeys'] == []
    assert provisioned['lockOnSleep'] and provisioned['lockIntervalSeconds'] == 300
    assert oct(keychain.stat().st_mode & 0o777) == '0o600' and not unlocked()
    record_path = Path(f'{keychain}.acl.json')
    record = json.loads(record_path.read_text())
    assert oct(record_path.stat().st_mode & 0o777) == '0o600' and record['keychain'] == str(keychain), record
    ctl_path = provisioned['ctlPath']
    assert record['keys'] == {provisioned['publicKeySha256']: {'ctlPath': ctl_path}}, record
    assert Path(ctl_path).name == 'macos-app-ctl', provisioned
    assert tool('/usr/bin/security', 'list-keychains', '-d', 'user').stdout == search_list
    assert tool('/usr/bin/openssl', 'req', '-in', str(work / 'signing.csr'), '-noout', '-verify').returncode == 0
    refused = key_call('provision-signing-key', keychain, '--common-name-hint', identity, '--csr-out', work / 'again.csr', code=64)
    assert 'already holds 1 private key' in refused['error']['reason'] and not (work / 'again.csr').exists()
    assert key_call('import-signing-cert', keychain, '--cert', work / 'ca.pem', code=22)['error']['kind'] == 'verification-failed'
    imported = key_call('import-signing-cert', keychain, '--cert', work / 'signing.pem')['result']
    assert imported['imported'] and imported['identity'] and imported['subject'] == identity
    assert not key_call('import-signing-cert', keychain, '--cert', work / 'signing.pem')['result']['imported']
    leaf = imported['certificateSha1']
    key_call('provision-signing-key', fixture_keychain, '--common-name-hint', 'fixture signer',
             '--csr-out', work / 'fixture.csr', '--test-self-signed-cert-out', work / 'fixture.pem')
    fixture_leaf = key_call('import-signing-cert', fixture_keychain, '--cert', work / 'fixture.pem')['result']['certificateSha1']
    fixture_record_path = Path(f'{fixture_keychain}.acl.json')
    fixture_record = json.loads(fixture_record_path.read_text())
    # A not-yet-pinned key with a foreign ACL record must refuse before even the
    # test-build sentinel is spawned. Preparation must not "repair" unknown ACLs.
    fixture = work / 'Fixture.app'
    shutil.copytree(desired, fixture)
    for path in [fixture, *fixture.rglob('*')]:
        if not path.is_symlink(): path.chmod(path.stat().st_mode | 0o200)
    nested = fixture / 'Contents/Helpers/Nested.app'
    shutil.copytree(desired, nested)
    for path in [fixture, *fixture.rglob('*')]:
        if not path.is_symlink(): path.chmod(path.stat().st_mode | 0o200)
    inventory_file = work / 'fixture-inventory.json'
    inventory_file.write_text(json.dumps(['Contents/Helpers/Nested.app']))
    fixture_identifier = 'dev.overeng.macos-app.fixture.synthetic-host'
    fixture_requirement = f'identifier "{fixture_identifier}" and certificate leaf = H"{fixture_leaf}"'
    production_requirements = work / 'production-requirements.json'
    production_requirements.write_text('[]')
    fixture_options = ['--certificate-sha1', fixture_leaf, '--identifier', fixture_identifier,
                       '--target', fixture, '--production-requirements', production_requirements]
    # These refusals require no password or usable signing identity.
    refused = key_call('sign-fixture', fixture_keychain, *fixture_options,
                      '--requirement', config['requirement'], code=64, secret=None)
    assert 'ctl-constructed' in refused['error']['reason'], refused
    refused = key_call('sign-fixture', fixture_keychain, '--certificate-sha1', fixture_leaf,
                      '--identifier', 'dev.example.production', '--target', fixture, code=64, secret=None)
    assert 'fixture.' in refused['error']['reason'], refused
    refused = key_call('sign-fixture', fixture_keychain, '--certificate-sha1', leaf, code=64, secret=None)
    assert 'fixture identity' in refused['error']['reason'], refused
    write_config(signer={'teamId': 'TEST', 'identity': fixture_leaf})
    try:
        refused = key_call('sign-fixture', fixture_keychain, *fixture_options, code=64, secret=None)
        assert 'production signer' in refused['error']['reason'], refused
    finally:
        write_config()
    # The production key's SHA1 and public-key hash stay genuine; only the
    # allowlist subject is forged. Refusal must use the actual locked certificate.
    forged_record_path = Path(f'{keychain}.fixture-identity.json')
    original_fixture_record = forged_record_path.read_text()
    forged_record = json.loads(original_fixture_record)
    forged_record['subject'] = 'forged fixture subject'
    forged_record_path.write_text(json.dumps(forged_record))
    signing_before = (work / 'codesign.log').read_text() if (work / 'codesign.log').exists() else ''
    try:
        refused = key_call('sign-fixture', keychain, '--certificate-sha1', leaf,
                          '--identifier', fixture_identifier, '--target', fixture,
                          '--production-requirements', production_requirements, code=64, secret=None)
        assert 'production signer' in refused['error']['reason'], refused
        assert not unlocked()
        assert ((work / 'codesign.log').read_text() if (work / 'codesign.log').exists() else '') == signing_before
    finally:
        forged_record_path.write_text(original_fixture_record)
    print('PASS forged allowlist subject cannot authorize the actual production certificate before unlock/codesign', flush=True)
    production_requirements.write_text(json.dumps([fixture_requirement.replace(' and ', '\n and ')]))
    try:
        refused = key_call('sign-fixture', fixture_keychain, *fixture_options, code=64, secret=None)
        assert 'production designated requirement' in refused['error']['reason'], refused
    finally:
        production_requirements.write_text('[]')
    assert not unlocked(fixture_keychain)
    print('PASS fixture namespace, unlisted/production identity and compiled-equivalent production DR refuse before unlocking', flush=True)
    before_codesign = (work / 'codesign.log').read_text() if (work / 'codesign.log').exists() else ''
    fixture_record_path.write_text(json.dumps(dict(fixture_record, keychain='foreign')))
    try:
        refusal = key_call('sign-fixture', fixture_keychain, *fixture_options, code=64)
        assert refusal['error']['kind'] == 'invalid-input' and 'ACL record' in refusal['error']['reason'], refusal
        assert ((work / 'codesign.log').read_text() if (work / 'codesign.log').exists() else '') == before_codesign
        assert not unlocked(fixture_keychain)
    finally:
        fixture_record_path.write_text(json.dumps(fixture_record))
    print('PASS unpinned fixture key with foreign ACL record refuses before sentinel codesign starts', flush=True)
    bad_inventory = work / 'bad-inventory.json'
    bad_inventory.write_text('{}')
    escaping_inventory = work / 'escaping-inventory.json'
    (fixture / 'Contents/escaped').symlink_to(work, target_is_directory=True)
    escaping_inventory.write_text(json.dumps(['Contents/escaped']))
    fixture_inputs = [
        ([], 64),
        (['--certificate-sha1', 'bad'], 64),
        (['--certificate-sha1', fixture_leaf], 64),
        (['--certificate-sha1', fixture_leaf, '--target', work / 'absent.app'], 23),
        (['--certificate-sha1', fixture_leaf, '--target', fixture], 64),
        (['--certificate-sha1', fixture_leaf, '--target', fixture, '--identifier', 'not-a-fixture'], 64),
        ([*fixture_options, '--inventory', bad_inventory], 64),
        ([*fixture_options, '--inventory', escaping_inventory], 64),
    ]
    try:
        for args, code in fixture_inputs:
            unlock_for_test(fixture_keychain)
            key_call('sign-fixture', fixture_keychain, *args, code=code)
            assert not unlocked(fixture_keychain), f'Fixture input refusal left the interrupted keychain unlocked: {args}'
        unlock_for_test(fixture_keychain)
        refused = key_call('sign-fixture', fixture_keychain, '--certificate-sha1', 'bad', code=20, failpoint='relock')
        assert refused['error']['category'] == 'relock-failed', refused
        assert not unlocked(fixture_keychain)
    finally:
        (fixture / 'Contents/escaped').unlink()
    print('PASS fixture input failures relock interrupted K and report a checked final-lock failure', flush=True)
    # A CA-issued test leaf with no system anchor must fail before codesign; no K search-list
    # membership or system trust change is permitted. Self-signed test leaves use a per-evaluation
    # anchor in the feature build only.
    key_call('provision-signing-key', chain_missing, '--common-name-hint', 'chain missing', '--csr-out', work / 'chain.csr')
    issue(work / 'chain.csr', work / 'chain.pem')
    key_call('import-signing-cert', chain_missing, '--cert', work / 'chain.pem')
    key_call('prove-signing-key', chain_missing, '--no-sign')
    signing_before = (work / 'sign.log').read_text() if (work / 'sign.log').exists() else ''
    incomplete = key_call('prove-signing-key', chain_missing, code=20)
    assert incomplete['error']['category'] == 'chain-incomplete', incomplete
    assert ((work / 'sign.log').read_text() if (work / 'sign.log').exists() else '') == signing_before
    assert not unlocked(chain_missing)
    production = tool(str(example / 'primitives/bin/macos-app-ctl'), 'provision-signing-key',
                      '--test-self-signed-cert-out', 'unused', check=False)
    assert production.returncode == 64 and 'Unknown option' in production.stdout
    print('PASS unanchored CA-issued leaf refused as chain-incomplete before codesign; production has no test issuance option', flush=True)
    login = Path.home() / 'Library/Keychains/login.keychain-db'
    assert 'login keychain' in key_call('provision-signing-key', login, '--common-name-hint', 'x', '--csr-out', work / 'x.csr', code=64, secret='unused')['error']['reason']
    assert 'Library/Keychains' in key_call('provision-signing-key', work / 'elsewhere.keychain-db', '--common-name-hint', 'x', '--csr-out', work / 'x.csr', code=64)['error']['reason']
    assert key_call('prove-signing-key', keychain, code=20, secret=b'')['error']['category'] == 'password-invalid'
    assert not (work / 'elsewhere.keychain-db').exists() and not (work / 'x.csr').exists()
    print('PASS provisioning: 0600 keychain off the search list, lock on sleep/300s, CSR verifies, '
          'existing key refused, non-pairing cert refused, idempotent import, login/elsewhere/empty password refused', flush=True)

    # Simulate SIGKILL leaving K unlocked: even argument/password/certificate failures must
    # acquire it locked and finish with a checked lock. An injected final-lock failure overrides
    # the original error, rather than silently relying on a best-effort destructor.
    errors = [
        ('provision-signing-key', ['--common-name-hint', '', '--csr-out', work / 'bad.csr'], 64, password),
        ('provision-signing-key', ['--common-name-hint', 'x', '--csr-out', work / 'bad.csr'], 20, b''),
        ('import-signing-cert', ['--cert', work / 'absent.pem'], 23, password),
        ('import-signing-cert', ['--cert', work / 'signing.pem'], 20, b''),
        ('import-signing-cert', ['--cert', work / 'ca.pem'], 22, password),
        ('prove-signing-key', ['--no-sign'], 20, b''),
        ('prove-signing-key', ['--no-sign'], 20, 'incorrect-password'),
    ]
    for action, args, code, secret in errors:
        unlock_for_test()
        key_call(action, keychain, *args, code=code, secret=secret)
        assert not unlocked(), f'{action} left the interrupted keychain unlocked on error'
    for action, args in [
        ('provision-signing-key', ['--common-name-hint', '', '--csr-out', work / 'bad.csr']),
        ('import-signing-cert', ['--cert', work / 'absent.pem']),
        ('prove-signing-key', ['--no-sign']),
    ]:
        unlock_for_test()
        failed = key_call(action, keychain, *args, code=20, secret=b'', failpoint='relock')
        assert failed['error']['category'] == 'relock-failed', failed
        assert not unlocked()
    print('PASS provisioning/import/proof failures relock interrupted K, with checked final-lock failure reporting', flush=True)

    # Dry pass first: pin and guard without running codesign, then the full proof.
    dry = key_call('prove-signing-key', keychain, '--no-sign')['result']
    assert dry['guardReady'] and dry['signOk'] is None and dry['signSkipped'], dry
    assert dry['exportAttempted'] and dry['exportRefused'] and dry['exportStatus'] == -25316, dry
    if agent_baseline is None:
        # The per-evaluation test anchor in ctl does not grant trust to codesign.
        # Prove the expected trust limitation rather than skipping other failures.
        valid = tool('/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning', str(keychain)).stdout
        matching = tool('/usr/bin/security', 'find-identity', '-p', 'codesigning', str(keychain)).stdout
        untrusted = any(leaf.lower() in line.lower() and 'CSSMERR_TP_NOT_TRUSTED' in line
                        for line in matching.splitlines())
        assert leaf.lower() not in valid.lower() and untrusted, (valid, matching)
        print('NOT RUN: untrusted test identity in no-UI session: positive sign-fixture, '
              'prove-signing-key codesign, and signing-dependent install/verify/rollback/IPC cases', flush=True)
        print('PASS no-UI refusal and non-signing integration cases; positive signing is NOT VERIFIED', flush=True)
        raise SystemExit(0)
    proof = key_call('prove-signing-key', keychain)['result']
    assert proof['partitionCapable'] and proof['guardReady'] and proof['signOk'] is True, proof
    assert proof['partitionList'] == ['apple:'] and proof['signAclExact'] and proof['recordedCtlPath'] == ctl_path, proof
    assert proof['securityToolExcluded'], proof
    assert proof['keyExtractable'] is False and proof['exportRefused'] and not proof['exportAttempted'], proof
    assert proof['lockedAfterWindow'] and proof['lockOnSleep'] and proof['lockIntervalSeconds'] == 300, proof
    assert not unlocked()
    print(f'PASS signing-key proof: {json.dumps(proof, sort_keys=True)}', flush=True)
    key_call('prove-signing-key', fixture_keychain, '--no-sign')
    sealed = key_call('sign-fixture', fixture_keychain, *fixture_options,
                      '--inventory', inventory_file)['result']
    assert sealed['signedPaths'] == [str(nested), str(fixture)], sealed
    for target in (nested, fixture):
        assert tool('/usr/bin/codesign', '--verify', '--strict', f'-R={fixture_requirement}', str(target)).returncode == 0
    assert not unlocked(fixture_keychain)
    print('PASS pinned fixture signs through ctl and verifies with the declared requirement', flush=True)

    # The fake signer pauses only after ctl has unlocked K and passed its exact guard.
    (work / 'sign-slow').touch()
    try:
        interrupted = call('prove-signing-key', '--keychain', keychain, secret=password, code=23,
                           terminate_when=work / 'slow-ready')
        assert 'Cancelled by signal' in interrupted['error']['reason'], interrupted
        assert not unlocked(), 'SIGTERM left K unlocked'
        child = int((work / 'slow-child-pid').read_text())
        try:
            os.kill(child, 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError('SIGTERM left the codesign child running or unreaped')
    finally:
        for name in ('sign-slow', 'slow-ready', 'slow-child-pid'):
            (work / name).unlink(missing_ok=True)
    print('PASS SIGTERM inside the signing window kills/reaps codesign and checks the final keychain lock', flush=True)

    # Descendants must not outlive a reaped codesign leader or pin its inherited pipes open.
    for mode, code in [('signal', 23), ('deadline', 20)]:
        (work / 'sign-fork-mode').write_text(mode)
        started = time.monotonic()
        try:
            stopped = call('prove-signing-key', '--keychain', keychain, secret=password, code=code,
                           terminate_when=work / 'fork-ready' if mode == 'signal' else None)
            if mode == 'signal':
                assert 'Cancelled by signal' in stopped['error']['reason'], stopped
            else:
                assert stopped['error']['category'] == 'sign-timeout', stopped
            assert time.monotonic() - started < 35, 'output drain escaped the codesign deadline'
            assert not unlocked(), f'{mode} with inherited output pipes left K unlocked'
            for name in ('fork-leader-pid', 'fork-descendant-pid'):
                pid = int((work / name).read_text())
                until = time.monotonic() + 3
                while True:
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        break
                    assert time.monotonic() < until, f'{mode} left group member {pid} alive or unreaped'
                    time.sleep(0.01)
        finally:
            for name in ('sign-fork-mode', 'fork-ready', 'fork-leader-pid', 'fork-descendant-pid'):
                (work / name).unlink(missing_ok=True)
    print('PASS descendant-held stdout/stderr: SIGTERM and deadline tear down the group and relock K', flush=True)

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

    # Production must ignore the PATH codesign shim for verification as well as signing.
    test_ctl = ctl
    ctl = example / 'primitives/bin/macos-app-ctl'
    codesign_before = log(work / 'codesign.log')
    try:
        assert call('status')['result']['drValid']
        assert not install(desired)['result']['changed']
    finally:
        ctl = test_ctl
    assert log(work / 'codesign.log') == codesign_before, 'production exec used PATH codesign'
    print('PASS production uses absolute /usr/bin/codesign despite the PATH shim', flush=True)

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
    assert Path(reinstalled['archive']).parent != Path(first_archive).parent, 'archive parent reused'
    assert status['bundleMetadataDigest'] == reinstalled['bundleMetadataDigest'], 'cleanup failure undid the exchange'
    shutil.rmtree(Path(first_archive).parent)
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
        return sorted(str(p / app_bundle_name) for p in app.parent.glob('.macos-app-stage-*')
                      if (p / app_bundle_name).is_dir())
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
    product_signatures = [Path(entry['argv'][-1]) for entry in calls
                          if ('--sign' in entry['argv'] or '-s' in entry['argv'])
                          and entry['argv'][-1].endswith('.app')
                          and not Path(entry['argv'][-1]).is_relative_to(fixture)]
    assert product_signatures, 'no product bundle signatures observed'
    assert all(path.name == app_bundle_name for path in product_signatures), product_signatures
    print('PASS all product signing targets, sealed/imported bundles, exchange stages, retained '
          'archives and rollback copies keep the pinned product basename', flush=True)
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

    other = work / 'UnrelatedOtherBuild.app'
    shutil.copytree(desired, other)
    for path in other.rglob('*'):
        if not path.is_symlink(): path.chmod(path.stat().st_mode | 0o200)
    with (other / 'Contents/Info.plist').open('rb') as f: info = plistlib.load(f)
    info['CFBundleIdentifier'] = 'dev.example.other-host'
    with (other / 'Contents/Info.plist').open('wb') as f: plistlib.dump(info, f)
    config = dict(config, bundleId='dev.example.other-host', appBundleName='Other.app',
                  requirement=f'identifier "dev.example.other-host" and certificate leaf = H"{leaf}"',
                  launchd=dict(config['launchd'], label='dev.example.other-host'))
    write_config()
    other_app = work / 'other-apps/Other.app'
    common[common.index('--app-dir') + 1] = str(other_app)
    common[common.index('--state') + 1] = str(work / 'other-state')
    # EndpointGuard holds an exclusive parent-directory flock for the host's lifetime.
    other_socket_dir = work / 'other'
    other_socket_dir.mkdir(mode=0o700)
    common[common.index('--socket') + 1] = str(other_socket_dir.relative_to(root) / 's')
    install(other)
    call('select-generation', '--generation', first)
    call('converge-launchd')
    call('verify', '--desired', other, '--generation', first)
    dr_a = tool('/usr/bin/codesign', '-d', '-r-', str(app)).stdout
    dr_b = tool('/usr/bin/codesign', '-d', '-r-', str(other_app)).stdout
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
    other_signatures = [Path(entry['argv'][-1])
                        for entry in map(json.loads, log(work / 'codesign.log').splitlines())
                        if ('--sign' in entry['argv'] or '-s' in entry['argv'])
                        and entry['argv'][-1].endswith('.app')
                        and Path(entry['argv'][-1]).is_relative_to(other_app.parent)]
    assert other_signatures and all(path.name == config['appBundleName']
                                    for path in other_signatures), other_signatures
    print('PASS host-only rollback works without a previous generation', flush=True)
finally:
    cleanup()
    print('PASS throwaway keychains removed; user search list unchanged')
    print(f'SecurityAgent after: {security_agent_windows()}' if agent_baseline is not None else
          f'SecurityAgent after: unavailable; no-UI audit session flags={no_ui_session():#x}', flush=True)
print(f'PASS primitive integration; scratch: {work.relative_to(root)}')
