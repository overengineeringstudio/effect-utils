import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerHttp2Stream } from 'node:http2'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  probeRemoteCacheCapabilities,
  publicProbeAddress,
  type RemoteCacheProbeConnectionEvent,
  type RemoteCacheProbeFailure,
  reconcileStandaloneCachePosture,
  standaloneCachePostureConfig,
} from './buck2-cache-posture.ts'

const trustedOrigin = {
  tier: 'private',
  urlPrefix: 'https://trusted-cache.example/cas/',
} as const

const temporaryRoots: string[] = []

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'buck2-cache-posture-'))
  writeFileSync(
    join(root, '.buckconfig'),
    `[archive_origin]
  trusted_url_prefix = ${trustedOrigin.urlPrefix}
  trusted_tier = ${trustedOrigin.tier}
`,
  )
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('standalone Buck cache posture', () => {
  it('selects registry for the exact public-lane opt-out and CAS otherwise', () => {
    expect(
      standaloneCachePostureConfig({
        current: '',
        env: { BUCK2_NO_REMOTE_CACHE: '1' },
        trustedOrigin,
      }),
    ).toBe(`# effect-utils standalone cache posture: begin
[buck2]
  remote_cache_enabled = false
  allow_cache_uploads = false
[archive_origin]
  url_prefix =
  tier = public
# effect-utils standalone cache posture: end
`)

    for (const value of [undefined, '0', 'true', ' 1'])
      expect(
        standaloneCachePostureConfig({
          current: '',
          env: { BUCK2_NO_REMOTE_CACHE: value },
          trustedOrigin,
        }),
      ).toBe(`# effect-utils standalone cache posture: begin
[archive_origin]
  url_prefix = https://trusted-cache.example/cas/
  tier = private
# effect-utils standalone cache posture: end
`)
  })

  it('reads the public TLS tier anonymously in a PR lane, without upload rights', () => {
    const prLane = standaloneCachePostureConfig({
      current: '',
      env: { BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
      trustedOrigin,
    })

    expect(prLane).toContain('remote_cache_enabled = true')
    expect(prLane).toContain('allow_cache_uploads = false')
    expect(prLane).toContain('url_prefix =\n  tier = public')
    expect(prLane).not.toContain('http_headers')

    const escapeHatch = standaloneCachePostureConfig({
      current: prLane,
      env: { BUCK2_PUBLIC_CACHE_READ_ONLY: '1', BUCK2_NO_REMOTE_CACHE: '1' },
      trustedOrigin,
    })
    expect(escapeHatch).toContain('remote_cache_enabled = false')
    expect(escapeHatch).toContain('allow_cache_uploads = false')
    expect(escapeHatch).not.toContain('remote_cache_enabled = true')
    expect(escapeHatch).not.toContain('http_headers')
  })

  it('selects the publisher posture only with a writer credential and never writes the credential', () => {
    const credential = 'd3JpdGVyOnNlY3JldA=='
    const publisher = standaloneCachePostureConfig({
      current: '',
      env: { BUCK2_NO_REMOTE_CACHE: '0', BUCK2_CACHE_WRITE_BASIC_AUTH: credential },
      trustedOrigin,
    })
    expect(publisher).toBe(`# effect-utils standalone cache posture: begin
[buck2]
  allow_cache_uploads = true
  default_allow_cache_upload = true
[buck2_re_client]
  http_headers = authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH
[archive_origin]
  url_prefix =
  tier = public
# effect-utils standalone cache posture: end
`)
    expect(publisher).not.toContain(credential)

    for (const value of [undefined, ''])
      expect(
        standaloneCachePostureConfig({
          current: '',
          env: { BUCK2_CACHE_WRITE_BASIC_AUTH: value },
          trustedOrigin,
        }),
      ).not.toContain('allow_cache_uploads = true')

    // The exact public-lane opt-out wins over a leaked credential.
    expect(
      standaloneCachePostureConfig({
        current: '',
        env: { BUCK2_NO_REMOTE_CACHE: '1', BUCK2_CACHE_WRITE_BASIC_AUTH: credential },
        trustedOrigin,
      }),
    ).not.toContain('allow_cache_uploads = true')
  })

  it('admits a private host writer without exposing credentials and removes auth on public lanes', () => {
    const credential = Buffer.from('host-a:secret').toString('base64')
    const env = {
      BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: credential,
      BUCK2_PRIVATE_CACHE_ADDRESS: 'grpc://private-cache.example:41045',
      BUCK2_CACHE_WRITE_BASIC_AUTH: 'publisher-credential',
    }
    const writer = standaloneCachePostureConfig({ current: '', env, trustedOrigin })
    expect(writer).toContain('allow_cache_uploads = true')
    for (const field of ['action_cache_address', 'cas_address', 'engine_address'])
      expect(writer).toContain(`${field} = ${env.BUCK2_PRIVATE_CACHE_ADDRESS}`)
    expect(writer).toContain('tls = false')
    expect(writer).toContain('$BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH')
    expect(writer).toContain(`url_prefix = ${trustedOrigin.urlPrefix}`)
    expect(writer).not.toContain(credential)
    expect(writer).not.toContain('$BUCK2_CACHE_WRITE_BASIC_AUTH')
    for (const override of [
      { BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
      { BUCK2_NO_REMOTE_CACHE: '1' },
    ]) {
      const reader = standaloneCachePostureConfig({
        current: writer,
        env: { ...env, ...override },
        trustedOrigin,
      })
      expect(reader).toContain('allow_cache_uploads = false')
      expect(reader).not.toContain('http_headers')
      expect(reader).not.toContain('private-cache.example')
    }
    expect(() =>
      standaloneCachePostureConfig({
        current: '',
        env: { BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: credential },
        trustedOrigin,
      }),
    ).toThrow()
  })

  it('replaces a publisher overlay with anonymous read-only posture in a reader root', () => {
    const publisher = standaloneCachePostureConfig({
      current: '',
      env: { BUCK2_CACHE_WRITE_BASIC_AUTH: 'd3JpdGVyOnNlY3JldA==' },
      trustedOrigin,
    })
    const reader = standaloneCachePostureConfig({
      current: publisher,
      env: { BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
      trustedOrigin,
    })

    expect(reader).toContain('remote_cache_enabled = true')
    expect(reader).toContain('allow_cache_uploads = false')
    expect(reader).not.toContain('default_allow_cache_upload = true')
    expect(reader).not.toContain('http_headers')
    expect(reader).not.toContain('BUCK2_CACHE_WRITE_BASIC_AUTH')
  })

  it('preserves local overrides while adding and removing the managed posture atomically', () => {
    const root = makeRoot()
    const output = join(root, '.buckconfig.local')
    const local = `[ui]\n  color = true\n`
    writeFileSync(output, local)

    reconcileStandaloneCachePosture({ repoRoot: root, env: { BUCK2_NO_REMOTE_CACHE: '1' } })
    expect(readFileSync(output, 'utf8')).toBe(`${local.trimEnd()}

# effect-utils standalone cache posture: begin
[buck2]
  remote_cache_enabled = false
  allow_cache_uploads = false
[archive_origin]
  url_prefix =
  tier = public
# effect-utils standalone cache posture: end
`)

    reconcileStandaloneCachePosture({ repoRoot: root, env: {} })
    expect(readFileSync(output, 'utf8')).toBe(`${local.trimEnd()}

# effect-utils standalone cache posture: begin
[archive_origin]
  url_prefix = https://trusted-cache.example/cas/
  tier = private
# effect-utils standalone cache posture: end
`)
  })

  it('replaces the public posture when a checkout returns to the trusted tier', () => {
    const root = makeRoot()
    const output = join(root, '.buckconfig.local')

    reconcileStandaloneCachePosture({ repoRoot: root, env: { BUCK2_NO_REMOTE_CACHE: '1' } })
    expect(existsSync(output)).toBeTrue()

    reconcileStandaloneCachePosture({ repoRoot: root, env: { BUCK2_NO_REMOTE_CACHE: '0' } })
    expect(readFileSync(output, 'utf8')).toContain(
      'url_prefix = https://trusted-cache.example/cas/',
    )
    expect(readFileSync(output, 'utf8')).not.toContain('remote_cache_enabled = false')
  })
})

describe('REAPI probe diagnostics', () => {
  it('exposes public addresses while redacting private and tailnet addresses', () => {
    for (const address of ['8.8.8.8', '2606:4700:4700::1111'])
      expect(publicProbeAddress(address)).toBe(address)
    for (const address of [
      '10.1.2.3',
      '100.72.218.29',
      '127.0.0.1',
      '169.254.1.2',
      '172.16.1.2',
      '192.168.1.2',
      '::1',
      'fe80::1',
      'fd7a:115c:a1e0::1',
      '::ffff:100.72.218.29',
      'private-host.example',
      'credential-secret',
    ])
      expect(publicProbeAddress(address)).toBe('redacted')
  })

  it('reports bounded probe failures once, without server messages or credentials', async () => {
    let response: 'healthy' | 'auth' | 'http' | 'grpc' | 'protocol' | 'deadline' = 'healthy'
    const grpc = createServer()
    grpc.on('stream', (stream: ServerHttp2Stream) => {
      stream.on('error', () => {})
      stream.on('data', () => {})
      stream.on('end', () => {
        if (response === 'deadline') return
        stream.respond({
          ':status': response === 'http' ? 503 : 200,
          'content-type': 'application/grpc',
          'grpc-status': response === 'auth' ? '16' : response === 'grpc' ? '14' : '0',
          'grpc-message': 'private-host.example credential-secret',
        })
        stream.end(Buffer.from(response === 'protocol' ? [1, 0, 0, 0, 0] : [0, 0, 0, 0, 0]))
      })
    })
    grpc.listen(0)
    await new Promise<void>((resolve) => grpc.once('listening', resolve))
    const bound = grpc.address()
    if (bound === null || typeof bound === 'string') throw new Error('expected TCP listener')
    try {
      for (const scenario of ['healthy', 'auth', 'http', 'grpc', 'protocol', 'deadline'] as const) {
        response = scenario
        const failures: RemoteCacheProbeFailure[] = []
        const connections: RemoteCacheProbeConnectionEvent[] = []
        const available = await probeRemoteCacheCapabilities({
          address: `grpc://localhost:${bound.port}`,
          instanceName: 'fixture',
          tls: false,
          header: 'authorization: Basic $TEST_SECRET',
          env: { TEST_SECRET: 'credential-secret' },
          deadlineMs: scenario === 'deadline' ? 50 : 1000,
          onFailure: (failure) => failures.push(failure),
          onConnectionEvent: (event) => connections.push(event),
        })
        expect(available).toBe(scenario === 'healthy')
        const connected = connections.some(({ event }) => event === 'tcp-connected')
        // The deadline bounds DNS and connection setup too; it may expire before either completes.
        if (scenario !== 'deadline') {
          expect(connections.some(({ event }) => event === 'dns-resolved')).toBeTrue()
          expect(connected).toBeTrue()
        }
        expect(connections.every(({ address }) => address === 'redacted')).toBeTrue()
        expect(connections.every(({ family }) => family === 'IPv4' || family === 'IPv6')).toBeTrue()
        expect(connections.every(({ elapsedMs }) => elapsedMs >= 0)).toBeTrue()
        if (scenario === 'healthy') {
          expect(failures).toEqual([])
        } else {
          expect(failures).toHaveLength(1)
          expect(failures[0]).toEqual({
            errorClass: scenario,
            phase: connected ? 'response' : connections.length > 0 ? 'tcp' : 'dns',
            elapsedMs: expect.any(Number),
            deadlineMs: scenario === 'deadline' ? 50 : 1000,
          })
          expect(failures[0]?.elapsedMs).toBeGreaterThanOrEqual(0)
          expect(JSON.stringify(failures)).not.toContain('private-host.example')
          expect(JSON.stringify(failures)).not.toContain('credential-secret')
        }
      }
    } finally {
      grpc.close()
    }
  })

  it('identifies a TLS handshake stall after TCP connected', async () => {
    const sockets = new Set<Socket>()
    const tcp = createTcpServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
    })
    tcp.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => tcp.once('listening', resolve))
    const bound = tcp.address()
    if (bound === null || typeof bound === 'string') throw new Error('expected TCP listener')
    try {
      const failures: RemoteCacheProbeFailure[] = []
      const connections: RemoteCacheProbeConnectionEvent[] = []
      expect(
        await probeRemoteCacheCapabilities({
          address: `grpc://127.0.0.1:${bound.port}`,
          instanceName: 'fixture',
          tls: true,
          header: undefined,
          env: {},
          deadlineMs: 100,
          onFailure: (failure) => failures.push(failure),
          onConnectionEvent: (event) => connections.push(event),
        }),
      ).toBeFalse()
      expect(failures).toHaveLength(1)
      expect(failures[0]?.errorClass).toBe('deadline')
      expect(failures[0]?.phase).toBe('tls')
      expect(connections.some(({ event }) => event === 'tcp-connected')).toBeTrue()
      expect(connections.some(({ event }) => event === 'tls-ready')).toBeFalse()
      expect(connections.every(({ address }) => address === 'redacted')).toBeTrue()
    } finally {
      for (const socket of sockets) socket.destroy()
      tcp.close()
    }
  })

  it('distinguishes invalid configuration and refused connections without logging inputs', async () => {
    for (const scenario of [
      {
        address: 'https://private-host.example/credential-secret',
        errorClass: 'configuration',
        phase: 'configuration',
      },
      { address: 'grpc://127.0.0.1:1', errorClass: 'tcp', phase: 'tcp' },
    ] as const) {
      const failures: RemoteCacheProbeFailure[] = []
      expect(
        await probeRemoteCacheCapabilities({
          address: scenario.address,
          instanceName: 'fixture',
          tls: false,
          header: undefined,
          env: {},
          deadlineMs: 1000,
          onFailure: (failure) => failures.push(failure),
        }),
      ).toBe(false)
      expect(failures).toHaveLength(1)
      expect(failures[0]?.errorClass).toBe(scenario.errorClass)
      expect(failures[0]?.phase).toBe(scenario.phase)
      expect(JSON.stringify(failures)).not.toContain('private-host.example')
      expect(JSON.stringify(failures)).not.toContain('credential-secret')
    }
  })
})
