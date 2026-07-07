// Thin child_process helpers for the demo-env CLI. Self-contained (does NOT
// import from demo/harness/* — that surface is under active edit). The whole CLI
// is external-process orchestration: it shells out to `ntn`, `notion-md`, and
// `notion` and captures output. Runs under plain `bun`/`node` as long as those
// bins + NOTION_API_TOKEN are on PATH (i.e. inside `devenv shell`).

import { spawn } from 'node:child_process'

export interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Piped to the child's stdin. */
  readonly input?: string
  /** Kill + reject after this many ms. */
  readonly timeoutMs?: number
}

/** Run a command, capture stdout/stderr. Never throws on non-zero exit. */
export const run = (
  file: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args as string[], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`timeout after ${opts.timeoutMs}ms: ${file} ${args.join(' ')}`))
      }, opts.timeoutMs)
    }
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    if (opts.input !== undefined) {
      child.stdin.write(opts.input)
      child.stdin.end()
    } else {
      child.stdin.end()
    }
  })

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))
