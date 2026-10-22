import { describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  cacheDaemonPostureFingerprint,
  cacheDaemonRestartDecision,
  admitCacheDaemonCommand,
} from './buck2-entrypoint.ts'

const secret = 'planted-writer-credential-never-persist'
const values = {
  'buck2.allow_cache_uploads': 'true',
  'buck2_re_client.http_headers': 'authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH',
}

describe('daemon RE posture', () => {
  it('compares keyed fingerprints, including credential rotation and reader transitions', () => {
    const env = { BUCK2_CACHE_WRITE_BASIC_AUTH: secret }
    const fingerprint = cacheDaemonPostureFingerprint({ values, env, salt: 'first-salt' })
    expect(fingerprint).not.toContain(secret)
    expect(fingerprint).toHaveLength(64)
    expect(cacheDaemonPostureFingerprint({ values, env, salt: 'first-salt' })).toBe(fingerprint)
    expect(cacheDaemonPostureFingerprint({ values, env, salt: 'other-salt' })).not.toBe(fingerprint)
    expect(cacheDaemonPostureFingerprint({ values, env: {}, salt: 'first-salt' })).not.toBe(
      fingerprint,
    )
    expect(
      cacheDaemonPostureFingerprint({
        values: { 'buck2.allow_cache_uploads': 'false' },
        env,
        salt: 'first-salt',
      }),
    ).not.toBe(fingerprint)
  })

  it('starts without a daemon, reuses matches, restarts only idle mismatches and refuses busy daemons', () => {
    expect(cacheDaemonRestartDecision({ daemon: 'none', matched: false })).toBe('start')
    for (const daemon of ['idle', 'busy'] as const)
      expect(cacheDaemonRestartDecision({ daemon, matched: true })).toBe('reuse')
    expect(cacheDaemonRestartDecision({ daemon: 'idle', matched: false })).toBe('restart')
    expect(cacheDaemonRestartDecision({ daemon: 'busy', matched: false })).toBe('refuse')
    expect(cacheDaemonRestartDecision({ daemon: 'unknown', matched: false })).toBe('refuse')
  })

  it('reconciles reader to writer and rotated auth once, persists only private keyed state and fails closed while busy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buck2-daemon-posture-'))
    const native = join(root, 'native')
    const state = join(root, 'native-state')
    const calls = join(root, 'calls')
    const marker = join(root, 'buck-out', '.cache-daemon-posture', 'v2.json')
    try {
      writeFileSync(
        join(root, '.buckconfig'),
        '[buck2]\nremote_cache_enabled = true\nallow_cache_uploads = false\n',
      )
      writeFileSync(
        native,
        `#!${process.execPath}\nimport {appendFileSync,existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
const args=process.argv.slice(2); const command=args[2];
appendFileSync(${JSON.stringify(calls)},command+'\\n');
if(command==='status') { if(existsSync(${JSON.stringify(state)})) console.log(readFileSync(${JSON.stringify(state)},'utf8')); }
else if(command==='kill') rmSync(${JSON.stringify(state)},{force:true});
else if(command==='audit') writeFileSync(${JSON.stringify(state)},JSON.stringify({project_root:${JSON.stringify(root)},isolation_dir:'v2',active_commands:[],process_info:{pid:process.pid},start_time:'now'}));
else process.exit(9);
`,
      )
      chmodSync(native, 0o700)
      const env = { ...process.env, CI: '1', BUCK2_CACHE_WRITE_BASIC_AUTH: secret }
      const admit = async () => ['build', '//:fixture']
      const reconcile = () =>
        admitCacheDaemonCommand({ native, root, args: ['build', '//:fixture'], env, admit })
      await admitCacheDaemonCommand({
        native,
        root,
        args: ['build', '//:fixture'],
        env: { ...env, CI: '' },
        admit,
      })
      expect(existsSync(calls)).toBe(false)
      await reconcile()
      await reconcile()
      expect(
        readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line === 'kill'),
      ).toHaveLength(0)
      writeFileSync(
        join(root, '.buckconfig.local'),
        '[buck2]\nallow_cache_uploads = true\n[buck2_re_client]\nhttp_headers = authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH\n',
      )
      await reconcile()
      await reconcile()
      expect(
        readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line === 'kill'),
      ).toHaveLength(1)
      const stored = readFileSync(marker, 'utf8')
      expect(stored).not.toContain(secret)
      expect(JSON.parse(stored).posture).toBe('writer')
      expect(statSync(marker).mode & 0o777).toBe(0o600)
      env.BUCK2_CACHE_WRITE_BASIC_AUTH = 'rotated-planted-credential'
      await reconcile()
      await reconcile()
      expect(
        readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line === 'kill'),
      ).toHaveLength(2)
      const active = JSON.parse(readFileSync(state, 'utf8'))
      active.active_commands = [{ trace_id: 'concurrent-command' }]
      writeFileSync(state, JSON.stringify(active))
      env.BUCK2_CACHE_WRITE_BASIC_AUTH = 'another-rotation'
      await expect(reconcile()).rejects.toThrow('refusing to stop it')
      expect(
        readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line === 'kill'),
      ).toHaveLength(2)
      // An externally replaced daemon is not covered by the old posture marker.
      active.process_info.pid++
      writeFileSync(state, JSON.stringify(active))
      await expect(reconcile()).rejects.toThrow('refusing to stop it')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('locks overlay selection through startup and refuses a mismatched pending native launch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buck2-posture-race-'))
    const native = join(root, 'native')
    const state = join(root, 'daemon.json')
    const overlay = join(root, '.buckconfig.local')
    const calls = join(root, 'native-calls')
    const worker = join(root, 'worker.ts')
    let writer: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
    let reader: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
    try {
      writeFileSync(join(root, '.buckconfig'), '[buck2]\nremote_cache_enabled = true\n')
      writeFileSync(
        native,
        `#!${process.execPath}
import {appendFileSync,existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
const command=process.argv[4];
appendFileSync(${JSON.stringify(calls)},command+'\\n');
if(command==='status') { if(existsSync(${JSON.stringify(state)})) console.log(readFileSync(${JSON.stringify(state)},'utf8')); }
else if(command==='kill') rmSync(${JSON.stringify(state)},{force:true});
else if(command==='audit') writeFileSync(${JSON.stringify(state)},JSON.stringify({project_root:${JSON.stringify(root)},isolation_dir:'v2',active_commands:[],process_info:{pid:process.pid},start_time:'now',startupOverlay:readFileSync(${JSON.stringify(overlay)},'utf8')}));
else process.exit(9);
`,
      )
      chmodSync(native, 0o700)
      writeFileSync(
        worker,
        `import {writeFileSync} from 'node:fs';
import {once} from 'node:events';
import {admitCacheDaemonCommand} from ${JSON.stringify(join(import.meta.dir, 'buck2-entrypoint.ts'))};
const mode=process.argv[2];
const writer=mode!=='reader';
const values=writer ? ${JSON.stringify(values)} : {'buck2.allow_cache_uploads':'false'};
const config=writer ? '[buck2]\\nallow_cache_uploads = true\\n[buck2_re_client]\\nhttp_headers = authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH\\n' : '[buck2]\\nallow_cache_uploads = false\\n';
console.log('attempting');
try {
await admitCacheDaemonCommand({
native:${JSON.stringify(native)},root:${JSON.stringify(root)},args:['build','//:fixture'],
env:{...process.env,CI:'1',BUCK2_CACHE_WRITE_BASIC_AUTH:${JSON.stringify(secret)}},
admit:async (check)=>{
check?.(values);
writeFileSync(${JSON.stringify(overlay)},config);
if(mode==='writer') { console.log('overlay'); await once(process.stdin,'data'); }
return ['build','//:fixture'];
}
});
console.log('admitted');
if(mode==='writer') await once(process.stdin,'data');
process.exit(0);
} catch(error) { console.error(error.message); process.exit(1); }
`,
      )
      writer = Bun.spawn([process.execPath, worker, 'writer'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const writerOutput = writer.stdout.getReader()
      let writerText = ''
      while (writerText.includes('overlay') === false)
        writerText += new TextDecoder().decode((await writerOutput.read()).value)
      const writerOverlay = readFileSync(overlay, 'utf8')
      reader = Bun.spawn([process.execPath, worker, 'reader'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const readerOutput = reader.stdout.getReader()
      expect(new TextDecoder().decode((await readerOutput.read()).value)).toContain('attempting')
      // Reader admission has begun, but cannot change the overlay while writer holds the lock.
      expect(readFileSync(overlay, 'utf8')).toBe(writerOverlay)
      writer.stdin.write('initialize\n')
      while (writerText.includes('admitted') === false)
        writerText += new TextDecoder().decode((await writerOutput.read()).value)
      // The daemon is idle here: the writer's PID reservation protects the pre-exec gap.
      expect(await reader.exited).toBe(1)
      expect(await new Response(reader.stderr).text()).toContain('concurrent launcher')
      expect(readFileSync(overlay, 'utf8')).toBe(writerOverlay)
      expect(JSON.parse(readFileSync(state, 'utf8')).startupOverlay).toBe(writerOverlay)
      expect(readFileSync(calls, 'utf8')).not.toContain('kill')
      const marker = JSON.parse(
        readFileSync(join(root, 'buck-out', '.cache-daemon-posture', 'v2.json'), 'utf8'),
      )
      expect(marker.posture).toBe('writer')
      expect(marker.launches).toContainEqual({ pid: writer.pid, fingerprint: marker.fingerprint })
      const matching = Bun.spawn([process.execPath, worker, 'matching'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await matching.exited, await new Response(matching.stderr).text()).toBe(0)
      writer.stdin.write('finish\n')
      expect(await writer.exited).toBe(0)
      const after = Bun.spawn([process.execPath, worker, 'reader'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await after.exited, await new Response(after.stderr).text()).toBe(0)
      expect(
        readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line === 'kill'),
      ).toHaveLength(1)
    } finally {
      writer?.kill()
      reader?.kill()
      if (writer !== undefined) await writer.exited
      if (reader !== undefined) await reader.exited
      rmSync(root, { recursive: true, force: true })
    }
  }, 15000)
})
