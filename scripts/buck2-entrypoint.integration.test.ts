import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerHttp2Stream } from 'node:http2'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { directBuckArguments } from './buck2-entrypoint.ts'

const roots: string[] = []
const fixture = (address = 'grpc://127.0.0.1:1', archive = 'http://127.0.0.1:1/cas/'): string => {
  const root = mkdtempSync(join(tmpdir(), 'direct-buck-posture-'))
  roots.push(root)
  writeFileSync(join(root, '.buckroot'), '')
  writeFileSync(
    join(root, '.buckconfig'),
    `[buck2]\nremote_cache_enabled = true\nallow_cache_uploads = false\n[buck2_re_client]\naction_cache_address = ${address}\ninstance_name = fixture\ntls = false\n[archive_origin]\ntrusted_url_prefix = ${archive}\ntrusted_tier = private\n`,
  )
  return root
}
const options = (root: string) => ({
  cwd: root,
  env: {},
  cacheDirectory: join(root, 'probe-cache'),
})

const watcherFixture = () => {
  const root = fixture()
  writeFileSync(join(root, '.buckconfig'), '[buck2]\nfile_watcher = watchman\n')
  const state = join(root, 'socket')
  const calls = join(root, 'watchman-calls')
  writeFileSync(state, 'healthy')
  writeFileSync(
    join(root, 'watchman'),
    `#!${Bun.which('sh')}
printf '%s\\n' "$*" >> '${calls}'
if [ "$1" = "--version" ]; then
  printf '2026.10.05\\n'
  exit 0
fi
if [ "$1" = "--no-spawn" ]; then shift; fi
# Like Watchman, a client-local version is healthy even with no reachable service.
if [ "$1" != "--no-local" ]; then
  printf '{"version":"2026.10.05"}\\n'
  exit 0
fi
shift
# WATCHMAN_SOCK itself is deliberately ignored: only --sockname selects a service.
socket='${state}'
case "$1" in
  --sockname=*) socket="\${1#--sockname=}"; shift ;;
esac
[ "$*" = "--output-encoding=json version" ] || exit 2
case "$(cat "$socket")" in
  healthy) printf '{"version":"2026.10.05"}\\n' ;;
  unreachable) printf 'unable to connect to service\\n' >&2; exit 1 ;;
  malformed) printf 'not json\\n' ;;
  error) printf '{"version":"2026.10.05","error":"service unavailable"}\\n' ;;
  wrong-type) printf '{"version":123}\\n' ;;
  missing-version) printf '{}\\n' ;;
  hanging) exec sleep 30 ;;
esac
`,
    { mode: 0o700 },
  )
  return {
    root,
    state,
    calls,
    env: { PATH: `${root}:${process.env['PATH'] ?? ''}`, HOME: root, WATCHMAN_SOCK: join(root, 'socket') },
  }
}
const watcherLocal = (root: string): string =>
  readFileSync(join(root, '.buckconfig.local'), 'utf8')
