/**
 * Test runner tasks.
 */

import { Effect } from 'effect'

import { runCommand } from '../utils.ts'
import type { TestConfig } from './types.ts'

/** Run tests */
export const testRun = (config?: TestConfig) =>
  runCommand({
    command: config?.command ?? 'vitest',
    args: ['run', ...(config?.args ?? [])],
  }).pipe(Effect.withSpan('testRun'))

/** Run tests in watch mode */
export const testWatch = (config?: TestConfig) =>
  runCommand({
    command: config?.command ?? 'vitest',
    args: [...(config?.args ?? [])],
  }).pipe(Effect.withSpan('testWatch'))
