#!/usr/bin/env python3
"""Run through the real Unix-socket boundary; all mutable state stays in tmp/."""
# From the Darwin checkout root:
#   nix build .#macos-app-example --no-link --option builders '' --option max-jobs 2
#   nix run .#macos-app-integration --option builders '' --option max-jobs 2
# An existing example store path can be passed as the runner's first argument.
# No signing identities, launchd jobs, installed applications or windows are used.
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import plistlib
import resource
import stat
import socket
import subprocess
import sys
import tempfile
import time

from jsonschema import Draft202012Validator

root = Path(__file__).resolve().parents[2]
example = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(subprocess.check_output(
    ['nix', 'build', '.#macos-app-example', '--no-link', '--print-out-paths',
     '--option', 'builders', '', '--option', 'max-jobs', '2'],
    cwd=root, text=True).strip())
validator = Draft202012Validator(json.loads((Path(__file__).parent / 'wire.schema.json').read_text()))
Draft202012Validator.check_schema(validator.schema)
ctl_config = json.loads((example / 'ctl-config.json').read_text())
app_bundle_name = ctl_config['appBundleName']
assert app_bundle_name == 'Synthetic Host.app'
host_app = example / 'hostAppBundle'
host = host_app / 'Contents/MacOS/macos-app-host'
second_host = example / 'secondHostApp/SyntheticHost.app/Contents/MacOS/macos-app-host'
assert hashlib.sha256(host.read_bytes()).digest() == hashlib.sha256(second_host.read_bytes()).digest()

def audit_session():
    """The kind the host must report: it inherits this runner's audit session."""
    import ctypes
    security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    session_id, attributes = ctypes.c_uint32(), ctypes.c_uint32()
    status = security.SessionGetInfo(ctypes.c_uint32(0xFFFFFFFF), ctypes.byref(session_id), ctypes.byref(attributes))
    if status != 0 or attributes.value & 0x0001: return 'no-session'
    return 'gui' if attributes.value & 0x0010 else 'background-only'
expected_session = audit_session()
with (host_app / 'Contents/Info.plist').open('rb') as file:
    plist = plistlib.load(file)
assert plist['CFBundleIdentifier'] == 'dev.example.synthetic-host' and plist['LSBackgroundOnly'] is True
assert plist['CFBundleDisplayName'] + '.app' == app_bundle_name
runtime_sources = Path(__file__).parent / 'host/src'
runtime_bytes = b''.join(path.name.encode() + b'\n' + path.read_bytes()
                         for path in sorted(runtime_sources.glob('*.rs')))
expected_source_hash = hashlib.sha256(runtime_bytes + b''.join(
    (Path(__file__).parent / relative).read_bytes()
    for relative in ['host/Cargo.toml', 'host/Cargo.lock'])).hexdigest()
print('PASS host bytes identical across payload generations', flush=True)
scratch = root / 'tmp'
scratch.mkdir(exist_ok=True)
work = Path(tempfile.mkdtemp(prefix='macos-app-integration-', dir=scratch))
with (scratch / 'TEMPORARY_FILES.md').open('a') as log:
    log.write(f'\n- `{work.relative_to(root)}`: macOS app integration manifests, socket and server logs.\n')
uid = os.getuid()

def generation(source, name):
    manifest = json.loads((source / 'manifest.json').read_text())
    manifest['statusAllowedUids'] = [uid]
    for action in manifest['actions'].values():
        action['allowedUids'] = [uid]
    destination = work / name
    destination.mkdir()
    (destination / 'manifest.json').write_text(json.dumps(manifest))
    return destination, manifest

first, first_manifest = generation(example / 'generation', 'first')
second, second_manifest = generation(example / 'secondGeneration', 'second')
# Filesystem reachability must include manifest-declared non-owner callers.
first_manifest['statusAllowedUids'].append(uid + 1)
first_manifest['actions']['echo']['allowedUids'].append(uid + 1)
(first / 'manifest.json').write_text(json.dumps(first_manifest))
pointer = work / 'current'

