import { useEffect, useRef, useState } from 'react'

import type { RawSegment } from '../../screenplay.ts'
import { fallbackCopy } from './clipboard.ts'
import { EXPLAINER_BY_ID, canExplain } from './explainers.ts'
import { InlineMd } from './inline-md.tsx'
import { type DemoModel, type ModelBeat, type Shot } from './model.gen.ts'

// A code segment is expected program OUTPUT (not a runnable command), so it gets
// NO copy affordance, when the model marked it `noCopy` — set in the parser from
// the fence info-string (```output/```console/```keys/```text) OR the legacy
// `^Error:`-only fallback. The `isOutputBlock` fallback below re-applies that
// legacy rule at render time so any un-flagged pre-info-string block still works.
const isOutputBlock = (raw: string): boolean => {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.length > 0 && lines.every((l) => /^Error:/.test(l))
}

// Resolve the no-copy decision for a code segment: trust the model flag, but
// fall back to the legacy heuristic so nothing regresses if a block predates it.
const isNoCopy = (seg: Extract<RawSegment, { kind: 'code' }>): boolean =>
  seg.noCopy ?? isOutputBlock(seg.raw)

// ---------------------------------------------------------------------------
// click-to-copy (byte-exact from the raw model string — never DOM text)
// ---------------------------------------------------------------------------

// `overlay` = absolutely-positioned button pinned inside a code block (default,
// used by every command <pre>). `inline` = a small in-flow button for tight
// chips (e.g. the compact backstage reset). Copy behavior is identical — always
// byte-exact from the raw model string.
const CopyButton = ({
  raw,
  variant = 'overlay',
}: {
  raw: string
  variant?: 'overlay' | 'inline'
}) => {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onClick = () => {
    const done = () => {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 900)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(raw)
        .then(done)
        .catch(() => fallbackCopy(raw, done))
    } else fallbackCopy(raw, done)
  }
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  const shape =
    variant === 'overlay'
      ? 'absolute right-1.5 top-1.5 h-7 w-[30px] text-[15px]'
      : 'h-6 w-6 flex-none text-[13px]'
  return (
    <button
      type="button"
      onClick={onClick}
      title="Copy to clipboard"
      aria-label="Copy command"
      className={
        `inline-flex cursor-pointer items-center justify-center rounded-md border leading-none ${shape} ` +
        (copied
          ? 'border-ok bg-ok text-white'
          : 'border-border bg-bg-panel text-fg-muted hover:border-border-strong hover:text-fg')
      }
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}

// ---------------------------------------------------------------------------
// segment renderer (raw model → JSX; escaping + inline-md done in JSX)
// ---------------------------------------------------------------------------

const CodeSegment = ({ seg }: { seg: Extract<RawSegment, { kind: 'code' }> }) => {
  const raw = seg.raw
  if (isNoCopy(seg)) {
    return (
      <div className="rounded-lg border border-border bg-bg-code">
        <span className="block px-3 pt-1.5 text-[11px] text-fg-muted">Expected output</span>
        <pre className="m-0 overflow-x-auto whitespace-pre px-3 pb-2.5 font-mono text-[13px] leading-normal text-code-fg">
          {raw}
        </pre>
      </div>
    )
  }
  return (
    <div className="relative rounded-lg border border-border-strong bg-bg-code">
      <pre className="m-0 overflow-x-auto whitespace-pre py-2.5 pl-3 pr-11 font-mono text-[13px] leading-normal text-code-fg">
        {raw}
      </pre>
      <CopyButton raw={raw} />
    </div>
  )
}

const Segment = ({ seg }: { seg: RawSegment }) => {
  if (seg.kind === 'code') return <CodeSegment seg={seg} />
  if (seg.kind === 'say') {
    return (
      <div className="flex items-start gap-2 rounded-md bg-say-bg px-2.5 py-2 text-[13.5px] text-say-fg">
        <span aria-hidden="true" className="mt-[1px] flex-none text-[13px] leading-none">
          💬
        </span>
        <p className="m-0">{seg.text}</p>
      </div>
    )
  }
  const isExpect = seg.isExpectation
  return (
    <p className={isExpect ? 'text-[13px] font-medium text-fg' : 'text-[13px] text-fg-muted'}>
      {isExpect && <span className="mr-0.5 font-bold text-accent">→ </span>}
      {seg.lines.map((line, i) => (
        <span key={i}>
          {i > 0 && <br />}
          <InlineMd line={line} />
        </span>
      ))}
    </p>
  )
}

// ---------------------------------------------------------------------------
// status badge + summary pill
// ---------------------------------------------------------------------------

const StatusBadge = ({ status }: { status: ModelBeat['status'] }) => {
  const base =
    'inline-flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full text-[13px] font-bold'
  if (status === 'pass')
    return (
      <span title="passed in latest harness run" className={`${base} bg-ok/15 text-ok`}>
        ✓
      </span>
    )
  if (status === 'fail')
    return (
      <span title="failed in latest harness run" className={`${base} bg-fail/15 text-fail`}>
        ✗
      </span>
    )
  if (status === 'mock')
    return (
      <span
        title="illustrative / mock — not harnessed"
        className={`${base} bg-amber/15 text-amber`}
      >
        ◆
      </span>
    )
  return (
    <span title="not yet harnessed" className={`${base} bg-bg-subtle text-neutral`}>
      ○
    </span>
  )
}

// ---------------------------------------------------------------------------
// beat card
// ---------------------------------------------------------------------------

