import { Agentation } from 'agentation'
import { Fragment, useCallback, useEffect, useState } from 'react'

import { DemoSection } from './demo-section.tsx'
import { canExplain } from './explainers.ts'
import { IntroPanel } from './intro.tsx'
import { DEMOS } from './model.gen.ts'
import { INTRO_ID, KEY_MAP, NAV_ITEMS, TabButton } from './nav.tsx'
import { type UiState, normalize, readUrl, writeUrl } from './url-state.ts'

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

export const App = () => {
  const [state, setState] = useState<UiState>(() => normalize(readUrl()))
  const active = DEMOS.find((d) => d.id === state.demo) ?? DEMOS[0]!

  // per-beat backup disclosure (local; keyed by demoId::index). The master
  // "show all backups" toggle (URL-backed) sets every active-demo beat at once;
  // per-beat toggles flip a single beat without touching the URL master state.
  const seedOpen = (demoId: string, shown: boolean): Record<string, boolean> => {
    const out: Record<string, boolean> = {}
    const d = DEMOS.find((x) => x.id === demoId)
    d?.beats.forEach((_, i) => {
      out[`${demoId}::${i}`] = shown
    })
    return out
  }
  const [openBeats, setOpenBeats] = useState<Record<string, boolean>>(() =>
    seedOpen(state.demo, state.backups === 'shown'),
  )

  // lightbox
  const [lightbox, setLightbox] = useState<string | null>(null)

  // commit: normalize, persist to URL, and re-apply master backups to the
  // (possibly new) active demo — mirrors build.ts applyState().
  const commit = useCallback((next: UiState) => {
    const norm = normalize(next)
    setState(norm)
    setOpenBeats(seedOpen(norm.demo, norm.backups === 'shown'))
    writeUrl(norm)
  }, [])

  // init: write the normalized URL on first mount.
  useEffect(() => {
    writeUrl(state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // respond to external hash changes (shared/reloaded links, back/forward)
  useEffect(() => {
    const onHash = () => commit(readUrl())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [commit])

  const onIntro = state.demo === INTRO_ID
  const setDemo = (id: string) => commit({ ...state, demo: id })
  const toggleExplain = useCallback(() => {
    if (state.demo === INTRO_ID || !canExplain(active)) return
    commit({ ...state, view: state.view === 'explanation' ? 'instructions' : 'explanation' })
  }, [active, state, commit])
  const closeExplain = () => commit({ ...state, view: 'instructions' })
  const toggleBeat = (key: string) => setOpenBeats((m) => ({ ...m, [key]: !m[key] }))

  // keyboard: 1..N tabs, e explainer, Esc closes lightbox
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && lightbox !== null) {
        setLightbox(null)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if (e.key === '0') {
        commit({ ...state, demo: INTRO_ID })
        return
      }
      const members = KEY_MAP[e.key]
      if (members && members.length > 0) {
        if (members.length === 1) {
          commit({ ...state, demo: members[0]!.id })
        } else {
          // group key: first press → first member; repeat → cycle to next member
          const idx = members.findIndex((m) => m.id === state.demo)
          const next = idx === -1 ? members[0]! : members[(idx + 1) % members.length]!
          commit({ ...state, demo: next.id })
        }
        return
      }
      if (e.key === 'e') toggleExplain()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox, state, commit, toggleExplain])

  // theme toggle: data-theme on <html> wins over prefers-color-scheme.
  // Matches control.html — NOT persisted across reloads.
  const toggleTheme = () => {
    const el = document.documentElement
    const cur = el.getAttribute('data-theme')
    const sysDark = matchMedia('(prefers-color-scheme:dark)').matches
    const next = cur ? (cur === 'dark' ? 'light' : 'dark') : sysDark ? 'light' : 'dark'
    el.setAttribute('data-theme', next)
  }

  const explainOpen = state.view === 'explanation'

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b border-border bg-bg px-4">
        <button
          type="button"
          onClick={() => setDemo(INTRO_ID)}
          className={
            onIntro
              ? '-mb-px inline-flex items-center gap-1.5 border-b-2 border-accent px-3 py-2.5 text-[13px] font-medium text-fg'
              : '-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-[13px] text-fg-muted hover:text-fg'
          }
        >
          <kbd
            className={`border-0 bg-transparent p-0 font-mono text-[11px] ${onIntro ? 'text-accent' : 'text-fg-faint'}`}
          >
            0
          </kbd>
          Intro
        </button>
        {NAV_ITEMS.map((item) => {
          if (item.kind === 'solo') {
            const d = item.demo
            return (
              <TabButton key={d.id} d={d} on={d.id === state.demo} onClick={() => setDemo(d.id)} />
            )
          }
          return (
            <Fragment key={item.groupId}>
              {item.members.map((d) => (
                <TabButton
                  key={d.id}
                  d={d}
                  on={d.id === state.demo}
                  onClick={() => setDemo(d.id)}
                />
              ))}
            </Fragment>
          )
        })}
      </nav>

      <main className="px-5 pb-16 pt-4">
        <IntroPanel
          hidden={!onIntro}
          slide={state.slide}
          onGo={(i) => commit({ ...state, slide: i })}
        />
        {DEMOS.map((d) => (
          <DemoSection
            key={d.id}
            d={d}
            active={d.id === state.demo}
            explainOpen={d.id === state.demo && explainOpen && canExplain(d)}
            openBeats={openBeats}
            onToggleExplain={toggleExplain}
            onCloseExplain={closeExplain}
            onToggleBeat={toggleBeat}
            onShot={setLightbox}
          />
        ))}
      </main>

      {/* lightbox */}
      {lightbox !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(4,6,10,.86)] p-7"
          onClick={(e) => {
            if (e.target === e.currentTarget) setLightbox(null)
          }}
        >
          <button
            type="button"
            aria-label="Close (Esc)"
            onClick={() => setLightbox(null)}
            className="fixed right-5 top-4 flex h-[38px] w-[38px] cursor-pointer items-center justify-center rounded-[9px] border border-white/25 bg-white/10 text-[17px] text-white hover:bg-white/25"
          >
            ✕
          </button>
          <img
            src={lightbox}
            alt=""
            className="max-h-[92vh] max-w-[96vw] rounded-lg bg-white shadow-[0_24px_70px_rgba(0,0,0,.6)]"
          />
        </div>
      )}

      {/* Minimal floating theme toggle — relocated from the removed top bar so theme switching still works. */}
      <button
        type="button"
        onClick={toggleTheme}
        title="Toggle theme"
        aria-label="Toggle theme"
        className="fixed bottom-4 left-4 z-40 rounded-md border border-border bg-bg-subtle px-2.5 py-1 text-xs text-fg-muted opacity-40 transition hover:text-fg hover:opacity-100"
      >
        ◐
      </button>
      {/* Dev-only visual feedback tool: turns UI annotations into structured context for coding agents via MCP. Dev server only — excluded from the built control.next.html. */}
      {import.meta.env.DEV && <Agentation />}
    </div>
  )
}
