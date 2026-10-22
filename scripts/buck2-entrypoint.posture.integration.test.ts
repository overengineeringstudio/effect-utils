import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  cacheDaemonPostureFingerprint,
  cacheDaemonRestartDecision,
  reconcileCacheDaemonPosture,
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

  it('reconciles reader to writer and rotated auth once, persists only private keyed state and fails closed while busy', () => {
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
      const reconcile = () =>
        reconcileCacheDaemonPosture({ native, root, args: ['build', '//:fixture'], env })
      reconcile()
      reconcile()
      expect(
        readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line === 'kill'),
      ).toHaveLength(0)
      writeFileSync(
        join(root, '.buckconfig.local'),
        '[buck2]\nallow_cache_uploads = true\n[buck2_re_client]\nhttp_headers = authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH\n',
      )
      reconcile()
      reconcile()
      expect(
        readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line === 'kill'),
      ).toHaveLength(1)
      const stored = readFileSync(marker, 'utf8')
      expect(stored).not.toContain(secret)
      expect(statSync(marker).mode & 0o777).toBe(0o600)
      env.BUCK2_CACHE_WRITE_BASIC_AUTH = 'rotated-planted-credential'
      reconcile()
      reconcile()
      expect(
        readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line === 'kill'),
      ).toHaveLength(2)
      const active = JSON.parse(readFileSync(state, 'utf8'))
      active.active_commands = [{ trace_id: 'concurrent-command' }]
      writeFileSync(state, JSON.stringify(active))
      env.BUCK2_CACHE_WRITE_BASIC_AUTH = 'another-rotation'
      expect(reconcile).toThrow('refusing to stop it')
      expect(
        readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line === 'kill'),
      ).toHaveLength(2)
      // An externally replaced daemon is not covered by the old posture marker.
      active.process_info.pid++
      writeFileSync(state, JSON.stringify(active))
      expect(reconcile).toThrow('refusing to stop it')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
