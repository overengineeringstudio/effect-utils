import { afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Bun enumerates cwd ancestors on startup, including the shared system temp
// directory. Keep subprocess fixtures in the checkout's ignored tmp instead:
// unrelated users' temporary files must not become part of a test's workload.
const parent = join(import.meta.dir, '..', 'tmp')
mkdirSync(parent, { recursive: true })
const root = mkdtempSync(join(parent, 'bun-fixtures-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Allocate an isolated fixture; callers still remove it in their finally block. */
export const createTestTempDirectory = (prefix: string): string => mkdtempSync(join(root, prefix))
