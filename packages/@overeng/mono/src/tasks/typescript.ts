/**
 * TypeScript and build tasks.
 */

import { Effect } from 'effect'

import { runCommand } from '../utils.ts'
import type { TypeCheckConfig } from './types.ts'

/**
 * Resolve the local tsc path from mono's node_modules.
 * This ensures we use the patched TypeScript with Effect Language Service support.
 */
export const resolveLocalTsc = (): string => {
  const tscUrl = import.meta.resolve?.('typescript/bin/tsc')
  if (!tscUrl) {
    throw new Error('Failed to resolve typescript/bin/tsc path')
  }
  // import.meta.resolve returns a string in bun, but could be Promise in other environments
  const tscPath = typeof tscUrl === 'string' ? tscUrl : String(tscUrl)
  return tscPath.replace('file://', '')
}

/** Type check task */
export const typeCheck = (config?: TypeCheckConfig) =>
  runCommand({
    command: resolveLocalTsc(),
    args: ['--build', config?.tsconfigPath ?? 'tsconfig.all.json'],
  }).pipe(Effect.withSpan('typeCheck'))

/** Type check in watch mode */
export const typeCheckWatch = (config?: TypeCheckConfig) =>
  runCommand({
    command: resolveLocalTsc(),
    args: ['--build', '--watch', config?.tsconfigPath ?? 'tsconfig.all.json'],
  }).pipe(Effect.withSpan('typeCheckWatch'))

/** Clean TypeScript build artifacts */
export const typeCheckClean = (config?: TypeCheckConfig) =>
  runCommand({
    command: resolveLocalTsc(),
    args: ['--build', '--clean', config?.tsconfigPath ?? 'tsconfig.all.json'],
  }).pipe(Effect.withSpan('typeCheckClean'))

/** Build task (tsc --build) */
export const build = (config?: TypeCheckConfig) =>
  runCommand({
    command: 'tsc',
    args: ['--build', config?.tsconfigPath ?? 'tsconfig.all.json'],
  }).pipe(Effect.withSpan('build'))