const effective = (args: readonly string[]): Record<string, string> => {
  const values: Record<string, string> = {}
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--') break
    if (args[index] === '-c' || args[index] === '--config') {
      const value = args[++index] ?? ''
      const equals = value.indexOf('=')
      values[value.slice(0, equals)] = value.slice(equals + 1)
    }
  }
  return values
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('direct pinned Buck posture', () => {
  it('falls back both unavailable endpoints without overwriting concurrent checkout configuration or run arguments', async () => {
    const root = fixture()
    const local = '[ui]\ncolor = false\n'
    writeFileSync(join(root, '.buckconfig.local'), local)
    const result = await directBuckArguments({
      ...options(root),
      args: ['run', '//:app', '--', '-c', 'buck2.remote_cache_enabled=true'],
    })
    expect(effective(result)['buck2.remote_cache_enabled']).toBe('false')
    expect(effective(result)['archive_origin.url_prefix']).toBe('')
    expect(effective(result)['archive_origin.tier']).toBe('public')
    expect(result.slice(result.indexOf('--'))).toEqual([
      '--',
      '-c',
      'buck2.remote_cache_enabled=true',
    ])
    expect(readFileSync(join(root, '.buckconfig.local'), 'utf8')).toBe(local)
  })

  it('admits RE-only roots with the consuming default, without requiring archive metadata', async () => {
    const root = fixture()
    const config = readFileSync(join(root, '.buckconfig'), 'utf8')
    writeFileSync(
      join(root, '.buckconfig'),
      config
        .slice(0, config.indexOf('[archive_origin]'))
        .replace('remote_cache_enabled = true\n', ''),
    )
    const reader = await directBuckArguments({ ...options(root), args: ['build', '//:app'] })
    expect(effective(reader)['buck2.remote_cache_enabled']).toBe('false')
    await expect(
      directBuckArguments({
        ...options(root),
        env: { BUCK2_CACHE_WRITE_BASIC_AUTH: 'publisher-credential' },
        args: ['build', '//:app'],
      }),
    ).rejects.toThrow('refusing to publish')
  })

  it('uses effective CLI endpoints rather than the tracked endpoint, and preserves a caller registry selection', async () => {
    const root = fixture()
    const result = await directBuckArguments({
      ...options(root),
      args: [
        'build',
        '//:app',
        '-c',
        'buck2.remote_cache_enabled=false',
        '-c',
        'archive_origin.url_prefix=',
      ],
    })
    const values = effective(result)
    expect(values['buck2.remote_cache_enabled']).toBe('false')
    expect(values['archive_origin.url_prefix']).toBe('')
  })

  it('admits cache-less source builds without validating unused sandbox archive placeholders', async () => {
    for (const selection of [
      { args: ['build', '--local-only', '--no-remote-cache', '//:app'], env: {} },
      { args: ['build', '//:app'], env: { BUCK2_NO_REMOTE_CACHE: '1' } },
      { args: ['build', '-c', 'buck2.remote_cache_enabled=false', '//:app'], env: {} },
    ]) {
      const root = fixture('$BUCK2_CACHE_ADDRESS', '$BUCK2_ARCHIVE_ORIGIN_URL_PREFIX')
      const result = await directBuckArguments({ ...options(root), ...selection })
      expect(effective(result)['buck2.remote_cache_enabled']).toBe('false')
      expect(effective(result)['buck2.allow_cache_uploads']).toBe('false')
      expect(effective(result)['archive_origin.url_prefix']).toBe('')
    }
    const root = fixture('$BUCK2_CACHE_ADDRESS', '$BUCK2_ARCHIVE_ORIGIN_URL_PREFIX')
    writeFileSync(join(root, '.buckconfig.local'), '[buck2]\nremote_cache_enabled = false\n')
    const result = await directBuckArguments({ ...options(root), args: ['build', '//:app'] })
    expect(effective(result)['archive_origin.url_prefix']).toBe('')
    expect(effective(result)['buck2.remote_cache_enabled']).toBe('false')
  })

  it('still rejects invalid trusted origins when cache disabling is only a run argument', async () => {
    const root = fixture('$BUCK2_CACHE_ADDRESS', '$BUCK2_ARCHIVE_ORIGIN_URL_PREFIX')
    await expect(
      directBuckArguments({
        ...options(root),
        args: ['run', '//:app', '--', '--no-remote-cache'],
      }),
    ).rejects.toThrow('tracked trusted archive origin')
  })

  it('caches healthy capabilities across hot loops but does not reuse them for a different endpoint or writer credential', async () => {
    let requests = 0
    const grpc = createServer()
    grpc.on('stream', (stream: ServerHttp2Stream) => {
      requests++
      stream.on('data', () => {})
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
        stream.end(Buffer.from([0, 0, 0, 0, 0]))
      })
    })
    grpc.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => grpc.once('listening', resolve))
    const bound = grpc.address()
    if (bound === null || typeof bound === 'string') throw new Error('expected TCP listener')
    const archive = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(null, { status: 404 }),
    })
    try {
      const root = fixture(
        `grpc://127.0.0.1:${bound.port}`,
        `http://127.0.0.1:${archive.port}/cas/`,
      )
      for (let index = 0; index < 3; index++) {
        const result = await directBuckArguments({ ...options(root), args: ['build', '//:app'] })
        expect(effective(result)['buck2.remote_cache_enabled']).not.toBe('false')
        expect(effective(result)['archive_origin.url_prefix']).toBe(
          `http://127.0.0.1:${archive.port}/cas/`,
        )
      }
      expect(requests).toBe(1)
      const ignoredClientOverride = await directBuckArguments({
        ...options(root),
        args: ['build', '//:app', '-c', 'buck2_re_client.action_cache_address=grpc://127.0.0.1:1'],
      })
      expect(effective(ignoredClientOverride)['buck2.remote_cache_enabled']).not.toBe('false')
      const config = readFileSync(join(root, '.buckconfig'), 'utf8')
      writeFileSync(
        join(root, '.buckconfig'),
        config.replace(`grpc://127.0.0.1:${bound.port}`, 'grpc://127.0.0.1:1'),
      )
      const changed = await directBuckArguments({ ...options(root), args: ['build', '//:app'] })
      expect(effective(changed)['buck2.remote_cache_enabled']).toBe('false')
      writeFileSync(join(root, '.buckconfig'), config)
      const archiveFallback = await directBuckArguments({
        ...options(root),
        args: ['build', '//:app', '-c', 'archive_origin.url_prefix=http://127.0.0.1:1/cas/'],
      })
      expect(effective(archiveFallback)['archive_origin.url_prefix']).toBe('')
      expect(effective(archiveFallback)['buck2.remote_cache_enabled']).not.toBe('false')
      await directBuckArguments({
        ...options(root),
        env: {
          BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: 'writer-credential',
          BUCK2_PRIVATE_CACHE_ADDRESS: `grpc://127.0.0.1:${bound.port}`,
        },
        args: ['build', '//:app'],
      })
      expect(requests).toBe(2)
      await expect(
        directBuckArguments({
          ...options(root),
          env: {
            BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: 'writer-credential',
            BUCK2_PRIVATE_CACHE_ADDRESS: 'grpc://127.0.0.1:1',
          },
          args: ['build', '//:app'],
        }),
      ).rejects.toThrow('refusing to publish')
    } finally {
      archive.stop(true)
      grpc.close()
    }
  })
})

