// The reusable demo runner. Given a typed `Demo`, it:
//   1. (optionally) runs the demo's reset.sh for a clean Notion slate,
//   2. starts the real CLI in a persistent PTY,
//   3. plays each beat: perform the action, then POLL expectations until they
//      pass (Notion API = authoritative; terminal log + local files secondary),
//   4. records actual per-beat durations vs soft budgets,
//   5. captures terminal (always) + Notion (if logged in) evidence screenshots,
//   6. writes timeline.json + a self-contained report.html.
//
// New demos reuse this unchanged — wiring one = writing its spec.

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, sleep } from './exec.ts'
import { makeNotionApi } from './notion-api.ts'
import { PtyDriver } from './pty-driver.ts'
import { Screenshotter } from './screenshot.ts'
import {
  type AssertionRecord,
  type BeatRecord,
  type RunRecord,
  type ScreenshotRecord,
  writeReport,
  writeTimeline,
} from './report.ts'
import type { Action, Beat, Demo, DemoCtx } from './spec.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const STORAGE_STATE = join(HERE, '.auth', 'storageState.json')
const DEFAULT_PARENT = '396e3d41f4a380a98491e1c96f6b5c43' // shared Recording page

export interface RunOptions {
  /** Run reset.sh first for a clean Notion slate (default true). */
  readonly reset?: boolean
}

const normalize = (s: string): string => s.replace(/\s+/g, '')

const actionSummary = (a: Action): string => {
  switch (a.kind) {
    case 'pty':
      return `$ ${a.cmd}`
    case 'pty-signal':
      return `[${a.key}]`
    case 'edit':
      return `edit ${a.file}`
    case 'notion':
      return `notion-side edit (via API)`
    case 'wait':
      return a.until ? `wait until…` : `wait ${a.ms ?? 0}ms`
  }
}

/** Parse the live page id + url from a stage `.nmd` file's JSON frontmatter. */
const readPageBinding = (
  stageDir: string,
  nmdFile: string,
): { id: string; url: string } => {
  const text = readFileSync(join(stageDir, nmdFile), 'utf8')
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) throw new Error(`no frontmatter in ${nmdFile}`)
  const fm = JSON.parse(m[1]!) as {
    notion_md?: { page_id?: string | null; url?: string | null }
  }
  const id = fm.notion_md?.page_id
  const url = fm.notion_md?.url
  if (!id) throw new Error(`${nmdFile} has no bound page_id (run reset.sh first)`)
  return { id, url: url ?? '' }
}

const byteSize = (p: string): number => (existsSync(p) ? statSync(p).size : 0)

const logSlice = (p: string, fromByte: number): string => {
  if (!existsSync(p)) return ''
  const buf = readFileSync(p)
  return buf.subarray(fromByte).toString('utf8')
}

/** Perform a beat's action exactly once. */
const performAction = async (
  action: Action,
  ctx: DemoCtx,
  pty: PtyDriver,
  watchLogAbs: string,
): Promise<void> => {
  switch (action.kind) {
    case 'pty': {
      // Tee stdout to the watch log for scroll-safe, unwrapped assertions.
      await pty.sendLine(`${action.cmd} 2>&1 | tee -a ${JSON.stringify(watchLogAbs)}`)
      break
    }
    case 'pty-signal':
      await pty.signal(action.key)
      await sleep(500)
      break
    case 'edit': {
      const file = join(ctx.stageDir, action.file)
      const next = action.apply(readFileSync(file, 'utf8'))
      writeFileSync(file, next)
      break
    }
    case 'notion':
      await action.run(ctx)
      break
    case 'wait':
      if (action.ms) await sleep(action.ms)
      if (action.until) {
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline && !(await action.until(ctx))) await sleep(1000)
      }
      break
  }
}

/** Evaluate all of a beat's expectations once; returns records + all-ok flag. */
const evalExpectations = async (
  beat: Beat,
  ctx: DemoCtx,
  logFromByte: number,
  watchLogAbs: string,
): Promise<{ records: AssertionRecord[]; allOk: boolean }> => {
  const records: AssertionRecord[] = []

  if (beat.expectTerminal !== undefined) {
    const slice = normalize(logSlice(watchLogAbs, logFromByte))
    const ok =
      beat.expectTerminal instanceof RegExp
        ? beat.expectTerminal.test(slice)
        : slice.includes(normalize(beat.expectTerminal))
    const want =
      beat.expectTerminal instanceof RegExp
        ? beat.expectTerminal.toString()
        : `"${beat.expectTerminal}"`
    records.push({ kind: 'terminal', ok, detail: `terminal contains ${want}` })
  }

  if (beat.expectNotion !== undefined) {
    try {
      const a = await beat.expectNotion(ctx)
      records.push({ kind: 'notion', ok: a.ok, detail: a.detail })
    } catch (e) {
      records.push({ kind: 'notion', ok: false, detail: `api error: ${String(e)}` })
    }
  }

  if (beat.expectFile !== undefined) {
    const { file, contains, absent } = beat.expectFile
    const p = join(ctx.stageDir, file)
    const text = existsSync(p) ? readFileSync(p, 'utf8') : ''
    const has = text.includes(contains)
    const ok = absent ? !has : has
    records.push({
      kind: 'file',
      ok,
      detail: `${file} ${absent ? 'lacks' : 'contains'} "${contains}" → ${
        ok ? 'yes' : 'no'
      }`,
    })
  }

  return { records, allOk: records.length === 0 ? true : records.every((r) => r.ok) }
}

