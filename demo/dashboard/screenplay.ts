/**
 * SCREENPLAY.md parser + typed model.
 *
 * Pure string work: turns a per-demo SCREENPLAY.md into the typed `Beat`/`Segment`
 * model the control-dashboard renderer consumes. The evidence/summary fields on
 * `Demo`/`Beat` are populated downstream by build.ts from the md evidence timeline;
 * this module only fills the pure-parse fields.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Segment =
  | { kind: 'prose'; html: string; isExpectation: boolean }
  | { kind: 'code'; raw: string }
  | { kind: 'say'; text: string }

export interface Beat {
  num: string | null // "0","1",… or null (Bonus)
  label: string // "Beat 0", "Bonus"
  title: string // "Start the watcher"
  narration: string // heading SAY
  segments: Segment[]
  status: 'pass' | 'fail' | 'none'
  images: { file: string; surface: string; label: string }[]
}

export interface Demo {
  id: string
  tab: string
  gapwow: string
  resetCmd: string | null
  explainerSrc: string | null
  beats: Beat[]
  summary: { harnessed: boolean; pass: number; total: number; durationSec?: number; finishedAt?: string }
}

// ---------------------------------------------------------------------------
// tiny inline-markdown → html (escape first, then bold/code)
// ---------------------------------------------------------------------------

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const inlineMd = (line: string): string => {
  let bulleted = false
  let s = line
  if (/^\s*-\s+/.test(s)) {
    bulleted = true
    s = s.replace(/^\s*-\s+/, '')
  }
  s = esc(s)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  return bulleted ? `<span class="bullet">•</span> ${s}` : s
}

// ---------------------------------------------------------------------------
// screenplay parser
// ---------------------------------------------------------------------------

export const parseBeats = (md: string): Beat[] => {
  const lines = md.split('\n')
  const beats: Beat[] = []
  let i = 0

  // find beat headings: "### … say: …" (case-insensitive say)
  while (i < lines.length) {
    const line = lines[i]!
    const isHeading = /^###\s+/.test(line)
    if (isHeading && /say:/i.test(line)) {
      const head = line.replace(/^###\s+/, '')
      const sayIdx = head.search(/say:/i)
      const left = head.slice(0, sayIdx).trim()
      const right = head.slice(sayIdx + 4).trim()
      // narration: prefer quoted string, else the whole remainder
      const q = right.match(/[“"]([^”"]+)[”"]/)
      const narration = q ? q[1]! : right.replace(/^[“"]|[”"]$/g, '').trim()
      // label / title from left, e.g. "Beat 0 — Start the watcher"
      const numMatch = left.match(/^Beat\s+(\d+)/i)
      const bonusMatch = /^Bonus/i.test(left)
      const num = numMatch ? numMatch[1]! : null
      const label = numMatch ? `Beat ${numMatch[1]}` : bonusMatch ? 'Bonus' : left.split('—')[0]!.trim()
      const dashIdx = left.indexOf('—')
      const title = dashIdx >= 0 ? left.slice(dashIdx + 1).trim() : left.replace(/^Beat\s+\d+/i, '').trim()

      // collect body until next ### or ## or EOF
      const body: string[] = []
      i++
      while (i < lines.length && !/^#{2,3}\s+/.test(lines[i]!)) {
        body.push(lines[i]!)
        i++
      }
      beats.push({ num, label, title, narration: narration ?? '', segments: parseBody(body), status: 'none', images: [] })
      continue
    }
    i++
  }
  return beats
}

const parseBody = (body: string[]): Segment[] => {
  const segs: Segment[] = []
  let proseBuf: string[] = []
  const flushProse = () => {
    if (proseBuf.length === 0) return
    const html = proseBuf.map(inlineMd).join('<br>')
    segs.push({ kind: 'prose', html, isExpectation: false })
    proseBuf = []
  }

  let inCode = false
  let codeBuf: string[] = []
  for (const rawLine of body) {
    const fence = /^\s*```/.test(rawLine)
    if (fence) {
      if (!inCode) {
        flushProse()
        inCode = true
        codeBuf = []
      } else {
        inCode = false
        segs.push({ kind: 'code', raw: codeBuf.join('\n') })
      }
      continue
    }
    if (inCode) {
      codeBuf.push(rawLine)
      continue
    }
    // secondary narration lines (sqlite b3, schema b4)
    if (/^\s*say:/i.test(rawLine)) {
      flushProse()
      const t = rawLine.replace(/^\s*say:\s*/i, '').replace(/^[“"]|[”"]$/g, '').trim()
      segs.push({ kind: 'say', text: t })
      continue
    }
    if (rawLine.trim() === '') {
      flushProse()
      continue
    }
    proseBuf.push(rawLine)
  }
  flushProse()

  // mark expectation: any prose segment with NO code segment after it
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k]!
    if (seg.kind !== 'prose') continue
    const hasCodeAfter = segs.slice(k + 1).some((s) => s.kind === 'code')
    seg.isExpectation = !hasCodeAfter
  }
  return segs
}

// ---------------------------------------------------------------------------
// RAW model (additive) — for React renderers that want raw text, not HTML.
//
// The `parseBeats`/`inlineMd`/`esc` path above emits PRE-ESCAPED HTML strings
// (`Segment.prose.html`) tailored to build.ts's string-concat renderer. A React
// app instead wants the RAW prose lines and does escaping + inline-markdown in
// JSX. `parseBeatsRaw` mirrors the same parse but carries raw text; it does NOT
// change any existing export's behavior. build.ts is untouched by this.
// ---------------------------------------------------------------------------

