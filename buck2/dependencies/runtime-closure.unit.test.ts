import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assembleRuntimeClosure, verifyRuntimeClosure } from './runtime-closure.ts'

const scratch: string[] = []
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const setup = () => { const root = mkdtempSync(join(tmpdir(), 'pnpm-runtime-')); scratch.push(root); return root }

describe('runtime closure relocation', () => {
  it('preserves sibling peer edges, shared roots and workspace first hops after moving the tree', async () => {
    const root = setup()
    const dependency = join(root, 'buck-out', 'peer')
    const plugin = join(root, 'buck-out', 'plugin')
    const view = join(root, 'buck-out', 'view')
    const workspace = join(root, 'buck-out', 'workspace')
    mkdirSync(join(dependency, 'node_modules', '@rolldown', 'pluginutils'), { recursive: true })
    writeFileSync(join(dependency, 'node_modules', '@rolldown', 'pluginutils', 'index.js'), 'module.exports = "peer resolved"\n')
    mkdirSync(join(plugin, 'node_modules', '@vitejs', 'plugin-react'), { recursive: true })
    writeFileSync(join(plugin, 'node_modules', '@vitejs', 'plugin-react', 'index.js'), 'module.exports = require("@rolldown/pluginutils")\n')
    mkdirSync(join(plugin, 'node_modules', '@rolldown'), { recursive: true })
    symlinkSync(join('..', '..', '..', 'peer', 'node_modules', '@rolldown', 'pluginutils'), join(plugin, 'node_modules', '@rolldown', 'pluginutils'))
    mkdirSync(join(view, '@vitejs'), { recursive: true })
    symlinkSync(join('..', '..', 'plugin', 'node_modules', '@vitejs', 'plugin-react'), join(view, '@vitejs', 'plugin-react'))
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'index.js'), 'module.exports = 7\n')
    symlinkSync(join('..', 'workspace'), join(view, 'blocks'))
    const out = join(root, 'output')
    await assembleRuntimeClosure({ output: out, primary: 'service', importers: { service: view, cli: view }, roots: [view, plugin, dependency, workspace] })
    const descriptor = JSON.parse(readFileSync(join(out, 'descriptor.json'), 'utf8')) as { digest: string }
    await verifyRuntimeClosure(out, descriptor.digest)
    const relocated = join(root, 'relocated')
    renameSync(out, relocated)
    rmSync(join(root, 'buck-out'), { recursive: true })
    const imported = createRequire(join(relocated, 'entry.js'))
    expect(imported('@vitejs/plugin-react')).toBe('peer resolved')
    expect(imported('blocks')).toBe(7)
    expect(readlinkSync(join(relocated, 'node_modules')).startsWith('/')).toBe(false)
    expect(readlinkSync(join(relocated, 'importers', 'cli', 'node_modules')).startsWith('/')).toBe(false)
    writeFileSync(createRequire(imported.resolve('@vitejs/plugin-react')).resolve('@rolldown/pluginutils'), 'module.exports = "tampered"\n')
    await expect(verifyRuntimeClosure(relocated, descriptor.digest)).rejects.toThrow('digest mismatch')
  })

  it('rejects undeclared and absolute symlink targets', async () => {
    const root = setup()
    const view = join(root, 'view')
    mkdirSync(view)
    symlinkSync('../missing', join(view, 'missing'))
    await expect(assembleRuntimeClosure({ output: join(root, 'out'), primary: 'service', importers: { service: view }, roots: [view] })).rejects.toThrow('outside declared roots')
    rmSync(join(view, 'missing'))
    symlinkSync('/tmp', join(view, 'missing'))
    await expect(assembleRuntimeClosure({ output: join(root, 'out'), primary: 'service', importers: { service: view }, roots: [view] })).rejects.toThrow('absolute source symlink')
  })
})
