#!/usr/bin/env bun
/**
 * Live control dashboard generator.
 *
 * Reads the per-demo SCREENPLAY.md files + the latest md evidence timeline.json
 * and emits a single self-contained `demo/explainers/control.html` — the surface
 * the presenter reads WHILE recording the Notion-tooling demos.
 *
 * Run:  bun demo/dashboard/build.ts
 * Out:  demo/explainers/control.html   (served at .../control.html)
 *
 * Design notes / faithfulness rules:
 *  - Each beat body is rendered in DOCUMENT ORDER. A fenced block is a copy box;
 *    prose is rendered as-is. We never relabel a diff/keystroke/expected-output
 *    as a "command" or reorder prose. Prose that has no code block after it in the
 *    beat is the "→ what to see" expectation; prose before/between blocks is setup.
 *  - Every command is stored raw (byte-exact) in a JS array; the copy button reads
 *    from that array. HTML escaping is display-only.
 *  - md evidence images are GLOBBED from the served md-evidence/ dir per beat so they
 *    track the harness's latest (re)published screenshots.
 *  - Explainer iframes + evidence images are referenced by RELATIVE path so they
 *    auto-update; nothing is inlined.
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Beat, type Demo, type Segment, esc, findResetCmd, inlineMd, parseBeats, parseGapWow } from './screenplay.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const EXPLAINERS = join(REPO, 'demo', 'explainers')
const OUT = join(EXPLAINERS, 'control.html')

// ---------------------------------------------------------------------------
// raw-command registry (byte-exact copy targets)
// ---------------------------------------------------------------------------

const CMDS: string[] = []
const cmd = (raw: string): number => {
  CMDS.push(raw)
  return CMDS.length - 1
}

// ---------------------------------------------------------------------------
// md evidence: latest timeline + globbed images
// ---------------------------------------------------------------------------

const loadMdTimeline = (): any | null => {
  const evDir = join(REPO, 'demo', 'md', 'evidence')
  if (!existsSync(evDir)) return null
  // Only the MAIN md demo (demoId "md"); ignore the "md-merge-proof" appendix runs
  // whose mp* screenshots are published to a different served dir. Pick the latest.
  const runs = readdirSync(evDir)
    .filter((d) => statSync(join(evDir, d)).isDirectory())
    .filter((d) => existsSync(join(evDir, d, 'timeline.json')))
    .sort()
  for (let k = runs.length - 1; k >= 0; k--) {
    const tl = JSON.parse(readFileSync(join(evDir, runs[k]!, 'timeline.json'), 'utf8'))
    if (tl.demoId === 'md') return tl
  }
  return null
}

const bucketMdImages = (): Record<string, { file: string; surface: string; label: string }[]> => {
  const dir = join(EXPLAINERS, 'md-evidence')
  const out: Record<string, { file: string; surface: string; label: string }[]> = {}
  if (!existsSync(dir)) return out
  const files = readdirSync(dir).filter((f) => f.endsWith('.png'))
  for (const f of files) {
    const m = f.match(/beat(\d+)/)
    if (!m) continue
    const num = m[1]!
    const surface = f.startsWith('terminal') ? 'terminal' : 'notion'
    let label = 'Notion'
    if (surface === 'terminal') label = 'Terminal'
    else if (/roadmap/.test(f)) label = 'Notion · roadmap'
    else if (/spec/.test(f)) label = 'Notion · spec'
    ;(out[num] ??= []).push({ file: `md-evidence/${f}`, surface, label })
  }
  // terminal first, then notion
  for (const k of Object.keys(out)) {
    out[k]!.sort((a, b) => (a.surface === b.surface ? 0 : a.surface === 'terminal' ? -1 : 1))
  }
  return out
}

// ---------------------------------------------------------------------------
// build demo models
// ---------------------------------------------------------------------------

const readScreenplay = (demoDir: string): string =>
  readFileSync(join(REPO, 'demo', demoDir, 'SCREENPLAY.md'), 'utf8')

const DEMO_DEFS: { id: string; dir: string; tab: string; explainer: string | null }[] = [
  { id: 'md', dir: 'md', tab: 'notion md', explainer: 'notion-md.html' },
  { id: 'sqlite', dir: 'sqlite', tab: 'notion sqlite', explainer: 'notion-sqlite.html' },
  { id: 'schema', dir: 'schema', tab: 'notion schema', explainer: 'notion-schema.html' },
  { id: 'react', dir: 'react', tab: 'notion-react', explainer: 'notion-react.html' },
]

const buildDemos = (): Demo[] => {
  const timeline = loadMdTimeline()
  const mdImages = bucketMdImages()
  // map timeline beat number -> pass/fail
  const mdStatusByNum: Record<string, 'pass' | 'fail'> = {}
  if (timeline) {
    for (const b of timeline.beats ?? []) {
      const m = String(b.id).match(/beat(\d+)/)
      if (m) mdStatusByNum[m[1]!] = b.pass ? 'pass' : 'fail'
    }
  }

  return DEMO_DEFS.map((def) => {
    const md = readScreenplay(def.dir)
    const beats = parseBeats(md)
    const explainerSrc = def.explainer && existsSync(join(EXPLAINERS, def.explainer)) ? def.explainer : null

    if (def.id === 'md') {
      for (const b of beats) {
        if (b.num && b.num in mdStatusByNum) b.status = mdStatusByNum[b.num]!
        if (b.num && mdImages[b.num]) b.images = mdImages[b.num]!
      }
    }

    const summary =
      def.id === 'md' && timeline
        ? {
            harnessed: true,
            pass: timeline.passCount ?? 0,
            total: (timeline.passCount ?? 0) + (timeline.failCount ?? 0),
            durationSec: timeline.durationSec,
            finishedAt: timeline.finishedAt,
          }
        : { harnessed: false, pass: 0, total: 0 }

    return {
      id: def.id,
      tab: def.tab,
      gapwow: parseGapWow(md),
      resetCmd: findResetCmd(md),
      explainerSrc,
      beats,
      summary,
    }
  })
}

// ---------------------------------------------------------------------------
// render helpers
// ---------------------------------------------------------------------------

const fmtWhen = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const day = d.getUTCDate()
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${mon} ${day} ${hh}:${mm}Z`
}

const copyBtn = (raw: string): string => `<button class="copy" data-cmd="${cmd(raw)}" title="Copy to clipboard" aria-label="Copy command">⧉</button>`

// A fenced block that is expected program OUTPUT, not a runnable command
// (e.g. sqlite Beat 3's typed refusals). Narrow, false-positive-safe detector:
// every non-empty line is an `Error:` line. Such blocks get no copy affordance.
const isOutputBlock = (raw: string): boolean => {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.length > 0 && lines.every((l) => /^Error:/.test(l))
}

const renderSegment = (seg: Segment): string => {
  if (seg.kind === 'code') {
    if (isOutputBlock(seg.raw)) {
      return `<div class="cmd out"><span class="out-tag">expected output · not a command</span><pre>${esc(seg.raw)}</pre></div>`
    }
    return `<div class="cmd"><pre>${esc(seg.raw)}</pre>${copyBtn(seg.raw)}</div>`
  }
  if (seg.kind === 'say') {
    return `<p class="say say-inline"><span class="say-tag">SAY</span>${esc(seg.text)}</p>`
  }
  const cls = seg.isExpectation ? 'note expect' : 'note'
  const prefix = seg.isExpectation ? '<span class="arrow">→</span> ' : ''
  return `<p class="${cls}">${prefix}${seg.html}</p>`
}

const statusBadge = (s: 'pass' | 'fail' | 'none'): string => {
  if (s === 'pass') return `<span class="badge ok" title="passed in latest harness run">✓</span>`
  if (s === 'fail') return `<span class="badge fail" title="failed in latest harness run">✗</span>`
  return `<span class="badge none" title="not yet harnessed">○</span>`
}

const renderBeat = (demoId: string, b: Beat, idx: number): string => {
  const evId = `${demoId}-ev-${idx}`
  const hasImages = b.images.length > 0
  const evidence = hasImages
    ? `<div class="evidence" id="${evId}" hidden>
         <div class="shots">
           ${b.images
             .map(
               (im) =>
                 `<figure><figcaption>${esc(im.label)}</figcaption><img class="shot" loading="lazy" src="${im.file}" data-full="${im.file}" alt="${esc(im.label)}" title="Click to enlarge"></figure>`,
             )
             .join('\n')}
         </div>
       </div>`
    : ''
  const backupToggle = hasImages
    ? `<button class="disclosure" data-target="${evId}">▸ show backup</button>`
    : `<span class="disclosure disabled" title="no harness screenshots yet">▹ evidence pending</span>`

  return `<article class="beat">
    <div class="beat-head">
      <span class="beat-label">${esc(b.label)}</span>
      <span class="beat-title">${esc(b.title)}</span>
      ${statusBadge(b.status)}
    </div>
    ${b.narration ? `<p class="say"><span class="say-tag">SAY</span>${esc(b.narration)}</p>` : ''}
    <div class="beat-body">
      ${b.segments.map(renderSegment).join('\n')}
    </div>
    <div class="beat-foot">${backupToggle}</div>
    ${evidence}
  </article>`
}

const renderSummary = (d: Demo): string => {
  if (d.summary.harnessed) {
    const ok = d.summary.pass === d.summary.total
    const dot = ok ? 'green' : 'red'
    return `<span class="run ${dot}">● ${d.summary.pass}/${d.summary.total} passed · ${Math.round(
      d.summary.durationSec ?? 0,
    )}s · ${fmtWhen(d.summary.finishedAt)}</span>`
  }
  return `<span class="run neutral">○ not yet harnessed</span>`
}

const renderDemo = (d: Demo, active: boolean): string => {
  const backstage = d.resetCmd
    ? `<div class="backstage"><span class="bs-tag">Backstage · not on camera</span><div class="cmd inline"><pre>${esc(
        d.resetCmd,
      )}</pre>${copyBtn(d.resetCmd)}</div><span class="bs-note">reset between takes</span></div>`
    : `<div class="backstage"><span class="bs-tag">Backstage · not on camera</span><span class="bs-note">no reset script — see SCREENPLAY.md for setup</span></div>`

  const explanationBtn = d.explainerSrc
    ? `<button class="layer-toggle" data-explain="${d.id}">▸ show explanation</button>`
    : `<span class="layer-toggle disabled" title="no explainer page for this demo">▹ no explainer</span>`

  const anyImages = d.beats.some((b) => b.images.length > 0)
  const allBackupsBtn = anyImages
    ? `<button class="layer-toggle" data-allbackups="${d.id}">▸ show all backups</button>`
    : `<span class="layer-toggle disabled" title="no harness screenshots yet">▹ backups pending</span>`

  const explanationPanel = d.explainerSrc
    ? `<aside class="explanation-panel" id="${d.id}-explain">
         <div class="ep-head"><span>Explainer · ${esc(d.tab)}</span><button class="ep-close" data-explain-close="${d.id}">✕</button></div>
         <iframe data-src="${d.explainerSrc}" title="${esc(d.tab)} explainer" loading="lazy"></iframe>
       </aside>`
    : ''

  return `<section class="demo${active ? ' active' : ''}" id="demo-${d.id}" data-demo="${d.id}">
    <div class="demo-head">
      <div class="demo-titles">
        <h2>${esc(d.tab)}</h2>
        <p class="gapwow">${inlineMd(d.gapwow)}</p>
      </div>
      <div class="demo-meta">${renderSummary(d)}</div>
    </div>
    ${backstage}
    <div class="demo-toolbar">${explanationBtn}${allBackupsBtn}</div>
    <div class="demo-body" id="${d.id}-body">
      <div class="instructions">
        ${d.beats.map((b, i) => renderBeat(d.id, b, i)).join('\n')}
      </div>
      ${explanationPanel}
    </div>
  </section>`
}

// ---------------------------------------------------------------------------
// page shell
// ---------------------------------------------------------------------------

const buildHtml = (demos: Demo[]): string => {
  const tabs = demos
    .map(
      (d, i) =>
        `<button class="tab${i === 0 ? ' active' : ''}" data-tab="${d.id}"><kbd>${i + 1}</kbd>${esc(d.tab)}</button>`,
    )
    .join('')
  const panels = demos.map((d, i) => renderDemo(d, i === 0)).join('\n')
  const cmdJson = JSON.stringify(CMDS).replace(/</g, '\\u003c')

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live Control · Notion tooling demos</title>
<style>
:root{
  --bg:#f6f7f9; --bg-panel:#ffffff; --bg-subtle:#eef0f3; --bg-code:#0f1115; --code-fg:#e6e6e6;
  --fg:#0b0d10; --fg-muted:#5b636e; --fg-faint:#8b939e; --border:#d9dde3; --border-strong:#c2c8d0;
  --accent:#2f6bff; --accent-fg:#ffffff; --ok:#1a8f3c; --fail:#d33; --neutral:#8b939e; --amber:#b9770e;
  --say-bg:#eaf1ff; --say-fg:#123a8f; --shadow:0 6px 24px rgba(10,14,20,.12);
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0c0e12; --bg-panel:#14171d; --bg-subtle:#1b1f27; --bg-code:#05070a; --code-fg:#e9edf2;
    --fg:#eef1f5; --fg-muted:#9aa3af; --fg-faint:#6b7480; --border:#262b34; --border-strong:#333a45;
    --accent:#5b8bff; --accent-fg:#08122b; --ok:#3ddc74; --fail:#ff6b6b; --neutral:#6b7480; --amber:#e0a94b;
    --say-bg:#132444; --say-fg:#bcd2ff; --shadow:0 8px 30px rgba(0,0,0,.5);
  }
}
:root[data-theme="light"]{
  --bg:#f6f7f9; --bg-panel:#ffffff; --bg-subtle:#eef0f3; --bg-code:#0f1115; --code-fg:#e6e6e6;
  --fg:#0b0d10; --fg-muted:#5b636e; --fg-faint:#8b939e; --border:#d9dde3; --border-strong:#c2c8d0;
  --accent:#2f6bff; --accent-fg:#ffffff; --ok:#1a8f3c; --fail:#d33; --neutral:#8b939e; --amber:#b9770e;
  --say-bg:#eaf1ff; --say-fg:#123a8f; --shadow:0 6px 24px rgba(10,14,20,.12);
}
:root[data-theme="dark"]{
  --bg:#0c0e12; --bg-panel:#14171d; --bg-subtle:#1b1f27; --bg-code:#05070a; --code-fg:#e9edf2;
  --fg:#eef1f5; --fg-muted:#9aa3af; --fg-faint:#6b7480; --border:#262b34; --border-strong:#333a45;
  --accent:#5b8bff; --accent-fg:#08122b; --ok:#3ddc74; --fail:#ff6b6b; --neutral:#6b7480; --amber:#e0a94b;
  --say-bg:#132444; --say-fg:#bcd2ff; --shadow:0 8px 30px rgba(0,0,0,.5);
}
*{box-sizing:border-box}
*{scrollbar-width:thin; scrollbar-color:var(--border-strong) transparent}
html,body{margin:0}
body{
  background:var(--bg); color:var(--fg);
  font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;
}
code,pre,kbd,.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
kbd{
  font-size:11px; padding:1px 5px; border-radius:4px; background:var(--bg-subtle);
  border:1px solid var(--border); color:var(--fg-muted); margin-right:6px;
}

/* header */
header{
  position:sticky; top:0; z-index:20; background:var(--bg-panel);
  border-bottom:1px solid var(--border); padding:10px 20px;
  display:flex; align-items:center; gap:16px;
}
header h1{font-size:15px; font-weight:600; margin:0; letter-spacing:.2px}
header .dot{color:var(--accent)}
header .spacer{flex:1}
header .hint{font-size:12px; color:var(--fg-faint)}
.theme-btn{
  border:1px solid var(--border); background:var(--bg-subtle); color:var(--fg-muted);
  border-radius:6px; padding:4px 10px; font-size:12px; cursor:pointer;
}
.theme-btn:hover{border-color:var(--border-strong); color:var(--fg)}

