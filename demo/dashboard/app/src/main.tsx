import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './index.css'
// Shared mockup kit component styles (read-only). NOT kit-page.css — that file
// owns body/page chrome and would clobber the dashboard layout; its design
// tokens are supplied by index.css instead (distinct names from the Tailwind
// --color-* theme, so no clash).
import '../../kit/kit-components.css'
// codegen.css is FULLY self-scoped under `.cg` (its thread root renders
// `.thread.cg`), so it is safe to import raw here — its shared-class overrides
// (.ide-code/.tmnl-body/.ntn-tbl/.seq-col widths/pills) can never leak onto
// md/sqlite/react/iac or the dashboard chrome. react.css + iac.css are BARE
// (unscoped) and are instead transcribed, scoped, into explainer.css below.
import '../../explainers/src/codegen.css'
// Inline-explainer layer: scoped page chrome + per-explainer content CSS + scoped
// explainer tokens, all under `.explainer-root` so nothing leaks into the
// dashboard chrome. (kit-page.css is still NOT imported — this replaces its role
// for the inline embed.) Includes the transcribed, scoped react.css + iac.css.
import './explainer.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
