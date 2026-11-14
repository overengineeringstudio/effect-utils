import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerHttp2Stream } from 'node:http2'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { localMaterializationCategories } from '../genie/ci-scripts/buck2-action-evidence.ts'
import {
  buckConfigValues,
  probeRemoteCacheCapabilities,
  publicProbeAddress,
  type ReapiAdmissionAttempt,
  type RemoteCacheProbeConnectionEvent,
  type RemoteCacheProbeFailure,
  reconcileStandaloneCachePosture,
  standaloneCachePostureConfig,
} from './buck2-cache-posture.ts'

const temporaryRoots: string[] = []
const replayProcesses = new Set<Bun.Subprocess<'ignore', 'pipe', 'pipe'>>()

const stopReplayProcesses = async (
  children: Iterable<Bun.Subprocess<'ignore', 'pipe', 'pipe'>>,
) => {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
    await child.exited
    // The shell's exit does not reap descendants from command substitutions.
    // Wait for the entire group to disappear before removing its input files.
    // OS reaping has no awaitable signal for non-child processes; poll the real
    // group condition rather than assuming a fixed grace period is sufficient.
    const deadline = performance.now() + 2000
    for (;;) {
      try {
        process.kill(-child.pid, 0)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break
        // Darwin can transiently report EPERM while a killed group is reaping.
        // This is not proof of absence: keep polling until ESRCH or the deadline.
        if (
          process.platform !== 'darwin' ||
          !(error instanceof Error && 'code' in error && error.code === 'EPERM')
        )
          throw error
      }
      if (performance.now() >= deadline) {
        const members: string[] = []
        if (existsSync('/proc') === true) {
          for (const pid of readdirSync('/proc')) {
            if (/^\d+$/.test(pid) === false) continue
            try {
              const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
              const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
              if (Number(fields[2]) === child.pid) members.push(`${pid} (${fields[0]})`)
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error
            }
          }
        }
        throw new Error(
          `Replay process group ${child.pid} was not reaped within 2000 ms; members: ${
            members.length > 0 ? members.join(', ') : 'unavailable'
          }; preserving fixtures`,
        )
      }
      await Bun.sleep(10)
    }
  }
}

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'buck2-cache-posture-'))
  writeFileSync(join(root, '.buckconfig'), '[buck2]\n  remote_cache_enabled = true\n')
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await stopReplayProcesses(replayProcesses)
  replayProcesses.clear()
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('replay subprocess cleanup', () => {
  for (const ignoreSigterm of [false, true]) {
    it(`reaps command-substitution descendants before deleting fixtures (ignore SIGTERM: ${ignoreSigterm})`, async () => {
      const fixture = join(makeRoot(), 'events.jsonl')
      writeFileSync(fixture, 'fixture')
      const child = Bun.spawn(
        [
          'bash',
          '-c',
          `${ignoreSigterm === true ? "trap '' TERM; " : ''}result="$(${ignoreSigterm === true ? "trap '' TERM; " : ''}printf ready >&2; exec sleep 30)"`,
        ],
        { detached: true, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      )
      replayProcesses.add(child)
      const { value } = await child.stderr.getReader().read()
      expect(new TextDecoder().decode(value)).toBe('ready')
      if (ignoreSigterm === true) {
        process.kill(-child.pid, 'SIGTERM')
        expect(() => process.kill(-child.pid, 0)).not.toThrow()
      }
      await stopReplayProcesses([child])
      replayProcesses.delete(child)
      expect(() => process.kill(-child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      expect(existsSync(fixture)).toBe(true)
      rmSync(fixture)
      expect(existsSync(fixture)).toBe(false)
    })
  }
})

describe('standalone Buck cache posture', () => {
  it('sets native count-only event-log retention only in CI or an evidence context', () => {
    const current = '[buck2]\n  retained_event_logs = 7\n[developer]\n  keep = yes\n'
    for (const env of [
      { GITHUB_ACTIONS: 'true' },
      { CI_BUCK2_CACHE_EVIDENCE_PATH: '/ci/evidence.json' },
      { GITHUB_ACTIONS: 'true', BUCK2_NO_REMOTE_CACHE: '1' },
      { GITHUB_ACTIONS: 'true', BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
    ]) {
      const ci = standaloneCachePostureConfig({ current, env })
      const values = buckConfigValues(ci)
      expect(values['buck2.retained_event_logs']).toBe('120')
      expect(ci.startsWith(current.trimEnd())).toBe(true)
      expect(ci).not.toContain('retained_event_log_bytes')
      const developer = standaloneCachePostureConfig({ current: ci, env: {} })
      expect(buckConfigValues(developer)['buck2.retained_event_logs']).toBe('7')
      expect(developer.startsWith(current.trimEnd())).toBe(true)
    }
    for (const env of [{}, { GITHUB_ACTIONS: 'false' }, { CI_BUCK2_CACHE_EVIDENCE_PATH: '' }]) {
      expect(
        buckConfigValues(standaloneCachePostureConfig({ current: '', env }))[
          'buck2.retained_event_logs'
        ],
      ).toBeUndefined()
    }
  })

  it('disables remote cache only for the exact opt-out without selecting an archive origin', () => {
    expect(
      standaloneCachePostureConfig({
        current: '',
        env: { BUCK2_NO_REMOTE_CACHE: '1' },
      }),
    ).toBe(`# effect-utils standalone cache posture: begin
[buck2]
  remote_cache_enabled = false
  allow_cache_uploads = false
# effect-utils standalone cache posture: end
`)

    for (const value of [undefined, '0', 'true', ' 1'])
      expect(
        standaloneCachePostureConfig({
          current: '',
          env: { BUCK2_NO_REMOTE_CACHE: value },
        }),
      ).toBe(`# effect-utils standalone cache posture: begin
# effect-utils standalone cache posture: end
`)
  })

  it('reads the public TLS tier anonymously in a PR lane, without upload rights', () => {
    const prLane = standaloneCachePostureConfig({
      current: '',
      env: { BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
    })

    expect(prLane).toContain('remote_cache_enabled = true')
    expect(prLane).toContain('allow_cache_uploads = false')
    expect(prLane).not.toContain('[archive_origin]')
    expect(prLane).not.toContain('http_headers')

    const escapeHatch = standaloneCachePostureConfig({
      current: prLane,
      env: { BUCK2_PUBLIC_CACHE_READ_ONLY: '1', BUCK2_NO_REMOTE_CACHE: '1' },
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
    })
    expect(publisher).toBe(`# effect-utils standalone cache posture: begin
[buck2]
  allow_cache_uploads = true
  default_allow_cache_upload = true
[buck2_re_client]
  http_headers = authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH
# effect-utils standalone cache posture: end
`)
    expect(publisher).not.toContain(credential)

    for (const value of [undefined, ''])
      expect(
        standaloneCachePostureConfig({
          current: '',
          env: { BUCK2_CACHE_WRITE_BASIC_AUTH: value },
        }),
      ).not.toContain('allow_cache_uploads = true')

    // The exact public-lane opt-out wins over a leaked credential.
    expect(
      standaloneCachePostureConfig({
        current: '',
        env: { BUCK2_NO_REMOTE_CACHE: '1', BUCK2_CACHE_WRITE_BASIC_AUTH: credential },
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
    const writer = standaloneCachePostureConfig({ current: '', env })
    expect(writer).toContain('allow_cache_uploads = true')
    for (const field of ['action_cache_address', 'cas_address', 'engine_address'])
      expect(writer).toContain(`${field} = ${env.BUCK2_PRIVATE_CACHE_ADDRESS}`)
    expect(writer).toContain('tls = false')
    expect(writer).toContain('$BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH')
    expect(writer).not.toContain('[archive_origin]')
    expect(writer).not.toContain(credential)
    expect(writer).not.toContain('$BUCK2_CACHE_WRITE_BASIC_AUTH')
    for (const override of [
      { BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
      { BUCK2_NO_REMOTE_CACHE: '1' },
    ]) {
      const reader = standaloneCachePostureConfig({
        current: writer,
        env: { ...env, ...override },
      })
      expect(reader).toContain('allow_cache_uploads = false')
      expect(reader).not.toContain('http_headers')
      expect(reader).not.toContain('private-cache.example')
    }
    expect(() =>
      standaloneCachePostureConfig({
        current: '',
        env: { BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: credential },
      }),
    ).toThrow()
  })

  it('replaces a publisher overlay with anonymous read-only posture in a reader root', () => {
    const publisher = standaloneCachePostureConfig({
      current: '',
      env: { BUCK2_CACHE_WRITE_BASIC_AUTH: 'd3JpdGVyOnNlY3JldA==' },
    })
    const reader = standaloneCachePostureConfig({
      current: publisher,
      env: { BUCK2_PUBLIC_CACHE_READ_ONLY: '1' },
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
# effect-utils standalone cache posture: end
`)

    reconcileStandaloneCachePosture({ repoRoot: root, env: {} })
    expect(readFileSync(output, 'utf8')).toBe(`${local.trimEnd()}

# effect-utils standalone cache posture: begin
# effect-utils standalone cache posture: end
`)
  })

  it('removes the public posture when a checkout returns to its default cache tier', () => {
    const root = makeRoot()
    const output = join(root, '.buckconfig.local')

    reconcileStandaloneCachePosture({ repoRoot: root, env: { BUCK2_NO_REMOTE_CACHE: '1' } })
    expect(existsSync(output)).toBeTrue()

    reconcileStandaloneCachePosture({ repoRoot: root, env: { BUCK2_NO_REMOTE_CACHE: '0' } })
    expect(readFileSync(output, 'utf8')).not.toContain('[archive_origin]')
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
        const attempts: ReapiAdmissionAttempt[] = []
        const available = await probeRemoteCacheCapabilities({
          address: `grpc://localhost:${bound.port}`,
          instanceName: 'fixture',
          tls: false,
          header: 'authorization: Basic $TEST_SECRET',
          env: { TEST_SECRET: 'credential-secret' },
          deadlineMs: scenario === 'deadline' ? 50 : 1000,
          onFailure: (failure) => failures.push(failure),
          onConnectionEvent: (event) => connections.push(event),
          onAttempt: (attempt) => attempts.push(attempt),
        })
        expect(available).toBe(scenario === 'healthy')
        expect(attempts).toHaveLength(1)
        expect(attempts[0]?.attemptIndex).toBe(1)
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
          expect(attempts[0]).toEqual({
            attemptIndex: 1,
            elapsedMs: expect.any(Number),
            deadlineMs: 1000,
            dnsResolvedMs: expect.any(Number),
            tcpConnectedMs: expect.any(Number),
            firstResponseMs: expect.any(Number),
            connectTlsDeadlineMs: 1000,
            responseDeadlineMs: 1000,
          })
        } else {
          expect(failures).toHaveLength(1)
          expect(failures[0]).toEqual({
            errorClass: scenario,
            phase: connected === true ? 'response' : connections.length > 0 ? 'tcp' : 'dns',
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
      const attempts: ReapiAdmissionAttempt[] = []
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
          attemptIndex: 2,
          onAttempt: (attempt) => attempts.push(attempt),
        }),
      ).toBeFalse()
      expect(failures).toHaveLength(1)
      expect(failures[0]?.errorClass).toBe('deadline')
      expect(failures[0]?.phase).toBe('tls')
      expect(attempts).toEqual([
        {
          attemptIndex: 2,
          elapsedMs: expect.any(Number),
          deadlineMs: 100,
          tcpConnectedMs: expect.any(Number),
          connectTlsDeadlineMs: 100,
          responseDeadlineMs: 100,
          failure: {
            class: 'deadline',
            phase: 'tls',
            elapsedMs: expect.any(Number),
            deadlineMs: 100,
          },
        },
      ])
      expect(connections.some(({ event }) => event === 'tcp-connected')).toBeTrue()
      expect(connections.some(({ event }) => event === 'tls-ready')).toBeFalse()
      expect(connections.every(({ address }) => address === 'redacted')).toBeTrue()
    } finally {
      for (const socket of sockets) socket.destroy()
      tcp.close()
    }
  })

  // Scaled equivalents of the production split (5000/2500/8000): a slow
  // connect/TLS must not consume the response budget, and grpc-timeout carries
  // only the response budget. The delayed server replies are real timers
  // because the probe's platform deadline timers are the behavior under test.
  it('admits a slow response under a fresh response budget with grpc-timeout carrying it', async () => {
    const grpcTimeouts: string[] = []
    const grpc = createServer()
    grpc.on('stream', (stream: ServerHttp2Stream, headers) => {
      grpcTimeouts.push(String(headers['grpc-timeout']))
      stream.on('error', () => {})
      stream.on('data', () => {})
      stream.on('end', () => {
        setTimeout(() => {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
          stream.end(Buffer.from([0, 0, 0, 0, 0]))
        }, 300)
      })
    })
    grpc.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => grpc.once('listening', resolve))
    const bound = grpc.address()
    if (bound === null || typeof bound === 'string') throw new Error('expected TCP listener')
    const attempts: ReapiAdmissionAttempt[] = []
    try {
      expect(
        await probeRemoteCacheCapabilities({
          address: `grpc://127.0.0.1:${bound.port}`,
          instanceName: 'fixture',
          tls: false,
          header: undefined,
          env: {},
          connectTlsDeadlineMs: 500,
          responseDeadlineMs: 1500,
          totalCeilingMs: 2000,
          onAttempt: (attempt) => attempts.push(attempt),
        }),
      ).toBeTrue()
      expect(grpcTimeouts).toEqual(['1500m'])
      expect(attempts[0]?.deadlineMs).toBe(1500)
      expect(attempts[0]?.connectTlsDeadlineMs).toBe(500)
      expect(attempts[0]?.responseDeadlineMs).toBe(1500)
      expect(attempts[0]?.totalCeilingMs).toBe(2000)
      expect(attempts[0]?.failure).toBeUndefined()
    } finally {
      grpc.close()
    }
  })

  it('stops a stalled response at the response budget, not the connect budget', async () => {
    const streams = new Set<ServerHttp2Stream>()
    const grpc = createServer()
    grpc.on('stream', (stream: ServerHttp2Stream) => {
      streams.add(stream)
      stream.on('error', () => {})
      stream.on('data', () => {})
      stream.on('end', () => {
        setTimeout(() => {
          if (stream.destroyed === true || stream.closed === true) return
          stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
          stream.end(Buffer.from([0, 0, 0, 0, 0]))
        }, 1000)
      })
      stream.on('close', () => streams.delete(stream))
    })
    grpc.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => grpc.once('listening', resolve))
    const bound = grpc.address()
    if (bound === null || typeof bound === 'string') throw new Error('expected TCP listener')
    const failures: RemoteCacheProbeFailure[] = []
    const attempts: ReapiAdmissionAttempt[] = []
    try {
      expect(
        await probeRemoteCacheCapabilities({
          address: `grpc://127.0.0.1:${bound.port}`,
          instanceName: 'fixture',
          tls: false,
          header: undefined,
          env: {},
          connectTlsDeadlineMs: 400,
          responseDeadlineMs: 200,
          totalCeilingMs: 600,
          onFailure: (failure) => failures.push(failure),
          onAttempt: (attempt) => attempts.push(attempt),
        }),
      ).toBeFalse()
      expect(failures).toEqual([
        { errorClass: 'deadline', phase: 'response', elapsedMs: expect.any(Number), deadlineMs: 200 },
      ])
      expect(attempts[0]?.failure?.phase).toBe('response')
      expect(attempts[0]?.failure?.deadlineMs).toBe(200)
      expect(attempts[0]?.deadlineMs).toBe(200)
    } finally {
      for (const stream of streams) stream.close()
      grpc.close()
    }
  })

  it('enforces the attempt ceiling over both phase budgets during a TLS stall', async () => {
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
    const failures: RemoteCacheProbeFailure[] = []
    try {
      expect(
        await probeRemoteCacheCapabilities({
          address: `grpc://127.0.0.1:${bound.port}`,
          instanceName: 'fixture',
          tls: true,
          header: undefined,
          env: {},
          connectTlsDeadlineMs: 10000,
          responseDeadlineMs: 10000,
          totalCeilingMs: 10000,
          attemptCeilingMs: 150,
          onFailure: (failure) => failures.push(failure),
        }),
      ).toBeFalse()
      expect(failures[0]?.errorClass).toBe('deadline')
      expect(failures[0]?.phase).toBe('tls')
      expect(failures[0]?.deadlineMs).toBe(10000)
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

describe('fresh-root remote build proof', () => {
  const replay = async (actions: readonly { category: string; executionKind: number }[]) => {
    const root = makeRoot()
    const events = join(root, 'events.jsonl')
    writeFileSync(
      events,
      actions
        .map(({ category, executionKind }) =>
          JSON.stringify({
            Event: {
              data: {
                SpanEnd: {
                  data: {
                    ActionExecution: {
                      name: { category },
                      execution_kind: executionKind,
                    },
                  },
                },
              },
            },
          }),
        )
        .join('\n'),
    )
    const repoRoot = resolve(import.meta.dirname, '..')
    const child = Bun.spawn(
      [
        'bash',
        join(repoRoot, 'scripts/buck2-remote-cache-proof.sh'),
        '--assert-context-b-build',
        events,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, GITHUB_WORKSPACE: repoRoot },
        stdin: 'ignore',
        stdout: 'pipe',
        detached: true,
        stderr: 'pipe',
      },
    )
    replayProcesses.add(child)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { exitCode, stdout, stderr }
    } finally {
      replayProcesses.delete(child)
    }
  }

  const descriptorHit = { category: 'javascript_product_descriptor', executionKind: 3 }

  it('accepts remote compute hits alongside every intentionally local materialization category', async () => {
    const result = await replay([
      descriptorHit,
      { category: 'tsgo_emit', executionKind: 3 },
      ...localMaterializationCategories.flatMap((category) =>
        [1, 7, 8, 10].map((executionKind) => ({ category, executionKind })),
      ),
    ])
    expect(result.exitCode).toBe(0)
  })

  it('accepts noncacheable runtime module copies alongside remote compute hits', async () => {
    const result = await replay([
      descriptorHit,
      { category: 'tsgo_emit', executionKind: 3 },
      ...[1, 7, 8, 10].map((executionKind) => ({
        category: 'runtime_module',
        executionKind,
      })),
    ])
    expect(result.exitCode).toBe(0)
  })

  // Each replay gets the runner's normal hang guard, not one shared wall-clock
  // budget for 18 subprocess trees. Await the actual exit without blocking Bun.
  for (const category of ['tsgo_emit', 'package_bin_artifact', 'unknown_category']) {
    for (const executionKind of [1, 2, 7, 8, 10, 11]) {
      it(`rejects ${category} execution kind ${executionKind} despite a descriptor remote hit`, async () => {
        const result = await replay([descriptorHit, { category, executionKind }])
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toContain('Context B executed a cache-eligible action')
      })
    }
  }

  it('requires a remote action-cache hit', async () => {
    const result = await replay([{ category: 'package_tree', executionKind: 1 }])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('did not report a remote action-cache hit')
  })

  it('requires the explicit remote descriptor hit', async () => {
    const result = await replay([{ category: 'tsgo_emit', executionKind: 3 }])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('did not reuse the remote product descriptor')
  })
})
