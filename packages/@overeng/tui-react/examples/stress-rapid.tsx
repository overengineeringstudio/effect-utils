/**
 * Stress test: rapid updates - tests differential rendering at high frequency.
 *
 * This example updates a counter at ~60fps to verify:
 * - The renderer can handle rapid state changes
 * - Differential rendering minimizes terminal writes
 * - No visual flickering occurs
 *
 * Run: npx tsx examples/stress-rapid.tsx
 */

import React from 'react'
import { createRoot } from '../src/mod.ts'
import { StressRapidExample } from '../src/examples/mod.ts'

const root = createRoot(process.stdout)
root.render(<StressRapidExample />)

// Auto-exit after 10 seconds
setTimeout(() => {
  root.unmount()
  console.log('\nStress test completed.')
  process.exit(0)
}, 10000)
