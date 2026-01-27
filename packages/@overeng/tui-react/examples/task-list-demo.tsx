#!/usr/bin/env bun
/**
 * Demo of TaskList component - simulates a sync-like progress display.
 *
 * Run: bun examples/task-list-demo.tsx
 *
 * This demo uses the shared SyncSimulationExample component.
 */

import React from 'react'
import { createRoot } from '../src/mod.ts'
import { SyncSimulationExample } from '../src/examples/mod.ts'

const root = createRoot(process.stdout)
root.render(<SyncSimulationExample />)

// Exit after some time
setTimeout(() => {
  root.unmount()
  process.exit(0)
}, 10000)