/* tabs */
.tabs{
  position:sticky; top:41px; z-index:19; display:flex; gap:4px; flex-wrap:wrap;
  padding:8px 20px; background:var(--bg); border-bottom:1px solid var(--border);
}
.tab{
  display:inline-flex; align-items:center; border:1px solid var(--border);
  background:var(--bg-panel); color:var(--fg-muted); border-radius:8px;
  padding:6px 12px; font-size:13px; font-weight:500; cursor:pointer; user-select:none;
}
.tab:hover{border-color:var(--border-strong); color:var(--fg)}
.tab.active{background:var(--accent); color:var(--accent-fg); border-color:var(--accent)}
.tab.active kbd{background:rgba(255,255,255,.18); border-color:transparent; color:inherit}

main{padding:16px 20px 60px}
.demo{display:none}
.demo.active{display:block}

/* demo head */
.demo-head{display:flex; align-items:flex-start; gap:20px; margin-bottom:10px}
.demo-titles{flex:1; min-width:0}
.demo-titles h2{font-size:18px; margin:0 0 3px; font-weight:600}
.gapwow{margin:0; font-size:12.5px; color:var(--fg-muted); max-width:120ch}
.gapwow code{background:var(--bg-subtle); padding:0 4px; border-radius:4px}
.demo-meta{white-space:nowrap; padding-top:3px}
.run{font-size:12.5px; font-weight:600; letter-spacing:.2px; padding:4px 10px; border-radius:20px; border:1px solid var(--border)}
.run.green{color:var(--ok)} .run.red{color:var(--fail)} .run.neutral{color:var(--neutral)}

