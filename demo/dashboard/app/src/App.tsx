import { useEffect, useState } from 'react'
import type { RawSegment } from '../../screenplay.ts'
import { DEMOS } from './model.gen.ts'
import { InlineMd } from './inline-md.tsx'

// ---------------------------------------------------------------------------
// segment renderer (raw model → JSX; escaping + inline-md done here, not in HTML)
// ---------------------------------------------------------------------------

const Segment = ({ seg }: { seg: RawSegment }) => {
  if (seg.kind === 'code') {
    return (
      <div className="relative rounded-lg border border-border-strong bg-bg-code">
        <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed text-code-fg">{seg.raw}</pre>
      </div>
    )
  }
  if (seg.kind === 'say') {
    return (
      <p className="py-1 text-[13px] italic text-fg-muted">
        <span className="mr-2 rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] font-bold not-italic tracking-wider text-fg-faint">
          SAY
        </span>
        {seg.text}
      </p>
    )
  }
  // prose (raw lines; joined with <br>, inline-md per line)
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
// app
// ---------------------------------------------------------------------------

export const App = () => {
  const [activeId, setActiveId] = useState(DEMOS[0]!.id)
  const active = DEMOS.find((d) => d.id === activeId) ?? DEMOS[0]!

  // theme toggle: data-theme on <html> (wins over prefers-color-scheme)
  const toggleTheme = () => {
    const el = document.documentElement
    const cur = el.getAttribute('data-theme')
    const sysDark = matchMedia('(prefers-color-scheme:dark)').matches
    const next = cur ? (cur === 'dark' ? 'light' : 'dark') : sysDark ? 'light' : 'dark'
    el.setAttribute('data-theme', next)
  }

  // keyboard 1..N switches demo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= DEMOS.length) setActiveId(DEMOS[n - 1]!.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-border bg-bg-panel px-5 py-2.5">
        <h1 className="m-0 text-[15px] font-semibold tracking-tight">
          <span className="text-accent">●</span> Live Control{' '}
          <span className="font-normal text-fg-faint">· Notion tooling demos (next)</span>
        </h1>
        <div className="flex-1" />
        <span className="text-xs text-fg-faint">
          keys <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-fg-muted">1</kbd>–
          <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-fg-muted">{DEMOS.length}</kbd>{' '}
          switch demo
        </span>
        <button
          type="button"
          onClick={toggleTheme}
          className="cursor-pointer rounded-md border border-border bg-bg-subtle px-2.5 py-1 text-xs text-fg-muted hover:text-fg"
        >
          ◐ theme
        </button>
      </header>

      <nav className="sticky top-[41px] z-10 flex flex-wrap gap-1 border-b border-border bg-bg px-5 py-2">
        {DEMOS.map((d, i) => {
          const on = d.id === activeId
          return (
            <button
              type="button"
              key={d.id}
              onClick={() => setActiveId(d.id)}
              className={
                on
                  ? 'inline-flex items-center rounded-lg border border-accent bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg'
                  : 'inline-flex items-center rounded-lg border border-border bg-bg-panel px-3 py-1.5 text-[13px] font-medium text-fg-muted hover:border-border-strong hover:text-fg'
              }
            >
              <kbd
                className={
                  on
                    ? 'mr-1.5 rounded border-transparent bg-white/20 px-1.5 py-0.5 text-[11px]'
                    : 'mr-1.5 rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-[11px] text-fg-muted'
                }
              >
                {i + 1}
              </kbd>
              {d.tab}
            </button>
          )
        })}
      </nav>

      <main className="px-5 pb-16 pt-4">
        <div className="mb-2.5">
          <h2 className="m-0 text-lg font-semibold">{active.tab}</h2>
          <p className="mt-0.5 max-w-[120ch] text-[12.5px] text-fg-muted">
            <InlineMd line={active.gapwow} />
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {active.beats.map((b, i) => (
            <article key={i} className="rounded-lg border border-border bg-bg-panel px-3.5 py-3">
              <div className="mb-2 flex items-center gap-2.5">
                <span className="whitespace-nowrap text-[11px] font-bold uppercase tracking-wider text-fg-faint">
                  {b.label}
                </span>
                <span className="min-w-0 flex-1 text-[14.5px] font-semibold">{b.title}</span>
              </div>
              {b.narration && (
                <p className="mb-2 rounded-md bg-say-bg px-2.5 py-1.5 text-[13.5px] text-say-fg">
                  <span className="mr-2 rounded bg-say-fg/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wider">
                    SAY
                  </span>
                  {b.narration}
                </p>
              )}
              <div className="flex flex-col gap-2">
                {b.segments.map((seg, j) => (
                  <Segment key={j} seg={seg} />
                ))}
              </div>
            </article>
          ))}
        </div>
      </main>
    </div>
  )
}
