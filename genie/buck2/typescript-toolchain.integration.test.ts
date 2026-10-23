import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  // Cache-less commands change daemon-scoped RE configuration. Isolations alone
  // do not isolate the root overlay/reservations from concurrent test:run writers.
  // Copy tracked inputs only (no buck-out/editor payloads), and expose the
  // source root's live editor links so the second emit still tests publication.
  const root = mkdtempSync(join(tmpdir(), 'tsgo-editor-root-'))
  const beforeIsolation = `tsgo-editor-before-${randomUUID()}`
  const publishedIsolation = `tsgo-editor-published-${randomUUID()}`
  const isolations = [beforeIsolation, publishedIsolation]
  const run = (
    command: string,
    args: readonly string[],
    cwd = root,
    env: typeof process.env = { ...process.env, BUCK2_NO_REMOTE_CACHE: '1' },
  ): string => {
    const result = spawnSync(command, args, {
      cwd,
      env,
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
    return productDigest(join(root, output))
  }
  try {
    const tracked = run('git', ['ls-files', '-z'], repoRoot, process.env)
      .split('\0')
      .filter((path) => path !== '')
    for (const path of tracked) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      cpSync(join(repoRoot, path), join(root, path), { verbatimSymlinks: true })
      if (path === 'package.json' || path.endsWith('/package.json') === true) {
        const modules = join(dirname(path), 'node_modules')
        symlinkSync(join(repoRoot, modules), join(root, modules), 'dir')
      }
    }
    // The host capability cell is immutable/tool-only; root-local daemon state
    // and cache posture are deliberately not linked or copied.
    mkdirSync(join(root, '.buck2'), { recursive: true })
    symlinkSync(
      realpathSync(join(repoRoot, '.buck2', 'capabilities')),
      join(root, '.buck2', 'capabilities'),
      'dir',
    )
    // Separate Buck daemons/action caches force the second invocation to execute,
    // rather than returning the successful verdict from before publication.
    const before = emit(beforeIsolation)
    // Publication stays in the original root with its inherited writer posture.
    run('devenv', ['tasks', 'run', 'buck2:editor:publish:test'], repoRoot, process.env)
    const rootTypes = join(root, 'node_modules', '@types', 'bun', 'index.d.ts')
    expect(
      existsSync(rootTypes),
      'the real publisher must expose the formerly leaking Bun types',
    ).toBe(true)
    expect(realpathSync(rootTypes)).not.toBe(rootTypes)
    expect(emit(publishedIsolation)).toBe(before)
  } finally {
    try {
      for (const isolation of isolations) run(buck, ['--isolation-dir', isolation, 'kill'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}, 1_800_000)