/* backstage */
.backstage{
  display:flex; align-items:center; gap:10px; flex-wrap:wrap;
  background:var(--bg-subtle); border:1px dashed var(--border-strong);
  border-radius:8px; padding:8px 12px; margin-bottom:10px;
}
.bs-tag{font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.6px; color:var(--amber)}
.bs-note{font-size:12px; color:var(--fg-faint)}

/* toolbar */
.demo-toolbar{margin-bottom:12px; display:flex; gap:8px; flex-wrap:wrap}
.layer-toggle{
  border:1px solid var(--border); background:var(--bg-panel); color:var(--fg-muted);
  border-radius:7px; padding:5px 12px; font-size:12.5px; font-weight:500; cursor:pointer;
}
.layer-toggle:hover:not(.disabled){border-color:var(--accent); color:var(--fg)}
.layer-toggle.disabled{cursor:default; color:var(--fg-faint); border-style:dashed}
.layer-toggle.open{background:var(--accent); color:var(--accent-fg); border-color:var(--accent)}

/* body: full width. instructions view ⇄ explanation view (mode switch, full bleed) */
.demo-body{display:block; min-width:0}
.instructions{min-width:0; display:flex; flex-direction:column; gap:12px}
.demo-body.explain-open .instructions{display:none}
.explanation-panel{display:none}
.demo-body.explain-open .explanation-panel{
  display:flex; flex-direction:column; width:100%;
  height:calc(100vh - 150px); min-height:560px;
  background:var(--bg-panel); border:1px solid var(--border); border-radius:10px;
  overflow:hidden; box-shadow:var(--shadow);
}
.ep-head{display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid var(--border); font-size:12.5px; font-weight:600; color:var(--fg-muted); flex:none}
.ep-close{border:1px solid var(--border); background:var(--bg-subtle); color:var(--fg-muted); font-size:13px; cursor:pointer; padding:3px 10px; border-radius:6px}
.ep-close:hover{background:var(--bg-panel); color:var(--fg)}
.explanation-panel iframe{flex:1; width:100%; border:none; background:#fff; display:block}

/* lightbox for backup screenshots */
.shot{cursor:zoom-in; display:block; width:100%; height:auto}
.lightbox{position:fixed; inset:0; z-index:50; background:rgba(4,6,10,.86); display:flex; align-items:center; justify-content:center; padding:28px}
.lightbox[hidden]{display:none}
.lightbox img{max-width:96vw; max-height:92vh; border-radius:8px; box-shadow:0 24px 70px rgba(0,0,0,.6); background:#fff}
.lb-close{position:fixed; top:16px; right:20px; width:38px; height:38px; border-radius:9px; border:1px solid rgba(255,255,255,.25); background:rgba(255,255,255,.12); color:#fff; font-size:17px; cursor:pointer; display:flex; align-items:center; justify-content:center}
.lb-close:hover{background:rgba(255,255,255,.24)}

/* beat card */
.beat{background:var(--bg-panel); border:1px solid var(--border); border-radius:10px; padding:12px 14px}
.beat-head{display:flex; align-items:center; gap:10px; margin-bottom:8px}
.beat-label{font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.7px; color:var(--fg-faint); white-space:nowrap}
.beat-title{font-size:14.5px; font-weight:600; flex:1; min-width:0}
.badge{width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center; border-radius:50%; font-size:13px; font-weight:700; flex:none}
.badge.ok{background:color-mix(in srgb,var(--ok) 18%,transparent); color:var(--ok)}
.badge.fail{background:color-mix(in srgb,var(--fail) 18%,transparent); color:var(--fail)}
.badge.none{background:var(--bg-subtle); color:var(--neutral)}

/* SAY */
.say{margin:0 0 8px; background:var(--say-bg); color:var(--say-fg); border-radius:7px; padding:7px 10px; font-size:13.5px; line-height:1.4}
.say-tag{font-size:10px; font-weight:700; letter-spacing:.8px; margin-right:8px; padding:1px 6px; border-radius:4px; background:color-mix(in srgb,var(--say-fg) 16%,transparent)}
.say-inline{background:transparent; color:var(--fg-muted); padding:4px 0; font-style:italic}
.say-inline .say-tag{background:var(--bg-subtle); color:var(--fg-faint); font-style:normal}

.beat-body{display:flex; flex-direction:column; gap:8px}
.note{margin:0; font-size:13px; color:var(--fg-muted)}
.note code{background:var(--bg-subtle); padding:0 4px; border-radius:4px; color:var(--fg)}
.note .bullet{color:var(--fg-faint); margin-right:4px}
.note.expect{color:var(--fg); font-weight:500}
.note .arrow{color:var(--accent); font-weight:700; margin-right:2px}

/* command block */
.cmd{position:relative; background:var(--bg-code); border-radius:8px; border:1px solid var(--border-strong)}
.cmd pre{margin:0; padding:11px 44px 11px 13px; overflow-x:auto; color:var(--code-fg); font-size:13px; line-height:1.5; white-space:pre}
.cmd.inline pre{padding:6px 40px 6px 10px}
.cmd.out{border-style:dashed; border-color:var(--fail); background:color-mix(in srgb,var(--fail) 8%,var(--bg-code))}
.cmd.out pre{padding-right:13px; color:#ffb4b4}
.out-tag{display:block; font-size:10px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--fail); padding:6px 13px 0}
.copy{
  position:absolute; top:6px; right:6px; width:30px; height:28px; border-radius:6px;
  border:1px solid rgba(255,255,255,.16); background:rgba(255,255,255,.06); color:#cfd6e0;
  cursor:pointer; font-size:15px; line-height:1; display:inline-flex; align-items:center; justify-content:center;
}
.copy:hover{background:rgba(255,255,255,.14); color:#fff}
.copy.copied{background:var(--ok); color:#fff; border-color:var(--ok)}

/* evidence */
.beat-foot{margin-top:10px}
.disclosure{border:none; background:transparent; color:var(--accent); font-size:12.5px; font-weight:500; cursor:pointer; padding:2px 0}
.disclosure:hover{text-decoration:underline}
.disclosure.disabled{color:var(--fg-faint); cursor:default}
.evidence{margin-top:10px; border-top:1px dashed var(--border); padding-top:10px}
.shots{display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px}
figure{margin:0; border:1px solid var(--border); border-radius:8px; overflow:hidden; background:var(--bg-subtle)}
figcaption{font-size:11px; font-weight:600; color:var(--fg-muted); padding:5px 9px; border-bottom:1px solid var(--border); background:var(--bg-panel)}
figure img{display:block; width:100%; height:auto}
@media (prefers-reduced-motion:reduce){*{transition:none!important; animation:none!important}}
</style>

<header>
  <h1><span class="dot">●</span> Live Control <span style="color:var(--fg-faint);font-weight:400">· Notion tooling demos</span></h1>
  <div class="spacer"></div>
  <span class="hint">keys <kbd>1</kbd>–<kbd>${demos.length}</kbd> switch demo · <kbd>e</kbd> explainer</span>
  <button class="theme-btn" id="theme-btn">◐ theme</button>
</header>

<nav class="tabs">${tabs}</nav>

<main>${panels}</main>

<div class="lightbox" id="lightbox" hidden>
  <button class="lb-close" id="lb-close" aria-label="Close (Esc)">✕</button>
  <img id="lb-img" src="" alt="">
</div>

<script>
window.__CMDS = ${cmdJson};
const TAB_IDS = ${JSON.stringify(demos.map((d) => d.id))};

// ---- click-to-copy (byte-exact from raw array) ----
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy');
  if (!btn) return;
  const raw = window.__CMDS[Number(btn.dataset.cmd)];
  const done = () => { btn.classList.add('copied'); const t=btn.textContent; btn.textContent='✓'; setTimeout(()=>{btn.classList.remove('copied'); btn.textContent=t;},900); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(raw).then(done).catch(()=>fallbackCopy(raw,done));
  } else fallbackCopy(raw, done);
});
function fallbackCopy(text, done){
  const ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{document.execCommand('copy'); done();}catch(_){}
  document.body.removeChild(ta);
}

// ---- URL-encoded UI state (reload-safe, shareable across tabs) ----
// scheme: control.html#demo=<id>&view=instructions|explanation&backups=shown|hidden
const state = { demo: TAB_IDS[0], view: 'instructions', backups: 'hidden' };

function canExplain(id){
  const b=document.querySelector('#demo-'+id+' [data-explain]');
  return !!(b && !b.classList.contains('disabled'));
}
function hasBackups(id){
  const b=document.querySelector('#demo-'+id+' [data-allbackups]');
  return !!(b && !b.classList.contains('disabled'));
}

function readUrl(){
  const p=new URLSearchParams(location.hash.replace(/^#/,''));
  const demo=p.get('demo'); if(TAB_IDS.includes(demo)) state.demo=demo;
  const view=p.get('view'); if(view==='explanation'||view==='instructions') state.view=view;
  const backups=p.get('backups'); if(backups==='shown'||backups==='hidden') state.backups=backups;
}
function writeUrl(){
  const p=new URLSearchParams();
  p.set('demo',state.demo); p.set('view',state.view); p.set('backups',state.backups);
  try{history.replaceState(null,'','#'+p.toString());}catch(_){}
}

function applyState(){
  // normalize against active demo capabilities
  if(state.view==='explanation' && !canExplain(state.demo)) state.view='instructions';
  // tabs + panels
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===state.demo));
  document.querySelectorAll('.demo').forEach(d=>d.classList.toggle('active', d.dataset.demo===state.demo));
  // reset every demo body, then apply to the active one
  document.querySelectorAll('.demo-body').forEach(b=>b.classList.remove('explain-open'));
  const demoEl=document.getElementById('demo-'+state.demo);
  const body=document.getElementById(state.demo+'-body');
  // explanation view (full-bleed) — lazy-load iframe on first open
  const explanationOn = state.view==='explanation';
  if(explanationOn){
    body.classList.add('explain-open');
    const iframe=demoEl.querySelector('.explanation-panel iframe');
    if(iframe && !iframe.src && iframe.dataset.src) iframe.src=iframe.dataset.src;
  }
  const eBtn=demoEl.querySelector('[data-explain]');
  if(eBtn && !eBtn.classList.contains('disabled')){ eBtn.classList.toggle('open',explanationOn); eBtn.textContent=explanationOn?'▾ hide explanation':'▸ show explanation'; }
  // master backups — active demo
  const show = state.backups==='shown';
  demoEl.querySelectorAll('.evidence').forEach(ev=>{ ev.hidden=!show; });
  demoEl.querySelectorAll('.disclosure[data-target]').forEach(d=>{ d.textContent = show?'▾ hide backup':'▸ show backup'; });
  const aBtn=demoEl.querySelector('[data-allbackups]');
  if(aBtn && !aBtn.classList.contains('disabled')){ aBtn.classList.toggle('open',show); aBtn.textContent = show?'▾ hide all backups':'▸ show all backups'; }
}
function commit(){ applyState(); writeUrl(); }

// ---- tabs ----
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{ state.demo=t.dataset.tab; commit(); }));

// ---- explanation toggle (button, close, and 'e' key) ----
function toggleExplain(){ if(!canExplain(state.demo))return; state.view = state.view==='explanation'?'instructions':'explanation'; commit(); }
document.querySelectorAll('[data-explain]').forEach(b=>{ if(b.classList.contains('disabled'))return; b.addEventListener('click',toggleExplain); });
document.querySelectorAll('[data-explain-close]').forEach(b=>b.addEventListener('click',()=>{ state.view='instructions'; commit(); }));

// ---- master backups toggle ----
document.querySelectorAll('[data-allbackups]').forEach(b=>{ if(b.classList.contains('disabled'))return; b.addEventListener('click',()=>{ state.backups = state.backups==='shown'?'hidden':'shown'; commit(); }); });

// ---- per-beat disclosure (local; does not touch URL master state) ----
document.addEventListener('click',(e)=>{
  const d=e.target.closest('.disclosure'); if(!d||d.classList.contains('disabled')||!d.dataset.target)return;
  const el=document.getElementById(d.dataset.target); if(!el)return;
  const open=el.hidden; el.hidden=!open; d.textContent=(open?'▾ hide backup':'▸ show backup');
});

// ---- lightbox for backup screenshots (in-page modal, no navigation) ----
const lb=document.getElementById('lightbox'), lbImg=document.getElementById('lb-img');
function openLb(src){ lbImg.src=src; lb.hidden=false; }
function closeLb(){ lb.hidden=true; lbImg.src=''; }
document.addEventListener('click',(e)=>{ const s=e.target.closest('.shot'); if(s){ openLb(s.dataset.full); } });
lb.addEventListener('click',(e)=>{ if(e.target===lb||e.target.id==='lb-close') closeLb(); });

// ---- keyboard: 1..N tabs, e explainer, Esc closes lightbox ----
document.addEventListener('keydown',(e)=>{
  if(e.key==='Escape' && !lb.hidden){ closeLb(); return; }
  if(e.metaKey||e.ctrlKey||e.altKey)return;
  const tag=(e.target.tagName||'').toLowerCase();
  if(tag==='input'||tag==='textarea')return;
  const n=parseInt(e.key,10);
  if(n>=1 && n<=TAB_IDS.length){ state.demo=TAB_IDS[n-1]; commit(); return; }
  if(e.key==='e'){ toggleExplain(); }
});

// ---- theme toggle ----
document.getElementById('theme-btn').addEventListener('click',()=>{
  const cur=document.documentElement.getAttribute('data-theme');
  const sysDark=matchMedia('(prefers-color-scheme:dark)').matches;
  const next=cur? (cur==='dark'?'light':'dark') : (sysDark?'light':'dark');
  document.documentElement.setAttribute('data-theme',next);
});

// ---- init from URL ----
readUrl();
applyState();
writeUrl();
window.addEventListener('hashchange',()=>{ readUrl(); applyState(); writeUrl(); });
</script>`
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const demos = buildDemos()
const html = buildHtml(demos)
writeFileSync(OUT, html)
console.log(`wrote ${OUT}`)
console.log(`  demos: ${demos.map((d) => `${d.id}(${d.beats.length} beats)`).join(', ')}`)
console.log(`  commands registered: ${CMDS.length}`)
const mdDemo = demos.find((d) => d.id === 'md')!
console.log(`  md harnessed: ${mdDemo.summary.harnessed} ${mdDemo.summary.pass}/${mdDemo.summary.total}`)
