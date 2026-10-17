#!/usr/bin/env python3
"""Remote-only ad-hoc caller-auth experiment; no keychain or named identity."""
import json
import os
import pathlib
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
sys.dont_write_bytecode = True
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import safety as boundary


def case(binary, authorized, client, mode, requirement, target=None, stale_version=False):
    # Short, private socket path avoids Darwin sockaddr_un's 104-byte limit.
    with tempfile.TemporaryDirectory(prefix='m3-e4-') as directory:
        socket = pathlib.Path(directory) / 's'
        baseline = boundary.windows()
        if baseline is not None and 'SecurityAgent' in baseline.values():
            raise RuntimeError('SecurityAgent present before E4 case: STOP')
        deadline = time.monotonic() + 30
        processes = []
        logs = {'server': '', 'client': ''}
        pending = {}
        selector = selectors.DefaultSelector()

        def launch(name, args, stdin=None):
            p, launch_baseline = boundary.spawn(args, stdin=stdin,
                                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            processes.append(p)
            os.set_blocking(p.stdout.fileno(), False)
            selector.register(p.stdout, selectors.EVENT_READ, name)
            pending[name] = ''
            return p

        def pump():
            if boundary.changed(boundary.windows(), baseline):
                raise RuntimeError('New UI window during E4: STOP')
            if time.monotonic() > deadline:
                raise RuntimeError('E4 case hard 30-second timeout')
            for key, _ in selector.select(.025):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                else:
                    text = data.decode('utf-8', errors='replace')
                    logs[key.data] += text
                    pending[key.data] += text

        def until(name, marker, process):
            while marker not in pending[name]:
                pump()
                if process.poll() is not None:
                    # Drain buffered pipe bytes once more before diagnosing an early exit.
                    pump()
                    if marker not in pending[name]:
                        raise RuntimeError(f'{name} exited before {marker}: rc={process.returncode}, log={logs[name]}')

        try:
            server = launch('server', [binary, 'stale-version-server' if stale_version else 'server', socket, requirement], subprocess.PIPE)
            until('server', 'READY\n', server)
            args = [client, 'client', socket, mode]
            if target is not None:
                args.append(target)
            subject = launch('client', args)
            until('server', 'CAPTURED ', server)
            if mode == 'exit':
                until('client', 'EXITING ', subject)
                while subject.poll() is None:
                    pump()
                if subject.returncode != 0:
                    raise RuntimeError('Exit-race fixture did not exit cleanly')
            else:
                until('client', 'EXECED ' if mode == 'exec' else 'LIVE ', subject)
            # Causal gate, not a scheduling delay: exit is reaped or replacement image
            # has executed main and written its H byte before Security lookup begins.
            server.stdin.write(b'K')
            server.stdin.flush()
            while any(p.poll() is None for p in processes) or selector.get_map():
                pump()
            if boundary.changed(boundary.windows(), baseline):
                raise RuntimeError('New UI window at E4 case completion: STOP')
            expected = 0 if client == authorized and mode == 'hold' and not stale_version else 1
            decision = f'DECISION accepted={1 if expected == 0 else 0}\n'
            passed = server.returncode == expected and decision in logs['server']
            expected_client = 0 if mode == 'exit' else expected
            passed = passed and subject.returncode == expected_client
            if mode == 'exec':
                passed = passed and 'LIVENESS hello=1\n' in logs['server']
                passed = passed and 'FRESHNESS stage=after-security rc=-1 errno=3 ' in logs['server']
                passed = passed and 'FRESHNESS stage=before-admission rc=-1 errno=3 ' in logs['server']
            return {'verdict': 'PASS' if passed else 'FAIL', 'serverExit': server.returncode,
                    'clientExit': subject.returncode, 'mode': mode, 'logs': logs,
                    'forcedTransitionBeforeSecurityLookup': mode in ('exit', 'exec')}
        finally:
            for p in processes:
                if p.poll() is None:
                    os.killpg(p.pid, signal.SIGKILL)
                    p.wait()
                if p.stdin:
                    p.stdin.close()
                p.stdout.close()
            selector.close()


def main():
    evidence = {'experiment':'E4','host':'headless CI Mac','status':'RUNNING','cases':{},
                'signingMode':'ad-hoc only','nice':19,'noLaunchd':True,
                'apiContract':'audit token, never PID-only; API availability logged',
                'pidReuseScope':'Synthetic wrong-incarnation token; no real kernel PID recycling claimed'}
    try:
        with tempfile.TemporaryDirectory(prefix='m3-e4-build-') as temp:
            directory=pathlib.Path(temp)
            binary=directory/'server'; check=directory/'requirement'
            boundary.run(['/usr/bin/clang','-std=c11','-Wall','-Wextra',HERE/'fixture.c',
                          '-framework','Security','-framework','CoreFoundation','-o',binary])
            boundary.run(['/usr/bin/clang',HERE.parent/'0003-sealed-boundary/requirement.c',
                          '-framework','Security','-framework','CoreFoundation','-o',check])
            paths={}
            for name in ['authorized','rejected']:
                path=directory/name; shutil.copy2(binary,path); paths[name]=path
                boundary.run(['/usr/bin/codesign','--force','-s','-','--timestamp=none',
                              '--identifier','dev.overeng.macos-app.m3-e4-'+name,path])
            authorized=paths['authorized']
            hash=boundary.run([check,'hash',authorized])[1].strip()
            requirement=f'cdhash H"{hash}" and identifier "dev.overeng.macos-app.m3-e4-authorized"'
            evidence['compiledRequirementInput']=requirement
            cases=[('authorized',authorized,'hold',None,False),
                   ('rejected-cdhash',paths['rejected'],'hold',None,False),
                   ('exit-before-check',authorized,'exit',None,False),
                   ('exec-rejected-before-check',authorized,'exec',paths['rejected'],False),
                   ('exec-authorized-before-check',authorized,'exec',authorized,False),
                   ('synthetic-pid-reuse-wrong-incarnation',authorized,'hold',None,True)]
            for name,client,mode,target,stale in cases:
                evidence['cases'][name]=case(binary,authorized,client,mode,requirement,target,stale)
            evidence['status']='PASS' if all(r['verdict']=='PASS' for r in evidence['cases'].values()) else 'FAIL'
        evidence['cleanup']={'temporaryTreeRemoved':not pathlib.Path(temp).exists()}
    except Exception as error:
        evidence['status']='FAIL'; evidence['error']=str(error); raise
    finally:
        evidence.update(argv=boundary.TRACE,ciChecks=boundary.CI,uiChecks=boundary.UI)
        (HERE/'evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
        print(json.dumps(evidence,indent=2),flush=True)
    if evidence['status']!='PASS': raise SystemExit(1)

if __name__ == '__main__':
    main()
