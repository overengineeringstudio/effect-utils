// Drives a persistent demo shell in a real PTY via the `pty` CLI. Sessions are
// isolated in a per-run PTY_ROOT (under the evidence dir) so the harness never
// touches the operator's global pty state. We run a clean `zsh -f` and type
// commands into it — mirroring exactly what the presenter does on camera.

import { run, sleep } from './exec.ts'

const PTY = process.env.PTY_BIN ?? 'pty'

export class PtyDriver {
  private readonly env: NodeJS.ProcessEnv

  constructor(
    private readonly session: string,
    private readonly ptyRoot: string,
    baseEnv: NodeJS.ProcessEnv = process.env,
  ) {
    this.env = { ...baseEnv, PTY_ROOT: ptyRoot }
  }

  private pty(args: readonly string[]): ReturnType<typeof run> {
    return run(PTY, args, { env: this.env, timeoutMs: 30_000 })
  }

  /** Start a clean login-free shell session. */
  async start(cwd: string): Promise<void> {
    await this.pty([
      'run',
      '-d',
      '-a',
      '--name',
      this.session,
      '--tag',
      'run.role=demo-harness',
      '--',
      'zsh',
      '-f',
    ])
    // Give the shell a beat to come up, then cd into the stage.
    await sleep(400)
    await this.sendLine(`cd ${JSON.stringify(cwd)}`)
    await sleep(200)
  }

  /** Type a command and press Enter. */
  async sendLine(text: string): Promise<void> {
    await this.pty(['send', this.session, '--seq', text, '--seq', 'key:return'])
  }

  /** Send a control key sequence, e.g. `ctrl+c`. */
  async signal(key: string): Promise<void> {
    await this.pty(['send', this.session, '--seq', `key:${key}`])
  }

  /** Current visible screen, ANSI stripped. */
  async peekPlain(): Promise<string> {
    const r = await this.pty(['peek', '--plain', this.session])
    return r.stdout
  }

  async kill(): Promise<void> {
    await this.pty(['kill', this.session]).catch(() => {})
    await this.pty(['rm', this.session]).catch(() => {})
  }
}
