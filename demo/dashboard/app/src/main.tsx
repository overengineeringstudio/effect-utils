import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './index.css'
// Shared mockup kit component styles (read-only). NOT kit-page.css — that file
// owns body/page chrome and would clobber the dashboard layout; its design
// tokens are supplied by explainer.css (scoped to `.explainer-root`) instead of a
// global :root, so no clash with the Tailwind --color-* theme.
import '../../kit/kit-components.css'
// Inline-explainer layer: the SCOPED explainer design tokens (--accent/--line/…)
// + page chrome (.thread/.beat/.stage/…), all under `.explainer-root` so nothing
// leaks into the dashboard chrome. (kit-page.css is NOT imported — this replaces
// its role for the inline embed.) Must come BEFORE the per-explainer CSS below.
import './explainer.css'
// Per-explainer content CSS — each file is SELF-SCOPED at the source under its own
// `.explainer-root.x-<id>` (codegen under `.cg`), so they are imported DIRECTLY
// here as the single source (no transcription, no cross-leak). Ordered AFTER
// kit-components.css so equal-specificity kit overrides win by source order.
import '../../explainers/src/md.css'
import '../../explainers/src/sqlite.css'
import '../../explainers/src/react.css'
import '../../explainers/src/codegen.css'
import '../../explainers/src/iac.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