const BeatCard = ({
  beat,
  open,
  onToggle,
  onShot,
}: {
  beat: ModelBeat
  open: boolean
  onToggle: () => void
  onShot: (src: string) => void
}) => {
  const hasImages = beat.images.length > 0
  return (
    <article className="border-t border-border py-4">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="whitespace-nowrap text-[11px] text-fg-faint">{beat.label}</span>
        <span className="min-w-0 flex-1 text-[14.5px] font-semibold">{beat.title}</span>
        <StatusBadge status={beat.status} />
      </div>
      {beat.narration && (
        <div className="mb-2 flex items-start gap-2 rounded-md bg-say-bg px-2.5 py-2 text-[13.5px] text-say-fg">
          <span aria-hidden="true" className="mt-[1px] flex-none text-[13px] leading-none">
            💬
          </span>
          <p className="m-0">{beat.narration}</p>
        </div>
      )}
      <div className="flex flex-col gap-2">
        {beat.segments.map((seg, j) => (
          <Segment key={j} seg={seg} />
        ))}
      </div>
      <div className="mt-2.5">
        {hasImages ? (
          <button
            type="button"
            onClick={onToggle}
            className="cursor-pointer border-none bg-transparent p-0 text-[12.5px] font-medium text-accent hover:underline"
          >
            {open ? '▾ hide backup' : '▸ show backup'}
          </button>
        ) : (
          <span
            title="no harness screenshots yet"
            className="text-[12.5px] font-medium text-fg-faint"
          >
            ▹ evidence pending
          </span>
        )}
      </div>
      {hasImages && open && (
        <div className="mt-2.5 border-t border-dashed border-border pt-2.5">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {beat.images.map((im: Shot, k) => (
              <figure
                key={k}
                className="m-0 overflow-hidden rounded-lg border border-border bg-bg-subtle"
              >
                <figcaption className="border-b border-border bg-bg-panel px-2.5 py-1.5 text-[11px] font-semibold text-fg-muted">
                  {im.label}
                </figcaption>
                <img
                  loading="lazy"
                  src={im.file}
                  alt={im.label}
                  title="Click to enlarge"
                  onClick={() => onShot(im.file)}
                  className="block h-auto w-full cursor-zoom-in"
                />
              </figure>
            ))}
          </div>
        </div>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------
// (The former ExplainerFrame iframe + scrollHeight auto-height machinery was
// removed: explainers now render INLINE as React components — see EXPLAINER_BY_ID
// and the `.explainer-root` embed in DemoSection below. No iframe, no .next.html.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// demo section — one per demo, ALL kept mounted (build.ts renders every
// `<section class="demo">` and toggles display, so explainer iframes load once
// and never re-fetch on reopen/switch). Only the active section is visible.
// ---------------------------------------------------------------------------

export const DemoSection = ({
  d,
  active,
  explainOpen,
  openBeats,
  onToggleExplain,
  onCloseExplain,
  onToggleBeat,
  onShot,
}: {
  d: DemoModel
  active: boolean
  explainOpen: boolean
  openBeats: Record<string, boolean>
  onToggleExplain: () => void
  onCloseExplain: () => void
  onToggleBeat: (key: string) => void
  onShot: (src: string) => void
}) => {
  const canExp = canExplain(d)
  const Explainer = EXPLAINER_BY_ID[d.id]
  return (
    <section hidden={!active}>
      {/* Planned/mock demos (e.g. 3.2) stay labelled per-beat via StatusBadge
          'mock' + narrated mock output (R8); the former heavy amber banner was
          removed per design feedback. */}
      {/* view switcher — Explanation ⇄ Instructions, Notion-native underline tabs.
          Explanation is first because it's the default view (see readUrl). */}
      {canExp && (
        <div className="mb-4 flex items-center gap-1 border-b border-border text-[13px]">
          <button
            type="button"
            onClick={() => {
              if (!explainOpen) onToggleExplain()
            }}
            className={
              explainOpen
                ? '-mb-px border-b-2 border-accent px-3 py-2 font-medium text-fg'
                : '-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-fg-muted hover:text-fg'
            }
          >
            Explanation
          </button>
          <button
            type="button"
            onClick={() => {
              if (explainOpen) onCloseExplain()
            }}
            className={
              explainOpen
                ? '-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-fg-muted hover:text-fg'
                : '-mb-px border-b-2 border-accent px-3 py-2 font-medium text-fg'
            }
          >
            Instructions
          </button>
        </div>
      )}

      {/* body: instructions ⇄ explanation (both mounted; CSS-toggled full bleed) */}
      <div className={explainOpen ? 'hidden' : 'flex flex-col gap-3'}>
        {d.beats.map((b, i) => {
          const key = `${d.id}::${i}`
          return (
            <BeatCard
              key={key}
              beat={b}
              open={!!openBeats[key]}
              onToggle={() => onToggleBeat(key)}
              onShot={onShot}
            />
          )
        })}
      </div>
      {canExp && (
        <aside className={explainOpen ? 'flex w-full flex-col' : 'hidden'}>
          {/* Explainer header bar removed per design feedback — close is still
              reachable via the Instructions/Explanation tabs above + the `e` key. */}
          {/* Inline React explainer — the SAME component the standalone page
              renders, scoped under `.explainer-root x-<id>` so the kit CSS +
              explainer tokens resolve without leaking into the dashboard chrome.
              Mounted only while open so the step players' timers stay idle when
              the explanation view is closed. */}
          {explainOpen && Explainer && (
            <div className={`explainer-root x-${d.id} overflow-x-auto`}>
              <Explainer />
            </div>
          )}
        </aside>
      )}
    </section>
  )
}
