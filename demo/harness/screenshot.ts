// Evidence screenshots via the `playwright-cli` (Nix-managed, browsers bundled).
// Two surfaces:
//   • terminal — render the PTY log slice into a terminal-styled page and shoot
//     it (works headless, no auth). This is the watch daemon's actual output.
//   • notion   — load a saved `storageState` and screenshot the live page. If
//     no storageState exists we SKIP (and say so) — never assert on the DOM.
//
// Assertions never touch this module; it is evidence only.

import { existsSync } from 'node:fs'
import { run, sleep } from './exec.ts'

const PW = process.env.PLAYWRIGHT_CLI ?? 'playwright-cli'

export interface ShotResult {
  readonly surface: 'terminal' | 'notion'
  readonly file: string
  readonly ok: boolean
  /** Present when skipped (e.g. no storageState). */
  readonly skipped?: string
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const terminalHtml = (title: string, promptLine: string, body: string): string => `
<!doctype html><html><head><meta charset="utf-8"><style>
  :root{color-scheme:dark}
  html,body{margin:0;background:#141414}
  .win{margin:14px;border-radius:10px;overflow:hidden;border:1px solid #2f2f2f;
    box-shadow:0 8px 30px rgba(0,0,0,.4);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .bar{background:#232323;padding:8px 12px;display:flex;gap:7px;align-items:center}
  .dot{width:11px;height:11px;border-radius:50%}
  .r{background:#ff5f56}.y{background:#ffbd2e}.g{background:#27c93f}
  .bar .t{margin-left:10px;color:#9a9aa0;font-size:12px}
  .scr{background:#191919;color:#ececee;padding:14px 16px;font-size:13px;line-height:1.5;
    white-space:pre-wrap;word-break:break-word;min-height:120px}
  .prompt{color:#4ec98a}.cmd{color:#ececee}
</style></head><body>
  <div class="win">
    <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
      <span class="t">${esc(title)} — demo/md/stage</span></div>
    <div class="scr"><span class="prompt">stage ❯ </span><span class="cmd">${esc(promptLine)}</span>
${esc(body)}</div>
  </div>
</body></html>`

const dataUrl = (html: string): string =>
  `data:text/html;base64,${Buffer.from(html, 'utf8').toString('base64')}`

export class Screenshotter {
  readonly hasAuth: boolean
  private opened = false

  constructor(
    private readonly session: string,
    private readonly storageStatePath: string,
  ) {
    this.hasAuth = existsSync(storageStatePath)
  }

  private pw(args: readonly string[]): ReturnType<typeof run> {
    return run(PW, [`-s=${this.session}`, ...args], { timeoutMs: 60_000 })
  }

  private async ensureOpen(): Promise<void> {
    if (this.opened) return
    await this.pw(['open', 'about:blank'])
    if (this.hasAuth) {
      await this.pw(['state-load', this.storageStatePath])
    }
    await this.pw(['resize', '1000', '720'])
    this.opened = true
  }

  /** Render the terminal log slice for one beat and screenshot it. */
  async captureTerminal(
    file: string,
    title: string,
    promptLine: string,
    logSlice: string,
  ): Promise<ShotResult> {
    await this.ensureOpen()
    const html = terminalHtml(title, promptLine, logSlice.trimEnd() || '(no output yet)')
    await this.pw(['goto', dataUrl(html)])
    await sleep(200)
    const r = await this.pw(['screenshot', `--filename=${file}`])
    return { surface: 'terminal', file, ok: r.code === 0 }
  }

  /** Screenshot a live Notion page. Requires storageState; else skipped. */
  async captureNotion(file: string, pageUrl: string): Promise<ShotResult> {
    if (!this.hasAuth) {
      return {
        surface: 'notion',
        file,
        ok: false,
        skipped: 'no storageState — run `bun demo/harness/login.ts` once',
      }
    }
    await this.ensureOpen()
    await this.pw(['goto', pageUrl])
    // Notion renders progressively; give it a moment to settle.
    await sleep(3500)
    const r = await this.pw(['screenshot', `--filename=${file}`])
    return { surface: 'notion', file, ok: r.code === 0 }
  }

  async close(): Promise<void> {
    if (this.opened) await this.pw(['close']).catch(() => {})
  }
}
