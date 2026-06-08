/**
 * Shared integration-test helpers: detect the native `restate-server` binary and
 * allocate ephemeral ports for the SDK endpoint (R27 — parallel-safe).
 */
import { createServer } from 'node:net'

/** Whether a usable `restate-server` binary is available without spawning it. */
export const serverAvailable: boolean = (() => {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    execFileSync(process.env['RESTATE_SERVER_BIN'] ?? 'restate-server', ['--version'], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
})()

/** Ask the OS for a free TCP port (bind `:0`, read the port, release it). */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('no free port')))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
