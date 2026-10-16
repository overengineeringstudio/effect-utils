"""Disposable experiment-only runner: remote CI exclusion, UI tripwire, adhoc-only signing."""
import ctypes, json, os, pathlib, signal, subprocess, time
CF=ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
CG=ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
CG.CGWindowListCopyWindowInfo.restype=ctypes.c_void_p
CF.CFArrayGetCount.argtypes=[ctypes.c_void_p]; CF.CFArrayGetCount.restype=ctypes.c_long
CF.CFArrayGetValueAtIndex.argtypes=[ctypes.c_void_p,ctypes.c_long]; CF.CFArrayGetValueAtIndex.restype=ctypes.c_void_p
CF.CFDictionaryGetValue.argtypes=[ctypes.c_void_p,ctypes.c_void_p]; CF.CFDictionaryGetValue.restype=ctypes.c_void_p
CF.CFNumberGetValue.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_void_p]
CF.CFStringGetCString.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_long,ctypes.c_uint32]
CF.CFRelease.argtypes=[ctypes.c_void_p]
NUMBER=ctypes.c_void_p.in_dll(CG,'kCGWindowNumber').value
OWNER=ctypes.c_void_p.in_dll(CG,'kCGWindowOwnerName').value
TRACE=[]; CI=[]
UI=[]
# Reused verbatim from merged nix/macos-app/ctl-integration.py (#1834).
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
def changed(current, baseline):
    if current is None or baseline is None: return current != baseline
    return bool(current.keys() - baseline.keys())
def windows():
    flags=no_ui_session()
    a=CG.CGWindowListCopyWindowInfo(1,0)
    if not a:
        return None  # Unavailable is never reported as zero windows.
    result={}
    try:
        for i in range(CF.CFArrayGetCount(a)):
            d=CF.CFArrayGetValueAtIndex(a,i); n=ctypes.c_int(); b=ctypes.create_string_buffer(512)
            CF.CFNumberGetValue(CF.CFDictionaryGetValue(d,NUMBER),9,ctypes.byref(n))
            name=CF.CFDictionaryGetValue(d,OWNER)
            if name: CF.CFStringGetCString(name,b,512,0x08000100)
            result[n.value]=b.value.decode(errors='replace')
        return result
    finally: CF.CFRelease(a)
def idle():
    # Publication omits the private hostname. The operator must explicitly pin
    # the authorized headless machine; an unset or mismatching pin fails closed.
    expected = os.environ.get('MACOS_APP_EXPERIMENT_HOST')
    assert expected and subprocess.check_output(['/usr/bin/nice','-n','19','/bin/hostname'],text=True).strip()==expected,'remote-only fixture: explicit authorized host pin required'
    while True:
        raw=subprocess.check_output(['/usr/bin/nice','-n','19','/bin/ps','-axo','pid,ppid,command'],text=True)
        jobs=[line for line in raw.splitlines() if 'Runner.Worker' in line or '/_work/' in line or '/_temp/' in line]
        CI.append({'time':time.time(),'activeJobCount':len(jobs)})
        if not jobs: return
        print('WAIT CI active jobs:',len(jobs),flush=True); time.sleep(15)
def argv_guard(args):
    args=list(map(str,args))
    if pathlib.Path(args[0]).name=='codesign':
        assert '--keychain' not in args and not any(a.startswith('--keychain=') for a in args),'keychain forbidden'
        assert '-s' in args and args[args.index('-s')+1]=='-','every codesign must be explicit -s -'
        assert '--sign' not in args and not any(a.startswith('--sign=') for a in args),'named signing form forbidden'
    return args
def spawn(args, **kwargs):
    args=argv_guard(args); idle(); baseline=windows()
    if baseline is not None and 'SecurityAgent' in baseline.values(): raise RuntimeError('SecurityAgent visible before step; STOP')
    UI.append({'auditFlags':hex(no_ui_session()),'windowList':'unavailable' if baseline is None else baseline})
    TRACE.append(args); print('ARGV '+json.dumps(args),flush=True)
    p=subprocess.Popen(['/usr/bin/nice','-n','19',*args],start_new_session=True,**kwargs)
    return p,baseline
def monitor(p,baseline,deadline):
    if changed(windows(),baseline) or time.monotonic()>deadline:
        raise RuntimeError('new UI window or hard timeout; STOP; leave dialog alone')
def run(args,expect=0,timeout=30):
    p,b=spawn(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    end=time.monotonic()+timeout
    try:
        while os.waitid(os.P_PID,p.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
            monitor(p,b,end); time.sleep(.02)
        monitor(p,b,end)
    except BaseException:
        try: os.killpg(p.pid,signal.SIGKILL)
        except (ProcessLookupError,PermissionError): pass
        p.communicate()
        raise
    try: os.killpg(p.pid,signal.SIGKILL)
    except (ProcessLookupError,PermissionError): pass
    out,err=p.communicate()
    if expect is not None and p.returncode!=expect: raise RuntimeError(f'exit {p.returncode}: {out} {err}')
    return p.returncode,out,err
