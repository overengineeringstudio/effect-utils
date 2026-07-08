import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './index.css'
// Shared mockup kit component styles (read-only). NOT kit-page.css — that file
// owns body/page chrome and would clobber the dashboard layout; its design
// tokens are supplied by index.css instead (distinct names from the Tailwind
// --color-* theme, so no clash).
import '../../kit/kit-components.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
