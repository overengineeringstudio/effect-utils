/**
 * useStepPlayer — the React port of the vanilla `engine.js` IIFE.
 *
 * engine.js ran ONCE on load via `document.querySelectorAll('[data-seq]').forEach`
 * and owned a closure per sequence. That run-once-global model breaks under
 * React mount/unmount/route-switch/HMR (segments get injected twice, timers
 * leak, a remounted `.seq` never re-arms). This hook moves the SAME driver to a
 * per-`<Sequence>` effect: it owns one `.seq` node via a ref, and on cleanup
 * tears everything down (timer, listeners, injected segments, attributes) so it
 * is safe under StrictMode double-invoke and Fast Refresh.
 *
 * The CONTRACT with kit-components.css is byte-identical to engine.js — it writes
 * the same `data-mode="anim"|"static"` + `data-step="N"` attributes, injects the
 * same `.seq-seg`/`.seq-seg-fill` markup into `[data-segs]`, drives the same
 * segmented-bar fill clock, and sets the same caption/count/aria state. So
 * kit-components.css needs ZERO changes: the intra-step arrival-gated timing
 * (r2b @1.35s, r3b @1.45s, packet travel, recv bands) is realized entirely by
 * the CSS `@keyframes` + `animation-delay` keyed on `data-step`, exactly as
 * before — this hook only advances the integer step and paints the progress bar.
 *
 * On the server (renderToStaticMarkup, the legacy SSG path) effects never run,
 * so importing this into the shared kit leaves the SSG output unchanged.
 */
import { useEffect, type RefObject } from 'react'

/** Auto-advance interval per step, ms — matches engine.js. */
const INTERVAL = 2600

export function useStepPlayer(ref: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const seq = ref.current
    if (!seq) return

    const reduce =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false

    // Steps derive from the legend (single source of truth for captions).
    const legendItems = seq.querySelectorAll<HTMLElement>('.seq-legend li')
    const steps = Array.from(legendItems).map((li, i) => ({
      caption: li.getAttribute('data-cap') || (li.textContent ?? '').trim(),
      state: String(i + 1),
    }))
    if (steps.length === 0) return

    const capEl = seq.querySelector<HTMLElement>('[data-cap]')
    const segsEl = seq.querySelector<HTMLElement>('[data-segs]')
    const countEl = seq.querySelector<HTMLElement>('[data-count]')
    const toggleBtn = seq.querySelector<HTMLElement>('[data-act="toggle"]')
    const icPlay = toggleBtn?.querySelector<HTMLElement>('.ic-play') ?? null
    const icPause = toggleBtn?.querySelector<HTMLElement>('.ic-pause') ?? null

    let idx = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let playing = false
    // Single clock: the fill transition AND the advance timeout both read
    // `legRemaining` (INTERVAL fresh, the pinned remainder on resume).
    let legStart = 0
    let legRemaining = INTERVAL

    // Build one segment per step (muted track + accent fill). Clear first so a
    // StrictMode remount (or any re-run) never doubles the segments.
    const segs: HTMLButtonElement[] = []
    const fills: HTMLElement[] = []
    if (segsEl) {
      segsEl.innerHTML = ''
      steps.forEach((_s, i) => {
        const seg = document.createElement('button')
        seg.type = 'button'
        seg.className = 'seq-seg'
        seg.setAttribute('data-i', String(i))
        seg.setAttribute('aria-label', `Go to step ${i + 1}`)
        const fill = document.createElement('span')
        fill.className = 'seq-seg-fill'
        seg.appendChild(fill)
        segsEl.appendChild(seg)
        segs.push(seg)
        fills.push(fill)
      })
    }

    const activeFill = (): HTMLElement | undefined => fills[idx]
    // Prior segments = full, later = empty, active reset to empty (no transition).
    const paintStatic = (): void => {
      fills.forEach((f, i) => {
        f.style.transition = 'none'
        f.style.width = i < idx ? '100%' : '0%'
      })
    }
    // Animate the active fill from its current width to 100% over `dur` ms.
    const fillTo100 = (dur: number): void => {
      const f = activeFill()
      if (!f) return
      const cur = getComputedStyle(f).width // resume point: 0 fresh, pinned px after pause
      f.style.transition = 'none'
      f.style.width = cur
      void f.offsetWidth // commit the start, then transition
      f.style.transition = `width ${dur}ms linear`
      f.style.width = '100%'
    }
    // Freeze the active fill at its current computed width (pause).
    const freezeFill = (): void => {
      const f = activeFill()
      if (!f) return
      const w = getComputedStyle(f).width
      f.style.transition = 'none'
      f.style.width = w
    }

    const render = (): void => {
      seq.setAttribute('data-step', steps[idx]!.state)
      if (capEl) capEl.textContent = steps[idx]!.caption
      if (countEl) countEl.textContent = `${idx + 1} / ${steps.length}`
      segs.forEach((d, i) => {
        d.classList.toggle('is-on', i === idx)
        if (i === idx) d.setAttribute('aria-current', 'step')
        else d.removeAttribute('aria-current')
      })
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-pressed', String(playing))
        toggleBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play')
        if (icPlay) icPlay.style.display = playing ? 'none' : ''
        if (icPause) icPause.style.display = playing ? '' : 'none'
      }
    }
    const clearTimer = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
    // One leg = fill + advance, both driven by `legRemaining`.
    const runLeg = (): void => {
      clearTimer()
      fillTo100(legRemaining)
      legStart = Date.now()
      timer = setTimeout(() => go(idx + 1), legRemaining)
    }
    const go = (i: number): void => {
      idx = ((i % steps.length) + steps.length) % steps.length
      legRemaining = INTERVAL // fresh leg = full duration
      paintStatic()
      render()
      if (playing) runLeg()
    }
    const start = (): void => {
      // begin / resume from the pinned remainder
      if (playing) return
      playing = true
      render()
      runLeg()
    }
    const stop = (): void => {
      // pause: keep elapsed, pin the fill width
      if (playing && legStart) legRemaining = Math.max(0, legRemaining - (Date.now() - legStart))
      playing = false
      legStart = 0
      clearTimer()
      freezeFill()
      render()
    }
    const toggle = (): void => {
      if (playing) stop()
      else start()
    }

    const onClick = (e: Event): void => {
      const target = e.target as HTMLElement | null
      if (!target) return
      const act = target.closest('[data-act]')
      if (act) {
        const a = act.getAttribute('data-act')
        if (a === 'toggle') toggle()
        else if (a === 'next') {
          stop()
          go(idx + 1)
        } else if (a === 'prev') {
          stop()
          go(idx - 1)
        }
        return
      }
      const seg = target.closest('.seq-seg') // clicking a segment jumps to that step
      if (seg) {
        stop()
        go(parseInt(seg.getAttribute('data-i') ?? '0', 10))
      }
    }
    seq.addEventListener('click', onClick)

    if (reduce) {
      // reduced-motion → static legend, no auto-advance (CSS resolves all frames).
      seq.setAttribute('data-mode', 'static')
    } else {
      seq.setAttribute('data-mode', 'anim')
      go(0)
      start()
    }

    return () => {
      clearTimer()
      seq.removeEventListener('click', onClick)
      if (segsEl) segsEl.innerHTML = ''
      seq.removeAttribute('data-mode')
      seq.removeAttribute('data-step')
    }
  }, [ref])
}
