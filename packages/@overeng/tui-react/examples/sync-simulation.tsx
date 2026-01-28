/**
 * Sync simulation - simulates `mr sync --deep` with nested repos, warnings, and completion.
 *
 * This is the KEY example demonstrating real-world usage of the TUI library:
 * - Static logs for completed repo syncs (with warnings/errors)
 * - Dynamic progress showing current operations
 * - Nested repo hierarchy
 * - Mixed success/warning/error states
 *
 * Run: npx tsx examples/sync-simulation.tsx
 */

import React from 'react'
import { createRoot } from '../src/mod.ts'
import { SyncDeepSimulationExample } from '../src/examples/mod.ts'

const root = createRoot(process.stdout)
root.render(<SyncDeepSimulationExample />)

// Exit after completion
setTimeout(() => {
  root.unmount()
  process.exit(0)
}, 15000)