// Fence info-strings that denote NON-copyable "expected output" (not a runnable
// command): ```output / ```console / ```keys / ```text. A code segment tagged
// with one of these renders as expected-output with no copy affordance.
const NO_COPY_LANGS = new Set(['output', 'console', 'keys', 'text'])

// Legacy fallback so screenplays authored before info-strings don't regress:
// a fenced block whose every non-empty line is an `Error:` line is output
// (e.g. sqlite Beat 3's typed refusals — that file has no info-string yet).
const isErrorOnlyBlock = (raw: string): boolean => {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.length > 0 && lines.every((l) => /^Error:/.test(l))
}

export type RawSegment =
  | { kind: 'prose'; lines: string[]; isExpectation: boolean } // raw lines, inline-md rendered in JSX
  | { kind: 'code'; raw: string; lang?: string; noCopy?: boolean } // lang = fence info-string; noCopy derived
  | { kind: 'say'; text: string }

export interface RawBeat {
  num: string | null
  label: string
  title: string
  narration: string
  segments: RawSegment[]
}

const parseBodyRaw = (body: string[]): RawSegment[] => {
  const segs: RawSegment[] = []
  let proseBuf: string[] = []
  const flushProse = () => {
    if (proseBuf.length === 0) return
    segs.push({ kind: 'prose', lines: proseBuf, isExpectation: false })
    proseBuf = []
  }

  let inCode = false
  let codeBuf: string[] = []
  let codeLang = '' // fence info-string of the currently-open block
  for (const rawLine of body) {
    const fenceMatch = rawLine.match(/^\s*```\s*([^\s`]*)/)
    if (fenceMatch) {
      if (!inCode) {
        flushProse()
        inCode = true
        codeBuf = []
        codeLang = fenceMatch[1] ?? '' // e.g. "output", "sh", "" (bare fence)
      } else {
        inCode = false
        const raw = codeBuf.join('\n')
        const lang = codeLang.toLowerCase()
        const noCopy = NO_COPY_LANGS.has(lang) || isErrorOnlyBlock(raw)
        segs.push({
          kind: 'code',
          raw,
          ...(lang ? { lang } : {}),
          ...(noCopy ? { noCopy: true } : {}),
        })
      }
      continue
    }
    if (inCode) {
      codeBuf.push(rawLine)
      continue
    }
    if (/^\s*say:/i.test(rawLine)) {
      flushProse()
      const t = rawLine.replace(/^\s*say:\s*/i, '').replace(/^[“"]|[”"]$/g, '').trim()
      segs.push({ kind: 'say', text: t })
      continue
    }
    if (rawLine.trim() === '') {
      flushProse()
      continue
    }
    proseBuf.push(rawLine)
  }
  flushProse()

  // expectation: any prose segment with NO code segment after it (same rule as parseBody)
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k]!
    if (seg.kind !== 'prose') continue
    const hasCodeAfter = segs.slice(k + 1).some((s) => s.kind === 'code')
    seg.isExpectation = !hasCodeAfter
  }
  return segs
}

export const parseBeatsRaw = (md: string): RawBeat[] => {
  const lines = md.split('\n')
  const beats: RawBeat[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const isHeading = /^###\s+/.test(line)
    if (isHeading && /say:/i.test(line)) {
      const head = line.replace(/^###\s+/, '')
      const sayIdx = head.search(/say:/i)
      const left = head.slice(0, sayIdx).trim()
      const right = head.slice(sayIdx + 4).trim()
      const q = right.match(/[“"]([^”"]+)[”"]/)
      const narration = q ? q[1]! : right.replace(/^[“"]|[”"]$/g, '').trim()
      const numMatch = left.match(/^Beat\s+(\d+)/i)
      const bonusMatch = /^Bonus/i.test(left)
      const num = numMatch ? numMatch[1]! : null
      const label = numMatch ? `Beat ${numMatch[1]}` : bonusMatch ? 'Bonus' : left.split('—')[0]!.trim()
      const dashIdx = left.indexOf('—')
      const title = dashIdx >= 0 ? left.slice(dashIdx + 1).trim() : left.replace(/^Beat\s+\d+/i, '').trim()

      const body: string[] = []
      i++
      while (i < lines.length && !/^#{2,3}\s+/.test(lines[i]!)) {
        body.push(lines[i]!)
        i++
      }
      beats.push({ num, label, title, narration: narration ?? '', segments: parseBodyRaw(body) })
      continue
    }
    i++
  }
  return beats
}

export const parseGapWow = (md: string): string => {
  // first non-heading paragraph (the "Gap: … Wow: …" line)
  const lines = md.split('\n')
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]!.trim()
    if (l.startsWith('#') || l === '') continue
    // gather until blank
    const buf = [l]
    let j = k + 1
    while (j < lines.length && lines[j]!.trim() !== '' && !lines[j]!.startsWith('#')) {
      buf.push(lines[j]!.trim())
      j++
    }
    return buf.join(' ')
  }
  return ''
}

export const findResetCmd = (md: string): string | null => {
  const m = md.match(/(\.\/demo\/[\w-]+\/reset\.sh)/)
  return m ? m[1]! : null
}
