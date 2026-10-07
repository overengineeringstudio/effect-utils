import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type ServerHttp2Stream } from 'node:http2'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer as createTlsServer } from 'node:tls'

import type { CacheAdmissionInvocation } from '../genie/ci-scripts/buck2-cache-evidence.ts'
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
  const root = realpathSync(fixture())
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
[ "$*" = "--output-encoding=json watch-project ${root}" ] || exit 2
case "$(cat "$socket")" in
  healthy) printf '{"version":"2026.10.05","watch":"${root}"}\\n' ;;
  unreachable) printf 'unable to connect to service\\n' >&2; exit 1 ;;
  malformed) printf 'not json\\n' ;;
  error) printf '{"version":"2026.10.05","error":"service unavailable"}\\n' ;;
  wrong-type) printf '{"version":123,"watch":"${root}"}\\n' ;;
  missing-version) printf '{"watch":"${root}"}\\n' ;;
  missing-root) printf '{"version":"2026.10.05"}\\n' ;;
  wrong-root) printf '{"version":"2026.10.05","watch":"${dirname(root)}","relative_path":"fixture"}\\n' ;;
  relative-root) printf '{"version":"2026.10.05","watch":"${root}","relative_path":"ignored"}\\n' ;;
  retry-timeout)
    if [ "$(wc -l < '${calls}')" -eq 1 ]; then exec sleep 30; fi
    printf '{"version":"2026.10.05","watch":"${root}"}\\n' ;;
  hanging) exec sleep 30 ;;