def select(destination):
    pending = work / 'pending'
    pending.symlink_to(destination)
    pending.replace(pointer)

select(first)
os.chdir(root)
# The resolved absolute endpoint must also fit Darwin's 104-byte sockaddr_un limit.
sock = work.relative_to(root) / 'host.sock'
log = (work / 'server.log').open('wb')
def start_server(fd_limit=None):
    def limit_descriptors():
        resource.setrlimit(resource.RLIMIT_NOFILE, (fd_limit, fd_limit))
    return subprocess.Popen(
        [str(host), 'serve', '--socket', str(sock), '--generation-pointer', str(pointer)],
        stdout=log, stderr=log, preexec_fn=limit_descriptors if fd_limit else None)

server = start_server()

def request(action, args=None):
    value = {'wireVersion': 1, 'action': action, 'args': args or {}}
    validator.validate(value)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(5)
        client.connect(str(sock))
        client.sendall(json.dumps(value).encode() + b'\n')
        with client.makefile('rb') as response:
            result = json.loads(response.readline())
    validator.validate(result)
    return result

def rejected(action, args, code):
    response = request(action, args)
    assert response['ok'] is False and response['error']['code'] == code, response
    print(f'PASS {code}', flush=True)

def wait_ready():
    deadline = time.monotonic() + 10
    while True:
        if server.poll() is not None:
            raise RuntimeError((work / 'server.log').read_text())
        try:
            return request('status')['status']
        except (FileNotFoundError, ConnectionRefusedError):
            if time.monotonic() >= deadline:
                raise TimeoutError('Host socket did not become ready')
            time.sleep(0.02)

