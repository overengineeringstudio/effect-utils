/**
 * Stress test: many lines - tests rendering 100+ lines simultaneously.
 *
 * This example renders a large number of items to verify:
 * - The renderer handles many lines without performance issues
 * - Yoga layout calculates correctly for tall content
 * - Terminal output remains coherent
 *
 * Run: npx tsx examples/stress-lines.tsx
 */

import React from 'react'
import { createRoot } from '../src/mod.ts'
import { StressLinesExample } from '../src/examples/mod.ts'

const root = createRoot(process.stdout)
root.render(<StressLinesExample />)

// Auto-exit after completion or timeout
setTimeout(() => {
  root.unmount()
  console.log('\nStress test completed.')
  process.exit(0)
}, 30000) // Max 30 seconds
