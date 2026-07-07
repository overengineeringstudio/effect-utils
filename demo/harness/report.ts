// Evidence output: `timeline.json` (machine-readable beat log) and a
// self-contained, theme-aware `report.html` (screenshots inlined as data URIs)
// that matches the visual language of demo/explainers/notion-md.html. The
// report is what we review to break the ~3-min demo into a seconds-level
// sequence and align assertions against the script.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AssertionRecord {
  readonly kind: 'terminal' | 'notion' | 'file'
  readonly ok: boolean
  readonly detail: string
}

export interface ScreenshotRecord {
  readonly surface: 'terminal' | 'notion'
  readonly role?: string
  /** Basename within the evidence dir. */
  readonly file: string
  readonly ok: boolean
  readonly skipped?: string
}

export interface BeatRecord {
  readonly id: string
  readonly narration: string
  readonly action: string
  readonly budgetSec: number
  readonly actualSec: number
  readonly startOffsetSec: number
  readonly assertions: readonly AssertionRecord[]
  readonly screenshots: readonly ScreenshotRecord[]
  readonly pass: boolean
}

export interface RunRecord {
  readonly demoId: string
  readonly title: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationSec: number
  readonly authPresent: boolean
  readonly pageUrls: Readonly<Record<string, string>>
  readonly beats: readonly BeatRecord[]
  readonly passCount: number
  readonly failCount: number
}

