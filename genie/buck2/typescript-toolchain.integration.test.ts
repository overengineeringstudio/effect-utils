import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const target = 'effect_utils//packages/@overeng/utils:dist'

const productDigest = (root: string): string => {
  const hash = createHash('sha256')
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const relative = `${prefix}${entry.name}`
      const path = join(directory, entry.name)
      if (entry.isDirectory() === true) visit(path, `${relative}/`)
      else {
        expect(entry.isFile(), `unexpected emitted product entry: ${path}`).toBe(true)
        const bytes = readFileSync(path)
        hash.update(JSON.stringify([relative, bytes.byteLength]))
        hash.update(bytes)
      }
    }
  }
  visit(root, '')
  return hash.digest('hex')
}

it('keeps real Buck emit identical after publishing the editor test dependency views', () => {
  const buck = process.env['BUCK2_BIN']
  if (buck === undefined) throw new Error('BUCK2_BIN is required for the real toolchain regression')
  const beforeIsolation = `tsgo-editor-before-${randomUUID()}`
  const publishedIsolation = `tsgo-editor-published-${randomUUID()}`
  const isolations = [beforeIsolation, publishedIsolation]
  const run = (command: string, args: readonly string[]): string => {
    const result = spawnSync(command, args, {
      cwd: repoRoot,
      env: { ...process.env, BUCK2_NO_REMOTE_CACHE: '1' },
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    expect(result.error, `${command} ${args.join(' ')}`).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    return result.stdout
  }
  const emit = (isolation: string): string => {
    const result = JSON.parse(
      run(buck, [
        '--isolation-dir',
        isolation,
        'build',
        '--local-only',
        '--no-remote-cache',
        '--show-json-output',
        target,
      ]),
    ) as Record<string, string>
    const output = result[target]
    if (output === undefined)
      throw new Error(`Buck did not report the emitted product for ${target}`)
    return productDigest(join(repoRoot, output))
  }
  try {
    // Separate Buck daemons/action caches force the second invocation to execute,
    // rather than returning the successful verdict from before publication.
    const before = emit(beforeIsolation)
    run('devenv', ['tasks', 'run', 'buck2:editor:publish:test'])
    const rootTypes = join(repoRoot, 'node_modules', '@types', 'bun', 'index.d.ts')
    expect(
      existsSync(rootTypes),
      'the real publisher must expose the formerly leaking Bun types',
    ).toBe(true)
    expect(realpathSync(rootTypes)).not.toBe(rootTypes)
    expect(emit(publishedIsolation)).toBe(before)
  } finally {
    for (const isolation of isolations) run(buck, ['--isolation-dir', isolation, 'kill'])
  }
}, 1_800_000)
