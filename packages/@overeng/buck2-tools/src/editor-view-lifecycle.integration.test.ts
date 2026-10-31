import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { unreleasedEditorViewRoots } from './editor-view-lifecycle.ts'

it('keeps the mr lifecycle subpath limited to Node builtin imports', async () => {
  const source = await readFile(new URL('./editor-view-lifecycle.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/gu)].map(
    (match) => match[2]!,
  )
  expect(imports.length).toBeGreaterThan(0)
  expect(
    imports.every(
      (specifier) => specifier.startsWith('node:') && builtinModules.includes(specifier.slice(5)),
    ),
  ).toBe(true)
})

it('distinguishes released controls from payloads, active locks and escaping links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'editor-lifecycle-'))
  try {
    const editor = join(root, 'packages/.editor-view')
    await mkdir(join(editor, '.leases'), { recursive: true })
    expect(await unreleasedEditorViewRoots(root)).toEqual([])
    await mkdir(join(editor, '.store'))
    expect(await unreleasedEditorViewRoots(root)).toEqual([editor])
    await rm(join(editor, '.store'), { recursive: true })
    await mkdir(join(editor, '.publish.lock'))
    await writeFile(join(editor, '.publish.lock/owner.json'), '{}')
    expect(await unreleasedEditorViewRoots(root)).toEqual([editor])
    await rm(editor, { recursive: true })
    await symlink(tmpdir(), editor)
    expect(await unreleasedEditorViewRoots(root)).toEqual([editor])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
