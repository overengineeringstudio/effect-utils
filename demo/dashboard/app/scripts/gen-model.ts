#!/usr/bin/env bun
/**
 * Build-time SCREENPLAY → typed model codegen.
 *
 * Reads the 4 real per-demo SCREENPLAY.md files and runs the PURE parser in
 * demo/dashboard/screenplay.ts (`parseBeatsRaw` — the raw-text model, so the
 * React app does escaping + inline-markdown in JSX, not HTML strings). Emits
 * src/model.gen.ts. The browser never sees .md or the parser — only the data.
 *
 * Evidence/status parity with demo/dashboard/build.ts (the live control.html
 * generator): the md demo is enriched from the latest md evidence timeline.json
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

// Same demo registry as build.ts (tab labels + explainer siblings).
const DEMO_DEFS: { id: string; dir: string; tab: string; explainer: string | null }[] = [
  { id: 'md', dir: 'md', tab: 'notion md', explainer: 'notion-md.html' },
  { id: 'sqlite', dir: 'sqlite', tab: 'notion sqlite', explainer: 'notion-sqlite.html' },
  { id: 'schema', dir: 'schema', tab: 'notion schema', explainer: 'notion-schema.html' },
  { id: 'react', dir: 'react', tab: 'notion-react', explainer: 'notion-react.html' },
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
type ModelBeat = RawBeat & { status: 'pass' | 'fail' | 'none'; images: Shot[] }

interface DemoModel {
  id: string
  tab: string
  gapwow: string
  resetCmd: string | null
  explainerSrc: string | null
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
    const beats: ModelBeat[] = rawBeats.map((b) => {
      const status =
        def.id === 'md' && b.num && b.num in mdStatusByNum ? mdStatusByNum[b.num]! : ('none' as const)
      const images = def.id === 'md' && b.num && mdImages[b.num] ? mdImages[b.num]! : []
      return { ...b, status, images }
    })

    const summary: Summary =
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
      // explainerSrc stays a plain RELATIVE sibling ref (served next to control.next.html);
      // Vite must never try to bundle it.
      explainerSrc: def.explainer,
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
  status: 'pass' | 'fail' | 'none'
  images: Shot[]
}

export interface Summary {
  harnessed: boolean
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
