import { expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'

import { requireEditorPublicationInputs } from './editor-publication-inputs.ts'
import {
  editorPublicationIsolation,
  type EditorPublicationOwner,
  releaseEditorPublicationOwner,
  withEditorPublicationOwner,
} from './editor-publication-owner.ts'

const withInputs = async (
  run: (root: string, privateInput: string, defaultInput: string) => Promise<void>,
): Promise<void> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-publication-inputs-')))
  const privateInput = join(root, 'buck-out', editorPublicationIsolation, 'gen', 'input.json')
  const defaultInput = join(root, 'buck-out', 'v2', 'gen', 'input.json')
  try {
    for (const path of [privateInput, defaultInput]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '{}\n')
    }
    await run(root, privateInput, defaultInput)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

it('requires a real owner for mutable inputs and rejects default outputs even for that owner', () =>
  withInputs(async (root, privateInput, defaultInput) => {
    expect(() => requireEditorPublicationInputs({ root, paths: [privateInput] })).toThrow()
    expect(() => requireEditorPublicationInputs({ root, paths: [defaultInput] })).toThrow()
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [privateInput], owner }),
        ).not.toThrow()
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [defaultInput], owner }),
        ).toThrow('outside its reserved Buck isolation')
      },
    })
  }))

it('rejects forged or copied owner objects and owners for another root', () =>
  withInputs(async (root, privateInput) => {
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        for (const forged of [{}, { ...owner }, Object.create(owner)] as EditorPublicationOwner[]) {
          expect(() =>
            requireEditorPublicationInputs({ root, paths: [privateInput], owner: forged }),
          ).toThrow()
        }
        await withInputs(async (foreignRoot, foreignInput) => {
          expect(() =>
            requireEditorPublicationInputs({
              root: foreignRoot,
              paths: [foreignInput],
              owner,
            }),
          ).toThrow()
        })
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [privateInput], owner }),
        ).not.toThrow()
      },
    })
  }))

it('rejects an explicitly released owner and an owner retained beyond its callback', () =>
  withInputs(async (root, privateInput) => {
    let retainedOwner: EditorPublicationOwner | undefined
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        retainedOwner = owner
        releaseEditorPublicationOwner(owner)
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [privateInput], owner }),
        ).toThrow()
      },
    })
    expect(() =>
      requireEditorPublicationInputs({ root, paths: [privateInput], owner: retainedOwner }),
    ).toThrow()
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        retainedOwner = owner
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [privateInput], owner }),
        ).not.toThrow()
      },
    })
    expect(() =>
      requireEditorPublicationInputs({ root, paths: [privateInput], owner: retainedOwner }),
    ).toThrow()
  }))

it('checks both mutable symlink carriers and reached Buck inputs without capturing generic files', () =>
  withInputs(async (root, privateInput, defaultInput) => {
    const generic = join(root, 'ordinary-source.json')
    const carrier = join(dirname(defaultInput), 'carrier.json')
    const disguisedDefault = join(root, 'disguised-default.json')
    const disguisedPrivate = join(root, 'disguised-private.json')
    writeFileSync(generic, '{}\n')
    symlinkSync(generic, carrier)
    symlinkSync(defaultInput, disguisedDefault)
    symlinkSync(privateInput, disguisedPrivate)
    expect(() => requireEditorPublicationInputs({ root, paths: [generic] })).not.toThrow()
    for (const path of [carrier, disguisedDefault, disguisedPrivate]) {
      expect(() => requireEditorPublicationInputs({ root, paths: [path] })).toThrow()
    }
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        for (const path of [carrier, disguisedDefault]) {
          expect(() => requireEditorPublicationInputs({ root, paths: [path], owner })).toThrow(
            'outside its reserved Buck isolation',
          )
        }
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [disguisedPrivate], owner }),
        ).not.toThrow()
      },
    })
  }))

it('inspects intermediate leaf and parent-directory carriers before their ordinary or Nix targets', () =>
  withInputs(async (root, privateInput, defaultInput) => {
    const ordinary = join(root, 'ordinary')
    mkdirSync(ordinary)
    writeFileSync(join(ordinary, 'child'), '{}\n')
    const immutable = realpathSync(process.execPath)
    expect(immutable.startsWith('/nix/store/')).toBe(true)
    const rejected: string[] = []
    const accepted = [join(ordinary, 'child'), immutable]
    for (const [index, target] of [join(ordinary, 'child'), immutable].entries()) {
      for (const [kind, directory] of [
        ['default', dirname(defaultInput)],
        ['private', dirname(privateInput)],
        ['foreign', join(root, 'other-root', 'buck-out', editorPublicationIsolation)],
        ['unknown', join(root, 'buck-out', 'unknown')],
      ] as const) {
        mkdirSync(directory, { recursive: true })
        const leafCarrier = join(directory, `leaf-${index}`)
        const parentCarrier = join(directory, `parent-${index}`)
        const leafAlias = join(root, `${kind}-leaf-${index}`)
        const parentAlias = join(root, `${kind}-parent-${index}`)
        symlinkSync(relative(dirname(leafCarrier), target), leafCarrier)
        symlinkSync(relative(dirname(parentCarrier), dirname(target)), parentCarrier)
        symlinkSync(relative(root, leafCarrier), leafAlias)
        symlinkSync(relative(root, parentCarrier), parentAlias)
        const paths = [leafAlias, join(parentAlias, basename(target))]
        if (kind === 'private') accepted.push(...paths)
        else rejected.push(...paths)
        for (const path of paths) {
          expect(() => requireEditorPublicationInputs({ root, paths: [path] })).toThrow()
        }
      }
    }
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        for (const path of rejected) {
          expect(() => requireEditorPublicationInputs({ root, paths: [path], owner })).toThrow(
            'outside its reserved Buck isolation',
          )
        }
        for (const path of accepted) {
          expect(() =>
            requireEditorPublicationInputs({ root, paths: [path], owner }),
          ).not.toThrow()
        }
      },
    })
    for (const path of [join(ordinary, 'child'), immutable]) {
      expect(() => requireEditorPublicationInputs({ root, paths: [path] })).not.toThrow()
    }
  }))

it('preserves filesystem-order dot segments and native resolution failures', () =>
  withInputs(async (root, privateInput, defaultInput) => {
    const directory = join(dirname(privateInput), 'directory')
    const alias = join(root, 'directory-alias')
    mkdirSync(directory)
    symlinkSync(relative(root, directory), alias)
    const throughParent = `${alias}/../${basename(privateInput)}`
    expect(() => requireEditorPublicationInputs({ root, paths: [throughParent] })).toThrow()
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [throughParent], owner }),
        ).not.toThrow()
      },
    })
    const loop = join(root, 'loop')
    symlinkSync('loop', loop)
    for (const [path, code] of [
      [join(dirname(defaultInput), 'missing'), 'ENOENT'],
      [`${defaultInput}/../input.json`, 'ENOTDIR'],
      [loop, 'ELOOP'],
    ] as const) {
      let error: unknown
      try {
        requireEditorPublicationInputs({ root, paths: [path] })
      } catch (cause) {
        error = cause
      }
      expect(error).toMatchObject({ code })
    }
  }))
