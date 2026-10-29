import { afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Bun enumerates cwd ancestors on startup, including the shared system temp
// directory. Keep subprocess fixtures in the checkout's ignored tmp instead:
// unrelated users' temporary files must not become part of a test's workload.
const parent = join(import.meta.dir, '..', 'tmp')

/** Call at each test file's top level so its cleanup owns only that file's root. */
export const createTestTempDirectoryFactory = (): ((prefix: string) => string) => {
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'bun-fixtures-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  return (prefix) => mkdtempSync(join(root, prefix))
}
