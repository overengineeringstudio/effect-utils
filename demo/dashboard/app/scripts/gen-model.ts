#!/usr/bin/env bun
/**
 * Build-time SCREENPLAY → typed model codegen.
 *
 * Reads the 4 real per-demo SCREENPLAY.md files and runs the PURE parser in
 * demo/dashboard/screenplay.ts (`parseBeatsRaw` — the raw-text model, so the
 * React app does escaping + inline-markdown in JSX, not HTML strings). Emits
 * src/model.gen.ts. The browser never sees .md or the parser — only the data.
 *
 * Evidence/status: the md demo is enriched from the latest md evidence timeline.json
 * (per-beat pass/fail + run summary) and the globbed md-evidence/*.png backups
 * (bucketed per beat, terminal-first). Non-md demos carry no status/images and
 * render the "not yet harnessed" / "evidence pending" affordances.
 *
 * Invoked by the Vite plugin (buildStart, dev + build) and runnable standalone:
 *   bun run scripts/gen-model.ts
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findResetCmd, parseBeatsRaw, parseGapWow, type RawBeat } from '../../screenplay.ts'

const HERE = dirname(fileURLToPath(import.meta.url)) // demo/dashboard/app/scripts
const APP = join(HERE, '..') // demo/dashboard/app
const DEMO_ROOT = join(APP, '..', '..') // demo/
const EXPLAINERS = join(DEMO_ROOT, 'explainers')

// Demo registry. Unlike build.ts's flat list, tab numbering is EXPLICIT here
// (`displayNum`) — never derived from array index — because the schema group
// splits into sub-numbered members 3.1/3.2. `groupId`/`groupLabel` cluster the
// two schema members in the nav; `planned` marks aspirational (not-yet-built)
// demos; `evidence: 'mock'` marks illustrative demos with no harness timeline.
interface DemoDef {
  id: string
  dir: string
  tab: string
  explainer: string | null
  displayNum: string // "1","2","3.1","3.2","4" — authoritative tab number
  groupId?: string // members sharing a groupId render clustered in the nav
  groupLabel?: string // human label for the group (e.g. "notion schema")
  planned?: boolean // aspirational demo: renders a prominent PLANNED banner + badge
  evidence?: 'mock' // illustrative demo (no harness); beats render as mock, not pass/fail
}

const DEMO_DEFS: DemoDef[] = [
  { id: 'md', dir: 'md', tab: 'notion md', explainer: null, displayNum: '1' },
  { id: 'sqlite', dir: 'sqlite', tab: 'notion sqlite', explainer: null, displayNum: '2' },
  {
    id: 'schema',
    dir: 'schema',
    tab: 'notion schema',
    explainer: null,
    displayNum: '3.1',
    groupId: 'schema',
    groupLabel: 'notion schema',
  },
  {
    id: 'schema-iac',
    dir: 'schema-iac',
    tab: 'notion schema apply',
    explainer: null,
    displayNum: '3.2',
    groupId: 'schema',
    groupLabel: 'notion schema',
    planned: true,
    evidence: 'mock',
  },
  { id: 'react', dir: 'react', tab: 'notion-react', explainer: null, displayNum: '4' },
]

// ---------------------------------------------------------------------------
// evidence / status — mirrors build.ts loadMdTimeline() + bucketMdImages()
// ---------------------------------------------------------------------------

interface Shot {
  file: string
  surface: string
  label: string
}

interface Summary {
  harnessed: boolean
  mock?: boolean // illustrative demo (no harness run) — renders "illustrative · not harnessed"
  pass: number
  total: number
  durationSec?: number
  finishedAt?: string
}

// The latest MAIN md demo run (demoId "md"); ignore "md-merge-proof" appendix runs.
const loadMdTimeline = (): {
  passCount?: number
  failCount?: number
  durationSec?: number
  finishedAt?: string
  beats?: { id: string; pass: boolean }[]
} | null => {
  const evDir = join(DEMO_ROOT, 'md', 'evidence')
  if (!existsSync(evDir)) return null
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

// Glob md-evidence/*.png, bucket per beat number, terminal-first.
const bucketMdImages = (): Record<string, Shot[]> => {
  const dir = join(EXPLAINERS, 'md-evidence')
  const out: Record<string, Shot[]> = {}
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
  for (const k of Object.keys(out)) {
    out[k]!.sort((a, b) => (a.surface === b.surface ? 0 : a.surface === 'terminal' ? -1 : 1))
  }
  return out
}

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

// A RawBeat enriched with the harness-derived status + backup screenshots.
type ModelBeat = RawBeat & { status: 'pass' | 'fail' | 'none' | 'mock'; images: Shot[] }

interface DemoModel {
  id: string
  tab: string
  gapwow: string
  resetCmd: string | null
  explainerSrc: string | null
  displayNum: string // "1","2","3.1","3.2","4" — authoritative tab number (NOT array index)
  groupId?: string // members sharing a groupId cluster in the nav (e.g. "schema")
  groupLabel?: string // human label for the group (e.g. "notion schema")
  planned?: boolean // aspirational demo: renders a prominent PLANNED banner + nav badge
  beats: ModelBeat[]
  summary: Summary
}

export const buildModel = (): DemoModel[] => {
  const timeline = loadMdTimeline()
  const mdImages = bucketMdImages()
  const mdStatusByNum: Record<string, 'pass' | 'fail'> = {}
  if (timeline) {
    for (const b of timeline.beats ?? []) {
      const m = String(b.id).match(/beat(\d+)/)
      if (m) mdStatusByNum[m[1]!] = b.pass ? 'pass' : 'fail'
    }
  }

  return DEMO_DEFS.map((def) => {
    const md = readFileSync(join(DEMO_ROOT, def.dir, 'SCREENPLAY.md'), 'utf8')
    const rawBeats = parseBeatsRaw(md)
    const isMock = def.evidence === 'mock'
    const beats: ModelBeat[] = rawBeats.map((b) => {
      // Illustrative demos carry a distinct 'mock' status on every beat — never
      // harness pass/fail. md is driven by its timeline; others are 'none'.
      const status: ModelBeat['status'] = isMock
        ? 'mock'
        : def.id === 'md' && b.num && b.num in mdStatusByNum
          ? mdStatusByNum[b.num]!
          : 'none'
      const images = def.id === 'md' && b.num && mdImages[b.num] ? mdImages[b.num]! : []
      return { ...b, status, images }
    })

    const summary: Summary = isMock
      ? { harnessed: false, mock: true, pass: 0, total: 0 }
      : def.id === 'md' && timeline
        ? {
            harnessed: true,
            pass: timeline.passCount ?? 0,
            total: (timeline.passCount ?? 0) + (timeline.failCount ?? 0),
            durationSec: timeline.durationSec,
            finishedAt: timeline.finishedAt,
          }
        : { harnessed: false, pass: 0, total: 0 }

    // explainerSrc: legacy field — the explainers now render inline as React
    // components (registry.tsx in dashboard/explainers/src), NOT as standalone
    // HTML files, so `def.explainer` is null and this resolves to null. Kept in
    // the emitted model for shape stability; consumed nowhere in the app.
    const explainerSrc = def.explainer && existsSync(join(EXPLAINERS, def.explainer)) ? def.explainer : null

    return {
      id: def.id,
      tab: def.tab,
      gapwow: parseGapWow(md),
      resetCmd: findResetCmd(md),
      explainerSrc,
      displayNum: def.displayNum,
      ...(def.groupId ? { groupId: def.groupId } : {}),
      ...(def.groupLabel ? { groupLabel: def.groupLabel } : {}),
      ...(def.planned ? { planned: true } : {}),
      beats,
      summary,
    }
  })
}

export const genModel = (): void => {
  const demos = buildModel()
  const out = `// GENERATED by scripts/gen-model.ts — do not edit. Source: demo/{md,sqlite,schema,react}/SCREENPLAY.md
import type { RawSegment } from '../../screenplay.ts'

export interface Shot {
  file: string
  surface: string
  label: string
}

export interface ModelBeat {
  num: string | null
  label: string
  title: string
  narration: string
  segments: RawSegment[]
  status: 'pass' | 'fail' | 'none' | 'mock'
  images: Shot[]
}

export interface Summary {
  harnessed: boolean
  mock?: boolean // illustrative demo (no harness run) — renders "illustrative · not harnessed"
  pass: number
  total: number
  durationSec?: number
  finishedAt?: string
}

export interface DemoModel {
  id: string
  tab: string
  gapwow: string
  resetCmd: string | null
  explainerSrc: string | null
  displayNum: string // "1","2","3.1","3.2","4" — authoritative tab number (NOT array index)
  groupId?: string // members sharing a groupId cluster in the nav (e.g. "schema")
  groupLabel?: string // human label for the group (e.g. "notion schema")
  planned?: boolean // aspirational demo: renders a prominent PLANNED banner + nav badge
  beats: ModelBeat[]
  summary: Summary
}

export const DEMOS: DemoModel[] = ${JSON.stringify(demos, null, 2)}
`
  writeFileSync(join(APP, 'src', 'model.gen.ts'), out)
}

// Run when invoked directly (bun run scripts/gen-model.ts)
if (import.meta.main) {
  genModel()
  const demos = buildModel()
  console.log(`gen-model: ${demos.map((d) => `${d.id}(${d.beats.length} beats)`).join(', ')}`)
  const mdDemo = demos.find((d) => d.id === 'md')!
  console.log(`  md harnessed: ${mdDemo.summary.harnessed} ${mdDemo.summary.pass}/${mdDemo.summary.total}`)
}
