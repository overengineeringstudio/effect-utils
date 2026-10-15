#!/usr/bin/env python3
"""Headless-CI-Mac-only ad-hoc platform falsifier; no keychain, identity or trust access."""
import hashlib,json,pathlib,plistlib,shutil,sys,tempfile
sys.dont_write_bytecode=True
HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent)); import safety
def digest(app):
    h=hashlib.sha256()
    for p in sorted(app.rglob('*')):
        if p.is_file(): h.update(str(p.relative_to(app)).encode()+b'\0'+p.read_bytes())
    return h.hexdigest()
def main():
    evidence={'host':'headless CI Mac','signingMode':'ad-hoc ONLY','cases':{},'verdict':'FAIL','launchdOperations':0}
    try:
        with tempfile.TemporaryDirectory(prefix='m3-e3-') as temp:
            work=pathlib.Path(temp); native=work/'native'; check=work/'requirement'
            safety.run(['/usr/bin/clang','-x','c',HERE/'native.c','-o',native])
            safety.run(['/usr/bin/clang',HERE/'requirement.c','-framework','Security','-framework','CoreFoundation','-o',check])
            app=work/'Fixture.app'; helper=app/'Contents/Helpers/Helper.app'
            inventory=[(helper,'dev.overeng.macos-app.m3-helper'),(app,'dev.overeng.macos-app.m3-host')]
            for bundle,ident,name in [(app,inventory[1][1],'Host'),(helper,inventory[0][1],'Helper')]:
                (bundle/'Contents/MacOS').mkdir(parents=True); shutil.copy2(native,bundle/'Contents/MacOS'/name)
                (bundle/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':ident,'CFBundleExecutable':name,'CFBundlePackageType':'APPL','CFBundleName':name,'CFBundleVersion':'1'}))
            def sign_all():
                for path,ident in inventory:
                    safety.run(['/usr/bin/codesign','--force','-s','-','--timestamp=none','--identifier',ident,path])
                for path,ident in inventory: safety.run([check,'check',path,f'identifier "{ident}"'])
            sign_all(); baseline=digest(app)
            for name in ['external-presentation-generation','pinned-payload']:
                before=len([a for a in safety.TRACE if pathlib.Path(a[0]).name=='codesign'])
                if name=='pinned-payload':
                    payload=work/'payload'; safety.run(['/usr/bin/clang','-DM3_REVISION=3',HERE/'native.c','-o',payload])
                    (work/'generation.json').write_text(json.dumps({'payload':str(payload),'sha256':hashlib.sha256(payload.read_bytes()).hexdigest()}))
                else: (work/'presentation.json').write_text('{"title":"Changed external presentation"}\n')
                safety.run([check,'check',app,f'identifier "{inventory[1][1]}"'])
                assert digest(app)==baseline and before==len([a for a in safety.TRACE if pathlib.Path(a[0]).name=='codesign'])
                evidence['cases'][name]={'verdict':'PASS','signCount':0,'sealedDigest':baseline,'staticValidity':0}
            plist=app/'Contents/Info.plist'; old=plist.read_bytes(); meta=plistlib.loads(old); meta['CFBundleName']='Changed'; plist.write_bytes(plistlib.dumps(meta))
            rc,out,err=safety.run([check,'check',app,f'identifier "{inventory[1][1]}"'],expect=None)
            assert rc!=0 and digest(app)!=baseline
            evidence['cases']['sealed-metadata']={'verdict':'PASS','decision':'reject; explicit host release required','staticExit':rc,'detail':out}; plist.write_bytes(old)
            nested=helper/'Contents/MacOS/Helper'; safety.run(['/usr/bin/clang','-DM3_REVISION=2',HERE/'native.c','-o',nested])
            rc,out,_=safety.run([check,'check',app,f'identifier "{inventory[1][1]}"'],expect=None); assert rc!=0
            before=len(safety.TRACE); sign_all()
            signed=[a for a in safety.TRACE[before:] if pathlib.Path(a[0]).name=='codesign']
            assert [pathlib.Path(a[-1]) for a in signed]==[helper,app] and all('--deep' not in a for a in signed)
            evidence['cases']['nested-code']={'verdict':'PASS','signCount':2,'leafFirst':['Contents/Helpers/Helper.app','Fixture.app'],'deep':False,'preSignStaticExit':rc}
            rogue=app/'Contents/MacOS/Undeclared'; shutil.copy2(native,rogue)
            declared={app/'Contents/MacOS/Host',nested}
            actual={p for p in app.rglob('*') if p.is_file() and p.read_bytes()[:4] in [b'\xcf\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xca\xfe\xba\xbe']}
            assert actual-declared=={rogue}; rogue.unlink()
            evidence['cases']['undeclared-MachO']={'verdict':'PASS','decision':'rejected by explicit inventory before signing','signCount':0}
            hash=safety.run([check,'hash',app])[1].strip()
            first=f'identifier "{inventory[1][1]}" and cdhash H"{hash}"'
            reorder=f'cdhash H"{hash}" and identifier "{inventory[1][1]}"'
            candidate=work/'Candidate.app'; shutil.copytree(app,candidate)
            for path,req in [(app,reorder),(candidate,first)]: safety.run([check,'check',path,req])
            for path in [app,candidate]: assert safety.run([check,'check',path,f'identifier "wrong" and cdhash H"{hash}"'],expect=None)[0]!=0
            evidence['cases']['compiled-requirement']={'verdict':'PASS','first':first,'reordered':reorder,'differentText':first!=reorder,'crossChecks':2,'differentMeaningRejected':2,'api':'SecRequirementCreateWithString + SecStaticCodeCheckValidity','logicalEquivalenceClaim':False}
            evidence['sealedDigest']=baseline; evidence['verdict']='PASS'
        evidence['cleanup']={'temporaryTreeRemoved':not pathlib.Path(temp).exists()}
    except Exception as e: evidence['error']=str(e); raise
    finally:
        evidence.update(argv=safety.TRACE,ciChecks=safety.CI,uiChecks=safety.UI)
        (HERE/'evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
    print(json.dumps(evidence,indent=2))
if __name__=='__main__': main()
