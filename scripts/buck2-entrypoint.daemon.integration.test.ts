import { expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('scopes concurrent posture reservations to real Buck roots and daemon isolations', async () => {
  const native = process.env['BUCK2_NATIVE_BIN']
  if (native === undefined)
    throw new Error('BUCK2_NATIVE_BIN is required for real daemon regression')
  const roots = [
    realpathSync(mkdtempSync(join(tmpdir(), 'buck2-real-posture-'))),
    realpathSync(mkdtempSync(join(tmpdir(), 'buck2-real-separate-'))),
  ]
  const root = roots[0]!
  const separate = roots[1]!
  const worker = join(root, 'launcher.ts')
  const children: Bun.Subprocess<'pipe', 'pipe', 'pipe'>[] = []
  const launch = (cwd: string, isolation: string, posture: string, hold = false) => {
    const child = Bun.spawn([process.execPath, worker, cwd, isolation, posture, String(hold)], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    children.push(child)
    return child
  }
  const status = () => {
    const result = spawnSync(native, ['--isolation-dir', 'writer', 'status'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout).process_info.pid
  }
  try {
    for (const cwd of roots) {
      writeFileSync(join(cwd, '.buckroot'), '')
      writeFileSync(
        join(cwd, '.buckconfig'),
        '[cells]\nfixture = .\n[buck2]\nremote_cache_enabled = true\n',
      )
    }
    // The worker is ordinary launcher code, never a copied/imported test module.
    // Native status, startup audit, daemon identity and cleanup all use real Buck.
    writeFileSync(
      worker,
      `
import {writeFileSync} from 'node:fs';
import {once} from 'node:events';
import {admitCacheDaemonCommand,directBuckArguments} from ${JSON.stringify(join(import.meta.dir, 'buck2-entrypoint.ts'))};
const [root,isolation,posture,hold]=process.argv.slice(2);
const fallback=posture==='fallback';
const env={...process.env,CI:'1',BUCK2_NO_REMOTE_CACHE:'',BUCK2_PUBLIC_CACHE_READ_ONLY:fallback?'1':'',BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH:'',BUCK2_PRIVATE_CACHE_ADDRESS:'',BUCK2_CACHE_WRITE_BASIC_AUTH:'',BUCK2_CACHE_WRITE_OPTIONAL:'',CI_BUCK2_CACHE_EVIDENCE_PATH:''};
const values={'buck2.remote_cache_enabled':'true','buck2.allow_cache_uploads':posture,...(posture==='true'?{'buck2.default_allow_cache_upload':'true','buck2_re_client.http_headers':'authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH'}:{})};
const auditArgs=posture==='true'?['@'+root+'/'+isolation+'.outer']:['audit','config','--json'];
if(posture==='true') {
 writeFileSync(root+'/'+isolation+'.inner','audit\\nconfig\\n--json\\n--\\nbuck2.allow_cache_uploads\\nbuck2.default_allow_cache_upload\\nbuck2_re_client.http_headers\\n');
 writeFileSync(root+'/'+isolation+'.outer','--flagfile\\n'+root+'/'+isolation+'.inner\\n');
}
try {
 const args=await admitCacheDaemonCommand({native:${JSON.stringify(native)},root,
  args:['--isolation-dir',isolation,...auditArgs],env,
  admit:async check=>{
   if(fallback) {
    const admitted=await directBuckArguments({cwd:root,args:['build','//:fixture'],env,cacheDirectory:root+'/probe-cache',deadlineMs:100,beforeCachePosture:check});
    return ['audit','config','--json',...admitted.slice(2)];
   }
   check?.(values);writeFileSync(root+'/.buckconfig.local','[buck2]\\nallow_cache_uploads = '+posture+'\\n'+(posture==='true'?'default_allow_cache_upload = true\\n[buck2_re_client]\\nhttp_headers = authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH\\n':''));return auditArgs;
  }
 });
 console.log('admitted');
 if(hold==='true') await once(process.stdin,'data');
 const {spawnSync}=await import('node:child_process');
 if(hold==='true' && !fallback) {
  const unpinned=spawnSync(${JSON.stringify(native)},['--isolation-dir',isolation,...auditArgs],{cwd:root,encoding:'utf8'});
  if(unpinned.status!==0 || JSON.parse(unpinned.stdout)['buck2.allow_cache_uploads']!=='false') throw new Error('shared-overlay control did not observe B');
 }
 const result=spawnSync(${JSON.stringify(native)},['--isolation-dir',isolation,...args],{cwd:root,encoding:'utf8'});
 if(result.status!==0) throw new Error('native audit failed');
 const config=JSON.parse(result.stdout);
 const expected=fallback?'false':posture;
 if((fallback && config['buck2.remote_cache_enabled']!=='false') || config['buck2.allow_cache_uploads']!==expected || config['buck2.default_allow_cache_upload']!==expected ||
   config['buck2_re_client.http_headers']!==(posture==='true'?'authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH':'')) throw new Error('native audit policy changed');
 process.exit(0);
} catch(error) {console.error(error.message);process.exitCode=1;}
`,
    )
    const writer = launch(root, 'writer', 'true', true)
    const ready = await writer.stdout.getReader().read()
    expect(new TextDecoder().decode(ready.value)).toContain('admitted')
    const writerPid = status()
    const otherIsolation = launch(root, 'reader', 'false')
    expect(await otherIsolation.exited, await new Response(otherIsolation.stderr).text()).toBe(0)
    const otherRoot = launch(separate, 'writer', 'false')
    expect(await otherRoot.exited, await new Response(otherRoot.stderr).text()).toBe(0)
    const sameDaemon = launch(root, 'writer', 'false')
    expect(await sameDaemon.exited).toBe(1)
    expect(await new Response(sameDaemon.stderr).text()).toContain('concurrent launcher')
    // B has replaced the root-wide overlay. A must still execute with its own policy.
    writer.stdin.write('finish\n')
    expect(await writer.exited, await new Response(writer.stderr).text()).toBe(0)
    const matching = launch(root, 'writer', 'true')
    expect(await matching.exited, await new Response(matching.stderr).text()).toBe(0)
    expect(status()).toBe(writerPid)
    // Keep a real fallback launcher alive across the next identical admission.
    writeFileSync(
      join(separate, '.buckconfig'),
      '[cells]\nfixture = .\n[buck2]\nremote_cache_enabled = true\n[buck2_re_client]\naction_cache_address = grpc://127.0.0.1:1\ncas_address = grpc://127.0.0.1:1\nengine_address = grpc://127.0.0.1:1\ntls = false\n',
    )
    const fallback = launch(separate, 'reader', 'fallback', true)
    const fallbackReady = await fallback.stdout.getReader().read()
    expect(new TextDecoder().decode(fallbackReady.value)).toContain('admitted')
    const identicalFallback = launch(separate, 'reader', 'fallback')
    expect(
      await identicalFallback.exited,
      await new Response(identicalFallback.stderr).text(),
    ).toBe(0)
    fallback.stdin.write('finish\n')
    expect(await fallback.exited, await new Response(fallback.stderr).text()).toBe(0)
  } finally {
    for (const child of children) child.kill()
    await Promise.all(children.map((child) => child.exited))
    for (const cwd of roots) {
      for (const isolation of ['writer', 'reader']) {
        const killed = spawnSync(native, ['--isolation-dir', isolation, 'kill'], {
          cwd,
          encoding: 'utf8',
        })
        expect(killed.status, killed.stderr).toBe(0)
      }
      rmSync(cwd, { recursive: true, force: true })
    }
  }
}, 30000)