describe('direct pinned Buck watcher admission', () => {
  it('admits a healthy service in a watcher-only root before the cache opt-in return', async () => {
    const { root, env, calls } = watcherFixture()
    const args = ['run', '//:app', '--', '-c', 'buck2.file_watcher=notify']
    const result = await directBuckArguments({ ...options(root), env, args })
    expect(result).toEqual(args)
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    expect(readFileSync(calls, 'utf8')).toBe(
      `${process.platform === 'darwin' ? '--no-spawn ' : ''}--no-local --sockname=${env.WATCHMAN_SOCK} --output-encoding=json version\n`,
    )
  })

  it('falls back when the executable exists but the service cannot be reached', async () => {
    const { root, env, state } = watcherFixture()
    writeFileSync(state, 'unreachable')
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    expect(watcherLocal(root)).toContain('file_watcher = notify')
  })

  it.each(['malformed', 'error', 'wrong-type', 'missing-version'])(
    'rejects %s service version output',
    async (mode) => {
      const { root, env, state } = watcherFixture()
      writeFileSync(state, mode)
      await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
      expect(watcherLocal(root)).toContain('file_watcher = notify')
    },
  )

  it('expires a healthy probe so a stopped service switches to notify', async () => {
    const { root, env, state, calls } = watcherFixture()
    const invocation = { ...options(root), env, args: ['build', '//:app'] }
    await directBuckArguments(invocation)
    writeFileSync(state, 'unreachable')
    await directBuckArguments(invocation)
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1)
    try {
      setSystemTime(new Date(Date.now() + 5001))
      await directBuckArguments(invocation)
      expect(watcherLocal(root)).toContain('file_watcher = notify')
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
    } finally {
      setSystemTime()
    }
  })

  it.each([
    'PATH',
    'HOME',
    'XDG_RUNTIME_DIR',
    'WATCHMAN_SOCK',
    'WATCHMAN_STATE_DIR',
    'TMPDIR',
    'TMP',
    'USER',
    'LOGNAME',
    'WATCHMAN_CONFIG_FILE',
  ])(
    'does not reuse a healthy service probe after %s changes',
    async (identity) => {
      const { root, env, state, calls } = watcherFixture()
      await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
      expect(watcherLocal(root)).toContain('file_watcher = watchman')
      if (identity !== 'WATCHMAN_SOCK') writeFileSync(state, 'unreachable')
      const changed = {
        ...env,
        [identity]: identity === 'PATH' ? `${env.PATH}:/nonexistent` : join(root, 'changed'),
      }
      if (identity === 'WATCHMAN_SOCK') writeFileSync(join(root, 'changed'), 'unreachable')
      await directBuckArguments({ ...options(root), env: changed, args: ['build', '//:app'] })
      expect(watcherLocal(root)).toContain('file_watcher = notify')
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
    },
  )

  it('removes stale admission while preserving a later unmanaged sandbox provider and cache overlay', async () => {
    const { root, env, calls } = watcherFixture()
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    const cacheOverlay =
      '# effect-utils standalone cache posture: begin\n[buck2]\n  remote_cache_enabled = false\n# effect-utils standalone cache posture: end\n'
    writeFileSync(
      join(root, '.buckconfig.local'),
      `${watcherLocal(root)}\n${cacheOverlay}\n[buck2]\nfile_watcher = fs_hash_crawler\n[ui]\ncolor = false\n`,
    )
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    const local = watcherLocal(root)
    expect(local).not.toContain('effect-utils file watcher admission')
    expect(local).toContain('file_watcher = fs_hash_crawler')
    expect(local).toContain(cacheOverlay.trimEnd())
    expect(local).toContain('[ui]\ncolor = false')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('preserves independent local cache configuration while switching watcher providers', async () => {
    const { root, env } = watcherFixture()
    const local =
      '# effect-utils standalone cache posture: begin\n[buck2]\nremote_cache_enabled = false\n# effect-utils standalone cache posture: end\n[ui]\ncolor = false\n'
    writeFileSync(join(root, '.buckconfig.local'), local)
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    expect(watcherLocal(root)).toContain(local.trimEnd())
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    writeFileSync(join(root, 'other-socket'), 'unreachable')
    await directBuckArguments({
      ...options(root),
      env: { ...env, WATCHMAN_SOCK: join(root, 'other-socket') },
      args: ['build', '//:app'],
    })
    expect(watcherLocal(root)).toContain(local.trimEnd())
    expect(watcherLocal(root)).toContain('file_watcher = notify')
    expect(watcherLocal(root)).not.toContain('file_watcher = watchman')
  })

  it('bounds a hanging service query and still admits local builds', async () => {
    const { root, env, state } = watcherFixture()
    writeFileSync(state, 'hanging')
    const started = performance.now()
    const args = ['build', '//:app']
    const result = await directBuckArguments({ ...options(root), env, args })
    expect(performance.now() - started).toBeLessThan(2500)
    expect(result).toEqual(args)
    expect(watcherLocal(root)).toContain('file_watcher = notify')
  }, 5000)

  it.each(['healthy', 'unreachable'])(
    'launches native Buck with %s service and caches argv only for healthy admission',
    async (mode) => {
      const { root, env, state } = watcherFixture()
      writeFileSync(state, mode)
      const native = join(root, 'native-buck')
      writeFileSync(
        native,
        `#!${Bun.which('sh')}\nprintf 'native:%s\\n' "$*"\ncat .buckconfig.local\n`,
        { mode: 0o700 },
      )
      const launchCache = join(root, 'launch-cache')
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'buck2-entrypoint.ts'),
          native,
          '--launch-cache',
          launchCache,
          'build',
          '//:app',
        ],
        {
          cwd: root,
          env: { ...env, XDG_CACHE_HOME: join(root, 'xdg-cache') },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exitCode).toBe(0)
      expect(stdout).toContain('native:build //:app')
      expect(stdout).toContain(`file_watcher = ${mode === 'healthy' ? 'watchman' : 'notify'}`)
      expect(existsSync(launchCache)).toBe(mode === 'healthy')
      if (mode === 'healthy') {
        expect(stderr).toBe('')
        expect(readFileSync(launchCache, 'utf8').split('\n')[1]).toBe('build\0//:app\0')
      } else {
        expect(stderr).toContain('warning: Buck2')
        expect(stderr).toContain('Watchman')
        expect(stderr.trim().split('\n')).toHaveLength(1)
      }
    },
  )
})