esac
`,
    { mode: 0o700 },
  )
  return {
    root,
    state,
    calls,
    env: {
      PATH: `${root}:${process.env['PATH'] ?? ''}`,
      HOME: root,
      WATCHMAN_SOCK: join(root, 'socket'),
    },
  }
}
const watcherLocal = (root: string): string =>
  existsSync(join(root, '.buckconfig.local')) === true
    ? readFileSync(join(root, '.buckconfig.local'), 'utf8')
    : ''
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
  for (const scenario of ['healthy', 'retry-success', 'both-fail'] as const) {
    it(`records per-invocation cache admission for ${scenario}`, async () => {
      let requests = 0
      let archiveRequests = 0
      const deadlines: string[] = []
      const grpc = createServer()
      grpc.on('stream', (stream: ServerHttp2Stream, headers) => {
        requests++
        deadlines.push(String(headers['grpc-timeout']))
        stream.on('error', () => {})
        stream.on('data', () => {})
        stream.on('end', () => {
          if (scenario === 'both-fail' || (scenario === 'retry-success' && requests === 1)) return
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
        fetch: () => {
          archiveRequests++
          if (scenario === 'both-fail' || (scenario === 'retry-success' && archiveRequests === 1))
            return new Promise<Response>(() => {})
          return new Response(null, { status: 404 })
        },
      })
      try {
        const root = fixture(
          `grpc://127.0.0.1:${bound.port}`,
          `http://127.0.0.1:${archive.port}/cas/`,
        )
        const evidence = join(root, 'evidence.json')
        const admissionOptions = {
          ...options(root),
          args: ['build', '//:app'],
          env: { CI_BUCK2_CACHE_EVIDENCE_PATH: evidence, GITHUB_ACTIONS: 'true' },
          ...(scenario === 'healthy' ? {} : { deadlineMs: 100 }),
        }
        const invocationId = '01234567-89ab-cdef-0123-456789abcdef'
        const result = await directBuckArguments({
          ...admissionOptions,
          env: { ...admissionOptions.env, BUCK_WRAPPER_UUID: invocationId.replaceAll('-', '') },
        })
        if (scenario === 'both-fail')
          expect(effective(result)['buck2.remote_cache_enabled']).toBe('false')
        else expect(effective(result)['buck2.remote_cache_enabled']).not.toBe('false')
        expect(effective(result)['archive_origin.url_prefix']).toBe(
          scenario === 'both-fail' ? '' : `http://127.0.0.1:${archive.port}/cas/`,
        )
        expect(requests).toBe(scenario === 'healthy' ? 1 : 2)
        expect(archiveRequests).toBe(scenario === 'healthy' ? 1 : 2)
        expect(deadlines).toEqual(scenario === 'healthy' ? ['2500m'] : ['100m', '100m'])
        if (scenario === 'both-fail') {
          await expect(
            directBuckArguments({
              ...admissionOptions,
              env: { ...admissionOptions.env, BUCK2_CACHE_WRITE_BASIC_AUTH: 'fixture-secret' },
            }),
          ).rejects.toThrow('refusing to publish without remote cache')
        } else {
          // A hot-loop cache hit is its own healthy invocation, not a second recovered retry.
          await directBuckArguments(admissionOptions)
        }
        const rows = readFileSync(`${evidence}.admission.jsonl`, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as CacheAdmissionInvocation)
        expect(rows).toHaveLength(2)
        expect(new Set(rows.map((row) => row.invocationId)).size).toBe(2)
        expect(rows[0]?.invocationId).toBe(invocationId)
        for (const [index, row] of rows.entries()) {
          expect(row.admissionFallbacks).toEqual({
            reapi: scenario === 'both-fail' ? 1 : 0,
            // The required writer selects its separate private archive posture (none in this fixture).
            archiveOrigin: scenario === 'both-fail' && index === 0 ? 1 : 0,
          })
          expect(row.admissionRetrySuccesses).toEqual({
            reapi: scenario === 'retry-success' && index === 0 ? 1 : 0,
            archiveOrigin: scenario === 'retry-success' && index === 0 ? 1 : 0,
          })
        }
      } finally {
        archive.stop(true)
        grpc.close()
      }
    })
  }

  it('preserves reader and writer admission when TLS succeeds without h2 ALPN', async () => {
    // Public test-only fixture, vendored verbatim from Bun 1.4.2 (valid through February 2036).
    // Regenerate these literals from the pinned upstream cert.pem and cert.key, not by hand:
    // https://github.com/oven-sh/bun/tree/744846f844374847c902b5e7fd59b4342a51ef99/test/js/bun/http/fixtures
    const cert = `-----BEGIN CERTIFICATE-----
MIIEDDCCAvSgAwIBAgIUbddWE2woW5e96uC4S2fd2M0AsFAwDQYJKoZIhvcNAQEL
BQAwfjELMAkGA1UEBhMCU0UxDjAMBgNVBAgMBVN0YXRlMREwDwYDVQQHDAhMb2Nh
dGlvbjEaMBgGA1UECgwRT3JnYW5pemF0aW9uIE5hbWUxHDAaBgNVBAsME09yZ2Fu
aXphdGlvbmFsIFVuaXQxEjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0yNjAyMTMyMzEx
MjlaFw0zNjAyMTEyMzExMjlaMH4xCzAJBgNVBAYTAlNFMQ4wDAYDVQQIDAVTdGF0
ZTERMA8GA1UEBwwITG9jYXRpb24xGjAYBgNVBAoMEU9yZ2FuaXphdGlvbiBOYW1l
MRwwGgYDVQQLDBNPcmdhbml6YXRpb25hbCBVbml0MRIwEAYDVQQDDAlsb2NhbGhv
c3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCt7iqkEIco372hv19q
0zjaYbm6gzxEnR45UjpQYqgztq4QHicD80mqIkCBCYknFxhwxhNn+Y3g5RWQdRep
lpQbkneqRVp+qixMvu2FmOA4zRRoqObP7FyF1Yusvmroe0Y9SP2xTTmA9Zo73pay
wPUIuZ9eKGwIiFTtj1yQ1FdghLhzZgxcf3LHEHRkGnxgxxNITFxh4nd6fGIjNqM5
fQAY8z35lMXdeWjrhtaqgFYB+Z20YY0X7LJx39vYao0wqW8sZjX88TqHI1zXWLpU
k6UK9RqaNza5xc80wV+9/zjhr3dc1FRjBxI1DS/ufo33dUfvilxv9/LtWwUnKfKL
ns9LAgMBAAGjgYEwfzAdBgNVHQ4EFgQUQCpSY7ODhdyD6pdZHvfHoWRXWsIwHwYD
VR0jBBgwFoAUQCpSY7ODhdyD6pdZHvfHoWRXWsIwDwYDVR0TAQH/BAUwAwEB/zAs
BgNVHREEJTAjgglsb2NhbGhvc3SHBH8AAAGHEAAAAAAAAAAAAAAAAAAAAAEwDQYJ
KoZIhvcNAQELBQADggEBAGKTIzGQsOqfD0+x15F2cu7FKjIo1ua0OiILAhPqGX65
kGcetjC/dJip2bGnw1NjG9WxEJNZ4YcsGrwh9egfnXXmfHNL0wzx/LTo2oysbXsN
nEj+cmzw3Lwjn/ywJc+AC221/xrmDfm3m/hMzLqncnj23ZAHqkXTSp5UtSMs+UDQ
my0AJOvsDGPVKHQsAX3JDjKHaoVJn4YqpHcIGmpjrNcQSvwUocDHPcC0ywco6SgF
Ylzy2bwWWdPd9Cz9JkAMb95nWc7Rwf/nxAqCjJFzKEisvrx7VZ+QSVI0nqJzt8V1
pbtWYH5gMFVstU3ghWdSLbAk4XufGYrIWAlA5mqjQ4o=
-----END CERTIFICATE-----
`
    const key = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCt7iqkEIco372h
v19q0zjaYbm6gzxEnR45UjpQYqgztq4QHicD80mqIkCBCYknFxhwxhNn+Y3g5RWQ
dReplpQbkneqRVp+qixMvu2FmOA4zRRoqObP7FyF1Yusvmroe0Y9SP2xTTmA9Zo7
3paywPUIuZ9eKGwIiFTtj1yQ1FdghLhzZgxcf3LHEHRkGnxgxxNITFxh4nd6fGIj
NqM5fQAY8z35lMXdeWjrhtaqgFYB+Z20YY0X7LJx39vYao0wqW8sZjX88TqHI1zX
WLpUk6UK9RqaNza5xc80wV+9/zjhr3dc1FRjBxI1DS/ufo33dUfvilxv9/LtWwUn
KfKLns9LAgMBAAECggEAAacPHM2G7GBIm/9rCr6tvihNgD8M685zOOZAqGYn9CqY
cYHC4gtF/L2U6CBj2pNAoCwo3LXUkD+6r7MYKXAgqQg3HTCM4rwFbhD1rU8FVHfh
OL0QwwZ2ut95DVdjoxTAlEN9ZcdSFc//llMJ1cF8lxoVvKFc4cv3uCI2mcaJk858
iABfJLl3yfdv1xtpAuOfXf66sXbAmn5NQfN0qTEg2iOdgb4BUee5Wb35MakDQb6+
/s7/bWB+ublZzYt12ChIh1jkBBHaGyQ8mFnPj99ZAJdFjAzi6ydoJ0a2rCVY7Ugs
bkhnzDUtAaHKxo9JXaqIwbUaVFkX8dDhbg82dJrWUQKBgQDb7hNR0bJFW845N19M
74p2PM+0dIiVzwxAg4E2dXDVe39awO/tw8Vu1o1+NPFhWAzGcidP7pAHmPEgRTVO
7LA2P3CDXpkAEx5E0QW6QWZGqHfSa3+P1AvetvAV+OxtlDphcNeLApY16TUVOKZg
SZlxW2e0dZylbHewgLBTIV9wUQKBgQDKdML+JD18WfenPeowsw8HzKdaw01iGiV1
fvTjEXu6YxPPynWFMuj5gjBQodXM2vv0EsQBAPKYfe0nzRFL2kNuYs7TLoaNxqkp
DNfJ2Ww5OSg7Mp76XgppeKKlsXLyUMYHHrDh6MRi5jvWtiHRpaNmV3cHMRs22c+B
cqKP5Zma2wKBgCPNnS2Lsrbh3C+qWQRgVq0q9zFMa1PgEgGKpwVjlwvaAACZOjX9
0e1aVkx+d/E98U55FPdJQf9Koa58NdJ0a7dZGor4YnYFpr7TPFh2/xxvnpoN0AVt
IsWOCIW7MVohcGOeiChkMmnyXibnQwaX1LgEhlx1bRvtDYsZWBsgarYRAoGAARvo
oYnDSHYZtDHToZapg2pslEOzndD02ZLrdn73BYtbZWz/fc5MlmlPKHHqgOfGL40W
w8akjY9LCEfIS3kTm3wxE9kSZZ5r+MyYNgPZ4upcPQ7G7iortm4xveSd85PbsdhK
McKbqMsIEuIGh2Z34ayi+0galQ9WYqglGdKxJ7cCgYEAuSPBHa+en0xaraZNRvMk
OfV9Su/wrpR3TXSeo0E1mZHLwq1JwulpfO1SjxTH5uOJtG0tusl122wfm0KjrXUO
vG5/It+X4u1Nv9oWj+z1+EV4fQrQ/Coqcc1r+5w1yzfURkKlHh74jbK5Yy/KfXrE
eqbbJD40tKhY8ho15D3iCSo=
-----END PRIVATE KEY-----
`
    let handshakes = 0
    const tls = createTlsServer({ cert, key }, (socket) => {
      handshakes++
      socket.on('error', () => {})
      socket.end()
    })
    tls.on('tlsClientError', () => {})
    tls.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => tls.once('listening', resolve))
    const bound = tls.address()
    if (bound === null || typeof bound === 'string') throw new Error('expected TLS listener')
    try {
      const cases = ['reader', 'optional', 'strict'].map((posture) => {
        const root = fixture()
        writeFileSync(
          join(root, '.buckconfig'),
          `[buck2]\nremote_cache_enabled = true\nallow_cache_uploads = false\n[buck2_re_client]\naction_cache_address = grpc://127.0.0.1:${bound.port}\ninstance_name = fixture\ntls = true\n`,
        )
        return {
          cwd: root,
          cacheDirectory: join(root, 'probe-cache'),
          args: ['build', '//:app'],
          env:
            posture === 'reader'
              ? {}
              : {
                  BUCK2_CACHE_WRITE_BASIC_AUTH: 'fixture-secret',
                  ...(posture === 'optional' ? { BUCK2_CACHE_WRITE_OPTIONAL: '1' } : {}),
                },
        }
      })
      const certificate = join(cases[0]?.cwd ?? '', 'fixture-ca.pem')
      writeFileSync(certificate, cert)
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          '-e',
          `import {directBuckArguments} from ${JSON.stringify(import.meta.dir + '/buck2-entrypoint.ts')};
const outcomes = [];
for (const options of ${JSON.stringify(cases)}) {
  try { outcomes.push({args: await directBuckArguments(options)}) }
  catch(error) { outcomes.push({error: error.message}) }
}
console.log(JSON.stringify(outcomes));`,
        ],
        env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exitCode).toBe(0)
      expect(handshakes).toBe(6)
      const outcomes = JSON.parse(stdout) as {
        readonly args?: string[]
        readonly error?: string
      }[]
      for (const outcome of outcomes.slice(0, 2)) {
        expect(effective(outcome.args ?? [])['buck2.remote_cache_enabled']).toBe('false')
        expect(effective(outcome.args ?? [])['buck2.allow_cache_uploads']).toBe('false')
      }
      expect(outcomes[2]?.error).toContain('refusing to publish without remote cache')
      expect(stderr.match(/warning: Buck2 REAPI probe failed:/gu)).toHaveLength(6)
      expect(stderr).not.toContain('ERR_HTTP2_SOCKET_UNBOUND')
      expect(stderr).not.toContain('fixture-secret')
    } finally {
      tls.close()
    }
  })

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

  it('falls back to local execution without uploads only for an optional writer', async () => {
    const root = fixture()
    const writer = {
      ...options(root),
      env: { BUCK2_CACHE_WRITE_BASIC_AUTH: 'publisher-credential' },
      args: ['build', '//:app'],
    }
    await expect(directBuckArguments(writer)).rejects.toThrow('refusing to publish')
    const result = await directBuckArguments({
      ...writer,
      env: { ...writer.env, BUCK2_CACHE_WRITE_OPTIONAL: '1' },
    })
    expect(effective(result)['buck2.remote_cache_enabled']).toBe('false')
    expect(effective(result)['buck2.allow_cache_uploads']).toBe('false')
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
    const args = ['run', '//:app', '--', '--version', '--help', '-c', 'buck2.file_watcher=notify']
    const result = await directBuckArguments({ ...options(root), env, args })
    expect(result).toEqual(args)
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    expect(readFileSync(calls, 'utf8')).toBe(
      `${process.platform === 'darwin' ? '--no-spawn ' : ''}--no-local --sockname=${env.WATCHMAN_SOCK} --output-encoding=json watch-project ${root}\n`,
    )
  })

  it('fails closed when the executable exists but the service cannot be reached', async () => {
    const { root, env, state } = watcherFixture()
    writeFileSync(state, 'unreachable')
    await expect(
      directBuckArguments({ ...options(root), env, args: ['build', '//:app'] }),
    ).rejects.toThrow('Watchman watch-project probe failed (service)')
    expect(watcherLocal(root)).not.toContain('file_watcher = notify')
  })

  it.each(['wrong-root', 'relative-root'])(
    'fails closed on %s Watchman selection',
    async (mode) => {
      const { root, env, state } = watcherFixture()
      writeFileSync(state, mode)
      await expect(
        directBuckArguments({ ...options(root), env, args: ['build', '//:app'] }),
      ).rejects.toThrow(`watchman watch '${root}'`)
      expect(watcherLocal(root)).not.toContain('file_watcher = notify')
    },
  )

  it('retries a transient Watchman timeout once and admits the healthy response', async () => {
    const { root, env, state, calls } = watcherFixture()
    writeFileSync(state, 'retry-timeout')
    await directBuckArguments({
      ...options(root),
      env,
      args: ['build', '//:app'],
      deadlineMs: 1000,
    })
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
  })

  it('does not cache failed admission after the service recovers', async () => {
    const { root, env, state, calls } = watcherFixture()
    writeFileSync(state, 'unreachable')
    const invocation = { ...options(root), env, args: ['build', '//:app'] }
    await expect(directBuckArguments(invocation)).rejects.toThrow('probe failed (service)')
    writeFileSync(state, 'healthy')
    await directBuckArguments(invocation)
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
  })

  it('invalidates a healthy root admission when Watchman ignore configuration changes', async () => {
    const { root, env, state, calls } = watcherFixture()
    const invocation = { ...options(root), env, args: ['build', '//:app'] }
    await directBuckArguments(invocation)
    writeFileSync(state, 'unreachable')
    writeFileSync(join(root, '.watchmanconfig'), '{"ignore_dirs":["ignored"]}\n')
    await expect(directBuckArguments(invocation)).rejects.toThrow('probe failed (service)')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('does not share root admission between worktrees using the same service identity', async () => {
    const { root, env, calls } = watcherFixture()
    const otherRoot = fixture()
    writeFileSync(join(otherRoot, '.buckconfig'), '[buck2]\nfile_watcher = watchman\n')
    const cacheDirectory = join(root, 'shared-probe-cache')
    await directBuckArguments({ ...options(root), env, cacheDirectory, args: ['build', '//:app'] })
    await expect(
      directBuckArguments({
        ...options(otherRoot),
        env,
        cacheDirectory,
        args: ['build', '//:app'],
      }),
    ).rejects.toThrow('probe failed (service)')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('admits an explicit local Watchman provider only after checking the service', async () => {
    const { root, env, state } = watcherFixture()
    writeFileSync(join(root, '.buckconfig.local'), '[buck2]\nfile_watcher = watchman\n')
    writeFileSync(state, 'unreachable')
    await expect(
      directBuckArguments({ ...options(root), env, args: ['build', '//:app'] }),
    ).rejects.toThrow('probe failed (service)')
    expect(watcherLocal(root)).toBe('[buck2]\nfile_watcher = watchman\n')
  })

  it('preserves the existing explicit local notify opt-in without automatic selection', async () => {
    const { root, env, state, calls } = watcherFixture()
    writeFileSync(state, 'unreachable')
    const local = '[buck2]\nfile_watcher = notify\n'
    writeFileSync(join(root, '.buckconfig.local'), local)
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    expect(watcherLocal(root)).toBe(local)
    expect(existsSync(calls)).toBe(false)
  })

  it('replaces legacy managed notify admission only with healthy Watchman', async () => {
    const { root, env } = watcherFixture()
    writeFileSync(
      join(root, '.buckconfig.local'),
      '# BEGIN effect-utils file watcher admission\n[buck2]\nfile_watcher = notify\n# END effect-utils file watcher admission\n',
    )
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    expect(watcherLocal(root)).not.toContain('file_watcher = notify')
  })

  it('admits expand-external-cell daemon startup without applying the cache-command policy', async () => {
    const { root, env } = watcherFixture()
    writeFileSync(
      join(root, '.buckconfig'),
      '[buck2]\nfile_watcher = watchman\nremote_cache_enabled = true\n[buck2_re_client]\naction_cache_address = grpc://127.0.0.1:1\n',
    )
    const args = ['expand-external-cell', 'prelude']
    const result = await directBuckArguments({ ...options(root), env, args })
    expect(result).toEqual(args)
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    expect(watcherLocal(root)).not.toContain('standalone cache posture')
  })

  it('does not query Watchman or mutate local configuration for help, version, or empty invocation', async () => {
    const { root, env, calls, state } = watcherFixture()
    writeFileSync(state, 'unreachable')
    const local = '[ui]\ncolor = false\n'
    writeFileSync(join(root, '.buckconfig.local'), local)
    for (const args of [
      [],
      ['--help'],
      ['-h'],
      ['--version'],
      ['build', '--help'],
      ['kill'],
      ['status', '--snapshot'],
      ['log', 'show', '--recent', '0'],
      ['--isolation-dir', 'owned', 'kill'],
    ]) {
      const result = await directBuckArguments({ ...options(root), env, args })
      expect(result).toEqual(args)
      expect(watcherLocal(root)).toBe(local)
    }
    expect(existsSync(calls)).toBe(false)
  })

  it('does not bypass admission for a build target or isolation named like maintenance', async () => {
    const { root, env, state } = watcherFixture()
    writeFileSync(state, 'unreachable')
    for (const args of [
      ['build', 'status'],
      ['--isolation-dir', 'status', 'build', '//:app'],
    ])
      await expect(directBuckArguments({ ...options(root), env, args })).rejects.toThrow(
        'probe failed',
      )
  })

  it.each(['malformed', 'error', 'wrong-type', 'missing-version', 'missing-root'])(
    'rejects %s service version output',
    async (mode) => {
      const { root, env, state } = watcherFixture()
      writeFileSync(state, mode)
      await expect(
        directBuckArguments({ ...options(root), env, args: ['build', '//:app'] }),
      ).rejects.toThrow('Watchman watch-project probe failed (response)')
      expect(watcherLocal(root)).not.toContain('file_watcher = notify')
    },
  )

  it('expires a healthy probe so a stopped service fails rather than switching to notify', async () => {
    const { root, env, state, calls } = watcherFixture()
    const invocation = { ...options(root), env, args: ['build', '//:app'] }
    await directBuckArguments(invocation)
    writeFileSync(state, 'unreachable')
    await directBuckArguments(invocation)
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1)
    try {
      setSystemTime(new Date(Date.now() + 5001))
      await expect(directBuckArguments(invocation)).rejects.toThrow('probe failed (service)')
      expect(watcherLocal(root)).toContain('file_watcher = watchman')
      expect(watcherLocal(root)).not.toContain('file_watcher = notify')
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
  ])('does not reuse a healthy service probe after %s changes', async (identity) => {
    const { root, env, state, calls } = watcherFixture()
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    if (identity !== 'WATCHMAN_SOCK') writeFileSync(state, 'unreachable')
    const changed = {
      ...env,
      [identity]: identity === 'PATH' ? `${env.PATH}:/nonexistent` : join(root, 'changed'),
    }
    if (identity === 'WATCHMAN_SOCK') writeFileSync(join(root, 'changed'), 'unreachable')
    await expect(
      directBuckArguments({ ...options(root), env: changed, args: ['build', '//:app'] }),
    ).rejects.toThrow('probe failed (service)')
    expect(watcherLocal(root)).not.toContain('file_watcher = notify')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
  })

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

  it('preserves independent local cache configuration when watcher admission fails', async () => {
    const { root, env } = watcherFixture()
    const local =
      '# effect-utils standalone cache posture: begin\n[buck2]\nremote_cache_enabled = false\n# effect-utils standalone cache posture: end\n[ui]\ncolor = false\n'
    writeFileSync(join(root, '.buckconfig.local'), local)
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    expect(watcherLocal(root)).toContain(local.trimEnd())
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    writeFileSync(join(root, 'other-socket'), 'unreachable')
    await expect(
      directBuckArguments({
        ...options(root),
        env: { ...env, WATCHMAN_SOCK: join(root, 'other-socket') },
        args: ['build', '//:app'],
      }),
    ).rejects.toThrow('probe failed (service)')
    expect(watcherLocal(root)).toContain(local.trimEnd())
    expect(watcherLocal(root)).not.toContain('file_watcher = notify')
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
  })

  it('bounds and retries a hanging service query without admitting native builds', async () => {
    const { root, env, state, calls } = watcherFixture()
    writeFileSync(state, 'hanging')
    const started = performance.now()
    await expect(
      directBuckArguments({ ...options(root), env, args: ['build', '//:app'], deadlineMs: 30 }),
    ).rejects.toThrow('probe failed (timeout)')
    expect(performance.now() - started).toBeLessThan(2500)
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(watcherLocal(root)).not.toContain('file_watcher = notify')
  }, 5000)

  it.each(['healthy', 'unreachable'])(
    'launches native Buck only with %s service and caches argv only for healthy admission',
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
      expect(exitCode).toBe(mode === 'healthy' ? 0 : 1)
      expect(stdout.includes('native:build //:app')).toBe(mode === 'healthy')
      expect(existsSync(launchCache)).toBe(mode === 'healthy')
      if (mode === 'healthy') {
        expect(stderr).toBe('')
        expect(stdout).toContain('file_watcher = watchman')
        expect(readFileSync(launchCache, 'utf8').split('\n')[1]).toBe('build\0//:app\0')
      } else {
        expect(stderr).toContain('Watchman watch-project probe failed (service)')
        expect(stderr).toContain('Probe:')
        expect(stderr).toContain('Fix:')
        expect(stderr).toContain('Refusing to use notify')
      }
    },
  )

  it.each(['legacy', 'notify', 'concurrent', 'failed-stop'] as const)(
    'migrates only the selected worktree isolation for %s daemon state',
    async (mode) => {
      const { root, env } = watcherFixture()
      const state = join(root, '.buck', 'buckd', root.slice(1))
      const selected = join(state, 'owned')
      const other = join(state, 'unrelated')
      const admission = join(root, '.buck', 'file-watcher-admission-v1', root.slice(1))
      const selectedMarker = join(admission, 'owned.json')
      const otherMarker = join(admission, 'unrelated.json')
      mkdirSync(admission, { recursive: true })
      const otherRoot = fixture()
      const otherWorktreeState = join(root, '.buck', 'buckd', otherRoot.slice(1), 'owned')
      mkdirSync(otherWorktreeState, { recursive: true })
      writeFileSync(join(otherWorktreeState, 'buckd.pid'), '888888')
      const oldMarker = JSON.stringify({
        schema: 'effect-utils/buck2-file-watcher-admission/v1',
        provider: 'notify',
      })
      for (const directory of [selected, other]) {
        mkdirSync(directory, { recursive: true })
        writeFileSync(join(directory, 'buckd.pid'), '999999')
      }
      writeFileSync(otherMarker, oldMarker)
      if (mode === 'notify') writeFileSync(selectedMarker, oldMarker)
      const nativeCalls = join(root, 'native-calls')
      const native = join(root, 'native-buck')
      writeFileSync(
        native,
        `#!${Bun.which('sh')}
printf '%s\\n' "$*" >> '${nativeCalls}'
if [ "$*" = "--isolation-dir owned kill" ]; then
  ${mode === 'failed-stop' ? 'exit 1' : `rm -rf '${selected}'\n  mkdir -p '${selected}'\n  exit 0`}
fi
printf '999998' > '${selected}/buckd.pid'
printf 'native build\\n'
`,
        { mode: 0o700 },
      )
      const launch = async () => {
        const child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, 'buck2-entrypoint.ts'),
            native,
            ...(mode === 'legacy'
              ? ['build', '//:app']
              : mode === 'notify'
                ? ['--isolation-dir=owned', 'build', '//:app']
                : ['--isolation-dir', 'owned', 'build', '//:app']),
          ],
          {
            cwd: root,
            env: { ...env, BUCK_ISOLATION_DIR: mode === 'legacy' ? 'owned' : undefined },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        return { exitCode, stdout, stderr }
      }
      const runs =
        mode === 'concurrent'
          ? await Promise.all([launch(), launch()])
          : [await launch(), await launch()]
      const calls = readFileSync(nativeCalls, 'utf8').trim().split('\n')
      expect(readFileSync(otherMarker, 'utf8')).toBe(oldMarker)
      expect(readFileSync(join(otherWorktreeState, 'buckd.pid'), 'utf8')).toBe('888888')
      expect(readFileSync(join(other, 'buckd.pid'), 'utf8')).toBe('999999')
      if (mode === 'failed-stop') {
        expect(runs.every(({ exitCode }) => exitCode === 1)).toBe(true)
        expect(runs.every(({ stdout }) => stdout === '')).toBe(true)
        expect(calls).toEqual(['--isolation-dir owned kill', '--isolation-dir owned kill'])
        expect(existsSync(selectedMarker)).toBe(false)
      } else {
        expect(runs.every(({ exitCode }) => exitCode === 0)).toBe(true)
        expect(runs.every(({ stdout }) => stdout.includes('native build'))).toBe(true)
        expect(calls.filter((call) => call.endsWith(' kill'))).toEqual([
          '--isolation-dir owned kill',
        ])
        expect(JSON.parse(readFileSync(selectedMarker, 'utf8')).provider).toBe('watchman')
      }
    },
  )
})
