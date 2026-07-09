import { canExplain } from './explainers.ts'
import { SLIDE_COUNT } from './intro.tsx'
import { DEMOS } from './model.gen.ts'
import { INTRO_ID, TAB_IDS } from './nav.tsx'

type View = 'instructions' | 'explanation'
type Backups = 'shown' | 'hidden'

// ---------------------------------------------------------------------------
// URL state (reload-safe, shareable). scheme:
//   control.next.html#demo=<id>&view=instructions|explanation&backups=shown|hidden&slide=<n>
// `slide` is the intro deck slide index; it is only written on the intro tab.
// ---------------------------------------------------------------------------

export interface UiState {
  demo: string
  view: View
  backups: Backups
  /** intro deck slide index (0-based); only meaningful while demo === INTRO_ID */
  slide: number
}

export const readUrl = (): UiState => {
  // default to the explanation (explainer) view; normalize() keeps intro / no-explainer demos on instructions
  const s: UiState = { demo: TAB_IDS[0]!, view: 'explanation', backups: 'hidden', slide: 0 }
  const p = new URLSearchParams(location.hash.replace(/^#/, ''))
  const demo = p.get('demo')
  if (demo && TAB_IDS.includes(demo)) s.demo = demo
  const view = p.get('view')
  if (view === 'explanation' || view === 'instructions') s.view = view
  const backups = p.get('backups')
  if (backups === 'shown' || backups === 'hidden') s.backups = backups
  const slide = Number(p.get('slide'))
  if (Number.isInteger(slide)) s.slide = slide
  return s
}

export const normalize = (s: UiState): UiState => {
  // clamp the intro slide to a valid index regardless of the active tab
  const slide = Math.max(0, Math.min(s.slide, SLIDE_COUNT - 1))
  // intro is not a demo and doesn't consume `view` (it renders its own panel
  // regardless), so leave the stored view untouched — otherwise it would
  // clobber it to 'instructions' and that stale value would stick once the
  // user navigates on to a real demo.
  if (s.demo === INTRO_ID) return { ...s, slide }
  const d = DEMOS.find((x) => x.id === s.demo) ?? DEMOS[0]!
  // can't be in explanation view if the active demo has no explainer
  const view: View = s.view === 'explanation' && !canExplain(d) ? 'instructions' : s.view
  return { ...s, view, slide }
}

export const writeUrl = (s: UiState): void => {
  const p = new URLSearchParams()
  p.set('demo', s.demo)
  p.set('view', s.view)
  p.set('backups', s.backups)
  // slide is intro-only state — keep it out of demo URLs to avoid noise
  if (s.demo === INTRO_ID) p.set('slide', String(s.slide))
  try {
    history.replaceState(null, '', '#' + p.toString())
  } catch {
    /* ignore */
  }
}
