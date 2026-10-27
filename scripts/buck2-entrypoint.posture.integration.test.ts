import { describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http2'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buckConfigValues, standaloneCachePostureConfig } from './buck2-cache-posture.ts'
import {
  cacheDaemonPostureFingerprint,
  cacheLauncherBirth,
  cacheDaemonRestartDecision,
  admitCacheDaemonCommand,
  directBuckArguments,
  cacheDaemonPolicyArguments,
} from './buck2-entrypoint.ts'
import './buck2-entrypoint.unit.test.ts'

const secret = 'planted-writer-credential-never-persist'
const values = {
  'buck2.allow_cache_uploads': 'true',
  'buck2_re_client.http_headers': 'authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH',
}

describe('daemon RE posture', () => {
  it('reruns an admitted reader once without remote cache and records evidence end-to-end', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buck2-reader-rerun-')))
    const grpc = createServer()
    grpc.on('stream', (stream) => {
      stream.on('data', () => {})
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
        stream.end(Buffer.from([0, 0, 0, 0, 0]))
      })
    })
    await new Promise<void>((resolve) => grpc.listen(0, '127.0.0.1', resolve))
    try {
      const address = grpc.address()
      if (address === null || typeof address === 'string')
        throw new Error('missing fixture address')
      writeFileSync(join(root, '.buckroot'), '')
      writeFileSync(
        join(root, '.buckconfig'),
        `[buck2]\nremote_cache_enabled = true\nallow_cache_uploads = false\nfile_watcher = fs_hash_crawler\n[buck2_re_client]\naction_cache_address = grpc://127.0.0.1:${address.port}\ntls = false\n`,
      )
      const native = join(root, 'native')
      const incidentOutput = readFileSync(
        new URL('./fixtures/buck2-re-unavailable.txt', import.meta.url),
        'utf8',
      )
      writeFileSync(
        native,
        `#!${process.execPath}
import {existsSync,readFileSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
const args=process.argv.slice(2), state='daemon.json';
if(args.includes('status')) { if(existsSync(state)) console.log(readFileSync(state,'utf8')); }
else if(args.includes('kill')) rmSync(state,{force:true});
else if(args.includes('audit')) writeFileSync(state,JSON.stringify({project_root:process.cwd(),isolation_dir:'v2',active_commands:[],process_info:{pid:12345},start_time:'fixture'}));
else if(args.includes('build')) {
 const policy=readFileSync(args[args.lastIndexOf('--config-file')+1],'utf8');
 appendFileSync('commands.jsonl',JSON.stringify({args,policy,noRemote:process.env.BUCK2_NO_REMOTE_CACHE})+'\\n');
 if(process.env.BUCK2_NO_REMOTE_CACHE!=='1') {
  console.error(${JSON.stringify(incidentOutput)});
  process.exit(1);
 }
 console.log('local build succeeded');
} else process.exit(9);
`,
        { mode: 0o700 },
      )
      const evidence = join(root, 'evidence')
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'buck2-entrypoint.ts'),
          native,
          'build',
          '//:fixture',
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            XDG_CACHE_HOME: join(root, 'cache'),
            BUCK2_PUBLIC_CACHE_READ_ONLY: '1',
            BUCK2_NO_REMOTE_CACHE: '',
            BUCK2_PRIVATE_CACHE_WRITE_AUTH: '',
            BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: '',
            BUCK2_CACHE_WRITE_BASIC_AUTH: '',
            CI: '1',
            GITHUB_RUN_ID: 'reader-rerun-fixture',
            GITHUB_JOB: 'reader-rerun-fixture',
            BUCK2_CI_JOB_INSTANCE: 'reader-rerun-fixture',
            GITHUB_ACTIONS: '',
            CI_BUCK2_CACHE_EVIDENCE_PATH: evidence,
            CI_BUCK2_CACHE_EVIDENCE_START: '',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, stderr).toBe(0)
      expect(stdout).toContain('local build succeeded')
      expect(stderr).toContain('rerunning once without remote cache')
      const commands = readFileSync(join(root, 'commands.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(commands).toHaveLength(2)
      expect(buckConfigValues(commands[0].policy)['buck2.remote_cache_enabled']).toBe('true')
      expect(commands[1].noRemote).toBe('1')
      expect(buckConfigValues(commands[1].policy)['buck2.remote_cache_enabled']).toBe('false')
      expect(buckConfigValues(commands[1].policy)['buck2.allow_cache_uploads']).toBe('false')
      const rows = readFileSync(`${evidence}.admission.jsonl`, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(rows).toHaveLength(2)
      expect(rows[1].event).toBe('reader-reapi-unavailable-rerun')
      expect(rows[1].admissionFallbacks.reapi).toBe(1)
      expect(rows[1].invocationId).not.toBe(rows[0].invocationId)
    } finally {
      await new Promise<void>((resolve, reject) =>
        grpc.close((error) => (error === undefined ? resolve() : reject(error))),
      )
      rmSync(root, { recursive: true, force: true })
    }
  }, 15000)
  it('pins before direct and nested argfile payloads and refuses unresolved argfiles', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'buck2-policy-argfiles-'))
    try {
      const pin = (args: readonly string[]) =>
        cacheDaemonPolicyArguments({
          args,
          cwd,
          env: {},
          policy: join(cwd, 'policy.buckconfig'),
        })
      for (const command of ['run', 'test', 'bxl']) {
        const input = [
          command,
          '//:fixture',
          '--',
          '--reuse-current-config',
          '@payload',
          '--flagfile',
          'literal',
        ]
        const direct = pin(input)
        expect(direct.indexOf('--config-file')).toBeLessThan(direct.indexOf('--'))
        expect(direct.slice(direct.indexOf('--'))).toEqual(input.slice(2))
        writeFileSync(join(cwd, 'inner'), `${input.join('\n')}\n`)
        writeFileSync(join(cwd, 'outer'), '--flagfile\ninner\n')
        expect(pin(['@outer'])).toEqual(direct)
        expect(pin(['--flagfile', 'outer'])).toEqual(direct)
        // Native resumes expansion in an outer frame after an inner separator.
        writeFileSync(join(cwd, 'tail'), 'expanded-payload\n')
        expect(pin(['@outer', '@tail']).at(-1)).toBe('expanded-payload')
      }
      expect(
        pin([
          '--reuse-current-config',
          'test',
          '//:fixture',
          '--',
          '--reuse-current-config',
        ]).filter((arg) => arg === '--reuse-current-config'),
      ).toHaveLength(1)
      expect(pin(['run', '//:fixture', 'payload', '--reuse-current-config']).slice(-2)).toEqual([
        'payload',
        '--reuse-current-config',
      ])
      writeFileSync(join(cwd, 'cycle'), '@cycle\n')
      writeFileSync(join(cwd, 'script.py'), 'never execute this')
      for (const args of [
        ['@missing'],
        ['@cycle'],
        ['@script.py'],
        ['@-'],
        ['--flagfile=outer'],
        ['--flagfile'],
        ['@cell//flags'],
      ])
        expect(() => pin(args)).toThrow('cannot safely resolve native arguments or argfiles')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('preserves absent root/native defaults without enabling reader uploads or headers', () => {
    const env = {}
    const salt = 'default-policy-test'
    expect(cacheDaemonPostureFingerprint({ values: {}, env, salt })).toBe(
      cacheDaemonPostureFingerprint({
        values: {
          'buck2.remote_cache_enabled': 'true',
          'buck2.allow_cache_uploads': 'true',
          'buck2.default_allow_cache_upload': 'false',
          'buck2_re_client.http_headers': '',
        },
        env,
        salt,
      }),
    )
    expect(
      cacheDaemonPostureFingerprint({
        values: { 'buck2.allow_cache_uploads': 'false' },
        env,
        salt,
      }),
    ).not.toBe(cacheDaemonPostureFingerprint({ values: {}, env, salt }))
  })

  it('snapshots effective reader/optional-writer outage policy and preserves the tracked publisher default', async () => {
    const tracked = readFileSync(join(import.meta.dir, '..', '.buckconfig'), 'utf8')
    expect(buckConfigValues(tracked)['buck2.remote_cache_enabled']).toBeUndefined()
    for (const posture of ['publisher', 'reader-outage', 'optional-writer-outage']) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'buck2-effective-posture-')))
      try {
        const native = join(root, 'native')
        writeFileSync(join(root, '.buckroot'), '')
        writeFileSync(
          join(root, '.buckconfig'),
          posture === 'publisher'
            ? tracked
            : tracked.replaceAll(/grpc:\/\/[^\s]+/gu, 'grpc://127.0.0.1:1'),
        )
        // This fixture tests RE policy, not the machine's shared Watchman service.
        writeFileSync(join(root, '.buckconfig.local'), '[buck2]\nfile_watcher = fs_hash_crawler\n')
        const env = {
          ...process.env,
          CI: '1',
          GITHUB_RUN_ID: 'posture-fixture-run',
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_JOB: 'posture-fixture',
          BUCK2_CI_JOB_INSTANCE: 'posture-fixture-instance',
          GITHUB_STEP_SUMMARY: join(root, 'summary'),
          BUCK2_CACHE_WRITE_BASIC_AUTH: secret,
          BUCK2_NO_REMOTE_CACHE: '',
          BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: '',
          BUCK2_PRIVATE_CACHE_ADDRESS: '',
          BUCK2_PUBLIC_CACHE_READ_ONLY: posture === 'reader-outage' ? '1' : '',
          BUCK2_CACHE_WRITE_OPTIONAL: posture === 'optional-writer-outage' ? '1' : '',
          CI_BUCK2_CACHE_EVIDENCE_PATH: '',
        }
        const overlay = standaloneCachePostureConfig({ current: '', env })
        // Use the production publisher block and the actual tracked config: neither
        // declares remote_cache_enabled, whose native default is enabled.
        if (posture === 'publisher')
          expect(buckConfigValues(overlay)['buck2.remote_cache_enabled']).toBeUndefined()
        writeFileSync(
          native,
          `#!${process.execPath}
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const state=process.cwd()+'/daemon.json';
if(process.argv[4]==='status') {if(existsSync(state)) console.log(readFileSync(state,'utf8'));}
else if(process.argv[4]==='audit') writeFileSync(state,JSON.stringify({project_root:process.cwd(),isolation_dir:'v2',active_commands:[],process_info:{pid:process.pid},start_time:'now'}));
else process.exit(9);
`,
        )
        chmodSync(native, 0o700)
        const args = await admitCacheDaemonCommand({
          native,
          root,
          args: ['build', '//:fixture'],
          env,
          admit: async (beforeCachePosture) => {
            if (posture !== 'publisher')
              return directBuckArguments({
                cwd: root,
                args: ['build', '//:fixture'],
                env,
                cacheDirectory: join(root, 'probe-cache'),
                deadlineMs: 100,
                beforeCachePosture,
              })
            beforeCachePosture?.(buckConfigValues(`${tracked}\n${overlay}`))
            writeFileSync(join(root, '.buckconfig.local'), overlay)
            return ['build', '//:fixture']
          },
        })
        const policy = args[args.lastIndexOf('--config-file') + 1]!
        const text = readFileSync(policy, 'utf8')
        const values = buckConfigValues(text)
        expect(values['buck2.remote_cache_enabled']).toBe(
          posture === 'publisher' ? 'true' : 'false',
        )
        expect(values['buck2.allow_cache_uploads']).toBe(posture === 'publisher' ? 'true' : 'false')
        expect(values['buck2.default_allow_cache_upload']).toBe(
          posture === 'reader-outage' ? 'false' : 'true',
        )
        expect(text).not.toContain(secret)
        if (posture !== 'publisher') {
          const state = join(root, 'buck-out', '.cache-daemon-posture')
          const pin = readdirSync(state).find((file) => file.startsWith('reapi-job-'))!
          const saved = readFileSync(join(state, pin), 'utf8')
          expect(saved).not.toContain(secret)
          expect(Object.keys(JSON.parse(saved).decisions)[0]).toMatch(/^[a-f0-9]{64}$/u)
          expect(statSync(join(state, pin)).mode & 0o777).toBe(0o600)
        }
        expect(statSync(policy).mode & 0o777).toBe(0o600)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }, 15000)

  it('records closed REAPI outage diagnostics, including cached admission failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buck2-admission-failure-'))
    try {
      const evidence = join(root, 'evidence.json')
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          `
import {createServer} from 'node:net';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {directBuckArguments} from ${JSON.stringify(join(import.meta.dir, 'buck2-entrypoint.ts'))};
const root=${JSON.stringify(root)}, evidence=${JSON.stringify(evidence)};
const server=createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
await new Promise(resolve=>server.close(resolve));
writeFileSync(join(root,'.buckroot'),'');
writeFileSync(join(root,'.buckconfig'),'[buck2]\\nremote_cache_enabled = true\\n[buck2_re_client]\\naction_cache_address = grpc://127.0.0.1:'+port+'\\ntls = false\\n');
for(let index=0;index<2;index++) await directBuckArguments({
 cwd:root,args:['build','//:fixture'],deadlineMs:100,
 cacheDirectory:join(root,'probe-cache'),
 env:{CI:'1',CI_BUCK2_CACHE_EVIDENCE_PATH:evidence},
});
`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
      const rows = readFileSync(`${evidence}.admission.jsonl`, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(rows).toHaveLength(2)
      expect(rows[0].admissionFallbacks.reapi).toBe(1)
      expect(rows[0].reapiFailure).toEqual({
        class: 'tcp',
        phase: 'tcp',
        elapsedMs: expect.any(Number),
        deadlineMs: 100,
      })
      expect(rows[1].reapiFailure).toEqual(rows[0].reapiFailure)
      expect(JSON.stringify(rows)).not.toContain('127.0.0.1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves launcher birth identity without relying on PATH', () => {
    const birth = cacheLauncherBirth(process.pid)
    expect(birth).toBeDefined()
    const path = process.env['PATH']
    try {
      for (const restricted of ['', '/nonexistent']) {
        process.env['PATH'] = restricted
        expect(cacheLauncherBirth(process.pid)).toBe(birth)
      }
    } finally {
      if (path === undefined) delete process.env['PATH']
      else process.env['PATH'] = path
    }
  })

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
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buck2-daemon-posture-')))
    const native = join(root, 'native')
    const state = join(root, 'native-state')
    const calls = join(root, 'calls')
    const marker = join(root, 'buck-out', '.cache-daemon-posture', 'root.json')
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
  }, 15000)

  it('refuses different postures on one daemon, admits other roots/isolations and expires a reused PID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buck2-posture-race-'))
    const separateRoot = mkdtempSync(join(tmpdir(), 'buck2-posture-separate-'))
    const native = join(root, 'native')
    const state = join(root, 'daemon.json')
    const overlay = join(root, '.buckconfig.local')
    const calls = join(root, 'native-calls')
    const worker = join(root, 'worker.ts')
    let writer: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
    let reader: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
    try {
      writeFileSync(join(root, '.buckconfig'), '[buck2]\nremote_cache_enabled = true\n')
      writeFileSync(join(separateRoot, '.buckconfig'), '[buck2]\nremote_cache_enabled = true\n')
      writeFileSync(
        native,
        `#!${process.execPath}
import {appendFileSync,existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
const command=process.argv[4], isolation=process.argv[3], state=process.cwd()+'/daemon.json.'+isolation;
appendFileSync(${JSON.stringify(calls)},command+'\\n');
if(command==='status') { if(existsSync(state)) console.log(readFileSync(state,'utf8')); }
else if(command==='kill') rmSync(state,{force:true});
else if(command==='audit') writeFileSync(state,JSON.stringify({project_root:process.cwd(),isolation_dir:isolation,active_commands:[],process_info:{pid:process.pid},start_time:'now',startupOverlay:readFileSync(process.cwd()+'/.buckconfig.local','utf8')}));
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
const root=process.argv[3]??${JSON.stringify(root)};
const isolation=process.argv[4]??'v2';
const writer=mode!=='reader';
const values=writer ? ${JSON.stringify(values)} : {'buck2.allow_cache_uploads':'false'};
const config=writer ? '[buck2]\\nallow_cache_uploads = true\\n[buck2_re_client]\\nhttp_headers = authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH\\n' : '[buck2]\\nallow_cache_uploads = false\\n';
console.log('attempting');
try {
await admitCacheDaemonCommand({
native:${JSON.stringify(native)},root,args:['--isolation-dir',isolation,'build','//:fixture'],
env:{...process.env,CI:'1',BUCK2_CACHE_WRITE_BASIC_AUTH:${JSON.stringify(secret)}},
admit:async (check)=>{
check?.({'buck2.remote_cache_enabled':'true',...values});
writeFileSync(root+'/.buckconfig.local',config);
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
      while (writerText.includes('overlay') === false) {
        const chunk = await writerOutput.read()
        expect(chunk.done, 'writer exited before overlay barrier').toBe(false)
        writerText += new TextDecoder().decode(chunk.value)
      }
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
      while (writerText.includes('admitted') === false) {
        const chunk = await writerOutput.read()
        expect(chunk.done, 'writer exited before recording admission').toBe(false)
        writerText += new TextDecoder().decode(chunk.value)
      }
      // The daemon is idle here: the writer's PID reservation protects the pre-exec gap.
      expect(await reader.exited).toBe(1)
      expect(await new Response(reader.stderr).text()).toContain('concurrent launcher')
      expect(readFileSync(overlay, 'utf8')).toBe(writerOverlay)
      expect(JSON.parse(readFileSync(`${state}.v2`, 'utf8')).startupOverlay).toBe(writerOverlay)
      expect(readFileSync(calls, 'utf8')).not.toContain('kill')
      const separate = Bun.spawn([process.execPath, worker, 'reader', separateRoot], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await separate.exited, await new Response(separate.stderr).text()).toBe(0)
      expect(readFileSync(overlay, 'utf8')).toBe(writerOverlay)
      expect(readFileSync(calls, 'utf8')).not.toContain('kill')
      const otherIsolation = Bun.spawn([process.execPath, worker, 'reader', root, 'other'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await otherIsolation.exited, await new Response(otherIsolation.stderr).text()).toBe(0)
      expect(JSON.parse(readFileSync(`${state}.v2`, 'utf8')).startupOverlay).toBe(writerOverlay)
      expect(readFileSync(calls, 'utf8')).not.toContain('kill')
      const marker = JSON.parse(
        readFileSync(join(root, 'buck-out', '.cache-daemon-posture', 'root.json'), 'utf8'),
      )
      expect(marker.daemons.v2).toBeDefined()
      expect(marker.launches).toContainEqual({
        pid: writer.pid,
        birth: cacheLauncherBirth(writer.pid),
        fingerprint: marker.daemons.v2.fingerprint,
        isolation: 'v2',
      })
      const matching = Bun.spawn([process.execPath, worker, 'matching'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await matching.exited, await new Response(matching.stderr).text()).toBe(0)
      writer.stdin.write('finish\n')
      expect(await writer.exited).toBe(0)
      // A live reused PID is not the reserved process when its birth identity differs.
      expect(cacheLauncherBirth(process.ppid)).toBeDefined()
      marker.launches = [
        { pid: process.ppid, birth: 'previous-process-birth', fingerprint: 'stale' },
      ]
      writeFileSync(
        join(root, 'buck-out', '.cache-daemon-posture', 'root.json'),
        JSON.stringify(marker),
      )
      const after = Bun.spawn([process.execPath, worker, 'reader', root, 'other'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await after.exited, await new Response(after.stderr).text()).toBe(0)
      expect(
        readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line === 'kill'),
      ).toHaveLength(0)
    } finally {
      writer?.kill()
      reader?.kill()
      if (writer !== undefined) await writer.exited
      if (reader !== undefined) await reader.exited
      rmSync(root, { recursive: true, force: true })
      rmSync(separateRoot, { recursive: true, force: true })
    }
  }, 15000)
})
