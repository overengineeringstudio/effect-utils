import { describe, expect, it } from 'vitest'

import { createStylexVitePlugins, stylexVirtualCssId } from './mod.js'

describe('createStylexVitePlugins', () => {
  it('drops the upstream asset-picking hooks', () => {
    const [compiler] = createStylexVitePlugins()

    // These two are the defect: `generateBundle` picks an emitted CSS asset by
    // filename and `writeBundle` appends to disk when nothing matched. Both
    // exit zero on a miss, which is how compiled CSS gets stranded in a lazy
    // chunk with a successful build.
    expect({
      name: compiler?.name,
      generateBundle: compiler?.generateBundle,
      writeBundle: compiler?.writeBundle,
    }).toEqual({
      name: '@stylexjs/unplugin',
      generateBundle: undefined,
      writeBundle: undefined,
    })
  })

  it('keeps the compiler transform that collects rules', () => {
    const [compiler] = createStylexVitePlugins()

    expect(typeof compiler?.transform).toBe('function')
  })

  it('appends the virtual stylesheet import to named entries only', async () => {
    const entry = '/repo/src/entry.tsx'
    const plugins = createStylexVitePlugins({ entries: [entry] })
    const injector = plugins.find((plugin) => plugin.name === 'overeng:stylex:entry-import')
    const transform =
      typeof injector?.transform === 'function' ? injector.transform : injector?.transform?.handler

    const onEntry = await transform?.call({} as never, 'export const a = 1', entry)
    const onOther = await transform?.call({} as never, 'export const b = 2', '/repo/src/other.tsx')

    expect({ onEntry, onOther }).toEqual({
      // Appended rather than prepended: imports hoist, so this still runs before
      // the module body, but sorts after the entry's own stylesheet imports.
      onEntry: { code: `export const a = 1\nimport "${stylexVirtualCssId}"\n`, map: null },
      onOther: null,
    })
  })

  it('resolves and loads the virtual stylesheet as a side-effectful CSS module', () => {
    const plugins = createStylexVitePlugins({ entries: ['/repo/src/entry.tsx'] })
    const injector = plugins.find((plugin) => plugin.name === 'overeng:stylex:entry-import')
    const resolveId =
      typeof injector?.resolveId === 'function' ? injector.resolveId : injector?.resolveId?.handler
    const load = typeof injector?.load === 'function' ? injector.load : injector?.load?.handler

    const resolved = resolveId?.call({} as never, stylexVirtualCssId, undefined, {} as never)
    const loaded = load?.call({} as never, resolved as string)

    expect({
      resolved,
      moduleSideEffects:
        typeof loaded === 'object' && loaded !== null && 'moduleSideEffects' in loaded
          ? loaded.moduleSideEffects
          : undefined,
    }).toEqual({ resolved: `\0${stylexVirtualCssId}`, moduleSideEffects: true })
  })
})
