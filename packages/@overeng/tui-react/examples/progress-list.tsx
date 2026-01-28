/**
 * Progress list example - task list with spinners and status icons.
 *
 * Run: npx tsx examples/progress-list.tsx
 */

import React from 'react'
import { createRoot } from '../src/mod.ts'
import { ProgressListExample } from '../src/examples/mod.ts'

const root = createRoot(process.stdout)
root.render(<ProgressListExample />)

// Exit after tasks complete
setTimeout(() => {
  root.unmount()
  process.exit(0)
}, 5000)