const writeShims = (
  shims: Readonly<Record<string, string>>,
  binDir: string,
): void => {
  mkdirSync(binDir, { recursive: true })
  for (const [name, target] of Object.entries(shims)) {
    const p = join(binDir, name)
    writeFileSync(p, `#!/usr/bin/env bash\nexec node ${JSON.stringify(target)} "$@"\n`)
    chmodSync(p, 0o755)
  }
}

export const runDemo = async (demo: Demo, opts: RunOptions = {}): Promise<RunRecord> => {
  const doReset = opts.reset ?? true
  const demoDir = join(REPO_ROOT, demo.demoRel)
  const seedStageDir = join(REPO_ROOT, demo.stageRel)
  const resetScript = join(REPO_ROOT, demo.resetRel)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const evidenceDir = join(demoDir, 'evidence', stamp)
  mkdirSync(evidenceDir, { recursive: true })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEMO_PARENT_PAGE: process.env.DEMO_PARENT_PAGE ?? DEFAULT_PARENT,
  }

  // 1. Reset for a clean Notion slate (fresh pages under $DEMO_PARENT_PAGE).
  if (doReset) {
    console.log('▶ reset.sh (fresh Notion pages)…')
    const r = await run('bash', [resetScript], { env, cwd: REPO_ROOT, timeoutMs: 240_000 })
    if (r.code !== 0) {
      throw new Error(`reset.sh failed:\n${r.stderr || r.stdout}`)
    }
    console.log(r.stdout.split('\n').filter((l) => l.startsWith('reset:')).join('\n'))
  }

  // 2. Isolate: run in a private working COPY of the freshly-bound stage, not
  // demo/md/stage itself. Both point at the same fresh pages, but only THIS
  // copy is edited locally — so any other watcher on the shared stage can only
  // ever passively pull (never clobber our pushes). This makes the run
  // deterministic regardless of what else touches the stage.
  const stageDir = join(evidenceDir, 'work')
  mkdirSync(stageDir, { recursive: true })
  for (const name of readdirSync(seedStageDir)) {
    if (name.endsWith('.nmd')) {
      copyFileSync(join(seedStageDir, name), join(stageDir, name))
    }
  }
  const seedStore = join(seedStageDir, '.notion-md')
  if (existsSync(seedStore)) {
    cpSync(seedStore, join(stageDir, '.notion-md'), { recursive: true })
  }
  const watchLogAbs = join(stageDir, demo.watchLog)

  // 3. Resolve live page ids/urls from the working copy's .nmd frontmatter.
  const pageIds: Record<string, string> = {}
  const pageUrls: Record<string, string> = {}
  for (const pg of demo.pages) {
    const b = readPageBinding(stageDir, pg.nmdFile)
    pageIds[pg.role] = b.id
    pageUrls[pg.role] = b.url
  }

  // 4. PATH shim so the on-screen command reads naturally. Targets are
  // repo-relative in the spec; resolve to absolute so they work from any CWD.
  const binDir = join(evidenceDir, 'bin')
  if (demo.shims) {
    const abs = Object.fromEntries(
      Object.entries(demo.shims).map(([k, v]) => [k, join(REPO_ROOT, v)]),
    )
    writeShims(abs, binDir)
  }

  // 5. Reset watch log + start the demo shell in a real PTY. The pty root must
  // be SHORT (its unix socket path has a ~90-byte limit) — the deep evidence dir
  // blows it — so use a short temp dir, cleaned up in `finally`.
  writeFileSync(watchLogAbs, '')
  const ptyRoot = mkdtempSync(join(tmpdir(), 'eup-'))
  const pty = new PtyDriver(`eu-demo-${demo.id}`, ptyRoot, env)
  const shooter = new Screenshotter(`eu-demo-${demo.id}-shot`, STORAGE_STATE)

  const ctx: DemoCtx = {
    demoDir,
    stageDir,
    evidenceDir,
    pageIds,
    pageUrls,
    api: makeNotionApi(),
    readLog: () => logSlice(watchLogAbs, 0),
  }

  const beats: BeatRecord[] = []
  const startedAt = new Date()
  const t0 = Date.now()

  try {
    await pty.start(stageDir)
    if (demo.shims) await pty.sendLine(`export PATH=${JSON.stringify(binDir)}:$PATH`)
    await sleep(300)

    for (const beat of demo.beats) {
      const startOffsetSec = (Date.now() - t0) / 1000
      console.log(`\n▶ ${beat.id}: ${actionSummary(beat.action)}`)
      const logFromByte = byteSize(watchLogAbs)
      const beatStart = Date.now()

      await performAction(beat.action, ctx, pty, watchLogAbs)

      // Poll expectations until all pass or a hard ceiling (soft budgets never fail).
      const ceilingMs = Math.max(beat.budgetSec * 4000, 25_000)
      let result = await evalExpectations(beat, ctx, logFromByte, watchLogAbs)
      const pollDeadline = Date.now() + ceilingMs
      while (!result.allOk && Date.now() < pollDeadline) {
        await sleep(1000)
        result = await evalExpectations(beat, ctx, logFromByte, watchLogAbs)
      }
      const actualSec = (Date.now() - beatStart) / 1000

      // Evidence screenshots (never affect pass/fail).
      const shots: ScreenshotRecord[] = []
      const surfaces = beat.screenshot ?? []
      if (surfaces.includes('terminal')) {
        const file = `terminal-${beat.id}.png`
        const prompt =
          beat.action.kind === 'pty'
            ? beat.action.cmd
            : `# ${actionSummary(beat.action)}`
        const res = await shooter.captureTerminal(
          join(evidenceDir, file),
          demo.title,
          prompt,
          logSlice(watchLogAbs, logFromByte),
        )
        shots.push({ surface: 'terminal', file, ok: res.ok, skipped: res.skipped })
      }
      if (surfaces.includes('notion')) {
        const roles = beat.capturePages ?? demo.pages.map((p) => p.role)
        for (const role of roles) {
          const file = `notion-${beat.id}-${role}.png`
          const res = await shooter.captureNotion(join(evidenceDir, file), pageUrls[role]!)
          shots.push({
            surface: 'notion',
            role,
            file,
            ok: res.ok,
            skipped: res.skipped,
          })
        }
      }

      const pass = result.allOk
      const over = actualSec > beat.budgetSec
      console.log(
        `  ${pass ? '✓ PASS' : '✕ FAIL'}  ${actualSec.toFixed(1)}s / ${beat.budgetSec}s${
          over ? ' ⚠ over budget' : ''
        }`,
      )
      for (const a of result.records) {
        console.log(`    ${a.ok ? '✓' : '✕'} ${a.kind}: ${a.detail}`)
      }

      beats.push({
        id: beat.id,
        narration: beat.narration,
        action: actionSummary(beat.action),
        budgetSec: beat.budgetSec,
        actualSec,
        startOffsetSec,
        assertions: result.records,
        screenshots: shots,
        pass,
      })
    }
  } finally {
    await pty.kill()
    // Reap our own watcher if it outlived the pty shell (killing zsh can leave
    // the `node … | tee` child re-parented to init). Scoped to THIS run's unique
    // work dir path, so it only ever matches our own processes.
    await run('bash', ['-c', `pkill -f ${JSON.stringify(stageDir)} || true`]).catch(() => {})
    await shooter.close()
    rmSync(ptyRoot, { recursive: true, force: true })
  }

  const finishedAt = new Date()
  const passCount = beats.filter((b) => b.pass).length
  const record: RunRecord = {
    demoId: demo.id,
    title: demo.title,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSec: (finishedAt.getTime() - t0) / 1000,
    authPresent: shooter.hasAuth,
    pageUrls,
    beats,
    passCount,
    failCount: beats.length - passCount,
  }

  writeTimeline(evidenceDir, record)
  writeReport(evidenceDir, record)

  // Best-effort: publish the report under the explainers devnet root so it's
  // reachable over the tailnet (e.g. https://<host>:8443/<demo>-evidence/).
  // report.html is self-contained (screenshots inlined); PNGs copied too.
  let servedRel: string | undefined
  const explainersDir = join(REPO_ROOT, 'demo', 'explainers')
  if (existsSync(explainersDir)) {
    try {
      const publishDir = join(explainersDir, `${demo.id}-evidence`)
      rmSync(publishDir, { recursive: true, force: true })
      mkdirSync(publishDir, { recursive: true })
      copyFileSync(join(evidenceDir, 'report.html'), join(publishDir, 'report.html'))
      for (const f of readdirSync(evidenceDir)) {
        if (f.endsWith('.png')) copyFileSync(join(evidenceDir, f), join(publishDir, f))
      }
      servedRel = `${demo.id}-evidence/report.html`
    } catch {
      /* non-fatal */
    }
  }

  console.log(`\n${'─'.repeat(56)}`)
  console.log(`${passCount}/${beats.length} beats passed · ${record.durationSec.toFixed(1)}s`)
  console.log(`evidence: ${evidenceDir}`)
  console.log(`  report:   ${join(evidenceDir, 'report.html')}`)
  console.log(`  timeline: ${join(evidenceDir, 'timeline.json')}`)
  if (servedRel) console.log(`  served:   demo/explainers/${servedRel} (→ tailnet devnet root)`)
  if (!shooter.hasAuth) {
    console.log(`\n⚠ Notion screenshots skipped — run once, headful:`)
    console.log(`    bun demo/harness/login.ts`)
  }
  return record
}