valid = {'choice': 'alpha', 'text': 'hello', 'count': 2}
try:
    status = wait_ready()
    assert status['pid'] == server.pid and status['generation'] == first_manifest['generation']
    assert status['hostVersion'] == '1' and status['session'] == expected_session
    assert status['hostSourceHash'] == expected_source_hash
    assert first_manifest['socketMode'] == 0o666
    assert stat.S_IMODE(sock.stat().st_mode) == 0o666
    print('PASS declared non-owner UID socket reachability mode', flush=True)
    held = []
    try:
        for _ in range(32):
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.settimeout(2)
            client.connect(str(sock))
            held.append(client)
        time.sleep(0.2)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as excess:
            excess.settimeout(2)
            excess.connect(str(sock))
            try:
                assert excess.recv(1) == b''
            except ConnectionResetError:
                pass
    finally:
        for client in held:
            client.close()
    time.sleep(0.2)
    assert request('status')['status']['pid'] == server.pid
    print('PASS global connection cap and capacity recovery', flush=True)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as slow:
        slow.settimeout(10)
        slow.connect(str(sock))
        started = time.monotonic()
        slow.sendall(b'{')
        for _ in range(4):
            time.sleep(1)
            slow.sendall(b' ')
        with slow.makefile('rb') as response:
            decoded = json.loads(response.readline())
        validator.validate(decoded)
        assert decoded['error']['code'] == 'requestTimeout', decoded
        assert time.monotonic() - started < 6.5
    print('PASS absolute whole-frame deadline against slowloris', flush=True)
    print('PASS status', flush=True)
    result = request('echo', valid)['result']
    assert result['exitCode'] == 0 and result['stdoutTail'] == 'first:alpha:hello:2\n' and result['stderrTail'] == '', result
    print('PASS declared action', flush=True)
    cli = subprocess.run([str(host), 'call', '--socket', str(sock), 'echo', '--arg', 'choice=beta', '--arg', 'text=world', '--arg', 'count=3'], text=True, capture_output=True, check=True)
    decoded = json.loads(cli.stdout)
    validator.validate(decoded)
    assert decoded['result']['stdoutTail'] == 'first:beta:world:3\n'
    print('PASS call client', flush=True)
    cli = subprocess.run([str(host), 'call', '--socket', str(sock), 'noisy'], text=True, capture_output=True, check=True)
    decoded = json.loads(cli.stdout)
    validator.validate(decoded)
    result = decoded['result']
    assert result['exitCode'] == 7 and result['stdoutTail'] == '\0' * 16384 and result['stderrTail'] == '\0' * 16384
    print('PASS bounded output tails, JSON escaping and nonzero exit', flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: request('wait'), range(8)))
    assert sum(response['ok'] for response in results) == 1, results
    assert all(response['ok'] or response['error']['code'] == 'busy' for response in results), results
    print('PASS per-action concurrency=1', flush=True)
    timed, manifest = generation(example / 'generation', 'timeout')
    manifest['actions']['wait']['timeoutMs'] = 50
    (timed / 'manifest.json').write_text(json.dumps(manifest))
    select(timed)
    started = time.monotonic()
    rejected('wait', {}, 'timeout')
    assert time.monotonic() - started < 2
    select(first)
    rejected('undeclared', {}, 'unknownAction')
    for bad in ({**valid, 'choice': 'other'}, {**valid, 'text': 'INVALID'}, {**valid, 'count': 9}, {**valid, 'extra': 'x'}, {**valid, 'text': 'x' * 21}):
        rejected('echo', bad, 'invalidArgs')
    mismatch, manifest = generation(example / 'generation', 'mismatch')
    manifest['actions']['echo']['executable'] = str(example / 'tamperedPayload/payload')
    (mismatch / 'manifest.json').write_text(json.dumps(manifest))
    select(mismatch)
    rejected('echo', valid, 'payloadHashMismatch')
    denied, manifest = generation(example / 'generation', 'denied')
    manifest['actions']['echo']['allowedUids'] = [uid + 1]
    manifest['statusAllowedUids'] = [uid + 1]
    (denied / 'manifest.json').write_text(json.dumps(manifest))
    select(denied)
    rejected('echo', valid, 'unauthorized')
    rejected('status', {}, 'unauthorized')
    select(second)
    result = request('echo', valid)['result']
    assert result['stdoutTail'] == 'second:alpha:hello:2\n' and result['generation'] == second_manifest['generation']
    status = request('status')['status']
    assert status['pid'] == server.pid and status['generation'] == second_manifest['generation']
    print('PASS pointer swap without restart', flush=True)
    duplicate = subprocess.run(
        [str(host), 'serve', '--socket', str(sock), '--generation-pointer', str(pointer)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
    assert duplicate.returncode != 0 and sock.exists()
    assert request('status')['status']['pid'] == server.pid
    print('PASS live listener refuses duplicate startup', flush=True)
    server.kill()
    server.wait(timeout=5)
    assert sock.exists(), 'SIGKILL should leave a stale socket for the restart test'
    server = start_server(fd_limit=24)
    assert wait_ready()['pid'] == server.pid
    print('PASS SIGKILL stale-socket restart', flush=True)
    exhausted = []
    try:
        # 24 total descriptors cannot accept all 40 connections; accept hits EMFILE.
        for _ in range(40):
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.settimeout(2)
            client.connect(str(sock))
            exhausted.append(client)
        time.sleep(0.3)
        assert server.poll() is None
    finally:
        for client in exhausted:
            client.close()
    time.sleep(0.5)
    assert request('status')['status']['pid'] == server.pid
    print('PASS EMFILE accept recovery without host exit', flush=True)
    server.terminate()
    assert server.wait(timeout=5) == 0
    assert not sock.exists(), 'Orderly shutdown must remove the socket itself'
    print('PASS SIGTERM socket cleanup', flush=True)
    print('macOS app integration: PASS', flush=True)
finally:
    if server.poll() is None:
        server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
    log.close()
