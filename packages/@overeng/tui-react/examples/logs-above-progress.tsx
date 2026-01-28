/**
 * Logs above progress example - demonstrates the key <Static> component feature.
 *
 * The <Static> component renders items once to a "static region" that persists
 * above the dynamic content. This is how logs appear above progress indicators,
 * matching Ink's behavior.
 *
 * Run: npx tsx examples/logs-above-progress.tsx
 */

import React from 'react'
import { createRoot } from '../src/mod.ts'
import { LogsAboveProgressExample } from '../src/examples/mod.ts'

const root = createRoot(process.stdout)
root.render(<LogsAboveProgressExample />)

// Exit after completion
setTimeout(() => {
  root.unmount()
  process.exit(0)
}, 6000)
