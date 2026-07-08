import { canExplain } from './explainers.ts'
import { DEMOS } from './model.gen.ts'
import { INTRO_ID, TAB_IDS } from './nav.tsx'

type View = 'instructions' | 'explanation'
type Backups = 'shown' | 'hidden'

// ---------------------------------------------------------------------------
// URL state (reload-safe, shareable). scheme:
//   control.next.html#demo=<id>&view=instructions|explanation&backups=shown|hidden
// ---------------------------------------------------------------------------

export interface UiState {
  demo: string
  view: View
  backups: Backups
}

export const readUrl = (): UiState => {
  // default to the explanation (explainer) view; normalize() keeps intro / no-explainer demos on instructions
  const s: UiState = { demo: TAB_IDS[0]!, view: 'explanation', backups: 'hidden' }
  const p = new URLSearchParams(location.hash.replace(/^#/, ''))
  const demo = p.get('demo')
  if (demo && TAB_IDS.includes(demo)) s.demo = demo
  const view = p.get('view')
  if (view === 'explanation' || view === 'instructions') s.view = view
  const backups = p.get('backups')
  if (backups === 'shown' || backups === 'hidden') s.backups = backups
  return s
}

export const normalize = (s: UiState): UiState => {
  // intro is not a demo — it has no explainer, so it is always instructions view
  if (s.demo === INTRO_ID) return { ...s, view: 'instructions' }
  const d = DEMOS.find((x) => x.id === s.demo) ?? DEMOS[0]!
  // can't be in explanation view if the active demo has no explainer
  const view: View = s.view === 'explanation' && !canExplain(d) ? 'instructions' : s.view
  return { ...s, view }
}

export const writeUrl = (s: UiState): void => {
  const p = new URLSearchParams()
  p.set('demo', s.demo)
  p.set('view', s.view)
  p.set('backups', s.backups)
  try {
    history.replaceState(null, '', '#' + p.toString())
  } catch {
    /* ignore */
  }
}
