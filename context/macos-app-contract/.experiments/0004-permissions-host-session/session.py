#!/usr/bin/env python3
"""Source-only preparation and human-present, fail-closed experiment controller."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import shlex
import sys
import threading
import time
import plistlib

from evidence import Tripwire, correlate_audit, parse

ROOT = Path(__file__).resolve().parent
PROMPTS = {'automation.a.request': 'kTCCServiceAppleEvents',
           'automation.b.request': 'kTCCServiceAppleEvents',
           'microphone.request': 'kTCCServiceMicrophone'}
PREFLIGHTS = ['status', 'automation.a.preflight', 'automation.b.preflight',
              'microphone.preflight', 'fda.preflight']
REVOKED = ['screen.capture', 'ax.probe', 'audio.capture', 'core.notify',
           'private.experiment-restic-backup', 'watchman.fda']
OPS = set(PREFLIGHTS + REVOKED + list(PROMPTS) + ['notifications.provisional',
          'private.seed', 'watchman.start', 'watchman.events', 'watchman.reconnect', 'watchman.stop'])


def append(path, value):
    with path.open('a', encoding='utf-8') as stream:
        stream.write(json.dumps({'observedAt': time.time(), **value}) + '\n')
        stream.flush()
SERVICES = {'ScreenCapture': 'kTCCServiceScreenCapture', 'Accessibility': 'kTCCServiceAccessibility',
            'SystemPolicyAllFiles': 'kTCCServiceSystemPolicyAllFiles', 'Microphone': 'kTCCServiceMicrophone',
            'Notifications': 'kTCCServiceNotifications'}



def gui_watch(directory):
    """Run ONLY as a directly launched gui-domain process, never from prep/SSH."""
    if subprocess.check_output(['/bin/launchctl', 'managername'], text=True).strip() != 'Aqua':
        raise RuntimeError('window watcher is not in the GUI bootstrap domain')
    cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
    cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
    cf.CFArrayGetCount.restype = ctypes.c_long
    cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
    cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
    cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    cf.CFDictionaryGetValue.restype = ctypes.c_void_p
    cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long, ctypes.c_uint32]
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    owner_key = ctypes.c_void_p.in_dll(cg, 'kCGWindowOwnerName').value
    try:
        while True:
            array = cg.CGWindowListCopyWindowInfo(1, 0)
            if not array:
                raise RuntimeError('GUI window list unavailable')
            owners = []
            try:
                for index in range(cf.CFArrayGetCount(array)):
                    item = cf.CFArrayGetValueAtIndex(array, index)
                    owner = cf.CFDictionaryGetValue(item, owner_key)
                    buffer = ctypes.create_string_buffer(1024)
                    if owner and cf.CFStringGetCString(owner, buffer, len(buffer), 0x08000100):
                        owners.append(buffer.value.decode('utf-8'))
            finally:
                cf.CFRelease(array)
            forbidden = sorted(set(owners) & {'SecurityAgent', 'UserNotificationCenter'})
            if forbidden:
                raise RuntimeError('forbidden dialog owner: ' + ', '.join(forbidden))
            # Do not include arbitrary app/window names in evidence.
            temporary = directory / 'gui-heartbeat.next'
            temporary.write_text(str(time.time()))
            temporary.replace(directory / 'gui-heartbeat')
            time.sleep(0.1)
    except BaseException as error:
        (directory / 'STOP').write_text(str(error))
        raise


class Session:
    def __init__(self, config):
        self.config = config
        self.directory = Path(config['evidenceDirectory']).expanduser().resolve()
        self.directory.mkdir(parents=True, exist_ok=False)
        os.chmod(self.directory, 0o700)
        self.events = queue.Queue()
        self.tripwire = Tripwire()
        self.allowed = set()
        self.log = None
        self.label = 'dev.overeng.permissions-host.experiment.tripwire.' + str(os.getpid())
        self.domain = 'gui/' + str(os.getuid())
        self.bootstrapped = False

    def start(self):
        if self.config.get('sealedReleasesVerified') is not True:
            raise RuntimeError('live session requires verified sealed v1/v2 artifacts')
        expected = self.config['authorizedHost']
        actual = subprocess.check_output(['/bin/hostname'], text=True).strip()
        if not expected or actual != expected:
            raise RuntimeError('authorized host pin mismatch')
        processes = subprocess.check_output(['/bin/ps', '-axo', 'pid,ppid,command'], text=True)
        if any(token in processes for token in ('Runner.Worker', '/_work/', '/_temp/')):
            raise RuntimeError('CI work active; session not started')
        plist = self.directory / 'gui-tripwire.plist'
        with plist.open('wb') as stream:
            plistlib.dump({'Label': self.label, 'ProgramArguments': [sys.executable,
                str(ROOT / 'session.py'), 'watch-gui', str(self.directory)],
                'RunAtLoad': True, 'ProcessType': 'Interactive',
                'StandardErrorPath': str(self.directory / 'gui.stderr')}, stream)
        subprocess.run(['/bin/launchctl', 'bootstrap', self.domain, str(plist)], check=True)
        self.bootstrapped = True
        deadline = time.monotonic() + 10
        while not (self.directory / 'gui-heartbeat').exists():
            if (self.directory / 'STOP').exists() or time.monotonic() > deadline:
                raise RuntimeError('GUI tripwire failed to arm')
            time.sleep(0.1)
        self.log = subprocess.Popen(['/usr/bin/log', 'stream', '--style', 'ndjson', '--level', 'info',
            '--predicate', 'process == "tccd" AND eventMessage CONTAINS "AUTHREQ_"'],
            stdout=subprocess.PIPE, stderr=(self.directory / 'tccd.stderr').open('w'), text=True)
        def ingest():
            for line in self.log.stdout:
                self.events.put(line)
            self.events.put(None)
        threading.Thread(target=ingest, daemon=True).start()
        # A live stream must stay alive before any native request is issued.
        time.sleep(1)
        self.guard()
        append(self.directory / 'session.jsonl', {'event': 'armed', 'pid': os.getpid()})

    def guard(self):
        stop = self.directory / 'STOP'
        if stop.exists():
            raise RuntimeError('GUI tripwire: ' + stop.read_text())
        heartbeat = self.directory / 'gui-heartbeat'
        if not heartbeat.exists() or time.time() - float(heartbeat.read_text()) > 2:
            raise RuntimeError('GUI tripwire heartbeat stale')
        if self.log is None or self.log.poll() is not None:
            raise RuntimeError('tccd stream unavailable')
        while not self.events.empty():
            line = self.events.get_nowait()
            if line is None:
                raise RuntimeError('tccd stream ended')
            with (self.directory / 'tccd.raw.jsonl').open('a') as stream:
                stream.write(line)
            # log stream emits a non-JSON startup banner; only that exact class is ignored.
            if line.startswith('Filtering the log data using '):
                continue
            row = json.loads(line)
            event = parse(row)
            if event:
                append(self.directory / 'tccd.parsed.jsonl', event)
                self.tripwire.observe(event, self.allowed)

    def ask(self, op, allow_prompt=False, remote=False):
        if op not in OPS or (allow_prompt and op not in PROMPTS):
            raise RuntimeError('operation or prompt flag not allowlisted')
        self.guard()
        if op in PROMPTS and not allow_prompt:
            raise RuntimeError('prompt operation requires explicit --allow-prompt')
        if op != 'status':
            snapshot = self.ask('status')
            if snapshot.get('status') != 'ok' or not isinstance(snapshot.get('result', {}).get('permissions'), dict):
                raise RuntimeError('fresh permission snapshot unavailable')
            permissions = snapshot['result']['permissions']
            self.allowed = {service for name, service in SERVICES.items() if permissions.get(name) is True}
            target = 'AppleEventsA' if op.startswith('automation.a.') else 'AppleEventsB' if op.startswith('automation.b.') else None
            if target and permissions.get(target) is True:
                self.allowed.add('kTCCServiceAppleEvents')
        if allow_prompt:
            print('ANNOUNCEMENT: the host will now request ' + op + '. Answer only this announced permission dialog.', flush=True)
            print('Human present: type ALLOW ' + op + ' to proceed:', flush=True)
            acknowledgement = queue.Queue()
            threading.Thread(target=lambda: acknowledgement.put(sys.stdin.readline()), daemon=True).start()
            while acknowledgement.empty():
                self.guard()
                time.sleep(0.05)
            answer = acknowledgement.get().strip()
            if answer != 'ALLOW ' + op:
                raise RuntimeError('prompt announcement not acknowledged')
            append(self.directory / 'session.jsonl', {'event': 'prompt-announced', 'op': op})
            self.allowed.add(PROMPTS[op])
        args = [self.config['client'], 'ask', '--socket', self.config['socket'], '--request', json.dumps({'op': op})]
        if allow_prompt:
            args.append('--allow-prompt')
        if remote:
            if allow_prompt:
                raise RuntimeError('prompt requests are local human-present only')
            for key in ('sshJump', 'sshTarget', 'remoteClient'):
                if not self.config.get(key) or self.config[key].startswith('-'):
                    raise RuntimeError('explicit SSH jump, target and remote client configuration required')
            remote_args = [self.config['remoteClient'], *args[1:]]
            args = ['/usr/bin/ssh', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
                    '-J', self.config['sshJump'], self.config['sshTarget'], shlex.join(remote_args)]
        # Fixed native CLI only: no shell, arbitrary worker argv, signing or keychain access.
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   start_new_session=True)
        result_queue = queue.Queue()
        def collect():
            result_queue.put(process.communicate())
        threading.Thread(target=collect, daemon=True).start()
        deadline = time.monotonic() + (120 if allow_prompt else 60)
        try:
            while result_queue.empty():
                self.guard()
                if time.monotonic() > deadline:
                    raise RuntimeError('native request timeout')
                time.sleep(0.05)
            stdout, stderr = result_queue.get_nowait()
            response = json.loads(stdout)
            append(self.directory / 'client.jsonl', {'request': {'op': op}, 'response': response,
                   'exitCode': process.returncode, 'stderr': stderr})
            # Drain delayed tccd rows while the one-shot announcement is still scoped.
            end = time.monotonic() + 1
            while time.monotonic() < end:
                self.guard()
                time.sleep(0.05)
            if process.returncode not in (0, 1):
                raise RuntimeError('native transport/request failed; see evidence')
            if process.returncode == 0 and response.get('status') != 'ok':
                raise RuntimeError('native success exit disagrees with response')
            if process.returncode == 1 and response.get('status') not in ('permission-required', 'failed', 'session-unavailable'):
                raise RuntimeError('native failure exit disagrees with response')
            audit_id = response.get('auditId')
            audit_rows = [json.loads(line) for line in Path(self.config['hostAudit']).read_text().splitlines() if line.strip()]
            for row in correlate_audit(audit_rows, audit_id):
                append(self.directory / 'host-audit.jsonl', row)
            return response
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            if allow_prompt:
                self.allowed.discard(PROMPTS[op])
            self.allowed.clear()


    def close(self):
        if self.log is not None:
            self.log.terminate()
            self.log.wait(timeout=5)
        if self.bootstrapped:
            subprocess.run(['/bin/launchctl', 'bootout', self.domain + '/' + self.label], check=False)


def prepare(config_path):
    config = json.loads(Path(config_path).read_text())
    for key in ('authorizedHost', 'client', 'socket', 'evidenceDirectory', 'hostAudit'):
        if not config.get(key):
            raise RuntimeError('missing external configuration: ' + key)
    if not Path(config['client']).is_file():
        raise RuntimeError('native client is not built; preparation never builds it')
    print('Configuration ready. No GUI watcher, host, protected call, build, signing or install was started.')
    return config



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prep', 'live', 'revocation', 'watch-gui'])
    parser.add_argument('config')
    args = parser.parse_args()
    if args.mode == 'watch-gui':
        gui_watch(Path(args.config))
        return
    config = prepare(args.config)
    if args.mode == 'prep':
        return
    def terminate(signum, frame):
        raise SystemExit('session terminated by signal ' + str(signum))
    signal.signal(signal.SIGTERM, terminate)
    session = Session(config)
    try:
        session.start()
        if args.mode == 'revocation':
            for op in REVOKED:
                response = session.ask(op)
                if response.get('status') != 'permission-required':
                    raise RuntimeError('revocation failed: ' + op + ': ' + json.dumps(response))
            return
        print('Commands: an allowlisted op; prompt OP --allow-prompt; note TEXT; quit. No implicit prompt permission.')
        while True:
            session.guard()
            # Continue monitoring while the operator reads the numbered script.
            pending = queue.Queue()
            threading.Thread(target=lambda: pending.put(sys.stdin.readline()), daemon=True).start()
            while pending.empty():
                session.guard()
                time.sleep(0.05)
            command = pending.get().strip()
            if command in ('quit', ''):
                break
            if command.startswith('note '):
                append(session.directory / 'human.jsonl', {'note': command[5:]})
            elif command.startswith('ssh '):
                print(json.dumps(session.ask(command[4:], remote=True)))
            elif command.startswith('prompt '):
                parts = command.split()
                if len(parts) != 3 or parts[2] != '--allow-prompt':
                    raise RuntimeError('explicit prompt syntax required')
                print(json.dumps(session.ask(parts[1], True)))
            else:
                print(json.dumps(session.ask(command)))
    except BaseException as error:
        append(session.directory / 'session.jsonl', {'event': 'ABORT', 'reason': str(error)})
        raise
    finally:
        session.close()


if __name__ == '__main__':
    main()
