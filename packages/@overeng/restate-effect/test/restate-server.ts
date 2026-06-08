/**
 * Docker-free native `restate-server` harness for integration tests.
 *
 * Spawns a real `restate-server` child against a throwaway base dir, waits for
 * the admin API to report healthy, and exposes the ingress/admin URLs plus a
 * `register(uri)` that POSTs an SDK deployment to the admin API. All output is
 * buffered so failures can dump diagnostics.
 *
 * The server binary is resolved from `RESTATE_SERVER_BIN` (built from
 * `nix/restate.nix`) and falls back to a `restate-server` on `$PATH`.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface RestateServerHandle {
  readonly ingressUrl: string
  readonly adminUrl: string
  readonly register: (uri: string) => Promise<void>
  readonly shutdown: () => Promise<void>
}

const INGRESS_PORT = 8080
const ADMIN_PORT = 9070

/** Resolve whether a usable server binary is available without spawning it. */
export const serverBin = (): string => process.env['RESTATE_SERVER_BIN'] ?? 'restate-server'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const startRestateServer = async (): Promise<RestateServerHandle> => {
  const baseDir = await mkdtemp(join(tmpdir(), 'restate-poc-'))
  const bin = serverBin()
  const ingressUrl = `http://localhost:${INGRESS_PORT}`
  const adminUrl = `http://localhost:${ADMIN_PORT}`

  let logs = ''
  const capture = (chunk: Buffer | string) => {
    logs += chunk.toString()
  }

  let child: ChildProcess
  try {
    /* `restate-server` takes the data dir via `--base-dir` (no env var); the
     * admin API listens on :9070 and ingress on :8080 by default. */
    child = spawn(bin, ['--base-dir', baseDir], {
      env: {
        ...process.env,
        /* Quiet but still capture warnings/errors for diagnostics. */
        RESTATE_LOG_FILTER: process.env['RESTATE_LOG_FILTER'] ?? 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (cause) {
    await rm(baseDir, { recursive: true, force: true })
    throw new Error(`failed to spawn restate-server (bin: ${bin}): ${String(cause)}`, { cause })
  }

  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)

  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
  child.on('exit', (code, signal) => {
    exited = { code, signal }
  })

  const fail = (msg: string): never => {
    throw new Error(`${msg}\n--- restate-server output ---\n${logs}\n-----------------------------`)
  }

  /* Poll the admin health endpoint until ready (or the process dies). */
  const deadline = Date.now() + 30_000
  for (;;) {
    if (exited !== undefined) {
      await rm(baseDir, { recursive: true, force: true })
      fail(`restate-server exited early (code=${exited.code} signal=${exited.signal}) bin=${bin}`)
    }
    try {
      const res = await fetch(`${adminUrl}/health`)
      if (res.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() >= deadline) {
      child.kill('SIGKILL')
      await rm(baseDir, { recursive: true, force: true })
      fail(`restate-server did not become healthy within 30s (admin: ${adminUrl}/health)`)
    }
    await sleep(200)
  }

  const register = async (uri: string): Promise<void> => {
    const res = await fetch(`${adminUrl}/deployments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri, force: true }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      fail(`deployment registration failed (${res.status}) for uri=${uri}: ${text}`)
    }
  }

  const shutdown = async (): Promise<void> => {
    if (exited === undefined) {
      child.kill('SIGTERM')
      const killDeadline = Date.now() + 5_000
      while (exited === undefined && Date.now() < killDeadline) await sleep(50)
      if (exited === undefined) child.kill('SIGKILL')
    }
    await rm(baseDir, { recursive: true, force: true })
  }

  return { ingressUrl, adminUrl, register, shutdown }
}