export const writeTimeline = (evidenceDir: string, run: RunRecord): void => {
  writeFileSync(join(evidenceDir, 'timeline.json'), JSON.stringify(run, null, 2))
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const dataUri = (evidenceDir: string, file: string): string | undefined => {
  try {
    const b = readFileSync(join(evidenceDir, file))
    return `data:image/png;base64,${b.toString('base64')}`
  } catch {
    return undefined
  }
}

const chip = (ok: boolean, label: string): string =>
  `<span class="chip ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'} ${esc(label)}</span>`

const shotFig = (evidenceDir: string, s: ScreenshotRecord): string => {
  const cap = s.surface === 'notion' ? `Notion${s.role ? ` · ${s.role}` : ''}` : 'Terminal'
  if (s.skipped) {
    return `<figure class="shot skip"><div class="ph">${esc(cap)}<br><small>${esc(
      s.skipped,
    )}</small></div><figcaption>${esc(cap)}</figcaption></figure>`
  }
  const uri = dataUri(evidenceDir, s.file)
  if (!uri) {
    return `<figure class="shot skip"><div class="ph">${esc(cap)}<br><small>missing: ${esc(
      s.file,
    )}</small></div><figcaption>${esc(cap)}</figcaption></figure>`
  }
  return `<figure class="shot"><img alt="${esc(cap)}" src="${uri}"><figcaption>${esc(
    cap,
  )}</figcaption></figure>`
}

const beatCard = (evidenceDir: string, b: BeatRecord): string => {
  const over = b.actualSec > b.budgetSec
  const barPct = Math.min(100, (b.actualSec / Math.max(b.budgetSec, 0.1)) * 100)
  const assertions = b.assertions.length
    ? b.assertions.map((a) => chip(a.ok, `${a.kind}: ${a.detail}`)).join(' ')
    : '<span class="chip muted">no assertions</span>'
  const shots = b.screenshots.length
    ? `<div class="shots">${b.screenshots.map((s) => shotFig(evidenceDir, s)).join('')}</div>`
    : ''
  return `
  <section class="beat ${b.pass ? 'pass' : 'fail'}">
    <div class="bhead">
      <span class="bid">${esc(b.id)}</span>
      <span class="bstatus ${b.pass ? 'ok' : 'bad'}">${b.pass ? 'PASS' : 'FAIL'}</span>
      <span class="btime ${over ? 'warn' : ''}">${b.actualSec.toFixed(1)}s
        <span class="budget">/ budget ${b.budgetSec}s${over ? ' ⚠ over' : ''}</span></span>
    </div>
    <p class="narr">“${esc(b.narration)}”</p>
    <p class="act"><code>${esc(b.action)}</code> · <span class="off">t+${b.startOffsetSec.toFixed(
      1,
    )}s</span></p>
    <div class="bar"><div class="fill ${over ? 'warn' : ''}" style="width:${barPct}%"></div></div>
    <div class="asserts">${assertions}</div>
    ${shots}
  </section>`
}

export const writeReport = (evidenceDir: string, run: RunRecord): void => {
  const authNote = run.authPresent
    ? '<span class="chip ok">✓ storageState loaded — Notion screenshots captured</span>'
    : '<span class="chip warn">⚠ no storageState — Notion screenshots skipped; run <code>bun demo/harness/login.ts</code> once</span>'
  const links = Object.entries(run.pageUrls)
    .map(([role, url]) => `<a href="${esc(url)}">${esc(role)}</a>`)
    .join(' · ')

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(run.title)} — E2E evidence</title>
<style>
  :root{
    --bg:#fff;--panel:#f7f7f8;--ink:#1a1a1a;--muted:#6b6b70;--line:#e3e3e6;
    --accent:#5b5bd6;--accent-soft:#ececfb;--warn:#b25000;--warn-soft:#fbeede;
    --ok:#1a7f4b;--ok-soft:#e5f4ec;--bad:#c02626;--bad-soft:#fbe9e9;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#191919;--panel:#202020;--ink:#ececee;--muted:#9a9aa0;--line:#2f2f2f;
    --accent:#9d9df0;--accent-soft:#26264a;--warn:#e0913f;--warn-soft:#35281a;
    --ok:#4ec98a;--ok-soft:#1c3327;--bad:#f08a8a;--bad-soft:#3a2020;
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
    line-height:1.5;padding:28px}
  .wrap{max-width:920px;margin:0 auto}
  .kicker{font:600 12px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;
    color:var(--accent);margin:0 0 6px}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}
  h1 code{font-family:var(--mono);font-size:.8em;background:var(--accent-soft);
    color:var(--accent);padding:2px 8px;border-radius:6px}
  .sub{color:var(--muted);margin:0 0 18px;font-size:15px}
  .summary{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:20px;
    padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
  .summary .big{font:700 20px var(--sans)}
  .summary a{color:var(--accent)}
  .chip{display:inline-block;font:600 12px/1.35 var(--mono);padding:3px 8px;border-radius:6px;
    background:var(--accent-soft);color:var(--accent)}
  .chip code{font-family:var(--mono)}
  .chip.ok{background:var(--ok-soft);color:var(--ok)}
  .chip.bad{background:var(--bad-soft);color:var(--bad)}
  .chip.warn{background:var(--warn-soft);color:var(--warn)}
  .chip.muted{background:var(--panel);color:var(--muted)}
  .beat{border:1px solid var(--line);border-left-width:4px;border-radius:12px;
    padding:16px 18px;margin-bottom:14px;background:var(--panel)}
  .beat.pass{border-left-color:var(--ok)}
  .beat.fail{border-left-color:var(--bad)}
  .bhead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  .bid{font:700 15px var(--sans)}
  .bstatus{font:700 11px var(--mono);letter-spacing:.06em}
  .bstatus.ok{color:var(--ok)}.bstatus.bad{color:var(--bad)}
  .btime{margin-left:auto;font:600 13px var(--mono);color:var(--ink)}
  .btime.warn{color:var(--warn)}
  .btime .budget{color:var(--muted);font-weight:400}
  .narr{margin:8px 0 4px;font-size:15px}
  .act{margin:0 0 10px;font-size:13px;color:var(--muted)}
  .act code{font-family:var(--mono);background:var(--accent-soft);color:var(--accent);
    padding:1px 6px;border-radius:5px}
  .act .off{font-family:var(--mono)}
  .bar{height:6px;background:var(--line);border-radius:4px;overflow:hidden;margin:0 0 12px}
  .fill{height:100%;background:var(--accent)}
  .fill.warn{background:var(--warn)}
  .asserts{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
  .shots{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:640px){.shots{grid-template-columns:1fr}}
  .shot{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--bg)}
  .shot img{display:block;width:100%;height:auto}
  .shot figcaption{font:600 11px var(--mono);color:var(--muted);padding:6px 10px;
    text-transform:uppercase;letter-spacing:.05em;border-top:1px solid var(--line)}
  .shot.skip .ph{display:flex;align-items:center;justify-content:center;text-align:center;
    min-height:160px;padding:16px;color:var(--muted);font:500 13px var(--sans)}
  .shot.skip small{font-family:var(--mono);font-size:11px}
  .foot{margin-top:20px;font-size:13px;color:var(--muted)}
</style></head><body><div class="wrap">
  <p class="kicker">Notion tooling · E2E demo harness</p>
  <h1><code>${esc(run.demoId)}</code> — ${esc(run.title)}</h1>
  <p class="sub">Storyboard evidence: real CLI in a PTY · assertions via the Notion API · seconds-level timeline.</p>
  <div class="summary">
    <span class="big">${run.passCount}/${run.beats.length} beats passed</span>
    <span class="chip ${run.failCount === 0 ? 'ok' : 'bad'}">${run.failCount} failing</span>
    <span class="chip">${run.durationSec.toFixed(1)}s total</span>
    ${authNote}
    ${links ? `<span class="chip muted">pages: ${links}</span>` : ''}
  </div>
  ${run.beats.map((b) => beatCard(evidenceDir, b)).join('')}
  <p class="foot">Generated ${esc(run.finishedAt)} · ${esc(
    run.startedAt,
  )} run start. Terminal panes are the real watch-daemon output; Notion panes are
  evidence only — every pass/fail chip is asserted against the Notion API, never the DOM.</p>
</div></body></html>`

  writeFileSync(join(evidenceDir, 'report.html'), html)
}
