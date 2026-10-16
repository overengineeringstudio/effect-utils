#!/usr/bin/env python3
import json,pathlib,sys,tempfile
sys.dont_write_bytecode=True
HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent)); import safety
result={'host':'headless CI Mac','commandShape':'ssh headless-ci-mac nice -n 19 python3 0005-lifecycle-secret/run.py','verdict':'FAIL'}
try:
    with tempfile.TemporaryDirectory(prefix='m3-e5-build-') as work:
        exe=pathlib.Path(work)/'probe'
        safety.run(['/usr/bin/clang','-std=c11','-Wall','-Wextra','-O2',HERE/'probe.c','-o',exe])
        code,out,err=safety.run([exe,'suite'],expect=None,timeout=35)
        result.update(suiteExit=code,stdout=out,stderr=err,verdict='PASS' if code==0 else 'FAIL')
    result['buildTreeRemoved']=not pathlib.Path(work).exists()
except Exception as e: result['error']=str(e); raise
finally:
    result.update(argv=safety.TRACE,ciChecks=safety.CI,uiChecks=safety.UI)
    (HERE/'evidence.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2)); sys.exit(0 if result['verdict']=='PASS' else 1)
