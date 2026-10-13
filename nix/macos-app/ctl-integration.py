#!/usr/bin/env python3
"""Real codesign/rename/socket tests; fake launchctl never registers a background item."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

root = Path.cwd()
example = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(subprocess.check_output([
    'nix', 'build', '.#macos-app-example', '--no-link', '--print-out-paths',
    '--option', 'builders', '', '--option', 'max-jobs', '2'], text=True).strip())
scratch = root / 'tmp'
scratch.mkdir(exist_ok=True)
work = Path(tempfile.mkdtemp(prefix='macos-app-ctl-', dir=scratch))
with (scratch / 'TEMPORARY_FILES.md').open('a') as log:
    log.write(f'\n- `{work.relative_to(root)}`: primitive integration apps, fake launchctl state, signing logs.\n')
# The raw executable is intentionally separate from the product wrapper, which refuses test signing.
wrapper = (example / 'ctl/bin/macos-app-ctl').read_text()
import re
ctl = Path(re.search(r"exec '([^']+)'", wrapper)[1])
config_path = Path(re.search(r"--config '([^']+)'", wrapper)[1])
config = json.loads(config_path.read_text())
config['allowTestSigning'] = True
config_file = work / 'config.json'
config_file.write_text(json.dumps(config))
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
with (base / 'launchctl.log').open('a') as log: log.write(json.dumps(args) + '\n')
if args[0] == 'bootout':
    job = jobs.pop(args[1])
    os.kill(job['pid'], signal.SIGTERM)
    for _ in range(500):
        if not Path(job['socket']).exists(): break
        time.sleep(.01)
    else: raise RuntimeError('host did not remove socket')
elif args[0] == 'bootstrap':
    with open(args[2], 'rb') as f: plist = plistlib.load(f)
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
    jobs[args[1] + '/' + plist['Label']] = {'pid': process.pid, 'socket': sock}
else: raise RuntimeError('unexpected launchctl operation')
jobs_file.write_text(json.dumps(jobs))
''')
launchctl.chmod(0o755)
# Real signing is always ad hoc; the shim provides an observable signer failure without keychain access.
codesign = bin_dir / 'codesign'
codesign.write_text(f'#!{sys.executable}\n' + r'''
import os, subprocess, sys
from pathlib import Path
base = Path(os.environ['MACOS_APP_TEST_WORK'])
args = sys.argv[1:]
if '--sign' in args:
    assert args[args.index('--sign') + 1] == '-'
    with (base / 'sign.log').open('a') as log: log.write('sign\n')
    if (base / 'sign-fail').exists():
        print('errSecInternalComponent (test-injected locked signer)', file=sys.stderr)
        sys.exit(1)
if '-r-' in args and (base / 'dr-mismatch').exists():
    print('designated => identifier "another.product"', file=sys.stderr)
    sys.exit(0)
sys.exit(subprocess.call(['/usr/bin/codesign'] + args))
''')
codesign.chmod(0o755)
env = dict(os.environ, PATH=f'{bin_dir}:/usr/bin:/bin', MACOS_APP_TEST_WORK=str(work))

common = ['--config', str(config_file), '--test-ad-hoc', '--app-dir', str(app),
          '--state', str(state), '--socket', sock, '--plist-dir', str(plists)]
def call(action, *args, code=0, extra_env=None):
    process = subprocess.run([str(ctl), action, *common, *map(str, args)], env=extra_env or env,
                             capture_output=True, text=True)
    assert process.returncode == code, (action, process.returncode, process.stdout, process.stderr)
    lines = process.stdout.splitlines()
    assert len(lines) == 1, process.stdout
    return json.loads(lines[0])

def contents(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def snapshots():
    return {str(p.relative_to(work)): (p.lstat().st_mtime_ns, p.lstat().st_size)
            for p in work.rglob('*') if p.name not in ['host.log']}

def log(path):
    return path.read_text() if path.exists() else ''

try:
    result = call('install-host', '--desired', desired)
    assert result['result']['changed']
    assert call('select-generation', '--generation', first)['result']['consumerRootRequired']
    assert call('converge-launchd')['result']['changed']
    call('verify', '--desired', desired, '--generation', first)
    before = snapshots()
    mutation_log = log(work / 'launchctl.log')
    signing_log = log(work / 'sign.log')
    assert not call('install-host', '--desired', desired)['result']['changed']
    assert not call('select-generation', '--generation', first)['result']['changed']
    assert not call('converge-launchd')['result']['changed']
    call('verify', '--desired', desired, '--generation', first)
    assert snapshots() == before, 'no-op wrote files or changed mtimes'
    assert log(work / 'launchctl.log') == mutation_log
    assert log(work / 'sign.log') == signing_log
    print('PASS no-op: no writes, signing or launchctl mutations (read-only print probes permitted)')
    call('select-generation', '--generation', second)
    assert not call('converge-launchd')['result']['changed']
    call('verify', '--desired', desired, '--generation', second)
    assert log(work / 'launchctl.log') == mutation_log
    print('PASS generation-only swap: running host rereads pointer, no restart')

    changed = work / 'changed.app'
    shutil.copytree(desired, changed)
    for path in changed.rglob('*'):
        if not path.is_symlink(): path.chmod(path.stat().st_mode | 0o200)
    (changed / 'Contents/Resources/host-source-hash').write_text('test-changed-host-source')
    with (changed / 'Contents/MacOS/macos-app-host').open('ab') as output: output.write(b'\0test changed host bytes\0')
    incumbent = contents(app / 'Contents/MacOS/macos-app-host')
    (work / 'sign-fail').touch()
    pending = call('install-host', '--desired', changed, code=20)
    assert pending['error']['kind'] == 'pending-signing'
    assert contents(app / 'Contents/MacOS/macos-app-host') == incumbent
    assert call('status')['result']['pendingSigning'] is not None
    (work / 'sign-fail').unlink()
    print('PASS signing failure: incumbent untouched, pending-signing exit 20')
    (work / 'dr-mismatch').touch()
    call('install-host', '--desired', changed, code=22)
    assert contents(app / 'Contents/MacOS/macos-app-host') == incumbent
    call('verify', '--desired', desired, '--generation', second, code=22)
    (work / 'dr-mismatch').unlink()
    print('PASS exact designated requirement mismatch rejected')
    installed = call('install-host', '--desired', changed)['result']
    assert installed['changed'] and Path(installed['archive']).is_dir()
    assert contents(app / 'Contents/MacOS/macos-app-host') != incumbent
    call('rollback', '--restore-host')
    assert contents(app / 'Contents/MacOS/macos-app-host') == incumbent
    assert state.joinpath('current').readlink() == first
    call('verify', '--desired', desired, '--generation', first)
    print('PASS changed host signed and atomically exchanged; rollback restored pointer and signed incumbent')

    (work / 'gui-absent').touch()
    config['session'] = 'gui-agent'
    config_file.write_text(json.dumps(config))
    before_log = log(work / 'launchctl.log')
    assert call('converge-launchd', code=21)['error']['kind'] == 'gui-absent'
    assert log(work / 'launchctl.log') == before_log
    assert call('status')['result']['session'] == 'background-only'
    config['session'] = 'background-agent'
    config_file.write_text(json.dumps(config))
    assert call('status')['result']['launchd']['domain'] == f'user/{uid}'
    print('PASS GUI-absent is explicit; background agent resolves user domain')
    (work / 'gui-absent').unlink()

    other = work / 'Other.app'
    shutil.copytree(desired, other)
    for path in other.rglob('*'):
        if not path.is_symlink(): path.chmod(path.stat().st_mode | 0o200)
    with (other / 'Contents/Info.plist').open('rb') as f: info = plistlib.load(f)
    info['CFBundleIdentifier'] = 'dev.example.other-host'
    with (other / 'Contents/Info.plist').open('wb') as f: plistlib.dump(info, f)
    config['bundleId'] = 'dev.example.other-host'
    config['launchd']['label'] = 'dev.example.other-host'
    config_file.write_text(json.dumps(config))
    other_app = work / 'apps/Other.app'
    common[common.index('--app-dir') + 1] = str(other_app)
    common[common.index('--state') + 1] = str(work / 'other-state')
    common[common.index('--socket') + 1] = str(work.relative_to(root) / 'other.sock')
    call('install-host', '--desired', other)
    call('select-generation', '--generation', first)
    call('converge-launchd')
    call('verify', '--desired', other, '--generation', first)
    dr_a = subprocess.run(['/usr/bin/codesign', '-d', '-r-', str(app)], capture_output=True, text=True).stderr
    dr_b = subprocess.run(['/usr/bin/codesign', '-d', '-r-', str(other_app)], capture_output=True, text=True).stderr
    assert 'identifier "dev.example.synthetic-host"' in dr_a
    assert 'identifier "dev.example.other-host"' in dr_b
    assert app != other_app
    jobs = json.loads((work / 'jobs.json').read_text())
    assert len({job['socket'] for job in jobs.values()}) == 2
    assert plists.joinpath('dev.example.synthetic-host.plist').is_file()
    assert plists.joinpath('dev.example.other-host.plist').is_file()
    print('PASS two products: distinct DR, app directory, label and socket')

    production = subprocess.run([str(example / 'ctl/bin/macos-app-ctl'), 'status', '--test-ad-hoc'], capture_output=True, text=True, env=env)
    assert production.returncode == 64 and json.loads(production.stdout)['error']['kind'] == 'invalid-input'
    print('PASS production wrapper refuses explicit test-only ad-hoc mode')
finally:
    if (work / 'jobs.json').exists():
        for job in json.loads((work / 'jobs.json').read_text()).values():
            try: os.kill(job['pid'], signal.SIGTERM)
            except ProcessLookupError: pass
print(f'PASS primitive integration; scratch: {work.relative_to(root)}')
