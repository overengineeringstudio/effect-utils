import { expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type ServerHttp2Session } from 'node:http2'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeRemoteCacheCapabilities } from './buck2-cache-posture.ts'

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
  const grpc = createServer()
  const sessions = new Set<ServerHttp2Session>()
  grpc.on('session', (session) => sessions.add(session))
  const launch = (cwd: string, isolation: string, posture: string, hold = false, job = '') => {
    const child = Bun.spawn(
      [process.execPath, worker, cwd, isolation, posture, String(hold), job],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
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
const [root,isolation,posture,hold,job]=process.argv.slice(2);
const fallback=posture==='fallback'||posture==='online';
const env={...process.env,CI:'1',GITHUB_ACTIONS:'true',GITHUB_RUN_ID:'2112-run',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'matrix-test',BUCK2_CI_JOB_INSTANCE:job==='missing'?'':job,GITHUB_STEP_SUMMARY:job?root+'/summary':'',BUCK2_NO_REMOTE_CACHE:'',BUCK2_PUBLIC_CACHE_READ_ONLY:fallback?'1':'',BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH:'',BUCK2_PRIVATE_CACHE_ADDRESS:'',BUCK2_CACHE_WRITE_BASIC_AUTH:'',BUCK2_CACHE_WRITE_OPTIONAL:'',CI_BUCK2_CACHE_EVIDENCE_PATH:job?root+'/admission':''};
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
 if((fallback && config['buck2.remote_cache_enabled']!==(posture==='online'?'true':'false')) || config['buck2.allow_cache_uploads']!==expected || config['buck2.default_allow_cache_upload']!==expected ||
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
    // The observed incident: timeout -> live fallback lease -> recovered endpoint.
    let healthy = false
    let requests = 0
    grpc.on('stream', (stream) => {
      requests++
      stream.on('data', () => {})
      stream.on('end', () => {
        if (healthy === true) {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
          stream.end(Buffer.from([0, 0, 0, 0, 0]))
        }
      })
    })
    await new Promise<void>((resolve) => grpc.listen(0, '127.0.0.1', resolve))
    const address = grpc.address()
    if (address === null || typeof address === 'string')
      throw new Error('fixture address unavailable')
    const endpoint = `grpc://127.0.0.1:${address.port}`
    writeFileSync(
      join(separate, '.buckconfig'),
      `[cells]\nfixture = .\n[buck2]\nremote_cache_enabled = true\n[buck2_re_client]\naction_cache_address = ${endpoint}\ncas_address = ${endpoint}\nengine_address = ${endpoint}\ntls = false\n`,
    )
    const pinned = launch(separate, 'reader', 'fallback', true, '2112-job-A')
    expect(new TextDecoder().decode((await pinned.stdout.getReader().read()).value)).toContain(
      'admitted',
    )
    expect(requests).toBe(2)
    healthy = true
    expect(
      await probeRemoteCacheCapabilities({
        address: endpoint,
        instanceName: '',
        header: undefined,
        tls: false,
        env: {},
        deadlineMs: 1000,
      }),
    ).toBe(true)
    // Evict the short-lived optimization without touching the authoritative job pin.
    rmSync(join(separate, 'probe-cache'), { recursive: true, force: true })
    const recovered = launch(separate, 'reader', 'fallback', false, '2112-job-A')
    expect(await recovered.exited, await new Response(recovered.stderr).text()).toBe(0)
    expect(requests).toBe(3) // The control succeeded; B did not select a new posture.
    const foreignJob = launch(separate, 'reader', 'online', false, '2112-job-B')
    expect(await foreignJob.exited).toBe(1)
    expect(await new Response(foreignJob.stderr).text()).toContain('concurrent launcher')
    expect(requests).toBe(4) // A different job gets its own fresh successful probe.
    pinned.stdin.write('finish\n')
    expect(await pinned.exited).toBe(0)
    const notice = await new Response(pinned.stderr).text()
    expect(notice).toContain('pinned to local fallback from first probe')
    expect(notice).toContain('class=deadline')
    const summary = readFileSync(join(separate, 'summary'), 'utf8')
    expect(summary).toContain('Pinned from first probe: local fallback for this CI job')
    expect(summary).toContain('class=deadline')
    expect(summary.match(/Pinned from first probe/gu)).toHaveLength(1)
    const decisions = readFileSync(join(separate, 'admission.admission.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(decisions[0].reapiDecision).toBe('first-probe-for-ci-job')
    expect(decisions[0].reapiFailure.class).toBe('deadline')
    expect(decisions[1].reapiDecision).toBe('pinned-from-first-probe')
    expect(decisions[1].admissionFallbacks.reapi).toBe(1)
    expect(decisions[2].admissionFallbacks.reapi).toBe(0)
    const state = join(separate, 'buck-out', '.cache-daemon-posture')
    expect(readdirSync(state).filter((file) => file.startsWith('reapi-job-'))).toHaveLength(2)
    for (const file of readdirSync(state).filter((file) => file.startsWith('reapi-job-')))
      expect(statSync(join(state, file)).mode & 0o777).toBe(0o600)
    const newJob = launch(separate, 'reader', 'online', false, '2112-job-B')
    expect(await newJob.exited, await new Response(newJob.stderr).text()).toBe(0)
    expect(requests).toBe(4)
    // A sequential matrix child on this same runner/root must probe independently,
    // although run, attempt and GITHUB_JOB are identical to both prior children.
    const sequentialChild = launch(separate, 'reader', 'online', false, '2112-job-C')
    expect(await sequentialChild.exited, await new Response(sequentialChild.stderr).text()).toBe(0)
    expect(requests).toBe(5)
    expect(readdirSync(state).filter((file) => file.startsWith('reapi-job-'))).toHaveLength(3)
    const unconfigured = launch(separate, 'reader', 'online', false, 'missing')
    expect(await unconfigured.exited, await new Response(unconfigured.stderr).text()).toBe(0)
    expect(requests).toBe(5) // Missing identity preserves the short-lived probe cache.
    const lastAdmission = JSON.parse(
      readFileSync(join(separate, 'admission.admission.jsonl'), 'utf8').trim().split('\n').at(-1)!,
    )
    expect(lastAdmission.reapiDecision).toBe('unpinned-missing-job-instance')
    expect(readdirSync(state).filter((file) => file.startsWith('reapi-job-'))).toHaveLength(3)
  } finally {
    for (const session of sessions) session.destroy()
    if (grpc.listening === true) grpc.close()
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
